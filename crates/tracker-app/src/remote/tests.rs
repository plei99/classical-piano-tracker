//! The windowed list and the web model over it: prefetch decisions, stale
//! answers, version changes, and the terminal's selection rules applied
//! when a new list arrives.

use anyhow::anyhow;
use tracker_core::Track;

use super::*;
use crate::api::InitialState;
use crate::model::{KeyPress, Msg, Services, WebModel};

fn row(id: i64) -> Row {
    Row {
        track: Track { id, spotify_id: format!("sp{id}"), track_name: format!("Track {id}"), ..Track::default() },
        rating: None,
        artists: format!("Pianist {id}"),
        art: None,
    }
}

/// A window of a list whose row at position `i` is track `ids[i]`.
fn window(version: u64, ids: &[i64], offset: usize, limit: usize, around: Option<i64>) -> ViewResponse {
    let index = around.and_then(|id| ids.iter().position(|&candidate| candidate == id));
    let offset = match index {
        Some(index) => index.saturating_sub(limit / 2).min(ids.len().saturating_sub(limit)),
        None => offset,
    };
    let rows = ids.iter().skip(offset).take(limit).map(|&id| row(id)).collect();
    ViewResponse { version, total: ids.len(), matched: ids.len(), offset, rows, index }
}

/// Track IDs 1..=n in display order.
fn ids(n: i64) -> Vec<i64> {
    (1..=n).collect()
}

/// A list of `n` tracks with the first [`CHUNK`] loaded, as a page starts.
fn list(n: i64) -> RemoteTracks {
    RemoteTracks::from_view(SortMode::RecentDesc, "", window(1, &ids(n), 0, CHUNK, None))
}

fn fetch(cmd: Option<Cmd>) -> ViewRequest {
    match cmd {
        Some(Cmd::FetchView(request)) => request,
        other => panic!("want a fetch, got {other:?}"),
    }
}

/// Answers a request from a list of `ids` at `version`.
fn answer(request: &ViewRequest, version: u64, ids: &[i64]) -> Result<ViewResponse> {
    Ok(window(version, ids, request.offset, request.limit, request.around))
}

fn web_model(n: i64) -> WebModel {
    let initial = InitialState { view: Some(window(1, &ids(n), 0, CHUNK, None)), error: None };
    WebModel::from_initial(Services::ALL, initial)
}

fn key(model: &mut WebModel, name: &str) -> Option<Cmd> {
    let key = match name.chars().count() {
        1 => KeyPress::typed(name.chars().next().unwrap()),
        _ => KeyPress::named(name),
    };
    model.update(Msg::Key(key))
}

fn deliver(model: &mut WebModel, request: ViewRequest, version: u64, ids: &[i64]) -> Option<Cmd> {
    let result = answer(&request, version, ids);
    model.update(Msg::ViewLoaded { request, result })
}

#[test]
fn a_server_rendered_page_starts_with_its_first_window() {
    let list = list(250);
    assert_eq!((list.len(), list.total(), list.version()), (250, 250, 1));
    assert_eq!(list.row(0).unwrap().track.id, 1);
    assert_eq!(list.row(99).unwrap().artists, "Pianist 100");
    assert!(list.row(100).is_none(), "not fetched yet");
    assert_eq!(list.index_of(42), Some(41));
    assert_eq!(list.index_of(142), None);
    assert_eq!(list.applied(), Some((SortMode::RecentDesc, "")));

    let model = web_model(250);
    assert!(!model.loading_tracks);
    assert_eq!(model.selected_track_id(), 1);
    assert_eq!(crate::presenter::track_list_summary(&model), "250 loaded · sort: recent");

    let failed = WebModel::from_initial(Services::ALL, InitialState { view: None, error: Some("locked".into()) });
    assert_eq!(crate::presenter::screen(&failed), crate::presenter::Screen::Error);
    let mut loading = WebModel::from_initial(Services::ALL, InitialState::default());
    assert!(loading.loading_tracks);
    let request = fetch(loading.init());
    assert_eq!((request.kind, request.around), (ViewKind::Refresh, None), "the first read needs no reload");
    deliver(&mut loading, request, 1, &ids(5));
    assert!(!loading.loading_tracks);
    assert_eq!(loading.selected_track_id(), 1);
}

