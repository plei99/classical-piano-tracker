package tui

import (
	"context"
	"fmt"
	"testing"

	tea "charm.land/bubbletea/v2"
	"github.com/plei99/classical-piano-tracker/internal/db"
)

// Benchmark sizes: 500 approximates a real library today; the larger sizes
// show how each interaction scales as listening history grows.
var benchSizes = []int{500, 5000, 25000}

var benchPianists = []string{
	"Krystian Zimerman", "Martha Argerich", "Grigory Sokolov", "Seong-Jin Cho",
	"Daniil Trifonov", "Víkingur Ólafsson", "András Schiff", "Mitsuko Uchida",
}

func benchTracks(n int) []db.Track {
	tracks := make([]db.Track, n)
	for i := range tracks {
		tracks[i] = db.Track{
			ID:           int64(i + 1),
			SpotifyID:    fmt.Sprintf("spotify-%06d", i),
			TrackName:    fmt.Sprintf("Piano Sonata No. %d in B-flat minor, Op. %d: II. Scherzo – Più lento", i%32+1, i%120+1),
			AlbumName:    fmt.Sprintf("Chopin: Complete Works Vol. %d", i%40),
			Artists:      fmt.Sprintf(`["Frédéric Chopin","%s"]`, benchPianists[i%len(benchPianists)]),
			PlayCount:    int64(i%17 + 1),
			LastPlayedAt: int64(1_700_000_000 + (i*7919)%1_000_000),
		}
	}
	return tracks
}

func benchRatings(tracks []db.Track) []db.Rating {
	var ratings []db.Rating
	for i, track := range tracks {
		if i%3 == 0 {
			ratings = append(ratings, db.Rating{TrackID: track.ID, Stars: int64(i%5 + 1), Opinion: "Lyrical and restrained.", UpdatedAt: 1_700_000_000})
		}
	}
	return ratings
}

// benchModel returns a model in the steady browsing state: tracks and
// ratings loaded and a realistic terminal size.
func benchModel(b *testing.B, n int) Model {
	b.Helper()
	tracks := benchTracks(n)
	model := NewModel(benchQueries(b, n), nil, nil)
	updated, _ := model.Update(tea.WindowSizeMsg{Width: 160, Height: 48})
	updated, _ = updated.Update(newTracksLoadedMsg(tracks, benchRatings(tracks)))
	return updated.(Model)
}

// newTracksLoadedMsg mirrors what loadTracksCmd produces from the DB.
func newTracksLoadedMsg(tracks []db.Track, ratings []db.Rating) tracksLoadedMsg {
	byTrackID := make(map[int64]db.Rating, len(ratings))
	for _, r := range ratings {
		byTrackID[r.TrackID] = r
	}
	return tracksLoadedMsg{tracks: tracks, ratings: byTrackID, trackText: buildTrackText(tracks)}
}

func BenchmarkTracksLoaded(b *testing.B) {
	for _, n := range benchSizes {
		tracks := benchTracks(n)
		loaded := newTracksLoadedMsg(tracks, benchRatings(tracks))
		b.Run(fmt.Sprintf("n=%d", n), func(b *testing.B) {
			b.ReportAllocs()
			base := NewModel(nil, nil, nil)
			for b.Loop() {
				// Copy so every iteration sorts the same unsorted input.
				msg := loaded
				msg.tracks = append([]db.Track(nil), tracks...)
				_, _ = base.Update(msg)
			}
		})
	}
}

func BenchmarkView(b *testing.B) {
	for _, n := range benchSizes {
		b.Run(fmt.Sprintf("n=%d", n), func(b *testing.B) {
			m := benchModel(b, n)
			b.ReportAllocs()
			for b.Loop() {
				_ = m.View()
			}
		})
	}
}

// BenchmarkMoveDownFrame measures one j keypress plus the frame Bubble Tea
// renders for it: the latency a user feels while scrolling.
func BenchmarkMoveDownFrame(b *testing.B) {
	for _, n := range benchSizes {
		b.Run(fmt.Sprintf("n=%d", n), func(b *testing.B) {
			m := benchModel(b, n)
			b.ReportAllocs()
			key := textKey("j")
			for b.Loop() {
				updated, cmd := m.Update(key)
				// Resolve any follow-up command inline (e.g. a rating fetch)
				// so its cost is counted.
				if cmd != nil {
					updated, _ = updated.Update(cmd())
				}
				_ = updated.View()
			}
		})
	}
}

// BenchmarkSearchKeystrokeFrame measures typing one character into the
// search box plus the resulting frame.
func BenchmarkSearchKeystrokeFrame(b *testing.B) {
	for _, n := range benchSizes {
		b.Run(fmt.Sprintf("n=%d", n), func(b *testing.B) {
			m := benchModel(b, n)
			updated, _ := m.Update(textKey("/"))
			updated, _ = updated.Update(textKey("c"))
			updated, _ = updated.Update(textKey("h"))
			m = updated.(Model)
			b.ReportAllocs()
			key := textKey("o")
			for b.Loop() {
				updated, cmd := m.Update(key)
				if cmd != nil {
					updated, _ = updated.Update(cmd())
				}
				_ = updated.View()
			}
		})
	}
}

func BenchmarkSortCycleFrame(b *testing.B) {
	for _, n := range benchSizes {
		b.Run(fmt.Sprintf("n=%d", n), func(b *testing.B) {
			m := benchModel(b, n)
			b.ReportAllocs()
			key := textKey("o")
			for b.Loop() {
				updated, _ := m.Update(key)
				m = updated.(Model)
				_ = m.View()
			}
		})
	}
}

// BenchmarkLoadTracksFromDB measures the startup query path against a real
// SQLite file.
func BenchmarkLoadTracksFromDB(b *testing.B) {
	for _, n := range benchSizes {
		b.Run(fmt.Sprintf("n=%d", n), func(b *testing.B) {
			queries := benchQueries(b, n)
			m := NewModel(queries, nil, nil)
			b.ReportAllocs()
			for b.Loop() {
				if msg := m.loadTracksCmd()().(tracksLoadedMsg); msg.err != nil {
					b.Fatal(msg.err)
				}
			}
		})
	}
}

func benchQueries(b *testing.B, n int) *db.Queries {
	b.Helper()
	conn, err := db.Open(b.TempDir() + "/bench.db")
	if err != nil {
		b.Fatal(err)
	}
	b.Cleanup(func() { _ = conn.Close() })
	ctx := context.Background()
	if err := db.Init(ctx, conn); err != nil {
		b.Fatal(err)
	}

	tx, err := conn.BeginTx(ctx, nil)
	if err != nil {
		b.Fatal(err)
	}
	q := db.New(tx)
	tracks := benchTracks(n)
	for _, track := range tracks {
		if _, err := q.UpsertTrack(ctx, db.UpsertTrackParams{
			SpotifyID: track.SpotifyID, TrackName: track.TrackName, AlbumName: track.AlbumName,
			Artists: track.Artists, LastPlayedAt: track.LastPlayedAt,
		}); err != nil {
			b.Fatal(err)
		}
	}
	for _, rating := range benchRatings(tracks) {
		if _, err := q.UpsertRating(ctx, db.UpsertRatingParams{
			TrackID: rating.TrackID, Stars: rating.Stars, Opinion: rating.Opinion, UpdatedAt: rating.UpdatedAt,
		}); err != nil {
			b.Fatal(err)
		}
	}
	if err := tx.Commit(); err != nil {
		b.Fatal(err)
	}
	return db.New(conn)
}
