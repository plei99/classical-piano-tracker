//! Human-oriented output blocks shared by the recommend and spotify commands.

use std::fmt::Write as _;
use std::io::{self, Write};

use tracker_recommend::{PianistProfile, TasteSummary, TasteTrack, ValidatedPianist};
use tracker_spotify::RecentTrack;

use super::Io;
use super::tabwriter::TabWriter;

pub const FALLBACK_OUTPUT_WIDTH: usize = 100;
const MIN_OUTPUT_WIDTH: usize = 40;

/// Renders recent plays as a human-scannable block per track. Spotify reports
/// play times in UTC, and the Go build printed them in that zone.
pub fn print_recent_spotify_tracks(out: &mut dyn Write, tracks: &[RecentTrack]) -> io::Result<()> {
    for (idx, track) in tracks.iter().enumerate() {
        writeln!(out, "{}. {}", idx + 1, track.name)?;
        writeln!(out, "   Artists: {}", track.artist_names().join(", "))?;
        if !track.album_name.trim().is_empty() {
            writeln!(out, "   Album:   {}", track.album_name)?;
        }
        writeln!(out, "   Played:  {}", track.played_at.strftime("%Y-%m-%d %H:%M:%S"))?;
        if idx + 1 < tracks.len() {
            writeln!(out)?;
        }
    }
    Ok(())
}

/// Renders deterministic pianist scores as a compact aligned table.
pub fn print_favorite_pianists(out: &mut dyn Write, profiles: &[PianistProfile]) -> io::Result<()> {
    let mut table = TabWriter::new();
    // Writing into the in-memory buffer cannot fail.
    let _ = writeln!(table, "#\tPianist\tScore\tAvg Stars\tRated Tracks\tTotal Plays");
    for (idx, profile) in profiles.iter().enumerate() {
        let _ = writeln!(
            table,
            "{}\t{}\t{:.2}\t{:.2}\t{}\t{}",
            idx + 1,
            profile.name,
            profile.favorite_score,
            profile.average_stars,
            profile.rated_track_count,
            profile.total_play_count,
        );
    }
    table.flush(out)
}

/// Renders the profile snapshot sent to the LLM, leaving out the internal
/// discovery-guidance prompt text.
pub fn print_taste_profile(out: &mut dyn Write, summary: &TasteSummary, width: usize) -> io::Result<()> {
    write!(
        out,
        "Tracks: {}\nRatings: {}\nComments: {}\nKnown Pianists: {}\n\n",
        summary.total_tracks,
        summary.total_ratings,
        summary.comment_count,
        summary.known_pianists.len(),
    )?;

    writeln!(out, "Favorite Pianists")?;
    if summary.favorite_pianists.is_empty() {
        writeln!(out, "  none")?;
    } else {
        let mut table = TabWriter::new();
        let _ = writeln!(table, "  #\tPianist\tAvg Stars\tRated Tracks\tTotal Plays");
        for (idx, pianist) in summary.favorite_pianists.iter().enumerate() {
            let _ = writeln!(
                table,
                "  {}\t{}\t{:.2}\t{}\t{}",
                idx + 1,
                pianist.name,
                pianist.average_stars,
                pianist.rated_track_count,
                pianist.total_play_count,
            );
        }
        table.flush(out)?;
    }

    writeln!(out)?;
    print_taste_tracks(out, "Loved Tracks", &summary.loved_tracks, width)?;
    writeln!(out)?;
    print_taste_tracks(out, "Disliked Tracks", &summary.disliked_tracks, width)?;
    writeln!(out)?;
    print_taste_tracks(out, "Commented Tracks", &summary.commented_tracks, width)?;
    writeln!(out)?;
    print_wrapped_field(out, "Known Pianists: ", "                ", &summary.known_pianists.join(", "), width)
}

