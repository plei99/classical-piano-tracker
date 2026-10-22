//! Ports of the Go `bench_test.go` scenarios. Frames are drawn through a
//! 160x48 `TestBackend`, so each "frame" includes ratatui's buffer diff.

use std::hint::black_box;
use std::sync::Arc;
use std::time::{Duration, Instant};

use criterion::{BatchSize, BenchmarkId, Criterion, criterion_group, criterion_main};
use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use ratatui::Terminal;
use ratatui::backend::TestBackend;
use tracker_core::db::Queries;
use tracker_core::{Db, Rating, Track, UpsertRatingParams, UpsertTrackParams};
use tracker_tui::LoadFn;
use tracker_tui::internals::{Draw, Model, Msg, Services, TracksLoaded, fetch_tracks, key_press};

/// 500 approximates a real library today; the larger sizes show how each
/// interaction scales as listening history grows.
const BENCH_SIZES: [usize; 3] = [500, 5000, 25000];

const BENCH_PIANISTS: [&str; 8] = [
    "Krystian Zimerman",
    "Martha Argerich",
    "Grigory Sokolov",
    "Seong-Jin Cho",
    "Daniil Trifonov",
    "Víkingur Ólafsson",
    "András Schiff",
    "Mitsuko Uchida",
];

const WIDTH: u16 = 160;
const HEIGHT: u16 = 48;

