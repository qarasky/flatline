package main

import (
	"fmt"
	"os"
)

const version = "0.1.0"

func main() {
	os.Exit(run(os.Args[1:]))
}

func run(args []string) int {
	if len(args) == 0 {
		fmt.Fprintln(os.Stderr, "usage: flatline-backup <version>")
		return 2
	}
	switch args[0] {
	case "version":
		fmt.Printf("flatline-backup %s\n", version)
		return 0
	default:
		fmt.Fprintf(os.Stderr, "unknown command %q\n", args[0])
		return 2
	}
}