fn print_taste_tracks(out: &mut dyn Write, heading: &str, tracks: &[TasteTrack], width: usize) -> io::Result<()> {
    writeln!(out, "{heading}")?;
    if tracks.is_empty() {
        return writeln!(out, "  none");
    }

    const NEXT: &str = "              ";
    for (idx, track) in tracks.iter().enumerate() {
        writeln!(out, "  {}. [{}] {}", idx + 1, track.track_id, track.track_name)?;
        print_wrapped_field(out, "     Artists: ", NEXT, &track.artists.join(", "), width)?;
        if !track.matched_artist.trim().is_empty() {
            writeln!(out, "     Matched: {}", track.matched_artist)?;
        }
        if !track.album_name.trim().is_empty() {
            print_wrapped_field(out, "     Album:   ", NEXT, &track.album_name, width)?;
        }
        writeln!(out, "     Stars:   {}/5", track.stars)?;
        writeln!(out, "     Plays:   {}", track.play_count)?;
        if !track.opinion.trim().is_empty() {
            print_wrapped_field(out, "     Opinion: ", NEXT, &track.opinion, width)?;
        }
        if idx + 1 < tracks.len() {
            writeln!(out)?;
        }
    }
    Ok(())
}

/// Renders the validated subset of LLM suggestions after the Spotify catalog
/// lookup has attached IDs and genres.
pub fn print_validated_pianists(
    out: &mut dyn Write,
    summary: &str,
    pianists: &[ValidatedPianist],
    width: usize,
) -> io::Result<()> {
    const NEXT: &str = "               ";
    print_wrapped_field(out, "Summary: ", "", summary, width)?;
    writeln!(out)?;
    for (idx, pianist) in pianists.iter().enumerate() {
        let suggestion = &pianist.suggestion;
        writeln!(out, "{}. {}", idx + 1, pianist.spotify_name)?;
        writeln!(out, "   Spotify ID: {}", pianist.spotify_id)?;
        if !pianist.genres.is_empty() {
            print_wrapped_field(out, "   Genres:     ", NEXT, &pianist.genres.join(", "), width)?;
        }
        if !suggestion.similar_to.is_empty() {
            print_wrapped_field(out, "   Similar to: ", NEXT, &suggestion.similar_to.join(", "), width)?;
        }
        print_wrapped_field(out, "   Why:        ", NEXT, &suggestion.why_fit, width)?;
        if !suggestion.confidence.trim().is_empty() {
            writeln!(out, "   Confidence: {}", suggestion.confidence)?;
        }
        if idx + 1 < pianists.len() {
            writeln!(out)?;
        }
    }
    Ok(())
}

/// The wrap width: the terminal's width when writing to one, else $COLUMNS,
/// else 100. Widths under 40 are ignored as implausible.
pub fn output_width(io: &Io<'_>) -> usize {
    let terminal = if io.out_is_terminal { crossterm::terminal::size().ok().map(|(cols, _)| cols) } else { None };
    resolve_output_width(terminal, std::env::var("COLUMNS").ok().as_deref())
}

fn resolve_output_width(terminal: Option<u16>, columns: Option<&str>) -> usize {
    if let Some(width) = terminal.map(usize::from).filter(|&width| width >= MIN_OUTPUT_WIDTH) {
        return width;
    }
    if let Some(width) = columns.and_then(|raw| raw.trim().parse::<usize>().ok()).filter(|&w| w >= MIN_OUTPUT_WIDTH) {
        return width;
    }
    FALLBACK_OUTPUT_WIDTH
}

