package main

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
)

// PostgresMetadata is collected from the same snapshot that produces the
// dump. Extensions and table names are recorded for restore prerequisites.
type PostgresMetadata struct {
	ServerVersion string
	ClientVersion string
	Extensions    []string
	Tables        []string
}

// PostgresSnapshot is an open read-only repeatable-read session. The snapshot
// is released when Close runs, so it must stay open while both the dump and
// the table counts are taken.
type PostgresSnapshot interface {
	ID() string
	Metadata(ctx context.Context) (PostgresMetadata, error)
	TableCounts(ctx context.Context, tables []string) (map[string]int64, error)
	Close() error
}

// PostgresExecutor is injectable so tests can prove argument safety and
// snapshot consistency without a Docker daemon.
type PostgresExecutor interface {
	OpenSnapshot(ctx context.Context, source PostgresSource, database string) (PostgresSnapshot, error)
	Dump(ctx context.Context, source PostgresSource, database, snapshotID string, output io.Writer) error
	Globals(ctx context.Context, source PostgresSource, output io.Writer) error
}

type dockerPostgresExecutor struct {
	binary string
}

func (d dockerPostgresExecutor) docker() string {
	if d.binary == "" {
		return "docker"
	}
	return d.binary
}

func (d dockerPostgresExecutor) OpenSnapshot(ctx context.Context, source PostgresSource, database string) (PostgresSnapshot, error) {
	command := exec.CommandContext(ctx, d.docker(), psqlArgs(source, database)...)
	stdin, err := command.StdinPipe()
	if err != nil {
		return nil, errors.New("open postgres session")
	}
	stdout, err := command.StdoutPipe()
	if err != nil {
		return nil, errors.New("open postgres session")
	}
	command.Stderr = &limitedBuffer{limit: 4096}
	if err := command.Start(); err != nil {
		return nil, errors.New("start postgres session")
	}

	snapshot := &psqlSnapshot{
		ctx:       ctx,
		command:   command,
		stdin:     stdin,
		stdout:    bufio.NewReader(stdout),
		docker:    d.docker(),
		container: source.Container,
	}
	if _, err := io.WriteString(stdin,
		"BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;\nSELECT pg_export_snapshot();\n\\echo "+queryMarker+"\n"); err != nil {
		_ = snapshot.Close()
		return nil, errors.New("open postgres snapshot")
	}
	lines, err := snapshot.readUntilMarker()
	if err != nil {
		_ = snapshot.Close()
		return nil, errors.New("open postgres snapshot")
	}
	for index := len(lines) - 1; index >= 0; index-- {
		if value := strings.TrimSpace(lines[index]); value != "" {
			snapshot.id = value
			break
		}
	}
	if snapshot.id == "" {
		_ = snapshot.Close()
		return nil, errors.New("postgres snapshot id was empty")
	}
	return snapshot, nil
}

const queryMarker = "__FLATLINE_QUERY_DONE__"

type psqlSnapshot struct {
	ctx       context.Context
	command   *exec.Cmd
	stdin     io.WriteCloser
	stdout    *bufio.Reader
	docker    string
	container string
	id        string

	closeOnce sync.Once
	closeErr  error
}

func (s *psqlSnapshot) ID() string { return s.id }

func (s *psqlSnapshot) readUntilMarker() ([]string, error) {
	var lines []string
	for {
		line, err := s.stdout.ReadString('\n')
		if err != nil {
			return nil, err
		}
		line = strings.TrimRight(line, "\r\n")
		if line == queryMarker {
			return lines, nil
		}
		lines = append(lines, line)
	}
}

func (s *psqlSnapshot) query(sql string) ([]string, error) {
	if _, err := io.WriteString(s.stdin, sql+";\n\\echo "+queryMarker+"\n"); err != nil {
		return nil, err
	}
	return s.readUntilMarker()
}

