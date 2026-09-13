package main

import (
	"crypto/rand"
	"math/big"
)

// nanoidAlphabet is the reference worker's shuffled 64-character alphabet, kept
// verbatim so ids minted here stay interchangeable with the ones it produced.
const nanoidAlphabet = "useandom-26T198340PX75pxJACKVERYMINDBUSHWOLF_GQZbfghjklqvwyzrict"

// newID returns a 21-character nanoid-compatible id.
func newID() string {
	const size = 21
	out := make([]byte, size)
	max := big.NewInt(int64(len(nanoidAlphabet)))
	for i := 0; i < size; i++ {
		n, err := rand.Int(rand.Reader, max)
		if err != nil {
			out[i] = nanoidAlphabet[0]
			continue
		}
		out[i] = nanoidAlphabet[n.Int64()]
	}
	return string(out)
}