/// Word-wraps `value` (whitespace collapsed) to `width` runes, starting with
/// `first_prefix` and continuing with `next_prefix`. Lines always leave room
/// for at least 20 runes of text, and a single long word is never split.
pub fn print_wrapped_field(
    out: &mut dyn Write,
    first_prefix: &str,
    next_prefix: &str,
    value: &str,
    width: usize,
) -> io::Result<()> {
    let mut words = value.split_whitespace().peekable();
    if words.peek().is_none() {
        return writeln!(out, "{}", first_prefix.trim_end_matches(' '));
    }

    let available_after = |prefix: &str| 20.max(width.saturating_sub(prefix.chars().count()));
    let mut line_prefix = first_prefix;
    let mut available = available_after(line_prefix);
    let mut current = String::new();
    let mut current_len = 0;

    for word in words {
        let word_len = word.chars().count();
        if current.is_empty() {
            current.push_str(word);
            current_len = word_len;
            continue;
        }
        if current_len + 1 + word_len <= available {
            current.push(' ');
            current.push_str(word);
            current_len += 1 + word_len;
            continue;
        }

        writeln!(out, "{line_prefix}{current}")?;
        line_prefix = next_prefix;
        available = available_after(line_prefix);
        current.clear();
        current.push_str(word);
        current_len = word_len;
    }

    if !current.is_empty() {
        writeln!(out, "{line_prefix}{current}")?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use tracker_recommend::{FavoritePianist, SuggestedPianist};
    use tracker_spotify::Artist;

    use super::*;

    fn render(f: impl FnOnce(&mut Vec<u8>) -> io::Result<()>) -> String {
        let mut out = Vec::new();
        f(&mut out).unwrap();
        String::from_utf8(out).unwrap()
    }

    fn assert_contains_all(output: &str, wants: &[&str]) {
        for want in wants {
            assert!(output.contains(want), "output = {output:?}, want {want:?}");
        }
    }

    #[test]
    fn print_recent_spotify_tracks_renders_blocks() {
        let output = render(|out| {
            print_recent_spotify_tracks(
                out,
                &[RecentTrack {
                    spotify_id: String::new(),
                    name: "Piano Concerto No. 1".into(),
                    album_name: "Album One".into(),
                    artists: vec![Artist { id: String::new(), name: "Martha Argerich".into() }],
                    duration_ms: 0,
                    played_at: "2026-04-01T12:30:00Z".parse().unwrap(),
                }],
            )
        });
        assert_contains_all(
            &output,
            &[
                "1. Piano Concerto No. 1",
                "Artists: Martha Argerich",
                "Album:   Album One",
                "Played:  2026-04-01 12:30:00",
            ],
        );
    }

    #[test]
    fn print_favorite_pianists_renders_table() {
        let output = render(|out| {
            print_favorite_pianists(
                out,
                &[PianistProfile {
                    name: "Martha Argerich".into(),
                    favorite_score: 98.42,
                    average_stars: 4.75,
                    rated_track_count: 4,
                    total_play_count: 12,
                    ..PianistProfile::default()
                }],
            )
        });
        assert_contains_all(&output, &["#", "Pianist", "Martha Argerich", "98.42", "4.75", "12"]);
        assert_eq!(
            output,
            "#  Pianist          Score  Avg Stars  Rated Tracks  Total Plays\n\
             1  Martha Argerich  98.42  4.75       4             12\n"
        );
    }

    #[test]
    fn print_taste_profile_renders_sections() {
        let summary = TasteSummary {
            total_tracks: 12,
            total_ratings: 4,
            comment_count: 2,
            favorite_pianists: vec![FavoritePianist {
                name: "Martha Argerich".into(),
                rated_track_count: 3,
                total_play_count: 9,
                average_stars: 4.67,
                ..FavoritePianist::default()
            }],
            loved_tracks: vec![TasteTrack {
                track_id: 42,
                track_name: "Gaspard de la nuit: Scarbo".into(),
                album_name: "Ravel".into(),
                artists: vec!["Martha Argerich".into()],
                play_count: 5,
                stars: 5,
                opinion: "Electrifying and rhythmically alive.".into(),
                matched_artist: "Martha Argerich".into(),
                ..TasteTrack::default()
            }],
            known_pianists: vec!["Martha Argerich".into(), "Yuja Wang".into()],
            discovery_guidance:
                "Recommend real classical concert pianists not already present in the known pianist list.".into(),
            ..TasteSummary::default()
        };
        let output = render(|out| print_taste_profile(out, &summary, FALLBACK_OUTPUT_WIDTH));
        assert_contains_all(
            &output,
            &[
                "Tracks: 12",
                "Ratings: 4",
                "Comments: 2",
                "Known Pianists: 2",
                "Favorite Pianists",
                "Martha Argerich",
                "Loved Tracks",
                "[42] Gaspard de la nuit: Scarbo",
                "Matched: Martha Argerich",
                "Opinion: Electrifying and rhythmically alive.",
                "Disliked Tracks",
                "Commented Tracks",
                "Known Pianists: Martha Argerich, Yuja Wang",
            ],
        );
        assert!(!output.contains("Discovery Guidance:"), "output = {output:?}, did not expect discovery guidance");
    }

    #[test]
    fn print_validated_pianists_renders_fields() {
        let output = render(|out| {
            print_validated_pianists(
                out,
                "You like fire and lyricism.",
                &[ValidatedPianist {
                    suggestion: SuggestedPianist {
                        pianist_name: "Radu Lupu".into(),
                        why_fit: "Poetic contrast to your current favorites.".into(),
                        similar_to: vec!["Martha Argerich".into()],
                        confidence: "medium".into(),
                    },
                    spotify_name: "Radu Lupu".into(),
                    spotify_id: "artist-1".into(),
                    genres: vec!["classical piano".into()],
                    ..ValidatedPianist::default()
                }],
                FALLBACK_OUTPUT_WIDTH,
            )
        });
        assert_contains_all(
            &output,
            &[
                "Summary: You like fire and lyricism.",
                "1. Radu Lupu",
                "Spotify ID: artist-1",
                "Genres:     classical piano",
                "Similar to: Martha Argerich",
                "Why:        Poetic contrast to your current favorites.",
                "Confidence: medium",
            ],
        );
        assert!(!output.contains("Popularity:"), "output = {output:?}, did not expect popularity field");
    }

    #[test]
    fn print_validated_pianists_wraps_long_text() {
        let output = render(|out| {
            print_validated_pianists(
                out,
                "Your taste centers on modern virtuoso pianism with exceptional clarity, control, and intelligence \
                 across large-scale Romantic and modern repertoire.",
                &[ValidatedPianist {
                    suggestion: SuggestedPianist {
                        pianist_name: "Arcadi Volodos".into(),
                        why_fit: "Your profile strongly favors dazzling technique that stays musically controlled, \
                                  with enough tonal imagination and rhythmic command to keep complex repertoire \
                                  coherent."
                            .into(),
                        similar_to: vec!["Yuja Wang".into(), "Martha Argerich".into(), "Yunchan Lim".into()],
                        confidence: "high".into(),
                    },
                    spotify_name: "Arcadi Volodos".into(),
                    spotify_id: "artist-1".into(),
                    ..ValidatedPianist::default()
                }],
                FALLBACK_OUTPUT_WIDTH,
            )
        });
        for line in output.trim_end_matches('\n').split('\n') {
            assert!(line.len() <= FALLBACK_OUTPUT_WIDTH, "line length = {}, want <= 100: {line:?}", line.len());
        }
        assert!(output.lines().count() > 6, "expected wrapped continuation lines: {output}");
    }

    #[test]
    fn wrapped_field_handles_blank_values_and_long_words() {
        let output = render(|out| print_wrapped_field(out, "Summary: ", "", "   ", 100));
        assert_eq!(output, "Summary:\n");

        let long_word = "x".repeat(60);
        let output = render(|out| print_wrapped_field(out, "A: ", "   ", &format!("{long_word} {long_word}"), 50));
        assert_eq!(output, format!("A: {long_word}\n   {long_word}\n"));
    }

    #[test]
    fn output_width_prefers_terminal_then_columns() {
        assert_eq!(resolve_output_width(Some(120), Some("80")), 120);
        assert_eq!(resolve_output_width(Some(30), Some("80")), 80);
        assert_eq!(resolve_output_width(None, Some(" 90 ")), 90);
        assert_eq!(resolve_output_width(None, Some("39")), FALLBACK_OUTPUT_WIDTH);
        assert_eq!(resolve_output_width(None, Some("wide")), FALLBACK_OUTPUT_WIDTH);
        assert_eq!(resolve_output_width(None, None), FALLBACK_OUTPUT_WIDTH);
    }
}
