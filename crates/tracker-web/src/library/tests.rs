use std::collections::HashMap;

use tracker_app::list::{LocalTracks, Refresh, TrackList};

use super::*;

/// Tracks with ties in every sort key, odd text, and a few ratings.
fn tracks() -> (Vec<Track>, Vec<Rating>) {
    let pianists = ["Martha Argerich", "Víkingur Ólafsson", "Yuja Wang", "Seong-Jin Cho"];
    let tracks: Vec<Track> = (1..=60)
        .map(|id| Track {
            id,
            spotify_id: format!("sp{id:02}"),
            track_name: format!("{} No. {}", if id % 3 == 0 { "Nocturne" } else { "Étude" }, id % 7),
            album_name: format!("Album {}", id % 5),
            artists: format!(r#"["Frédéric Chopin","{}"]"#, pianists[id as usize % pianists.len()]),
            play_count: id % 4,
            last_played_at: 1_000 + (id * 37) % 11,
            created_at: 0,
        })
        .collect();
    let ratings = (1..=60)
        .filter(|id| id % 5 == 0)
        .map(|track_id| Rating { track_id, stars: track_id % 5 + 1, opinion: "fine".into(), updated_at: 9 })
        .collect();
    (tracks, ratings)
}

fn no_art(ids: &[&str]) -> Vec<Option<Option<Artwork>>> {
    vec![None; ids.len()]
}

fn query(sort: SortMode, query: &str, offset: usize, limit: usize, around: Option<i64>) -> ViewQuery {
    ViewQuery { sort, query: query.into(), offset, limit, around }
}

/// What the terminal UI shows for this order and query.
fn terminal_ids(sort: SortMode, search: &str) -> Vec<i64> {
    let (tracks, ratings) = tracks();
    let loaded = TracksLoaded::new(tracks, ratings);
    let ratings: HashMap<i64, Rating> = loaded.ratings;
    let mut list = LocalTracks::new(loaded.rows, ratings);
    assert!(matches!(list.refresh(sort, search, 0), Refresh::Done(_)));
    (0..list.len()).map(|index| list.row(index).unwrap().track.id).collect()
}

#[test]
fn orders_and_matches_exactly_as_the_terminal_does() {
    let (tracks, ratings) = tracks();
    let library = Library::new(1, tracks, ratings);
    for sort in SortMode::ALL {
        for search in
            ["", "  NOCTURNE ", "ólafsson", "album 3", "chopin, yuja", "étude no. 2", "zzz", "nocturne\0album"]
        {
            let view = library.view(&query(sort, search, 0, MAX_VIEW_LIMIT, None), &no_art);
            let ids: Vec<i64> = view.rows.iter().map(|row| row.track.id).collect();
            assert_eq!(ids, terminal_ids(sort, search), "{sort:?} {search:?}");
            assert_eq!((view.matched, view.total), (ids.len(), 60));
        }
    }
}

#[test]
fn windows_with_offsets_and_around() {
    let (tracks, ratings) = tracks();
    let library = Library::new(4, tracks, ratings);
    let all = terminal_ids(SortMode::IdAsc, "");
    let view = library.view(&query(SortMode::IdAsc, "", 10, 5, None), &no_art);
    assert_eq!((view.version, view.offset, view.index), (4, 10, None));
    assert_eq!(view.rows.iter().map(|row| row.track.id).collect::<Vec<_>>(), all[10..15]);
    assert_eq!(view.rows[0].artists, "Frédéric Chopin, Seong-Jin Cho");
    assert!(library.view(&query(SortMode::IdAsc, "", 70, 5, None), &no_art).rows.is_empty());

    // Centered on the track, offset ignored.
    let view = library.view(&query(SortMode::IdAsc, "", 0, 10, Some(30)), &no_art);
    assert_eq!((view.offset, view.index), (24, Some(29)));
    // Clamped at either end.
    let view = library.view(&query(SortMode::IdAsc, "", 0, 10, Some(2)), &no_art);
    assert_eq!((view.offset, view.index), (0, Some(1)));
    let view = library.view(&query(SortMode::IdAsc, "", 0, 10, Some(59)), &no_art);
    assert_eq!((view.offset, view.index, view.rows.len()), (50, Some(58), 10));
    // Not matched: the offset applies.
    let view = library.view(&query(SortMode::IdAsc, "nocturne", 2, 3, Some(1)), &no_art);
    assert_eq!((view.offset, view.index), (2, None));
    assert_eq!(view.rows.iter().map(|row| row.track.id).collect::<Vec<_>>(), [9, 12, 15]);
}

#[test]
fn rows_carry_ratings_and_only_known_art() {
    let (tracks, ratings) = tracks();
    let library = Library::new(1, tracks, ratings);
    let art = |ids: &[&str]| -> Vec<Option<Option<Artwork>>> {
        ids.iter()
            .map(|id| match *id {
                "sp01" => Some(Some(Artwork { small: Some("s".into()), ..Artwork::default() })),
                "sp02" => Some(None),
                _ => None,
            })
            .collect()
    };
    let view = library.view(&query(SortMode::IdAsc, "", 0, 5, None), &art);
    assert_eq!(view.rows[0].art.as_ref().unwrap().as_ref().unwrap().small.as_deref(), Some("s"));
    assert_eq!(view.rows[1].art, Some(None));
    assert_eq!(view.rows[2].art, None);
    assert_eq!(view.rows[4].rating.as_ref().map(|rating| rating.stars), Some(1));
    assert_eq!(view.rows[3].rating, None);
}

#[test]
fn a_saved_rating_makes_a_new_version_and_reorders_unrated_first() {
    let (tracks, ratings) = tracks();
    let library = Library::new(1, tracks, ratings);
    let unrated = |library: &Library| {
        library.view(&query(SortMode::UnratedFirst, "", 0, MAX_VIEW_LIMIT, None), &no_art).rows[0].track.id
    };
    let first = unrated(&library);
    let next = library.with_rating(2, Rating { track_id: first, stars: 3, opinion: String::new(), updated_at: 1 });
    assert_eq!((next.version(), next.total()), (2, 60));
    assert_ne!(unrated(&next), first, "the rated track moved after the unrated ones");
    let row = next.view(&query(SortMode::IdAsc, "", 0, 60, Some(first)), &no_art);
    assert_eq!(row.rows[row.index.unwrap() - row.offset].rating.as_ref().map(|rating| rating.stars), Some(3));
    assert_eq!(unrated(&library), first, "the old version is unchanged");
    assert!(Arc::ptr_eq(&library.orders[0], &next.orders[0]), "other orders are shared");
}

#[test]
fn caches_filtered_lists() {
    let (tracks, ratings) = tracks();
    let library = Library::new(1, tracks, ratings);
    let first = library.matched(SortMode::TopPlayed, "Nocturne ");
    assert!(Arc::ptr_eq(&first, &library.matched(SortMode::TopPlayed, " nocturne")));
    assert!(!Arc::ptr_eq(&first, &library.matched(SortMode::IdAsc, "nocturne")));
    for i in 0..FILTER_CACHE {
        library.matched(SortMode::TopPlayed, &format!("{i}"));
    }
    assert!(!Arc::ptr_eq(&first, &library.matched(SortMode::TopPlayed, "nocturne")), "evicted");
}

#[test]
fn parses_view_queries_as_strictly_as_the_typescript_server() {
    let parse = |query: &str| ViewQuery::parse(&Url::parse(&format!("http://127.0.0.1/api/view?{query}")).unwrap());
    assert_eq!(parse("sort=recentDesc&limit=100"), Ok(ViewQuery::initial()));
    assert_eq!(
        parse("sort=unratedFirst&q=a%20b&offset=20&limit=500&around=7"),
        Ok(query(SortMode::UnratedFirst, "a b", 20, 500, Some(7)))
    );
    assert_eq!(parse("sort=idAsc&limit=1&sort=bad").map(|query| query.sort), Ok(SortMode::IdAsc), "first wins");
    let sort_error = Err("sort must be one of recentDesc, idAsc, topPlayed, unratedFirst".to_string());
    for bad in ["limit=10", "sort=recent&limit=10", "sort=&limit=10"] {
        assert_eq!(parse(bad), sort_error, "{bad}");
    }
    for limit in ["", "&limit=", "&limit=0", "&limit=501", "&limit=x", "&limit=-1", "&limit=1.5", "&limit=+5"] {
        assert_eq!(
            parse(&format!("sort=idAsc{limit}")),
            Err("limit must be an integer from 1 to 500".into()),
            "{limit}"
        );
    }
    for offset in ["-1", "", "+1", "1e3", "1234567890123456"] {
        assert_eq!(
            parse(&format!("sort=idAsc&limit=5&offset={offset}")),
            Err("offset must be a non-negative integer".into()),
            "{offset}"
        );
    }
    for around in ["abc", "", "0", "-4", "+4"] {
        assert_eq!(
            parse(&format!("sort=idAsc&limit=5&around={around}")),
            Err("around must be a positive track ID".into()),
            "{around}"
        );
    }
}
