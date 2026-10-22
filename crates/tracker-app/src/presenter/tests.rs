use anyhow::anyhow;

use super::*;
use crate::model::tests::loaded;
use crate::model::{KeyPress, Model, Msg};

#[test]
fn hint_sets_follow_the_mode_and_print_as_the_terminal_does() {
    let mut model = loaded();
    assert_eq!(
        hints(&model).iter().map(hint_text).collect::<Vec<_>>(),
        ["j/k or arrows: move", "g/G: top/bottom", "o: sort", "s: sync", "enter/e: rate", "r: reload", "q: quit"]
    );
    assert!(hints(&model).iter().find(|hint| hint.label == "quit").unwrap().terminal_only);
    assert_eq!(hints(&model).iter().filter_map(|hint| hint.key).collect::<Vec<_>>(), ["o", "s", "e", "r", "q"]);

    model.start_rating_editor();
    assert_eq!(
        hints(&model).iter().map(|hint| hint.keys).collect::<Vec<_>>(),
        ["1-5", "tab", "ctrl+u", "enter", "esc"]
    );

    let model = Model { searching: true, ..loaded() };
    assert_eq!(hints(&model)[0].keys, "type");
}

#[test]
fn screens() {
    assert_eq!(screen(&Model { loading_tracks: true, ..Model::default() }), Screen::Loading);
    let mut failed = Model::default();
    failed.update(Msg::TracksLoaded(Err(anyhow!("database is locked"))));
    assert_eq!(screen(&failed), Screen::Error);
    assert_eq!(error_text(&failed), "Error: database is locked");
    assert_eq!(screen(&Model::default()), Screen::Empty);
    let mut model = loaded();
    model.update(Msg::SetSearch(" zzz ".into()));
    assert_eq!(screen(&model), Screen::NoMatch);
    assert_eq!(no_match_text(&model), "No tracks match /zzz");
    assert_eq!(screen(&loaded()), Screen::Browse);
}

#[test]
fn status_lines() {
    assert_eq!(status(&loaded()), None);
    let status_of = |model: &Model| status(model).map(|status| (status.text, status.is_error));
    assert_eq!(status_of(&Model { syncing: true, ..loaded() }), Some(("Syncing with Spotify...".into(), false)));
    assert_eq!(status_of(&Model { saving_rating: true, ..loaded() }), Some(("Saving rating...".into(), false)));
    assert_eq!(
        status_of(&Model { status_message: "bad".into(), status_is_error: true, ..loaded() }),
        Some(("Error: bad".into(), true))
    );

    let mut model = loaded();
    model.update(Msg::Key(KeyPress::typed('/')));
    model.update(Msg::SetSearch("track 2".into()));
    assert_eq!(status_of(&model), Some(("Search /track 2_ (1/3)".into(), false)));
    assert_eq!(track_list_summary(&model), "1/3 shown · sort: recent");
    model.update(Msg::Key(KeyPress::named("enter")));
    assert_eq!(status_of(&model), Some(("Filter /track 2 (1/3)".into(), false)));
    model.update(Msg::Key(KeyPress::named("esc")));
    assert_eq!(track_list_summary(&model), "3 loaded · sort: recent");
}

#[test]
fn details_list_the_terminal_fields_in_order() {
    let model = loaded();
    let shown = details(&model).unwrap();
    assert_eq!(shown.artists, "Pianist 1");
    assert_eq!(
        shown.fields.iter().map(|field| field.label).collect::<Vec<_>>(),
        ["ID", "Spotify ID", "Album", "Play Count", "Last Played"]
    );
    assert_eq!(field_text(&shown.fields[4]), "Last Played: 1970-01-01T00:01:39Z");
    assert_eq!(shown.rating, RatingView::Unrated);
    assert_eq!(details(&Model { saving_rating: true, ..loaded() }).unwrap().rating, RatingView::Saving);
    assert!(details(&Model::default()).is_none());

    let rating = Rating { track_id: 1, stars: 4, opinion: "Warm".into(), updated_at: 0 };
    let mut rated = loaded();
    rated.list.ratings.insert(1, rating.clone());
    assert_eq!(details(&rated).unwrap().rating, RatingView::Rated(&rating));
    assert_eq!(rating_text(&rating), "Rating: 4/5");
    assert_eq!(opinion_text(&rating), "Opinion: Warm");
    assert_eq!(updated_text(&rated, &rating), "Updated: 1970-01-01T00:00:00Z");
}

#[test]
fn editor_labels() {
    let mut model = loaded();
    model.start_rating_editor();
    assert_eq!(stars_field_label(&model), "Stars: not set");
    assert_eq!(draft_opinion_line(&model), "");
    model.update(Msg::Key(KeyPress::typed('5')));
    model.update(Msg::Key(KeyPress::typed('!')));
    assert_eq!(stars_field_label(&model), "Stars: 5/5");
    assert_eq!(draft_opinion_line(&model), "!_");
}
