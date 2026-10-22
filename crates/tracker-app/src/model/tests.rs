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
}
