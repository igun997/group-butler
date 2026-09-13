package main

import "time"

func mustDate(iso string) time.Time {
	t, err := time.Parse("2006-01-02", iso)
	if err != nil {
		panic(err)
	}
	return t
}
