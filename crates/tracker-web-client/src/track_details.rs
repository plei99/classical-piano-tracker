use leptos::prelude::*;
use tracker_app::presenter::{
    self, DETAILS_HEADING, NO_SELECTION_TEXT, RATING_NONE_TEXT, RATING_SAVING_TEXT, RatingView,
};
use tracker_app::{KeyPress, Msg, WebModel};

use crate::artwork::ArtworkStore;
use crate::cover::{Cover, CoverSize};
use crate::player::{Player, track_uri};
use crate::rating_editor::RatingEditor;

#[component]
fn Stars(stars: i64) -> impl IntoView {
    view! {
        <span class="stars" aria-label=format!("{stars} out of 5 stars")>
            {(1..=5)
                .map(|value| {
                    view! {
                        <span class=if value <= stars { "star star--on" } else { "star" } aria-hidden="true">
                            "★"
                        </span>
                    }
                })
                .collect_view()}
        </span>
    }
}

/// The selected track's rating as the pane shows it, owned so a memo can
/// compare it.
#[derive(Debug, Clone, PartialEq, Eq)]
enum RatingShown {
    Saving,
    Unrated,
    Rated { stars: i64, opinion: String, updated: String },
}

/// The selected track's text, for the hero.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct Hero {
    spotify_id: String,
    track_name: String,
    artists: String,
    album_name: String,
}

#[component]
pub fn TrackDetails(model: RwSignal<WebModel>, send: Callback<Msg>, player: Player) -> impl IntoView {
    let store = expect_context::<ArtworkStore>();
    let has_selection = Memo::new(move |_| model.with(|m| m.selected_track().is_some()));
    let hero = Memo::new(move |_| {
        model.with(|m| {
            presenter::details(m).map_or_else(Hero::default, |details| Hero {
                spotify_id: details.track.spotify_id.clone(),
                track_name: details.track.track_name.clone(),
                artists: details.artists.to_string(),
                album_name: details.track.album_name.clone(),
            })
        })
    });
    let fields = Memo::new(move |_| {
        model.with(|m| {
            presenter::details(m).map_or_else(Vec::new, |details| {
                details.fields.into_iter().map(|field| (field.label, field.value)).collect::<Vec<_>>()
            })
        })
    });
    let rating = Memo::new(move |_| {
        model.with(|m| match presenter::details(m).map(|details| details.rating) {
            Some(RatingView::Rated(rating)) => RatingShown::Rated {
                stars: rating.stars,
                opinion: rating.opinion.clone(),
                updated: presenter::updated_text(m, rating),
            },
            Some(RatingView::Saving) => RatingShown::Saving,
            _ => RatingShown::Unrated,
        })
    });
    let editing = Memo::new(move |_| model.with(|m| m.editing_rating));
    let url = Memo::new(move |_| hero.with(|hero| store.url(&hero.spotify_id, true)));
    let playing = Memo::new(move |_| {
        let spotify_id = hero.with(|hero| hero.spotify_id.clone());
        player.state.with(|state| state.loaded_id.as_deref() == Some(spotify_id.as_str()) && !state.is_paused)
    });
    let player_error = Memo::new(move |_| player.state.with(|state| state.error.clone()));

    let details = move || {
        view! {
            <section class="pane pane--detail" aria-label="Track details">
                <div class="hero">
                    <Cover
                        url=url
                        size=CoverSize::Large
                        album_name=Signal::derive(move || hero.with(|hero| hero.album_name.clone()))
                        class="hero__cover"
                    />
                    <div class="hero__text">
                        <h2 class="hero__title">{move || hero.with(|hero| hero.track_name.clone())}</h2>
                        <p class="hero__artists">{move || hero.with(|hero| hero.artists.clone())}</p>
                        <p class="hero__album">{move || hero.with(|hero| hero.album_name.clone())}</p>
                        <div class="hero__actions">
                            <button
                                type="button"
                                class="button button--primary"
                                aria-pressed=move || if playing.get() { "true" } else { "false" }
                                on:click=move |_| player.play(&hero.with_untracked(|hero| hero.spotify_id.clone()))
                            >
                                {move || if playing.get() { "Pause" } else { "Play" }}
                            </button>
                            <a class="button" href=move || hero.with(|hero| track_uri(&hero.spotify_id))>
                                "Open in Spotify"
                            </a>
                            <Show when=move || !editing.get()>
                                <button
                                    type="button"
                                    class="button"
                                    on:click=move |_| send.run(Msg::Key(KeyPress::typed('e')))
                                >
                                    {move || {
                                        if matches!(rating.get(), RatingShown::Rated { .. }) { "Edit rating" } else { "Rate" }
                                    }}
                                </button>
                            </Show>
                        </div>
                        {move || player_error.get().map(|error| view! { <p class="error small">{error}</p> })}
                    </div>
                </div>
                <Show
                    when=move || editing.get()
                    fallback=move || {
                        view! {
                            <section class="rating" aria-label="Rating">
                                {move || match rating.get() {
                                    RatingShown::Saving => {
                                        view! { <p class="muted">{RATING_SAVING_TEXT}</p> }.into_any()
                                    }
                                    RatingShown::Unrated => view! { <p class="muted">{RATING_NONE_TEXT}</p> }.into_any(),
                                    RatingShown::Rated { stars, opinion, updated } => {
                                        view! {
                                            <p class="rating__stars">
                                                <Stars stars=stars />
                                                " "
                                                <span>{format!("{stars}/5")}</span>
                                            </p>
                                            {(!opinion.is_empty())
                                                .then(|| view! { <blockquote class="rating__opinion">{opinion}</blockquote> })}
                                            <p class="muted small">{updated}</p>
                                        }
                                            .into_any()
                                    }
                                }}
                            </section>
                            <dl class="facts">
                                {move || {
                                    fields
                                        .get()
                                        .into_iter()
                                        .map(|(label, value)| {
                                            view! {
                                                <div class="facts__row">
                                                    <dt>{label}</dt>
                                                    <dd>{value}</dd>
                                                </div>
                                            }
                                        })
                                        .collect_view()
                                }}
                            </dl>
                        }
                    }
                >
                    <RatingEditor model=model send=send />
                </Show>
            </section>
        }
    };

    view! {
        <Show
            when=move || has_selection.get()
            fallback=|| {
                view! {
                    <section class="pane pane--detail" aria-label="Track details">
                        <h2>{DETAILS_HEADING}</h2>
                        <p class="muted">{NO_SELECTION_TEXT}</p>
                    </section>
                }
            }
        >
            {details}
        </Show>
    }
}