#[test]
fn prefetches_ahead_of_the_viewport_and_never_twice() {
    let mut list = list(1000);
    // Rows 0-15 on screen: a screen and more is loaded below.
    assert!(list.viewport(0, 16).is_none());
    // Near the end of the loaded rows: fetch on from there.
    let request = fetch(list.viewport(80, 96));
    assert_eq!((request.kind, request.offset, request.limit), (ViewKind::Window, 100, CHUNK));
    assert_eq!((request.sort, request.query.as_str(), request.around), (SortMode::RecentDesc, "", None));
    assert!(list.viewport(80, 96).is_none(), "already on its way");
    assert!(list.fetch(150).is_none(), "covered by the window on its way");

    assert!(matches!(list.view_loaded(&request, answer(&request, 1, &ids(1000)), 1), ViewOutcome::Merged));
    assert_eq!(list.loaded_count(0..1000), 200);
    assert!(list.viewport(150, 166).is_none(), "two screens and more ahead are loaded");
}

#[test]
fn prefetches_upward_when_scrolling_up_and_centers_jumps() {
    let mut list = RemoteTracks::from_view(SortMode::IdAsc, "", window(1, &ids(1000), 500, CHUNK, None));
    let up = fetch(list.viewport(505, 520));
    assert_eq!((up.offset, up.limit), (400, CHUNK), "the rows just above the loaded ones");
    let jump = fetch(list.viewport(800, 815));
    assert_eq!((jump.offset, jump.limit), (757, CHUNK), "centered on the rows needed");
    let end = fetch(list.fetch(999));
    assert_eq!((end.offset, end.limit), (900, CHUNK), "clamped to the end");
}

#[test]
fn drops_windows_of_a_replaced_list_and_superseded_lists() {
    let mut list = list(1000);
    let stale_window = fetch(list.viewport(85, 100));
    let Refresh::Pending(first) = list.refresh(SortMode::RecentDesc, "a", 1) else { panic!("fetches") };
    let Refresh::Pending(second) = list.refresh(SortMode::RecentDesc, "ab", 1) else { panic!("fetches") };
    let (first, second) = (fetch(Some(first)), fetch(Some(second)));
    assert!(second.seq > first.seq);
    assert_eq!(second.around, Some(1));

    // The second query's answer arrives first; the first's is then stale.
    let matches = [5, 1, 9];
    assert!(matches!(list.view_loaded(&second, answer(&second, 1, &matches), 1), ViewOutcome::Replaced(Some(1))));
    assert!(matches!(list.view_loaded(&first, answer(&first, 1, &ids(1000)), 1), ViewOutcome::Stale));
    assert_eq!((list.len(), list.applied()), (3, Some((SortMode::RecentDesc, "ab"))));
    // A window of the old list no longer applies.
    assert!(matches!(list.view_loaded(&stale_window, answer(&stale_window, 1, &ids(1000)), 1), ViewOutcome::Stale));
    assert_eq!(list.len(), 3);
}

#[test]
fn a_newer_version_refetches_once_and_an_older_one_is_ignored() {
    let mut list = list(1000);
    let first = fetch(list.viewport(85, 100));
    let second = fetch(list.viewport(400, 415));
    assert!(matches!(list.view_loaded(&first, answer(&first, 2, &ids(1000)), 1), ViewOutcome::Outdated));
    assert!(matches!(list.view_loaded(&second, answer(&second, 2, &ids(1000)), 1), ViewOutcome::Stale));
    assert_eq!(list.loaded_count(0..1000), CHUNK, "nothing merged from the newer version");
    assert_eq!(list.row(0).unwrap().track.id, 1, "the rows stay until the new list arrives");

    let older = fetch(list.viewport(85, 100));
    assert!(matches!(list.view_loaded(&older, answer(&older, 0, &ids(1000)), 1), ViewOutcome::Stale));
}

