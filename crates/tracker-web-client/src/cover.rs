use leptos::prelude::*;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CoverSize {
    Small,
    Large,
}

/// The tile's letter while there is no art: the album's first character.
fn initial(album_name: &str) -> String {
    album_name.trim().chars().next().map_or_else(|| "♪".to_string(), String::from)
}

/// A square album cover. While art is unknown, or when Spotify has none, it
/// shows the album's initial on a plain tile so the layout never shifts.
/// The image is recreated (restarting its fade-in) only when the URL changes.
#[component]
pub fn Cover(
    #[prop(into)] url: Signal<Option<String>>,
    size: CoverSize,
    #[prop(into)] album_name: Signal<String>,
    #[prop(optional)] class: Option<&'static str>,
) -> impl IntoView {
    let size = if size == CoverSize::Small { "small" } else { "large" };
    let classes = match class {
        Some(class) => format!("cover cover--{size} {class}"),
        None => format!("cover cover--{size}"),
    };
    move || match url.get() {
        Some(src) => view! {
            <img
                class=classes.clone()
                src=src
                alt=move || format!("Cover of {}", album_name.get())
                loading="lazy"
                decoding="async"
            />
        }
        .into_any(),
        None => view! {
            <div class=format!("{classes} cover--empty") aria-hidden="true">
                <span>{move || initial(&album_name.get())}</span>
            </div>
        }
        .into_any(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn initial_is_the_first_character_or_a_note() {
        assert_eq!(initial("  Études"), "É");
        assert_eq!(initial(""), "♪");
        assert_eq!(initial("   "), "♪");
    }
}
