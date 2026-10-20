package main

import (
	"errors"
	"testing"
)

func TestSpoolCountsIntermediateAndBundleBytes(t *testing.T) {
	spool, err := NewSpool(t.TempDir(), 100)
	if err != nil {
		t.Fatal(err)
	}

	first, err := spool.Create("intermediate.dump")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := first.Write(make([]byte, 60)); err != nil {
		t.Fatal(err)
	}
	if err := first.Close(); err != nil {
		t.Fatal(err)
	}
	if spool.Used() != 60 {
		t.Fatalf("used = %d", spool.Used())
	}

	second, err := spool.Create("bundle.age")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := second.Write(make([]byte, 41)); !errors.Is(err, ErrSpoolLimit) {
		t.Fatalf("expected the cap to reject the write, got %v", err)
	}
	// Closing a failed writer removes its partial file and releases its bytes.
	if err := second.Close(); err != nil && !errors.Is(err, ErrSpoolLimit) {
		t.Fatalf("close failed writer: %v", err)
	}
	if spool.Used() != 60 {
		t.Fatalf("failed writer leaked bytes: %d", spool.Used())
	}

	third, err := spool.Create("bundle.age")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := third.Write(make([]byte, 40)); err != nil {
		t.Fatal(err)
	}
	if err := third.Close(); err != nil {
		t.Fatal(err)
	}
	if spool.Used() != 100 {
		t.Fatalf("exactly full spool = %d", spool.Used())
	}

	if _, err := spool.Create("bundle.age"); err == nil {
		t.Fatal("existing spool names must not be truncated")
	}

	if err := spool.Remove("bundle.age"); err != nil {
		t.Fatal(err)
	}
	if spool.Used() != 60 {
		t.Fatalf("remove did not release bytes: %d", spool.Used())
	}

	fourth, err := spool.Create("next.age")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := fourth.Write(make([]byte, 41)); !errors.Is(err, ErrSpoolLimit) {
		t.Fatalf("retained intermediate bytes must still count: %v", err)
	}
	_ = fourth.Close()
}