#[test]
fn failed_windows_are_asked_for_again() {
    let mut list = list(1000);
    let request = fetch(list.viewport(85, 100));
    assert!(matches!(list.view_loaded(&request, Err(anyhow!("offline")), 1), ViewOutcome::Stale));
    assert_eq!(fetch(list.viewport(85, 100)).offset, 100);
}

#[test]
fn moving_within_loaded_rows_never_fetches() {
    let mut model = web_model(1000);
    for _ in 0..99 {
        assert!(key(&mut model, "j").is_none());
    }
    assert_eq!(model.selected_track_id(), 100);
    assert!(model.update(Msg::Select { track_id: 50 }).is_none());
    assert_eq!(model.selected_index, 49);
}

#[test]
fn jumps_to_rows_not_loaded_wait_for_them() {
    let mut model = web_model(1000);
    let request = fetch(key(&mut model, "G"));
    assert_eq!((request.offset, request.limit), (900, CHUNK));
    assert_eq!(model.selected_index, 0, "the selection stays until the row arrives");
    assert_eq!(model.pending_index, Some(999));
    assert!(key(&mut model, "G").is_none(), "already on its way");
    assert!(deliver(&mut model, request, 1, &ids(1000)).is_none());
    assert_eq!((model.selected_index, model.selected_track_id()), (999, 1000));
    assert!(key(&mut model, "g").is_none(), "row 0 is still loaded");
    assert_eq!(model.selected_index, 0);

    // A jump whose rows arrive after the editor opened is dropped...
    let mut model = web_model(1000);
    let request = fetch(key(&mut model, "end"));
    let mut editing = model.clone();
    key(&mut editing, "e");
    deliver(&mut editing, request.clone(), 1, &ids(1000));
    assert_eq!((editing.selected_index, editing.editing_rating), (0, true));
    // ...and so is one overtaken by another move.
    key(&mut model, "j");
    assert_eq!(model.pending_index, None);
    deliver(&mut model, request, 1, &ids(1000));
    assert_eq!(model.selected_index, 1);
}

#[test]
fn sorting_and_searching_keep_the_selected_track_like_the_terminal() {
    let mut model = web_model(1000);
    for _ in 0..5 {
        key(&mut model, "j");
    }
    let request = fetch(key(&mut model, "o"));
    assert_eq!((request.kind, request.sort, request.around), (ViewKind::Refresh, SortMode::IdAsc, Some(6)));
    assert_eq!(crate::presenter::track_list_summary(&model), "1000 loaded · sort: recent", "until it arrives");
    let reversed: Vec<i64> = (1..=1000).rev().collect();
    deliver(&mut model, request, 1, &reversed);
    assert_eq!((model.selected_index, model.selected_track_id()), (994, 6));
    assert_eq!(crate::presenter::track_list_summary(&model), "1000 loaded · sort: id");
    assert!(model.list.row(994).is_some());

    // A query that drops the selected track selects the first match and
    // closes the editor, as `refreshTrackList` does.
    let request = fetch(model.update(Msg::SetSearch("x".into())));
    assert_eq!((request.query.as_str(), request.around), ("x", Some(6)));
    model.start_rating_editor();
    deliver(&mut model, request, 1, &[7, 8]);
    assert_eq!((model.selected_index, model.selected_track_id(), model.editing_rating), (0, 7, false));
    let status = crate::presenter::status(&model).unwrap();
    assert_eq!(status.text, "Filter /x (2/2)");

    // No matches at all.
    let request = fetch(model.update(Msg::SetSearch("zz".into())));
    let none = ViewResponse { version: 1, total: 1000, ..ViewResponse::default() };
    model.update(Msg::ViewLoaded { request, result: Ok(none) });
    assert_eq!(crate::presenter::screen(&model), crate::presenter::Screen::NoMatch);
    assert_eq!(crate::presenter::no_match_text(&model), "No tracks match /zz");
}

