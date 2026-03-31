package db

import (
	"context"
	"database/sql"
	_ "embed"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

//go:embed schema.sql
var schemaSQL string

// Open opens a SQLite database using the configured pure-Go driver.
func Open(path string) (*sql.DB, error) {
	if path != "" && path != ":memory:" && !strings.HasPrefix(path, "file:") {
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			return nil, fmt.Errorf("create sqlite directory for %q: %w", path, err)
		}
	}

	db, err := sql.Open(DriverName, path)
	if err != nil {
		return nil, fmt.Errorf("open sqlite database %q: %w", path, err)
	}

	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)

	if err := db.Ping(); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("ping sqlite database %q: %w", path, err)
	}

	if _, err := db.Exec("PRAGMA foreign_keys = ON"); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("enable foreign keys for %q: %w", path, err)
	}

	return db, nil
}

// Init creates the schema objects required by the application.
func Init(ctx context.Context, db *sql.DB) error {
	if _, err := db.ExecContext(ctx, schemaSQL); err != nil {
		return fmt.Errorf("initialize sqlite schema: %w", err)
	}

	return nil
}