fn bench_tracks(n: usize) -> Vec<Track> {
    (0..n)
        .map(|i| Track {
            id: i as i64 + 1,
            spotify_id: format!("spotify-{i:06}"),
            track_name: format!(
                "Piano Sonata No. {} in B-flat minor, Op. {}: II. Scherzo – Più lento",
                i % 32 + 1,
                i % 120 + 1
            ),
            album_name: format!("Chopin: Complete Works Vol. {}", i % 40),
            artists: format!(r#"["Frédéric Chopin","{}"]"#, BENCH_PIANISTS[i % BENCH_PIANISTS.len()]),
            play_count: (i % 17 + 1) as i64,
            last_played_at: 1_700_000_000 + ((i * 7919) % 1_000_000) as i64,
            created_at: 0,
        })
        .collect()
}

fn bench_ratings(tracks: &[Track]) -> Vec<Rating> {
    tracks
        .iter()
        .enumerate()
        .filter(|(i, _)| i % 3 == 0)
        .map(|(i, track)| Rating {
            track_id: track.id,
            stars: (i % 5 + 1) as i64,
            opinion: "Lyrical and restrained.".into(),
            updated_at: 1_700_000_000,
        })
        .collect()
}

/// A model in the steady browsing state: tracks and ratings loaded and a
/// realistic terminal size.
fn bench_model(n: usize) -> Model {
    let tracks = bench_tracks(n);
    let ratings = bench_ratings(&tracks);
    let mut model = Model::new(Services::ALL);
    model.update(Msg::Resize { width: WIDTH, height: HEIGHT });
    model.update(Msg::TracksLoaded(Ok(TracksLoaded::new(tracks, ratings))));
    model
}

fn terminal() -> Terminal<TestBackend> {
    Terminal::new(TestBackend::new(WIDTH, HEIGHT)).expect("test backend")
}

fn draw(terminal: &mut Terminal<TestBackend>, model: &Model) {
    terminal.draw(|frame| model.render(frame)).expect("draw to test backend");
}

fn text_key(c: char) -> Msg {
    key_msg(KeyEvent::new(KeyCode::Char(c), KeyModifiers::NONE))
}

fn key(code: KeyCode) -> Msg {
    key_msg(KeyEvent::new(code, KeyModifiers::NONE))
}

fn key_msg(event: KeyEvent) -> Msg {
    Msg::Key(key_press(&event).expect("a key press"))
}

fn id(n: usize) -> BenchmarkId {
    BenchmarkId::from_parameter(format!("n={n}"))
}

/// Times `step` + a frame, then runs `undo` + a frame untimed, so every
/// measured keypress starts from the same state and draws a real change.
fn time_step(
    model: &mut Model,
    terminal: &mut Terminal<TestBackend>,
    iters: u64,
    step: impl Fn() -> Msg,
    undo: impl Fn() -> Msg,
) -> Duration {
    let mut total = Duration::ZERO;
    for _ in 0..iters {
        let start = Instant::now();
        black_box(model.update(step()));
        draw(terminal, model);
        total += start.elapsed();
        model.update(undo());
        draw(terminal, model);
    }
    total
}

fn tracks_loaded(c: &mut Criterion) {
    let mut group = c.benchmark_group("TracksLoaded");
    for n in BENCH_SIZES {
        let tracks = bench_tracks(n);
        let loaded = TracksLoaded::new(tracks.clone(), bench_ratings(&tracks));
        let base = Model::new(Services::ALL);
        group.bench_function(id(n), |b| {
            // Clone outside the timing so every iteration sorts the same
            // unsorted input.
            b.iter_batched(
                || (base.clone(), loaded.clone()),
                |(mut model, loaded)| {
                    model.update(Msg::TracksLoaded(Ok(loaded)));
                    model
                },
                BatchSize::LargeInput,
            );
        });
    }
    group.finish();
}

fn view(c: &mut Criterion) {
    let mut group = c.benchmark_group("View");
    for n in BENCH_SIZES {
        let model = bench_model(n);
        let mut terminal = terminal();
        group.bench_function(id(n), |b| b.iter(|| draw(&mut terminal, &model)));
    }
    group.finish();
}

/// One `j` keypress plus the frame drawn for it: the latency a user feels
/// while scrolling.
fn move_down_frame(c: &mut Criterion) {
    let mut group = c.benchmark_group("MoveDownFrame");
    for n in BENCH_SIZES {
        let mut model = bench_model(n);
        let mut terminal = terminal();
        draw(&mut terminal, &model);
        group.bench_function(id(n), |b| {
            b.iter_custom(|iters| time_step(&mut model, &mut terminal, iters, || text_key('j'), || text_key('k')));
        });
    }
    group.finish();
}

/// Typing one character into the search box plus the resulting frame.
fn search_keystroke_frame(c: &mut Criterion) {
    let mut group = c.benchmark_group("SearchKeystrokeFrame");
    for n in BENCH_SIZES {
        let mut model = bench_model(n);
        for c in ['/', 'c', 'h'] {
            model.update(text_key(c));
        }
        let mut terminal = terminal();
        draw(&mut terminal, &model);
        group.bench_function(id(n), |b| {
            b.iter_custom(|iters| {
                time_step(&mut model, &mut terminal, iters, || text_key('o'), || key(KeyCode::Backspace))
            });
        });
    }
    group.finish();
}

fn sort_cycle_frame(c: &mut Criterion) {
    let mut group = c.benchmark_group("SortCycleFrame");
    for n in BENCH_SIZES {
        let mut model = bench_model(n);
        let mut terminal = terminal();
        group.bench_function(id(n), |b| {
            b.iter(|| {
                black_box(model.update(text_key('o')));
                draw(&mut terminal, &model);
            });
        });
    }
    group.finish();
}

/// Writes `n` tracks and their ratings to a SQLite file in `dir`.
fn bench_db(dir: &tempfile::TempDir, n: usize) -> Arc<Db> {
    let db = Db::open(&dir.path().join("bench.db")).expect("open bench db");
    {
        let mut conn = db.conn();
        let tx = conn.transaction().expect("begin");
        let tracks = bench_tracks(n);
        for track in &tracks {
            tx.upsert_track(&UpsertTrackParams {
                spotify_id: track.spotify_id.clone(),
                track_name: track.track_name.clone(),
                album_name: track.album_name.clone(),
                artists: track.artists.clone(),
                last_played_at: track.last_played_at,
            })
            .expect("insert track");
        }
        for rating in bench_ratings(&tracks) {
            tx.upsert_rating(&UpsertRatingParams {
                track_id: rating.track_id,
                stars: rating.stars,
                opinion: rating.opinion,
                updated_at: rating.updated_at,
            })
            .expect("insert rating");
        }
        tx.commit().expect("commit");
    }
    Arc::new(db)
}

/// The startup query path against a real SQLite file: both queries plus
/// the per-row text preparation the load thread does.
fn load_tracks_from_db(c: &mut Criterion) {
    let mut group = c.benchmark_group("LoadTracksFromDB");
    for n in BENCH_SIZES {
        let dir = tempfile::tempdir().expect("temp dir");
        let db = bench_db(&dir, n);
        let load: LoadFn = Arc::new(move || {
            let conn = db.conn();
            Ok((conn.list_all_tracks()?, conn.list_all_ratings()?))
        });
        group.bench_function(id(n), |b| b.iter(|| fetch_tracks(&load).expect("load tracks")));
    }
    group.finish();
}

criterion_group!(
    benches,
    tracks_loaded,
    view,
    move_down_frame,
    search_keystroke_frame,
    sort_cycle_frame,
    load_tracks_from_db
);
criterion_main!(benches);