#[test]
fn a_selection_that_moved_meanwhile_is_kept_or_fetched_again() {
    let mut model = web_model(1000);
    let request = fetch(key(&mut model, "o"));
    key(&mut model, "j");
    key(&mut model, "j");
    // Track 3 is in the new window: keep it.
    deliver(&mut model, request, 1, &ids(1000));
    assert_eq!(model.selected_track_id(), 3);

    let request = fetch(key(&mut model, "o"));
    for _ in 0..60 {
        key(&mut model, "j");
    }
    assert_eq!(model.selected_track_id(), 63);
    // Track 63 is outside a window centered on track 3 of this order: ask
    // again around it, leaving the list as it is until then.
    let mut far: Vec<i64> = (1..=1000).collect();
    far.swap(62, 900);
    let again = fetch(deliver(&mut model, request, 1, &far));
    assert_eq!(again.around, Some(63));
    assert_eq!(model.selected_track_id(), 63);
    deliver(&mut model, again, 1, &far);
    assert_eq!((model.selected_index, model.selected_track_id()), (900, 63));
}

#[test]
fn a_saved_rating_shows_at_once_and_the_list_is_fetched_again_without_a_gap() {
    let mut model = web_model(1000);
    key(&mut model, "j");
    key(&mut model, "e");
    key(&mut model, "4");
    let Some(Cmd::SaveRating(params)) = key(&mut model, "enter") else { panic!("saves") };
    let rating = Rating { track_id: params.track_id, stars: 4, opinion: String::new(), updated_at: 5 };
    let request = fetch(model.update(Msg::RatingSaved { track_id: params.track_id, result: Ok(rating.clone()) }));
    assert_eq!(model.selected_rating(), Some(&rating), "the server's answer, before the refetch");
    assert_eq!(model.status_message, "Saved 4/5 rating for track 2");
    assert_eq!((request.kind, request.around), (ViewKind::Refresh, Some(2)));
    assert!(model.list.row(0).is_some(), "the rows stay while the list is fetched again");

    let mut response = window(2, &ids(1000), 0, CHUNK, Some(2));
    response.rows[1].rating = Some(rating.clone());
    model.update(Msg::ViewLoaded { request, result: Ok(response) });
    assert_eq!((model.selected_track_id(), model.list.version()), (2, 2));
    assert_eq!(model.selected_rating(), Some(&rating));
    assert_eq!(model.status_message, "Saved 4/5 rating for track 2", "a refetch does not clear the status");
}

#[test]
fn a_version_change_seen_while_scrolling_refetches_around_the_selection() {
    let mut model = web_model(1000);
    key(&mut model, "j");
    let window = fetch(model.update(Msg::Viewport { first: 85, last: 100 }));
    let refetch = fetch(deliver(&mut model, window, 2, &ids(1001)));
    assert_eq!((refetch.kind, refetch.around), (ViewKind::Refresh, Some(2)));
    assert_eq!(model.list.len(), 1000, "unchanged until the new list arrives");
    let mut grown = vec![1001];
    grown.extend(ids(1000));
    deliver(&mut model, refetch, 2, &grown);
    assert_eq!((model.list.len(), model.selected_index, model.selected_track_id()), (1001, 2, 2));
}

#[test]
fn reloads_reread_and_failures_are_reported() {
    let mut model = web_model(10);
    let request = fetch(key(&mut model, "r"));
    assert_eq!(request.kind, ViewKind::Reload);
    assert!(model.loading_tracks);
    model.update(Msg::ViewLoaded { request, result: Err(anyhow!("database is locked")) });
    assert_eq!((model.loading_tracks, model.err.as_deref()), (false, Some("database is locked")));
    let request = fetch(key(&mut model, "r"));
    deliver(&mut model, request, 3, &ids(10));
    assert_eq!((model.err.as_deref(), model.list.version()), (None, 3));

    // A failed search keeps the list and says why.
    let request = fetch(model.update(Msg::SetSearch("x".into())));
    model.update(Msg::ViewLoaded { request, result: Err(anyhow!("server stopped")) });
    assert_eq!(model.list.len(), 10);
    assert_eq!((model.status_message.as_str(), model.status_is_error), ("server stopped", true));

    // After a sync the server has already re-read the database.
    model.syncing = true;
    let request = fetch(model.update(Msg::SyncFinished(Ok(tracker_core::SyncStats::default()))));
    assert_eq!(request.kind, ViewKind::Refresh);
}