func (s *psqlSnapshot) Metadata(ctx context.Context) (PostgresMetadata, error) {
	server, err := s.query("SHOW server_version")
	if err != nil || len(server) == 0 {
		return PostgresMetadata{}, errors.New("read postgres server version")
	}
	extensions, err := s.query("SELECT extname FROM pg_extension ORDER BY extname")
	if err != nil {
		return PostgresMetadata{}, errors.New("read postgres extensions")
	}
	tables, err := s.query(
		"SELECT format('%I.%I', schemaname, tablename) FROM pg_tables " +
			"WHERE schemaname NOT IN ('pg_catalog', 'information_schema') ORDER BY 1")
	if err != nil {
		return PostgresMetadata{}, errors.New("read postgres tables")
	}

	clientVersion := ""
	command := exec.CommandContext(ctx, s.docker, "exec", "--", s.container, "psql", "--version")
	if output, err := command.Output(); err == nil {
		clientVersion = lastField(string(output))
	}

	return PostgresMetadata{
		ServerVersion: strings.TrimSpace(server[0]),
		ClientVersion: clientVersion,
		Extensions:    nonEmpty(extensions),
		Tables:        nonEmpty(tables),
	}, nil
}

func (s *psqlSnapshot) TableCounts(ctx context.Context, tables []string) (map[string]int64, error) {
	counts := make(map[string]int64, len(tables))
	if len(tables) == 0 {
		return counts, nil
	}

	lines, err := s.query(buildCountQuery(tables) + " ORDER BY 1")
	if err != nil {
		return nil, errors.New("read postgres table counts")
	}
	for _, line := range lines {
		fields := strings.Split(line, "\t")
		if len(fields) != 2 {
			return nil, errors.New("read postgres table counts")
		}
		var count int64
		if _, err := fmt.Sscanf(fields[1], "%d", &count); err != nil {
			return nil, errors.New("read postgres table counts")
		}
		counts[fields[0]] = count
	}
	return counts, nil
}

func (s *psqlSnapshot) Close() error {
	s.closeOnce.Do(func() {
		_, _ = io.WriteString(s.stdin, "COMMIT;\n\\q\n")
		_ = s.stdin.Close()
		if err := s.command.Wait(); err != nil {
			s.closeErr = err
		}
	})
	return s.closeErr
}

func (d dockerPostgresExecutor) Dump(ctx context.Context, source PostgresSource, database, snapshotID string, output io.Writer) error {
	return d.stream(ctx, dumpArgs(source, database, snapshotID), output)
}

func (d dockerPostgresExecutor) Globals(ctx context.Context, source PostgresSource, output io.Writer) error {
	return d.stream(ctx, globalsArgs(source), output)
}

func (d dockerPostgresExecutor) stream(ctx context.Context, args []string, output io.Writer) error {
	command := exec.CommandContext(ctx, d.docker(), args...)
	command.Stderr = &limitedBuffer{limit: 2048}
	stdout, err := command.StdoutPipe()
	if err != nil {
		return errors.New("start database command")
	}
	if err := command.Start(); err != nil {
		return errors.New("start database command")
	}
	_, copyErr := io.Copy(output, stdout)
	if copyErr != nil {
		// The child blocks once the pipe is full after the spool cap is hit.
		// Kill it before Wait so a bounded spool failure is reported promptly.
		_ = command.Process.Kill()
		_ = command.Wait()
		return copyErr
	}
	waitErr := command.Wait()
	if waitErr != nil {
		return errors.New("database command failed")
	}
	return nil
}

