//! Ports of the Go `app_test.go` suite, plus layout checks against output
//! captured from the Go build (`testdata/go_*.txt`, rendered with TZ=UTC).

use std::collections::HashMap;
use std::sync::Arc;

use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use jiff::tz::TimeZone;
use ratatui::Terminal;
use ratatui::backend::TestBackend;
use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::style::Modifier;
use tracker_app::{LocalTracks, Model, Services, SortMode, TrackList, TrackRow};
use tracker_core::db::Queries;
use tracker_core::{Db, Rating, SyncStats, Track, UpsertRatingParams, UpsertTrackParams};

use super::*;
use crate::view::Draw;
use crate::{SaveRatingFn, SyncFn};

fn track(id: i64) -> Track {
    Track { id, ..Track::default() }
}

fn named_track(id: i64, name: &str, artists: &str) -> Track {
    Track { id, track_name: name.into(), artists: artists.into(), ..Track::default() }
}

fn searchable(id: i64, name: &str, album: &str, artists: &str, last_played_at: i64) -> Track {
    Track {
        id,
        track_name: name.into(),
        album_name: album.into(),
        artists: artists.into(),
        last_played_at,
        ..Track::default()
    }
}

/// A model showing `tracks` in the given (unsorted) order, like a Go test
/// model built with only its `tracks` field set.
fn with_tracks(tracks: Vec<Track>) -> Model {
    Model {
        list: LocalTracks::new(tracks.into_iter().map(TrackRow::new).collect(), HashMap::new()),
        time_zone: TimeZone::UTC,
        ..Model::default()
    }
}

/// [`with_tracks`] plus saved ratings.
fn with_rated_tracks(tracks: Vec<Track>, entries: impl IntoIterator<Item = Rating>) -> Model {
    let mut model = with_tracks(tracks);
    model.list.ratings = ratings(entries);
    model
}

fn ids(model: &Model) -> Vec<i64> {
    model.visible_rows().map(|row| row.track.id).collect()
}

fn ratings(entries: impl IntoIterator<Item = Rating>) -> HashMap<i64, Rating> {
    entries.into_iter().map(|rating| (rating.track_id, rating)).collect()
}

fn loaded(tracks: Vec<Track>, ratings: Vec<Rating>) -> Msg {
    Msg::TracksLoaded(Ok(TracksLoaded::new(tracks, ratings)))
}

fn key_msg(event: KeyEvent) -> Msg {
    Msg::Key(key_press(&event).expect("a key press"))
}

/// The key press crossterm reports for typed text.
fn text_key(c: char) -> Msg {
    key_msg(KeyEvent::new(KeyCode::Char(c), KeyModifiers::NONE))
}

fn key(code: KeyCode) -> Msg {
    key_msg(KeyEvent::new(code, KeyModifiers::NONE))
}

fn ctrl(c: char) -> Msg {
    key_msg(KeyEvent::new(KeyCode::Char(c), KeyModifiers::CONTROL))
}

fn shift_tab() -> Msg {
    key_msg(KeyEvent::new(KeyCode::BackTab, KeyModifiers::SHIFT))
}

fn type_keys(model: &mut Model, keys: impl IntoIterator<Item = Msg>) {
    for key in keys {
        model.update(key);
    }
}

fn type_text(model: &mut Model, text: &str) {
    type_keys(model, text.chars().map(text_key));
}

/// Callbacks that fail the test if a command reaches them.
fn deps() -> Deps {
    Deps {
        load: Arc::new(|| panic!("unexpected load")),
        sync: Arc::new(|| panic!("unexpected sync")),
        save_rating: Arc::new(|_| panic!("unexpected save")),
    }
}

/// Runs a command the way the terminal's worker thread does.
fn run_task(deps: &Deps, cmd: Option<Cmd>) -> Msg {
    match cmd {
        Some(Cmd::Quit) | None => panic!("expected a background task, got {cmd:?}"),
        Some(cmd) => execute(deps, cmd).expect("a result message"),
    }
}

fn buffer_lines(buffer: &Buffer) -> Vec<String> {
    let area = buffer.area;
    (area.top()..area.bottom())
        .map(|y| {
            let mut line = String::new();
            let mut skip = 0;
            for x in area.left()..area.right() {
                if skip > 0 {
                    skip -= 1;
                    continue;
                }
                let symbol = buffer[(x, y)].symbol();
                skip = crate::text::width(symbol).saturating_sub(1);
                line.push_str(symbol);
            }
            line.trim_end().to_string()
        })
        .collect()
}

/// The whole frame, unclipped, like Go's `View().Content`.
fn view_text(model: &Model) -> String {
    let height = u16::try_from(model.view().height()).unwrap();
    let width = model.width.max(200);
    let mut buffer = Buffer::empty(Rect::new(0, 0, width, height));
    model.render_to(buffer.area, &mut buffer);
    buffer_lines(&buffer).join("\n")
}

/// The frame as a terminal of the model's size would show it.
fn screen(model: &Model) -> Buffer {
    let mut terminal = Terminal::new(TestBackend::new(model.width, model.height)).unwrap();
    terminal.draw(|frame| model.render(frame)).unwrap();
    terminal.backend().buffer().clone()
}

/// Shows an error status, as a failed sync does.
fn set_error(model: &mut Model, message: impl Into<String>) {
    model.status_message = message.into();
    model.status_is_error = true;
}

fn footer_has_notification_line(rendered: &str, want: &str) -> bool {
    let lines: Vec<&str> = rendered.split('\n').collect();
    lines.iter().enumerate().any(|(index, line)| {
        line.contains(want) && lines.get(index + 1).is_some_and(|next| next.contains("j/k or arrows: move"))
    })
}

