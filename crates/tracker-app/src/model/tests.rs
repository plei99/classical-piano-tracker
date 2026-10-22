//! The pointer intents and the command protocol. The keyboard behavior is
//! covered by the terminal UI's ports of the Go tests (tracker-tui).

use anyhow::anyhow;

use super::*;

pub(crate) fn tracks() -> Vec<Track> {
    (1..=3)
        .map(|id| Track {
            id,
            spotify_id: format!("sp{id}"),
            track_name: format!("Track {id}"),
            album_name: format!("Album {id}"),
            artists: format!(r#"["Pianist {id}"]"#),
            play_count: id,
            last_played_at: 100 - id,
            created_at: 1,
        })
        .collect()
}

/// A model with three tracks loaded (ordered 1, 2, 3) and timestamps in UTC.
pub(crate) fn loaded() -> Model {
    let mut model = Model { time_zone: Zone::Tz(TimeZone::UTC), ..Model::new(Services::ALL) };
    model.update(Msg::TracksLoaded(Ok(TracksLoaded::new(tracks(), Vec::new()))));
    model
}

fn ids(model: &Model) -> Vec<i64> {
    model.visible_rows().map(|row| row.track.id).collect()
}

#[test]
fn commands_are_data() {
    let mut model = Model::new(Services::ALL);
    assert!(model.loading_tracks);
    assert_eq!(model.init(), Some(Cmd::LoadTracks));

    let mut model = loaded();
    assert_eq!(model.update(Msg::Key(KeyPress::typed('s'))), Some(Cmd::Sync));
    assert_eq!(model.update(Msg::SyncFinished(Ok(SyncStats::default()))), Some(Cmd::LoadTracks));
    assert_eq!(model.update(Msg::Key(KeyPress::typed('r'))), Some(Cmd::LoadTracks));
    model.update(Msg::TracksLoaded(Ok(TracksLoaded::new(tracks(), Vec::new()))));
    assert_eq!(model.update(Msg::Key(KeyPress::typed('q'))), Some(Cmd::Quit));

    model.update(Msg::Key(KeyPress::typed('e')));
    model.update(Msg::Key(KeyPress::typed('4')));
    for c in " Op. 9 ".chars() {
        model.update(Msg::Key(KeyPress::typed(c)));
    }
    let Some(Cmd::SaveRating(params)) = model.update(Msg::Key(KeyPress::named("enter"))) else {
        panic!("enter should save the rating");
    };
    assert_eq!((params.track_id, params.stars, params.opinion.as_str()), (1, 4, "Op. 9"));
    assert!(params.updated_at > 1_700_000_000, "saves are stamped with the current time");
    assert!(model.saving_rating);
}

#[test]
fn select_moves_to_a_track_by_id_and_ignores_unknown_ids() {
    let mut model = loaded();
    model.status_message = "old".into();
    assert!(model.update(Msg::Select { track_id: 3 }).is_none());
    assert_eq!(model.selected_index, 2);
    assert_eq!(model.status_message, "", "moving clears the status, like the keys");
    model.update(Msg::Select { track_id: 99 });
    assert_eq!(model.selected_index, 2);
}

#[test]
fn select_is_ignored_while_busy_or_editing() {
    for (syncing, saving_rating) in [(true, false), (false, true)] {
        let mut model = Model { syncing, saving_rating, ..loaded() };
        model.update(Msg::Select { track_id: 2 });
        assert_eq!(model.selected_index, 0);
    }
    let mut model = loaded();
    model.start_rating_editor();
    model.update(Msg::Select { track_id: 2 });
    assert_eq!(model.selected_index, 0);
}

#[test]
fn set_search_filters_and_keeps_a_matching_selection() {
    let mut model = loaded();
    model.update(Msg::Select { track_id: 2 });
    model.update(Msg::SetSearch("track 2".into()));
    assert_eq!(ids(&model), vec![2]);
    assert_eq!(model.selected_index, 0);
    assert_eq!(model.selected_track_id(), 2);

    model.update(Msg::SetSearch(String::new()));
    assert_eq!(ids(&model), vec![1, 2, 3]);
    assert_eq!(model.selected_track_id(), 2);

    let mut busy = Model { syncing: true, ..loaded() };
    busy.update(Msg::SetSearch("track 2".into()));
    assert_eq!(busy.search_query, "");
}

#[test]
fn editor_fields_only_change_while_editing() {
    let mut model = loaded();
    model.update(Msg::SetDraftStars(3));
    model.update(Msg::SetDraftOpinion("ignored".into()));
    model.update(Msg::FocusField(EditorField::Opinion));
    assert_eq!((model.draft_stars, model.draft_opinion.as_str(), model.editing_opinion), (0, "", false));

    model.start_rating_editor();
    model.update(Msg::SetDraftStars(4));
    assert_eq!(model.draft_stars, 4);
    model.update(Msg::SetDraftStars(6));
    model.update(Msg::SetDraftStars(-1));
    assert_eq!(model.draft_stars, 4, "stars stay within 0-5");
    model.update(Msg::SetDraftStars(0));
    assert_eq!(model.draft_stars, 0);

    model.update(Msg::SetDraftOpinion("Op. 9".into()));
    assert_eq!((model.draft_opinion.as_str(), model.editing_opinion), ("Op. 9", true));
    model.update(Msg::FocusField(EditorField::Stars));
    assert!(!model.editing_opinion);
    model.update(Msg::FocusField(EditorField::Opinion));
    assert!(model.editing_opinion);
}

#[test]
fn failures_come_back_as_messages() {
    let mut model = Model { syncing: true, ..loaded() };
    model.update(Msg::SyncFinished(Err(anyhow!("spotify login required"))));
    assert_eq!(model.status_message, "Sync failed: spotify login required");

    let mut model = Model { loading_tracks: true, ..Model::default() };
    model.update(Msg::TracksLoaded(Err(anyhow!("locked").context("list tracks"))));
    assert_eq!(model.err.as_deref(), Some("list tracks: locked"));
}

#[test]
fn format_time_matches_strftime() {
    let zones = [
        TimeZone::UTC,
        TimeZone::fixed(jiff::tz::offset(9)),
        TimeZone::fixed(jiff::tz::Offset::from_seconds(-(3 * 3600 + 30 * 60)).unwrap()),
        // Local mean time offsets have seconds.
        TimeZone::fixed(jiff::tz::Offset::from_seconds(17 * 60 + 30).unwrap()),
        TimeZone::get("America/New_York").unwrap(),
    ];
    let seconds = [
        Timestamp::MIN.as_second() + 86_400,
        -62_135_596_800,
        -1,
        0,
        1_700_000_000,
        1_783_000_000,
        Timestamp::MAX.as_second() - 86_400,
    ];
    for zone in zones {
        let model = Model { time_zone: Zone::Tz(zone.clone()), ..Model::new(Services::ALL) };
        for second in seconds {
            let zoned = Timestamp::from_second(second).unwrap().to_zoned(zone.clone());
            let want = if zoned.offset().seconds() == 0 {
                zoned.strftime("%Y-%m-%dT%H:%M:%SZ").to_string()
            } else {
                zoned.strftime("%Y-%m-%dT%H:%M:%S%:z").to_string()
            };
            assert_eq!(model.format_time(second), want, "{second} in {zone:?}");
        }
    }
    let browser = Model { time_zone: Zone::Offset(|_| -(4 * 3600)), ..Model::new(Services::ALL) };
    assert_eq!(browser.format_time(0), "1969-12-31T20:00:00-04:00");
}
