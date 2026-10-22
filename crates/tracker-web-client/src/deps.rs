//! The shared model's I/O, over the local server's JSON API. The web UI runs
//! the same state machine as the terminal UI; only how its commands are
//! carried out differs.

use anyhow::{Result, anyhow};
use serde::Serialize;
use serde::de::DeserializeOwned;
use tracker_app::api::{
    ErrorResponse, INITIAL_STATE_ID, InitialState, RATINGS_PATH, RELOAD_PATH, ReloadResponse, SYNC_PATH, TOKEN_HEADER,
    TOKEN_META, ViewResponse,
};
use tracker_core::{Rating, SyncStats, UpsertRatingParams};
use wasm_bindgen::{JsCast, JsValue};
use wasm_bindgen_futures::JsFuture;
use web_sys::{Headers, RequestInit, Response};

/// The per-launch token the server put in the page, required on every POST.
pub fn page_token() -> String {
    web_sys::window()
        .and_then(|window| window.document())
        .and_then(|document| document.query_selector(&format!(r#"meta[name="{TOKEN_META}"]"#)).ok().flatten())
        .and_then(|meta| meta.get_attribute("content"))
        .unwrap_or_default()
}

/// The state the server rendered the page from (see [`INITIAL_STATE_ID`]);
/// loading when the page has none.
pub fn initial_state() -> InitialState {
    web_sys::window()
        .and_then(|window| window.document())
        .and_then(|document| document.get_element_by_id(INITIAL_STATE_ID))
        .and_then(|script| script.text_content())
        .and_then(|json| serde_json::from_str(&json).ok())
        .unwrap_or_default()
}

/// The browser's UTC offset in seconds at a Unix second, from `Date`.
#[cfg(target_arch = "wasm32")]
pub fn local_offset(seconds: i64) -> i32 {
    let date = js_sys::Date::new(&JsValue::from_f64(seconds as f64 * 1000.0));
    (-date.get_timezone_offset() * 60.0) as i32
}

/// The message of a rejected promise (a JavaScript `Error`, usually).
pub fn js_error(value: JsValue) -> anyhow::Error {
    match value.dyn_ref::<js_sys::Error>() {
        Some(err) => anyhow!(String::from(err.message())),
        None => anyhow!(value.as_string().unwrap_or_else(|| format!("{value:?}"))),
    }
}

/// Sends a request and decodes the JSON answer; a non-2xx answer fails with
/// the server's error message.
async fn call<T: DeserializeOwned>(path: &str, init: &RequestInit) -> Result<T> {
    let window = web_sys::window().ok_or_else(|| anyhow!("no window"))?;
    let response: Response =
        JsFuture::from(window.fetch_with_str_and_init(path, init)).await.map_err(js_error)?.unchecked_into();
    let text = match response.text() {
        Ok(promise) => JsFuture::from(promise).await.ok().and_then(|text| text.as_string()).unwrap_or_default(),
        Err(_) => String::new(),
    };
    if !response.ok() {
        let message = serde_json::from_str::<ErrorResponse>(&text)
            .map(|body| body.error)
            .unwrap_or_else(|_| format!("{} {}", response.status(), response.status_text()));
        return Err(anyhow!(message));
    }
    serde_json::from_str(&text).map_err(|err| anyhow!("decode {path}: {err}"))
}

pub async fn get_json<T: DeserializeOwned>(path: &str) -> Result<T> {
    call(path, &RequestInit::new()).await
}

/// The server's API, authorized by the page token.
#[derive(Debug, Clone)]
pub struct HttpDeps {
    token: String,
}

impl HttpDeps {
    pub fn new(token: String) -> HttpDeps {
        HttpDeps { token }
    }

    fn post(&self, body: Option<&impl Serialize>) -> Result<RequestInit> {
        let headers = Headers::new().map_err(js_error)?;
        headers.set(TOKEN_HEADER, &self.token).map_err(js_error)?;
        let init = RequestInit::new();
        init.set_method("POST");
        if let Some(body) = body {
            headers.set("Content-Type", "application/json").map_err(js_error)?;
            init.set_body(&JsValue::from_str(&serde_json::to_string(body)?));
        }
        init.set_headers(&headers);
        Ok(init)
    }

    /// Has the server re-read the database.
    pub async fn reload(&self) -> Result<ReloadResponse> {
        call(RELOAD_PATH, &self.post(None::<&()>)?).await
    }

    /// One window of the library; see [`tracker_app::ViewRequest::url`].
    pub async fn view(&self, url: &str) -> Result<ViewResponse> {
        get_json(url).await
    }

    pub async fn sync(&self) -> Result<SyncStats> {
        call(SYNC_PATH, &self.post(None::<&()>)?).await
    }

    pub async fn save_rating(&self, params: &UpsertRatingParams) -> Result<Rating> {
        call(RATINGS_PATH, &self.post(Some(params))?).await
    }
}