fn db_loader(db: Arc<Db>) -> LoadFn {
    Arc::new(move || {
        let conn = db.conn();
        Ok((conn.list_all_tracks()?, conn.list_all_ratings()?))
    })
}

#[test]
fn update_tracks_loaded_selects_first_track_with_cached_rating() {
    let mut model = Model { loading_tracks: true, ..Model::default() };
    let cmd = model.update(loaded(
        vec![
            Track { last_played_at: 100, ..named_track(3, "Track Three", r#"["Artist Three"]"#) },
            Track { last_played_at: 200, ..named_track(1, "Track One", r#"["Artist One"]"#) },
            Track { last_played_at: 100, ..named_track(2, "Track Two", r#"["Artist Two"]"#) },
        ],
        vec![Rating { track_id: 1, stars: 4, ..Rating::default() }],
    ));
    assert!(!model.loading_tracks, "loading_tracks should be false after TracksLoaded");
    assert_eq!(ids(&model), vec![1, 3, 2], "tracks should be sorted by recent desc");
    assert_eq!(model.selected_rating().map(|rating| rating.stars), Some(4), "want cached 4-star rating");
    assert!(cmd.is_none(), "selecting a loaded track should not need a follow-up DB command");
}

#[test]
fn update_tracks_loaded_preserves_selected_track_across_reload() {
    let mut model = Model { selected_index: 1, ..with_tracks(vec![track(7), track(9)]) };
    let cmd = model.update(loaded(
        vec![
            Track { last_played_at: 300, ..named_track(5, "Five", r#"["Artist Five"]"#) },
            Track { last_played_at: 200, ..named_track(9, "Nine", r#"["Artist Nine"]"#) },
            Track { last_played_at: 100, ..named_track(7, "Seven", r#"["Artist Seven"]"#) },
        ],
        Vec::new(),
    ));
    assert_eq!(model.selected_track().map(|track| track.id), Some(9), "selected track after reload");
    assert!(cmd.is_none(), "reloading tracks should not need a follow-up DB command");
}

#[test]
fn move_selection_reads_rating_from_cache() {
    let mut model = Model {
        width: 120,
        height: 28,
        ..with_rated_tracks(
            vec![named_track(1, "One", r#"["A"]"#), named_track(2, "Two", r#"["B"]"#)],
            [Rating { track_id: 2, stars: 5, updated_at: 10, ..Rating::default() }],
        )
    };

    let cmd = model.update(text_key('j'));
    assert!(cmd.is_none(), "moving the selection should not issue a DB command");
    let view = view_text(&model);
    assert!(view.contains("Rating: 5/5"), "view = {view}\nwant cached rating for track 2");

    model.update(text_key('k'));
    let view = view_text(&model);
    assert!(view.contains("Rating: none"), "view = {view}\nwant no rating for track 1");
}

#[test]
fn sync_key_starts_async_sync() {
    let sync: SyncFn =
        Arc::new(|| Ok(SyncStats { fetched: 5, accepted: 2, inserted: 1, updated: 1, ..SyncStats::default() }));
    let mut model = Model { services: Services::ALL, loading_tracks: true, ..with_tracks(vec![track(1)]) };

    let cmd = model.update(text_key('s'));
    assert!(model.syncing, "syncing should be true after pressing s");
    match run_task(&Deps { sync, ..deps() }, cmd) {
        Msg::SyncFinished(Ok(stats)) => assert_eq!(stats.fetched, 5),
        Msg::SyncFinished(Err(err)) => panic!("unexpected sync error: {err}"),
        _ => panic!("sync command should return SyncFinished"),
    }
}

#[test]
fn sync_finished_reloads_tracks() {
    let db = Arc::new(Db::open_in_memory().unwrap());
    let mut model = Model { syncing: true, ..with_tracks(vec![track(1)]) };

    let cmd = model.update(Msg::SyncFinished(Ok(SyncStats {
        fetched: 5,
        accepted: 2,
        inserted: 1,
        updated: 1,
        ..SyncStats::default()
    })));
    assert!(!model.syncing, "syncing should be false after SyncFinished");
    assert!(model.loading_tracks, "loading_tracks should be true while refreshing after sync");
    assert!(
        footer_has_notification_line(&model.footer(), "Sync complete."),
        "footer = {:?}, want sync completion on a separate line",
        model.footer()
    );
    assert!(
        matches!(run_task(&Deps { load: db_loader(db), ..deps() }, cmd), Msg::TracksLoaded(Ok(_))),
        "expected track reload after successful sync"
    );
}

#[test]
fn sync_finished_error_sets_status() {
    let mut model = Model { syncing: true, ..with_tracks(vec![track(1)]) };
    model.update(Msg::SyncFinished(Err(anyhow!("bad token"))));
    assert!(!model.syncing, "syncing should be false after a failed sync");
    assert!(model.status_is_error, "status should be marked as error after failed sync");
    assert!(
        footer_has_notification_line(&model.footer(), "Error: Sync failed: bad token"),
        "footer = {:?}, want sync error on a separate line",
        model.footer()
    );
}

#[test]
fn sort_key_cycles_order_and_preserves_selected_track() {
    let mut model = Model {
        sort_mode: SortMode::RecentDesc,
        selected_index: 1,
        ..with_tracks(vec![
            Track { last_played_at: 300, play_count: 2, ..track(10) },
            Track { last_played_at: 200, play_count: 8, ..track(7) },
            Track { last_played_at: 100, play_count: 1, ..track(4) },
        ])
    };

    model.update(text_key('o'));
    assert_eq!(model.sort_mode, SortMode::IdAsc);
    assert_eq!(model.selected_track().map(|track| track.id), Some(7));
    assert_eq!(ids(&model), vec![4, 7, 10], "tracks after ID sort");

    // The rest of the cycle, then back to the start.
    model.update(text_key('o'));
    assert_eq!((model.sort_mode, ids(&model)), (SortMode::TopPlayed, vec![7, 10, 4]));
    model.update(text_key('o'));
    assert_eq!((model.sort_mode, ids(&model)), (SortMode::UnratedFirst, vec![10, 7, 4]));
    model.update(text_key('o'));
    assert_eq!((model.sort_mode, ids(&model)), (SortMode::RecentDesc, vec![10, 7, 4]));
    assert_eq!(model.selected_track().map(|track| track.id), Some(7));
}

#[test]
fn go_to_top_and_bottom_keys_move_selection() {
    let mut model = Model { selected_index: 1, ..with_tracks(vec![track(11), track(22), track(33)]) };

    let cmd = model.update(text_key('g'));
    assert_eq!((model.selected_index, model.selected_track().map(|track| track.id)), (0, Some(11)));
    assert!(cmd.is_none(), "g should not issue a DB command");

    let cmd = model.update(text_key('G'));
    assert_eq!((model.selected_index, model.selected_track().map(|track| track.id)), (2, Some(33)));
    assert!(cmd.is_none(), "G should not issue a DB command");

    model.update(key(KeyCode::Home));
    assert_eq!(model.selected_index, 0, "home should jump to the top");
    model.update(key(KeyCode::End));
    assert_eq!(model.selected_index, 2, "end should jump to the bottom");
    model.update(key(KeyCode::Up));
    assert_eq!(model.selected_index, 1, "up should move up");
    model.update(key(KeyCode::Down));
    model.update(key(KeyCode::Down));
    assert_eq!(model.selected_index, 2, "down should stop at the last track");
}

fn search_tracks() -> Vec<Track> {
    vec![
        searchable(3, "Ballade No. 1", "Chopin", r#"["Martha Argerich"]"#, 300),
        searchable(2, "Images", "Debussy", r#"["Seong-Jin Cho"]"#, 200),
        searchable(1, "Etudes", "Ligeti", r#"["Yuja Wang"]"#, 100),
    ]
}

#[test]
fn search_filters_tracks_and_enter_exits_search_mode() {
    let mut model = with_tracks(search_tracks());

    model.update(text_key('/'));
    assert!(model.searching, "searching should be true after pressing /");

    let mut cmds = Vec::new();
    for c in "yuja".chars() {
        cmds.push(model.update(text_key(c)));
    }
    assert_eq!(model.search_query, "yuja");
    assert_eq!(ids(&model), vec![1], "want only the Yuja Wang track");
    assert_eq!(model.selected_track().map(|track| track.id), Some(1));
    assert!(cmds.iter().all(Option::is_none), "search should not issue a DB command");

    model.update(key(KeyCode::Enter));
    assert!(!model.searching, "searching should be false after pressing enter");
    assert!(
        footer_has_notification_line(&model.footer(), "Filter /yuja (1/3)"),
        "footer = {:?}, want active filter summary on a separate line",
        model.footer()
    );
}

#[test]
fn search_esc_clears_filter_and_restores_tracks() {
    let mut model = Model {
        searching: true,
        search_query: "yuja".into(),
        list: LocalTracks {
            all_tracks: [
                searchable(2, "Images", "Debussy", r#"["Seong-Jin Cho"]"#, 200),
                searchable(1, "Etudes", "Ligeti", r#"["Yuja Wang"]"#, 100),
            ]
            .into_iter()
            .map(TrackRow::new)
            .collect(),
            tracks: vec![1],
            ..LocalTracks::default()
        },
        ..Model::default()
    };

    let cmd = model.update(key(KeyCode::Esc));
    assert!(!model.searching, "searching should be false after esc");
    assert_eq!(model.search_query, "", "query should be cleared");
    assert_eq!(model.list.len(), 2, "want restored full list");
    assert_eq!(model.selected_track().map(|track| track.id), Some(1), "selection should be preserved");
    assert!(cmd.is_none(), "clearing search should not issue a command");
}

#[test]
fn search_editing_keys() {
    let mut model = Model { searching: true, ..with_tracks(search_tracks()) };
    type_text(&mut model, "yuja x");
    assert_eq!((model.search_query.as_str(), model.list.len()), ("yuja x", 0));
    model.update(key(KeyCode::Backspace));
    model.update(key(KeyCode::Backspace));
    assert_eq!((model.search_query.as_str(), ids(&model)), ("yuja", vec![1]));
    model.update(ctrl('u'));
    assert_eq!((model.search_query.as_str(), model.list.len()), ("", 3));
    assert!(model.searching, "ctrl+u keeps search mode");
    assert!(model.update(text_key('q')).is_none(), "q is text while searching");
    assert!(matches!(model.update(ctrl('c')), Some(Cmd::Quit)), "ctrl+c still quits");
}

#[test]
fn search_no_matches_view() {
    let mut model = Model {
        width: 100,
        height: 28,
        search_query: "zzz".into(),
        ..with_tracks(vec![searchable(1, "Etudes", "Ligeti", r#"["Yuja Wang"]"#, 100)])
    };
    model.refresh_track_list(0);

    let view = view_text(&model);
    assert!(view.contains("No tracks match /zzz"), "view = {view}\nwant no-match message");
    assert!(footer_has_notification_line(&view, "Filter /zzz (0/1)"), "view = {view}\nwant filter count");
}

#[test]
fn rating_saved_resorts_unrated_first() {
    let mut model = Model {
        sort_mode: SortMode::UnratedFirst,
        selected_index: 0,
        ..with_rated_tracks(
            vec![Track { last_played_at: 300, ..track(4) }, Track { last_played_at: 200, ..track(9) }],
            [Rating { track_id: 9, stars: 2, ..Rating::default() }],
        )
    };
    let before = model.clone();

    model.update(Msg::RatingSaved {
        track_id: 4,
        result: Ok(Rating { track_id: 4, stars: 5, updated_at: 10, ..Rating::default() }),
    });
    assert!(model.list.ratings.contains_key(&4), "track 4 should be marked as rated after save");
    assert_eq!(model.selected_track().map(|track| track.id), Some(4));
    assert_eq!(ids(&model), vec![4, 9], "want selected track preserved with deterministic order");
    assert!(!before.list.ratings.contains_key(&4), "saving should not mutate a previous copy of the model");
}

#[test]
fn enter_starts_rating_editor_with_existing_rating() {
    let mut model = Model {
        ..with_rated_tracks(
            vec![named_track(1, "One", r#"["A"]"#)],
            [Rating { track_id: 1, stars: 4, opinion: "Warm".into(), ..Rating::default() }],
        )
    };

    model.update(key(KeyCode::Enter));
    assert!(model.editing_rating, "editing_rating should be true after pressing enter");
    assert_eq!((model.draft_stars, model.draft_opinion.as_str()), (4, "Warm"));
}

#[test]
fn rating_editor_handles_input_and_save() {
    let save: SaveRatingFn = Arc::new(|params: UpsertRatingParams| {
        Ok(Rating {
            track_id: params.track_id,
            stars: params.stars,
            opinion: params.opinion,
            updated_at: params.updated_at,
        })
    });
    let mut model =
        Model { services: Services::ALL, loading_tracks: true, ..with_tracks(vec![named_track(7, "One", r#"["A"]"#)]) };

    model.update(key(KeyCode::Enter));
    assert!(model.editing_rating, "editor should open");

    type_text(&mut model, "5Great");
    let cmd = model.update(key(KeyCode::Enter));
    assert!(!model.editing_rating, "editor should close when save starts");
    assert!(model.saving_rating, "saving_rating should be true while the save is in flight");

    match run_task(&Deps { save_rating: save, ..deps() }, cmd) {
        Msg::RatingSaved { track_id, result: Ok(rating) } => {
            assert_eq!((track_id, rating.stars, rating.opinion.as_str()), (7, 5, "Great"));
            assert!(rating.updated_at > 0, "save should stamp the current time");
        }
        _ => panic!("save command should return a successful RatingSaved"),
    }
}

#[test]
fn rating_saved_updates_selection() {
    let mut model = Model { saving_rating: true, ..with_tracks(vec![track(9)]) };
    model.update(Msg::RatingSaved {
        track_id: 9,
        result: Ok(Rating { track_id: 9, stars: 3, opinion: "Good".into(), updated_at: 10 }),
    });
    assert!(!model.saving_rating, "saving_rating should be false after RatingSaved");
    assert_eq!(model.selected_rating().map(|rating| rating.stars), Some(3));
    assert_eq!(model.status_message, "Saved 3/5 rating for track 9");
}

#[test]
fn rating_save_failure_and_validation_set_status() {
    let mut model = with_tracks(vec![track(9)]);
    model.start_rating_editor();
    assert!(model.update(key(KeyCode::Enter)).is_none());
    assert_eq!(model.status_message, "Choose a star rating from 1 to 5 before saving.");
    assert!(model.status_is_error && model.editing_rating);

    type_text(&mut model, "3");
    assert!(model.update(key(KeyCode::Enter)).is_none(), "no saver injected");
    assert_eq!(model.status_message, "Saving ratings is unavailable in this view.");

    model.saving_rating = true;
    model.update(Msg::RatingSaved { track_id: 9, result: Err(anyhow!("disk full")) });
    assert!(!model.saving_rating);
    assert_eq!((model.status_message.as_str(), model.status_is_error), ("Save failed: disk full", true));

    model.editing_rating = true;
    model.update(key(KeyCode::Esc));
    assert!(!model.editing_rating);
    assert_eq!((model.status_message.as_str(), model.status_is_error), ("Rating edit canceled.", false));
}

#[test]
fn format_track_artists() {
    assert_eq!(
        tracker_core::artists::format(r#"["Martha Argerich","Daniil Trifonov"]"#),
        "Martha Argerich, Daniil Trifonov"
    );
}

#[test]
fn format_track_artists_matches_json_decoding() {
    for raw in [
        r#"["Frédéric Chopin","Víkingur Ólafsson"]"#,
        r#"["Solo"]"#,
        r#"["A",""]"#,
        r#"[""]"#,
        r#"["Quote \"Nickname\" Pianist","B"]"#,
        r#"["Tom & Jerry"]"#,
        r#"["Spaced", "Out"]"#,
        "[]",
        "not json",
    ] {
        let want = match serde_json::from_str::<Vec<String>>(raw) {
            Ok(artists) if !artists.is_empty() => artists.join(", "),
            _ => raw.to_string(),
        };
        assert_eq!(tracker_core::artists::format(raw), want, "format({raw})");
    }
}

#[test]
fn render_error_state() {
    let model = Model { err: Some("boom".into()), ..Model::default() };
    let view = view_text(&model);
    assert!(view.contains("Error: boom"), "view = {view}\nwant error text");
    assert!(view.contains("Press r to retry or q to quit."));
}

#[test]
fn load_error_shows_error_state_and_r_retries() {
    let mut model = Model { loading_tracks: true, ..Model::default() };
    assert!(view_text(&model).contains("Loading local tracks..."));
    model.update(Msg::TracksLoaded(Err(anyhow!("database is locked").context("list tracks"))));
    assert_eq!(model.err.as_deref(), Some("list tracks: database is locked"), "errors show their full chain");
    let cmd = model.update(text_key('r'));
    assert!(model.loading_tracks && model.err.is_none());
    assert_eq!(cmd, Some(Cmd::LoadTracks), "r should reload");
}

#[test]
fn empty_library_view() {
    let mut model = Model::default();
    model.update(loaded(Vec::new(), Vec::new()));
    let view = view_text(&model);
    assert!(view.contains("No local tracks found. Run `tracker sync` first."), "view = {view}");
    assert!(view.contains("j/k or arrows: move"), "view = {view}\nwant the key help");
}

#[test]
fn layout_uses_vertical_mode_for_narrow_windows() {
    let model = Model { width: 70, height: 24, ..Model::default() };
    let layout = model.layout();
    assert!(layout.vertical, "layout() should use vertical mode for narrow widths");
    assert_eq!(layout.list_width, layout.detail_width, "vertical layout should use the same pane width");
}

#[test]
fn layout_uses_horizontal_mode_for_wide_windows() {
    let model = Model { width: 140, height: 30, ..Model::default() };
    let layout = model.layout();
    assert!(!layout.vertical, "layout() should use horizontal mode for wide widths");
    assert_eq!(layout.list_height, layout.detail_height, "horizontal layout should use the full height for both panes");
}

#[test]
fn visible_tracks_centers_selection() {
    let model = Model { selected_index: 6, ..with_tracks(vec![Track::default(); 12]) };
    let window = model.visible_tracks(11);
    assert!(window.end > window.start, "visible_tracks() should return visible rows");
    assert_ne!(window.start, 0, "visible_tracks() should scroll when selection is in the middle");
    assert!(window.hidden_above && window.hidden_below, "should report hidden rows above and below");
}

#[test]
fn view_includes_scrollable_hint() {
    let tracks = ["One", "Two", "Three", "Four", "Five", "Six"]
        .iter()
        .zip(1..)
        .map(|(name, id)| Track { last_played_at: 100, ..named_track(id, name, r#"["A"]"#) })
        .collect();
    let model = Model { width: 80, height: 16, ..with_tracks(tracks) };

    let view = view_text(&model);
    assert!(view.contains("Local track history"), "view = {view}\nwant main header");
    assert!(view.contains("sort: recent"), "view = {view}\nwant sort indicator");
    assert!(view.contains("... 5 more"), "view = {view}\nwant the scroll hint");
}

/// A model with the editor open on a fresh track.
fn open_rating_editor() -> Model {
    let mut model = with_tracks(vec![named_track(1, "One", r#"["A"]"#)]);
    model.update(key(KeyCode::Enter));
    assert!(model.editing_rating && !model.editing_opinion, "editor should open on the stars field");
    model
}

#[test]
fn rating_editor_digits_in_opinion_after_stars() {
    let mut model = open_rating_editor();
    type_text(&mut model, "5");
    assert_eq!((model.draft_stars, model.editing_opinion), (5, true), "want 5 and focus on opinion");

    type_text(&mut model, "Op. 25 No. 1");
    assert_eq!(model.draft_opinion, "Op. 25 No. 1", "want digits kept as text");
    assert_eq!(model.draft_stars, 5, "digits in the opinion should not change stars");
}

#[test]
fn rating_editor_text_on_stars_field_starts_opinion() {
    let mut model = open_rating_editor();
    type_text(&mut model, "7th");
    assert_eq!((model.draft_stars, model.draft_opinion.as_str(), model.editing_opinion), (0, "7th", true));
}

#[test]
fn rating_editor_tab_switches_field() {
    let mut model = open_rating_editor();
    type_text(&mut model, "4Lovely");
    model.update(shift_tab());
    assert!(!model.editing_opinion, "shift+tab should move focus to the stars field");

    type_text(&mut model, "2");
    assert_eq!((model.draft_stars, model.draft_opinion.as_str(), model.editing_opinion), (2, "Lovely", true));

    model.update(key(KeyCode::Tab));
    assert!(!model.editing_opinion, "tab should toggle focus back to the stars field");
}

#[test]
fn rating_editor_backspace_edits_focused_field() {
    let mut model = open_rating_editor();
    type_text(&mut model, "3ab");
    model.update(key(KeyCode::Backspace));
    assert_eq!((model.draft_stars, model.draft_opinion.as_str()), (3, "a"), "backspace deletes from the opinion");

    type_keys(&mut model, [key(KeyCode::Tab), key(KeyCode::Backspace)]);
    assert_eq!((model.draft_stars, model.draft_opinion.as_str()), (0, "a"), "backspace on stars clears stars only");
}

#[test]
fn rating_editor_ctrl_u_clears_opinion_and_ctrl_c_is_ignored() {
    let mut model = open_rating_editor();
    type_text(&mut model, "4 Op. 111");
    assert_eq!(model.draft_opinion, " Op. 111");
    model.update(ctrl('u'));
    assert_eq!((model.draft_stars, model.draft_opinion.as_str()), (4, ""));
    assert!(model.update(ctrl('c')).is_none(), "the Go editor does not quit on ctrl+c");
    assert!(model.editing_rating);
}

#[test]
fn view_shows_rating_editor_focus() {
    let mut model = Model { width: 120, height: 28, ..with_tracks(vec![named_track(1, "One", r#"["A"]"#)]) };
    model.start_rating_editor();
    model.draft_opinion = "Op. 10".into();

    let view = view_text(&model);
    assert!(view.contains("> Stars: not set") && !view.contains("Op. 10_"), "view = {view}\nwant focus on stars");

    type_text(&mut model, "4");
    let view = view_text(&model);
    assert!(
        view.contains("> Opinion:") && view.contains("Stars: 4/5") && view.contains("Op. 10_"),
        "view = {view}\nwant focus marker and cursor on the opinion"
    );
}

#[test]
fn view_shows_rating_editor() {
    let model = Model {
        width: 120,
        height: 28,
        editing_rating: true,
        draft_stars: 5,
        draft_opinion: "Very good".into(),
        ..with_tracks(vec![named_track(1, "One", r#"["A"]"#)])
    };
    let view = view_text(&model);
    assert!(view.contains("Rating Editor"), "view = {view}\nwant rating editor");
    assert!(view.contains("Stars: 5/5"), "view = {view}\nwant draft stars");
    assert!(view.contains("1-5: stars   tab: switch field"), "view = {view}\nwant editor help");
}

#[test]
fn view_fits_small_window_with_status_footer() {
    let model = Model {
        width: 92,
        height: 30,
        status_message: "Sync complete. fetched=10 accepted=10 inserted=0 updated=10".into(),
        ..with_tracks(vec![Track {
            id: 49,
            spotify_id: "4WlRUx1NuFSR1Oc7ksBBIm".into(),
            track_name: "Transcendental Etudes, S. 139: No. 4, Mazeppa - Live".into(),
            artists: r#"["Franz Liszt","Yunchan Lim"]"#.into(),
            album_name: "Live from The Cliburn - Liszt: Transcendental Etudes".into(),
            play_count: 1,
            last_played_at: 1_780_000_000_000_000_000,
            ..Track::default()
        }])
    };
    let height = model.view().height();
    assert!(height <= usize::from(model.height), "view height = {height}, want <= {}", model.height);
    let lines = buffer_lines(&screen(&model));
    assert!(lines.iter().any(|line| line.contains("Sync complete.")), "footer status should be on screen");
}

#[test]
fn load_tracks_cmd_returns_ratings_by_track_id() {
    let db = Arc::new(Db::open_in_memory().unwrap());
    let track = db
        .conn()
        .upsert_track(&UpsertTrackParams {
            spotify_id: "sp-1".into(),
            track_name: "One".into(),
            album_name: "Album".into(),
            artists: r#"["A"]"#.into(),
            last_played_at: 100,
        })
        .unwrap();
    db.conn()
        .upsert_rating(&UpsertRatingParams { track_id: track.id, stars: 4, opinion: "Warm".into(), updated_at: 10 })
        .unwrap();

    let mut model = Model::default();
    let Msg::TracksLoaded(Ok(loaded)) = run_task(&Deps { load: db_loader(db), ..deps() }, model.init()) else {
        panic!("load command should return a successful TracksLoaded");
    };
    assert_eq!(loaded.rows.len(), 1);
    let rating = &loaded.ratings[&track.id];
    assert_eq!((rating.stars, rating.opinion.as_str()), (4, "Warm"));
    assert_eq!(loaded.rows[0].artists, "A", "artists are formatted on the load thread");
}

#[test]
fn search_matches_artists_and_album() {
    let mut model = with_tracks(vec![
        searchable(1, "Etudes", "Ligeti", r#"["Yuja Wang"]"#, 100),
        searchable(2, "Nocturne", "Chopin: Nocturnes", r#"["Frédéric Chopin","Víkingur Ólafsson"]"#, 200),
    ]);

    for query in ["ólafsson", "NOCTURNES", "ligeti"] {
        model.search_query = query.into();
        model.refresh_track_list(0);
        assert_eq!(model.list.len(), 1, "query {query:?}");
    }

    model.search_query = "wang ligeti".into();
    model.refresh_track_list(0);
    assert!(model.list.is_empty(), "a query spanning two fields should not match");
}

#[test]
fn paste_appends_to_search_and_opinion() {
    let mut model = Model {
        searching: true,
        ..with_tracks(vec![
            searchable(1, "Etudes", "Ligeti", r#"["Yuja Wang"]"#, 100),
            searchable(2, "Images", "Debussy", r#"["Seong-Jin Cho"]"#, 200),
        ])
    };

    model.update(Msg::Paste("yuja".into()));
    assert_eq!((model.search_query.as_str(), ids(&model)), ("yuja", vec![1]));

    model.searching = false;
    model.editing_rating = true;
    model.update(Msg::Paste("Op. 111".into()));
    assert_eq!((model.draft_opinion.as_str(), model.draft_stars, model.editing_opinion), ("Op. 111", 0, true));
}

#[test]
fn busy_states_block_navigation_and_show_progress() {
    let mut model = Model { width: 120, height: 28, ..with_tracks(vec![track(1), track(2)]) };
    model.syncing = true;
    for msg in [text_key('j'), text_key('o'), text_key('/'), text_key('s')] {
        assert!(model.update(msg).is_none());
    }
    assert_eq!((model.selected_index, model.searching), (0, false));
    assert!(footer_has_notification_line(&model.footer(), "Syncing with Spotify..."));

    model.syncing = false;
    model.saving_rating = true;
    assert!(model.update(key(KeyCode::Enter)).is_none());
    assert!(!model.editing_rating, "no editor while a save is in flight");
    assert!(footer_has_notification_line(&model.footer(), "Saving rating..."));
    assert!(view_text(&model).contains("Rating: saving..."));

    model.saving_rating = false;
    model.update(text_key('s'));
    assert_eq!((model.status_message.as_str(), model.status_is_error), ("Sync is unavailable in this view.", true));
    assert!(matches!(model.update(text_key('q')), Some(Cmd::Quit)));
}

#[test]
fn panicking_callbacks_report_errors() {
    let sync: SyncFn = Arc::new(|| panic!("token refresh exploded"));
    let mut model = Model { services: Services::ALL, ..with_tracks(vec![track(1)]) };
    let msg = run_task(&Deps { sync, ..deps() }, model.update(text_key('s')));
    model.update(msg);
    assert!(!model.syncing);
    assert_eq!(model.status_message, "Sync failed: panic: token refresh exploded");
}

#[test]
fn key_names_follow_bubble_tea() {
    let name = |code, modifiers| key_press(&KeyEvent::new(code, modifiers)).map(|key| key.name);
    assert_eq!(name(KeyCode::Char('c'), KeyModifiers::CONTROL).as_deref(), Some("ctrl+c"));
    assert_eq!(name(KeyCode::Char('G'), KeyModifiers::SHIFT).as_deref(), Some("G"));
    assert_eq!(name(KeyCode::BackTab, KeyModifiers::SHIFT).as_deref(), Some("shift+tab"));
    assert_eq!(name(KeyCode::Char(' '), KeyModifiers::NONE).as_deref(), Some("space"));
    assert_eq!(name(KeyCode::Char('j'), KeyModifiers::ALT).as_deref(), Some("alt+j"));
    assert_eq!(name(KeyCode::Enter, KeyModifiers::SHIFT).as_deref(), Some("shift+enter"));
    assert_eq!(name(KeyCode::Esc, KeyModifiers::NONE).as_deref(), Some("esc"));
}

// Layouts captured from the Go build (see the module docs).

/// Mirrors the Go golden generator's fixture tracks.
fn golden_tracks(n: usize, long: bool) -> Vec<Track> {
    (0..n)
        .map(|i| Track {
            id: i as i64 + 1,
            spotify_id: format!("sp-{i}"),
            track_name: if long {
                format!("Piano Sonata No. {} in B-flat minor, Op. {}: II. Scherzo – Più lento", i % 32 + 1, i % 120 + 1)
            } else {
                format!("Track {}", i + 1)
            },
            album_name: "Album".into(),
            artists: format!(r#"["Frédéric Chopin","Pianist {i}"]"#),
            play_count: (i % 5 + 1) as i64,
            last_played_at: 1_700_000_000 + i as i64,
            created_at: 0,
        })
        .collect()
}

fn golden_model(width: u16, height: u16, tracks: usize, long: bool) -> Model {
    let mut model = Model { time_zone: TimeZone::UTC, ..Model::default() };
    model.update(Msg::Resize { width, height });
    model.update(loaded(
        golden_tracks(tracks, long),
        vec![Rating {
            track_id: 28,
            stars: 4,
            opinion: "Lyrical and restrained, with a long singing line that goes on and on across the whole movement."
                .into(),
            updated_at: 1_700_000_000,
        }],
    ));
    model
}

fn assert_matches_go(model: &Model, golden: &str) {
    let got = view_text(model);
    let got = got.trim_end_matches('\n');
    let want = golden.trim_end_matches('\n');
    if got != want {
        let diff: Vec<String> = got
            .lines()
            .zip(want.lines())
            .enumerate()
            .filter(|(_, (got, want))| got != want)
            .map(|(index, (got, want))| format!("line {index}\n  got:  {got:?}\n  want: {want:?}"))
            .collect();
        panic!(
            "frame differs from Go ({} vs {} lines)\n{}\n--- got ---\n{got}",
            got.lines().count(),
            want.lines().count(),
            diff.join("\n")
        );
    }
}

#[test]
fn golden_wide_layout_matches_go() {
    let mut model = golden_model(120, 28, 30, false);
    model.selected_index = 15;
    assert_matches_go(&model, include_str!("../../testdata/go_wide_mid.txt"));
    model.selected_index = 2;
    assert_matches_go(&model, include_str!("../../testdata/go_wide_rated.txt"));
}

#[test]
fn golden_narrow_and_tiny_layouts_match_go() {
    let mut model = golden_model(70, 24, 30, true);
    model.selected_index = 10;
    assert_matches_go(&model, include_str!("../../testdata/go_narrow_mid.txt"));
    assert_matches_go(&golden_model(30, 10, 5, false), include_str!("../../testdata/go_tiny.txt"));
}

#[test]
fn golden_large_list_matches_go() {
    let mut model = golden_model(160, 48, 300, true);
    model.selected_index = 150;
    assert_matches_go(&model, include_str!("../../testdata/go_big_mid.txt"));
}

#[test]
fn golden_editor_search_and_status_match_go() {
    let mut model = golden_model(120, 28, 5, false);
    model.start_rating_editor();
    model.draft_opinion = "Op. 10".into();
    type_text(&mut model, "4");
    assert_matches_go(&model, include_str!("../../testdata/go_editor_opinion.txt"));

    let mut model = golden_model(120, 28, 5, false);
    model.searching = true;
    type_text(&mut model, "track 3");
    assert_matches_go(&model, include_str!("../../testdata/go_searching.txt"));

    let mut model = golden_model(100, 30, 5, false);
    set_error(&mut model, "Sync failed: bad token");
    assert_matches_go(&model, include_str!("../../testdata/go_status_err.txt"));
}

#[test]
fn styles_match_lip_gloss() {
    let mut model = golden_model(120, 28, 5, false);
    let buffer = screen(&model);
    let modifiers = |x: u16, y: u16| buffer[(x, y)].modifier;
    assert!(modifiers(1, 1).contains(Modifier::BOLD), "title is bold");
    assert!(modifiers(1, 2).contains(Modifier::DIM), "subtitle is faint");
    assert_eq!(buffer[(1, 4)].symbol(), "╭", "panes use rounded borders");
    // The selected row is reversed including its one-cell padding.
    assert!(modifiers(3, 9).contains(Modifier::REVERSED));
    assert!(modifiers(15, 9).contains(Modifier::REVERSED));
    assert!(!modifiers(16, 9).contains(Modifier::REVERSED));
    assert!(modifiers(5, 10).contains(Modifier::REVERSED | Modifier::DIM), "selected subtitle is faint and reversed");
    assert!(buffer_lines(&buffer)[26].starts_with(" j/k or arrows: move"), "footer sits above the bottom margin");
    assert!(modifiers(1, 26).contains(Modifier::DIM), "footer is faint");

    model.start_rating_editor();
    let buffer = screen(&model);
    assert_eq!(buffer[(45, 11)].symbol(), ">");
    assert!(buffer[(45, 11)].modifier.contains(Modifier::BOLD), "the focused field is highlighted");
}

#[test]
fn golden_long_status_wraps_like_go() {
    let mut model = golden_model(70, 24, 30, false);
    set_error(
        &mut model,
        "Sync failed: spotify: HTTP 503: upstream connect error or disconnect/reset before headers. reset reason: \
         connection_termination_and_a_very_long_unbroken_token_that_must_split",
    );
    assert_matches_go(&model, include_str!("../../testdata/go_status_long.txt"));
}

/// Guards the footer: every frame must fit the window, at every scroll
/// position, with the key help on its last lines.
#[test]
fn view_fits_window_at_every_size() {
    type Setup = fn(&mut Model);
    let states: [(&str, Setup); 4] = [
        ("browsing", |_| {}),
        ("editing", |model| {
            model.start_rating_editor();
            model.draft_opinion = "lyrical ".repeat(40);
        }),
        ("searching", |model| model.searching = true),
        ("long error", |model| {
            set_error(model, format!("Sync failed: {}", "spotify: HTTP 503 upstream unavailable ".repeat(6)))
        }),
    ];
    for (name, setup) in states {
        for width in [50, 60, 80, 89, 90, 100, 120, 160] {
            for height in [16, 20, 24, 30, 48] {
                for selected in [0, 1, 7, 20, 38, 39] {
                    let mut model = golden_model(width, height, 40, true);
                    model.selected_index = selected;
                    setup(&mut model);

                    let frame = view_text(&model);
                    let lines: Vec<&str> = frame.lines().collect();
                    let size = format!("{name} {width}x{height} sel={selected}");
                    assert!(model.view().height() <= usize::from(height), "{size}: frame too tall:\n{frame}");
                    for line in &lines {
                        assert!(crate::text::width(line) <= usize::from(width), "{size}: line too wide: {line:?}");
                    }
                    let footer = model.footer();
                    let last_hint = footer.lines().last().unwrap().trim();
                    assert!(frame.contains(last_hint), "{size}: footer {last_hint:?} missing:\n{frame}");
                }
            }
        }
    }
}

#[test]
fn visible_tracks_leaves_room_for_scroll_hints() {
    let mut model = golden_model(100, 30, 30, false);
    for height in 5..=40 {
        for selected in 0..30 {
            model.selected_index = selected;
            let window = model.visible_tracks(height);
            let lines = 3
                + 2 * (window.end - window.start)
                + usize::from(window.hidden_above)
                + usize::from(window.hidden_below);
            assert!(lines <= height.max(3 + 2 + 2), "height={height} selected={selected}: list needs {lines} lines");
        }
    }
}

#[test]
fn footer_wraps_hints_to_width() {
    let mut model = Model::default();
    model.update(Msg::Resize { width: 50, height: 30 });
    let footer = model.footer();
    assert!(footer.lines().all(|line| crate::text::width(line) <= 48), "footer = {footer:?}");
    assert!(
        footer.contains("j/k or arrows: move") && footer.contains("q: quit"),
        "footer = {footer:?}, want whole hints"
    );
}

#[test]
fn view_drops_body_when_window_has_no_room_for_it() {
    let model = golden_model(30, 10, 1, false);
    assert!(model.view().height() <= 10, "{}", view_text(&model));
    assert!(view_text(&model).contains("q: quit"));

    // Degenerate sizes must still render without panicking.
    let mut model = golden_model(120, 28, 30, false);
    for (width, height) in [(1, 1), (10, 3), (30, 10), (41, 12), (89, 20), (300, 5)] {
        model.update(Msg::Resize { width, height });
        assert_eq!(buffer_lines(&screen(&model)).len(), usize::from(height), "{width}x{height}");
    }
}

#[test]
fn hard_wrap_matches_go_ansi_wrap() {
    use crate::text::hard_wrap;
    // Expected values from x/ansi.Wrap(s, limit, "") in the Go build.
    assert_eq!(hard_wrap("hello world foo", 11), "hello world\nfoo");
    assert_eq!(hard_wrap("abcdefghij", 4), "abcd\nefgh\nij");
    assert_eq!(hard_wrap("well-known phrase", 6), "well-\nknown\nphrase");
    assert_eq!(hard_wrap("short", 40), "short");
    assert_eq!(hard_wrap("Più lento è bello", 8), "Più\nlento è\nbello");
}