// exportPostgresInto appends one source's databases (and optional globals)
// to the shared export state.
func exportPostgresInto(ctx context.Context, source PostgresSource, spool *Spool, state *exportState, executor PostgresExecutor) error {
	for _, database := range source.Databases {
		snapshot, err := executor.OpenSnapshot(ctx, source, database)
		if err != nil {
			return fmt.Errorf("open postgres snapshot for %q", database)
		}

		metadata, metaErr := snapshot.Metadata(ctx)
		var counts map[string]int64
		if metaErr == nil {
			counts, metaErr = snapshot.TableCounts(ctx, metadata.Tables)
		}
		if metaErr != nil {
			_ = snapshot.Close()
			return fmt.Errorf("read postgres metadata for %q", database)
		}

		path := state.databasePath()
		writer, err := spool.Create(path)
		if err != nil {
			_ = snapshot.Close()
			return err
		}
		dumpErr := executor.Dump(ctx, source, database, snapshot.ID(), writer)
		closeErr := writer.Close()
		_ = snapshot.Close()
		if dumpErr == nil {
			dumpErr = closeErr
		}
		if dumpErr != nil {
			_ = spool.Remove(path)
			if errors.Is(dumpErr, ErrSpoolLimit) {
				return dumpErr
			}
			return fmt.Errorf("export postgres database %q failed", database)
		}

		state.addFile(ExportFile{
			Path:       path,
			SourcePath: spoolPath(spool, path),
			Kind:       kindPostgres,
			Database:   database,
		})
		state.addPostgres(PostgresSummary{
			Container:     source.Container,
			Database:      database,
			ServerVersion: metadata.ServerVersion,
			ClientVersion: metadata.ClientVersion,
			Extensions:    metadata.Extensions,
			TableCounts:   counts,
		})
	}

	if source.IncludeGlobals {
		path := state.globalsPath()
		writer, err := spool.Create(path)
		if err != nil {
			return err
		}
		globalsErr := executor.Globals(ctx, source, writer)
		closeErr := writer.Close()
		if globalsErr == nil {
			globalsErr = closeErr
		}
		if globalsErr != nil {
			_ = spool.Remove(path)
			if errors.Is(globalsErr, ErrSpoolLimit) {
				return globalsErr
			}
			return errors.New("export postgres globals failed")
		}
		state.addFile(ExportFile{
			Path:       path,
			SourcePath: spoolPath(spool, path),
			Kind:       kindGlobals,
		})
	}

	return nil
}

func spoolPath(spool *Spool, name string) string {
	return filepath.Join(spool.Root(), name)
}

func nonEmpty(lines []string) []string {
	result := make([]string, 0, len(lines))
	for _, line := range lines {
		if trimmed := strings.TrimSpace(line); trimmed != "" {
			result = append(result, trimmed)
		}
	}
	return result
}

// psqlArgs passes every value as its own argument; the database name is
// bound with `--dbname=` so a leading dash or shell metacharacter is data,
// never an option or command.
func psqlArgs(source PostgresSource, database string) []string {
	return []string{
		"exec", "-i", "--", source.Container,
		"psql", "-X", "-q", "-A", "-t", "-F", "\t", "-v", "ON_ERROR_STOP=1",
		"-U", source.User, "--dbname=" + database,
	}
}

func dumpArgs(source PostgresSource, database, snapshotID string) []string {
	return []string{
		"exec", "--", source.Container,
		"pg_dump", "-Fc", "--snapshot=" + snapshotID,
		"--dbname=" + database, "-U", source.User,
	}
}

func globalsArgs(source PostgresSource) []string {
	return []string{"exec", "--", source.Container, "pg_dumpall", "--globals-only", "-U", source.User}
}

// buildCountQuery uses table names already quoted server-side with
// format('%I.%I'). Only the display literal is additionally escaped here.
func buildCountQuery(tables []string) string {
	parts := make([]string, 0, len(tables))
	for _, table := range tables {
		display := strings.ReplaceAll(table, "'", "''")
		parts = append(parts, fmt.Sprintf("SELECT '%s' AS name, count(*)::bigint AS rows FROM %s", display, table))
	}
	return strings.Join(parts, " UNION ALL ")
}

func lastField(line string) string {
	fields := strings.Fields(strings.TrimSpace(line))
	if len(fields) == 0 {
		return ""
	}
	return strings.TrimSuffix(fields[len(fields)-1], ",")
}

// limitedBuffer keeps only the first bytes of stderr. Its contents are never
// included in API-visible errors.
type limitedBuffer struct {
	limit int
	mu    sync.Mutex
	data  []byte
}

func (b *limitedBuffer) Write(data []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if remaining := b.limit - len(b.data); remaining > 0 {
		if len(data) > remaining {
			b.data = append(b.data, data[:remaining]...)
		} else {
			b.data = append(b.data, data...)
		}
	}
	return len(data), nil
}
