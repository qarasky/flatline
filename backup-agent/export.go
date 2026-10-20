package main

import (
	"context"
	"fmt"
	"time"
)

// exportState numbers generated paths across all sources of one instance so
// databases and objects never collide.
type exportState struct {
	manifest  Manifest
	files     []ExportFile
	databases int
	globals   int
	objects   int
}

func newExportState(cfg Config, clientRunID string, started time.Time) *exportState {
	return &exportState{
		manifest: Manifest{
			FormatVersion:    manifestFormatVersion,
			ClientRunID:      clientRunID,
			AgentName:        cfg.Name,
			ExportStartedAt:  started.UTC().Format(time.RFC3339),
			ExportFinishedAt: started.UTC().Format(time.RFC3339),
			Postgres:         []PostgresSummary{},
			Entries:          []Entry{},
		},
	}
}

func (s *exportState) databasePath() string {
	s.databases++
	return fmt.Sprintf("databases/%06d.dump", s.databases)
}

func (s *exportState) globalsPath() string {
	s.globals++
	return fmt.Sprintf("globals/%06d.sql", s.globals)
}

func (s *exportState) objectPath() string {
	s.objects++
	return fmt.Sprintf("objects/%06d", s.objects)
}

func (s *exportState) addFile(file ExportFile) {
	s.files = append(s.files, file)
	s.manifest.Entries = append(s.manifest.Entries, Entry{
		Path:        file.Path,
		Kind:        file.Kind,
		Bucket:      file.Bucket,
		Key:         file.Key,
		ContentType: file.ContentType,
		Database:    file.Database,
	})
}

func (s *exportState) addVanished(bucket, key string) {
	s.manifest.Vanished = append(s.manifest.Vanished, VanishedObject{Bucket: bucket, Key: key})
}

func (s *exportState) addPostgres(summary PostgresSummary) {
	s.manifest.Postgres = append(s.manifest.Postgres, summary)
}

func (s *exportState) export(finished time.Time) Export {
	s.manifest.ExportFinishedAt = finished.UTC().Format(time.RFC3339)
	return Export{Manifest: s.manifest, Files: s.files}
}

// ExportSources exports every configured PostgreSQL database and S3 bucket
// under one two-hour job context. Any required-source failure aborts the
// whole export.
func ExportSources(ctx context.Context, cfg Config, spool *Spool, clientRunID string) (Export, error) {
	jobCtx, cancel := context.WithTimeout(ctx, 2*time.Hour)
	defer cancel()

	state := newExportState(cfg, clientRunID, time.Now().UTC())
	executor := dockerPostgresExecutor{}

	for _, source := range cfg.Postgres {
		if err := exportPostgresInto(jobCtx, source, spool, state, executor); err != nil {
			return Export{}, err
		}
	}
	for _, source := range cfg.S3 {
		client, err := newS3Client(jobCtx, source)
		if err != nil {
			return Export{}, err
		}
		if err := exportBucketInto(jobCtx, source, spool, state, client); err != nil {
			return Export{}, err
		}
	}
	return state.export(time.Now().UTC()), nil
}

// ExportPostgres is the direct, single-source adapter used by tests and
// callers that need only database exports.
func ExportPostgres(ctx context.Context, source PostgresSource, spool *Spool) (Export, error) {
	state := newExportState(Config{Name: "direct"}, "direct", time.Now().UTC())
	if err := exportPostgresInto(ctx, source, spool, state, dockerPostgresExecutor{}); err != nil {
		return Export{}, err
	}
	return state.export(time.Now().UTC()), nil
}

// ExportBucket is the direct, single-source object adapter.
func ExportBucket(ctx context.Context, source S3Source, spool *Spool) (Export, error) {
	client, err := newS3Client(ctx, source)
	if err != nil {
		return Export{}, err
	}
	state := newExportState(Config{Name: "direct"}, "direct", time.Now().UTC())
	if err := exportBucketInto(ctx, source, spool, state, client); err != nil {
		return Export{}, err
	}
	return state.export(time.Now().UTC()), nil
}
