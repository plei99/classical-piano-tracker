package cli

import (
	"bytes"
	"context"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/plei99/classical-piano-tracker/internal/db"
)

func TestSyncStatusPrintsNeverWithoutCheckpoint(t *testing.T) {
	t.Parallel()

	dbPath := filepath.Join(t.TempDir(), "tracker.db")
	cmd := NewRootCmd()
	var out bytes.Buffer
	cmd.SetOut(&out)
	cmd.SetErr(&out)
	cmd.SetArgs([]string{"--db", dbPath, "sync", "status"})

	if err := cmd.Execute(); err != nil {
		t.Fatalf("cmd.Execute() error = %v", err)
	}
	if got := strings.TrimSpace(out.String()); got != "Last sync: never" {
		t.Fatalf("output = %q, want Last sync: never", out.String())
	}
}

func TestSyncStatusPrintsCheckpointTimestamp(t *testing.T) {
	t.Parallel()

	dbPath := filepath.Join(t.TempDir(), "tracker.db")
	queries := newSyncStatusTestQueries(t, dbPath)
	checkpoint := time.Date(2026, time.April, 3, 14, 30, 0, 0, time.UTC)
	if err := queries.UpsertRecentPlayCheckpoint(context.Background(), checkpoint.UnixNano()); err != nil {
		t.Fatalf("UpsertRecentPlayCheckpoint() error = %v", err)
	}

	cmd := NewRootCmd()
	var out bytes.Buffer
	cmd.SetOut(&out)
	cmd.SetErr(&out)
	cmd.SetArgs([]string{"--db", dbPath, "sync", "status"})

	if err := cmd.Execute(); err != nil {
		t.Fatalf("cmd.Execute() error = %v", err)
	}
	want := "Last sync: " + checkpoint.Local().Format("January 2, 2006 at 3:04 PM MST")
	if got := strings.TrimSpace(out.String()); got != want {
		t.Fatalf("output = %q, want %q", out.String(), want)
	}
}

func newSyncStatusTestQueries(t *testing.T, dbPath string) *db.Queries {
	t.Helper()

	conn, err := db.Open(dbPath)
	if err != nil {
		t.Fatalf("db.Open() error = %v", err)
	}
	t.Cleanup(func() {
		_ = conn.Close()
	})

	if err := db.Init(context.Background(), conn); err != nil {
		t.Fatalf("db.Init() error = %v", err)
	}

	return db.New(conn)
}
