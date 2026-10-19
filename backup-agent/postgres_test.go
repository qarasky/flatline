package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"strings"
	"sync"
	"testing"
)

type fakeSnapshot struct {
	id      string
	version int
	meta    PostgresMetadata
	counts  map[string]int64
	closed  bool
}

func (s *fakeSnapshot) ID() string { return s.id }

func (s *fakeSnapshot) Metadata(ctx context.Context) (PostgresMetadata, error) {
	return s.meta, nil
}

func (s *fakeSnapshot) TableCounts(ctx context.Context, tables []string) (map[string]int64, error) {
	return s.counts, nil
}

func (s *fakeSnapshot) Close() error {
	s.closed = true
	return nil
}

type fakePostgresExecutor struct {
	mu         sync.Mutex
	version    int
	snapshots  map[string]*fakeSnapshot
	databases  []string
	fail       bool
	globals    bool
	writeBytes int
}

func (f *fakePostgresExecutor) OpenSnapshot(ctx context.Context, source PostgresSource, database string) (PostgresSnapshot, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.version++
	if f.snapshots == nil {
		f.snapshots = make(map[string]*fakeSnapshot)
	}
	snapshot := &fakeSnapshot{
		id:      fmt.Sprintf("snap-%d", f.version),
		version: f.version,
		meta: PostgresMetadata{
			ServerVersion: "16.4",
			ClientVersion: "16.4",
			Extensions:    []string{"plpgsql"},
			Tables:        []string{`"public"."items"`},
		},
		counts: map[string]int64{`"public"."items"`: int64(f.version)},
	}
	f.snapshots[snapshot.id] = snapshot
	f.databases = append(f.databases, database)
	return snapshot, nil
}

func (f *fakePostgresExecutor) Dump(ctx context.Context, source PostgresSource, database, snapshotID string, output io.Writer) error {
	if f.fail {
		return errors.New("stderr: secret-password leaked")
	}
	f.mu.Lock()
	snapshot := f.snapshots[snapshotID]
	// A concurrent writer changes the source while the dump is running. The
	// dump must still write the snapshot's version, not the new one.
	f.version++
	f.mu.Unlock()

	if f.writeBytes > 0 {
		_, err := output.Write(make([]byte, f.writeBytes))
		return err
	}
	if _, err := fmt.Fprintf(output, "dump:%s:%d", snapshotID, snapshot.version); err != nil {
		return err
	}
	return nil
}

func (f *fakePostgresExecutor) Globals(ctx context.Context, source PostgresSource, output io.Writer) error {
	f.globals = true
	_, err := io.WriteString(output, "-- globals")
	return err
}

func TestPostgresDumpFailurePreventsExport(t *testing.T) {
	spool, err := NewSpool(t.TempDir(), 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	executor := &fakePostgresExecutor{fail: true}
	state := newExportState(Config{Name: "meks"}, "run-1", nowUTC())
	source := PostgresSource{Container: "pg", User: "postgres", Databases: []string{"modernization"}}

	err = exportPostgresInto(context.Background(), source, spool, state, executor)
	if err == nil {
		t.Fatal("a failed pg_dump must prevent the export")
	}
	if len(state.files) != 0 {
		t.Fatalf("a failed dump produced files: %+v", state.files)
	}
	if spool.Used() != 0 {
		t.Fatalf("failed dump left bytes in the spool: %d", spool.Used())
	}
	if strings.Contains(err.Error(), "secret-password") {
		t.Fatalf("stderr leaked into the error: %v", err)
	}
}

func TestPostgresNamesAreArguments(t *testing.T) {
	databases := []string{"with space", "quote'name", "-leading", "semi;colon"}
	spool, err := NewSpool(t.TempDir(), 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	executor := &fakePostgresExecutor{}
	state := newExportState(Config{Name: "meks"}, "run-1", nowUTC())
	source := PostgresSource{Container: "pg", User: "postgres", Databases: databases}

	if err := exportPostgresInto(context.Background(), source, spool, state, executor); err != nil {
		t.Fatal(err)
	}
	if len(executor.databases) != len(databases) {
		t.Fatalf("databases = %v", executor.databases)
	}
	for index, database := range databases {
		if executor.databases[index] != database {
			t.Fatalf("database %q became %q", database, executor.databases[index])
		}
		psql := psqlArgs(source, database)
		if !contains(psql, "--dbname="+database) {
			t.Fatalf("psql args do not bind the database explicitly: %v", psql)
		}
		if contains(psql, "--dbname") {
			t.Fatalf("psql must not split --dbname from its value: %v", psql)
		}
		if !contains(dumpArgs(source, database, "snap-1"), "--dbname="+database) {
			t.Fatalf("pg_dump args do not bind the database explicitly")
		}
	}
	if !contains(dumpArgs(source, "-leading", "snap-9"), "--snapshot=snap-9") {
		t.Fatal("pg_dump must receive the exported snapshot")
	}

	query := buildCountQuery([]string{`"public"."weird'name"`})
	if !strings.Contains(query, `FROM "public"."weird'name"`) {
		t.Fatalf("server-side identifier quoting was altered: %s", query)
	}
	if !strings.Contains(query, `'"public"."weird''name"'`) {
		t.Fatalf("the display literal was not escaped: %s", query)
	}
}

func TestPostgresCountsMatchExportSnapshot(t *testing.T) {
	spool, err := NewSpool(t.TempDir(), 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	executor := &fakePostgresExecutor{}
	state := newExportState(Config{Name: "meks"}, "run-1", nowUTC())
	source := PostgresSource{Container: "pg", User: "postgres", Databases: []string{"modernization"}}

	if err := exportPostgresInto(context.Background(), source, spool, state, executor); err != nil {
		t.Fatal(err)
	}
	if len(state.manifest.Postgres) != 1 {
		t.Fatalf("summaries = %+v", state.manifest.Postgres)
	}
	summary := state.manifest.Postgres[0]
	if summary.TableCounts[`"public"."items"`] != 1 {
		t.Fatalf("counts did not come from the exported snapshot: %v", summary.TableCounts)
	}
	if executor.version != 2 {
		t.Fatalf("the fake source did not change during the export: %d", executor.version)
	}

	file, err := openSpoolFile(spool, state.files[0].Path)
	if err != nil {
		t.Fatal(err)
	}
	dump, err := io.ReadAll(file)
	_ = file.Close()
	if err != nil {
		t.Fatal(err)
	}
	if string(dump) != "dump:snap-1:1" {
		t.Fatalf("dump did not use the exported snapshot: %q", dump)
	}
}

func TestPostgresGlobalsAreSeparate(t *testing.T) {
	spool, err := NewSpool(t.TempDir(), 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	executor := &fakePostgresExecutor{}
	state := newExportState(Config{Name: "meks"}, "run-1", nowUTC())
	source := PostgresSource{
		Container: "pg", User: "postgres", Databases: []string{"modernization"}, IncludeGlobals: true,
	}
	if err := exportPostgresInto(context.Background(), source, spool, state, executor); err != nil {
		t.Fatal(err)
	}
	if !executor.globals {
		t.Fatal("globals were requested but not exported")
	}
	if len(state.files) != 2 || state.files[1].Kind != kindGlobals {
		t.Fatalf("globals are not a separate entry: %+v", state.files)
	}
	if state.files[1].Path != "globals/000001.sql" {
		t.Fatalf("globals path = %q", state.files[1].Path)
	}
}

func contains(values []string, wanted string) bool {
	for _, value := range values {
		if value == wanted {
			return true
		}
	}
	return false
}
