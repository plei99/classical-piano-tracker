//! `tracker show`: print one local track and its rating.

use anyhow::{Context, Result, anyhow};
use clap::Args;
use tracker_core::db::Queries;
use tracker_core::{Db, artists};

use super::timefmt::local_rfc3339;
use super::{Io, RootOptions, parse_positive_i64};

#[derive(Debug, Args)]
pub(crate) struct ShowArgs {
    // Parsed by hand so invalid IDs get the shared positive-integer message.
    #[arg(value_name = "track-id")]
    track_id: String,
}

pub(crate) fn run(args: &ShowArgs, opts: &RootOptions, io: &mut Io<'_>) -> Result<()> {
    let track_id = parse_positive_i64(&args.track_id, "track ID")?;
    let db = Db::open(&opts.resolve_db_path()?)?;
    let conn = db.conn();

    let track = conn
        .track_by_id(track_id)
        .with_context(|| format!("lookup track {track_id}"))?
        .ok_or_else(|| anyhow!("track {track_id} not found"))?;

    let out = &mut *io.out;
    writeln!(out, "id: {}", track.id)?;
    writeln!(out, "spotify_id: {}", track.spotify_id)?;
    writeln!(out, "title: {}", track.track_name)?;
    writeln!(out, "album: {}", track.album_name)?;
    writeln!(out, "artists: {}", artists::format(&track.artists))?;
    writeln!(out, "play_count: {}", track.play_count)?;
    writeln!(out, "last_played_at: {}", local_rfc3339(track.last_played_at))?;

    match conn.rating_by_track_id(track.id).with_context(|| format!("lookup rating for track {}", track.id))? {
        Some(rating) => {
            writeln!(out, "rating_stars: {}", rating.stars)?;
            if !rating.opinion.is_empty() {
                writeln!(out, "rating_opinion: {}", rating.opinion)?;
            }
            writeln!(out, "rating_updated_at: {}", local_rfc3339(rating.updated_at))?;
        }
        None => writeln!(out, "rating: none")?,
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use tracker_core::db::Queries;
    use tracker_core::{Db, UpsertRatingParams, UpsertTrackParams};

    use super::super::testutil::{path_str, run, temp_path};
    use super::super::timefmt::local_rfc3339;

    #[test]
    fn show_prints_track_and_rating() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = temp_path(&dir, "tracker.db");
        let db = Db::open(&db_path).unwrap();
        let track = db
            .conn()
            .upsert_track(&UpsertTrackParams {
                spotify_id: "sp-1".into(),
                track_name: "Scarbo".into(),
                album_name: "Ravel".into(),
                artists: r#"["Martha Argerich"]"#.into(),
                last_played_at: 1_775_226_600,
            })
            .unwrap();

        let (result, out) = run(&["--db", path_str(&db_path), "show", "1"]);
        result.unwrap();
        assert_eq!(
            out,
            format!(
                "id: 1\nspotify_id: sp-1\ntitle: Scarbo\nalbum: Ravel\nartists: Martha Argerich\nplay_count: 1\n\
                 last_played_at: {}\nrating: none\n",
                local_rfc3339(1_775_226_600)
            )
        );

        db.conn()
            .upsert_rating(&UpsertRatingParams {
                track_id: track.id,
                stars: 4,
                opinion: "Fiery".into(),
                updated_at: 1_775_226_700,
            })
            .unwrap();
        let (result, out) = run(&["--db", path_str(&db_path), "show", "1"]);
        result.unwrap();
        assert!(
            out.ends_with(&format!(
                "rating_stars: 4\nrating_opinion: Fiery\nrating_updated_at: {}\n",
                local_rfc3339(1_775_226_700)
            )),
            "{out}"
        );

        let (result, _) = run(&["--db", path_str(&db_path), "show", "2"]);
        assert_eq!(result.unwrap_err().to_string(), "track 2 not found");
        let (result, _) = run(&["--db", path_str(&db_path), "show", "zero"]);
        assert_eq!(result.unwrap_err().to_string(), "track ID must be a positive integer, got \"zero\"");
    }
}
