package main

import (
	"log"
	"os"
)

var logger = log.New(os.Stdout, "[wa-worker] ", log.LstdFlags|log.Lmsgprefix)

func logf(format string, args ...any) { logger.Printf(format, args...) }
