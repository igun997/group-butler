package main

import (
	"fmt"
	"strings"
	"unicode"
)

// The WhatsApp address vocabulary the worker's surfaces need.
//
// WHY this is here rather than a protocol library's JID type: the group and send
// surfaces used to hold a WhatsApp client, so parsing an address was free at the
// edge of the library they already imported. They speak the Hermes bridge's
// contract instead — addresses arrive and leave as strings, exactly the ones
// WhatsApp reported — so what they need is not a protocol type but three rules:
// which server an address names, which two addresses name one account, and how to
// echo an address back. This is deliberately not a second general JID library: it
// splits the one "@", strips the one device suffix, and rewrites nothing else.
//
// The worker holds no session (main.go), so nothing here is a protocol type and
// nothing else imports one: a stored address and a bridge answer are the same
// strings, and this file is the whole of the worker's address handling.

// The servers this worker addresses, by the roles they play.
const (
	// groupServer names a group chat: `120363043123456789@g.us`.
	groupServer = "g.us"
	// userServer is the phone-number address of an account.
	userServer = "s.whatsapp.net"
	// hiddenUserServer is the LID address of the same account, which is how a
	// group that hides phone numbers lists its members.
	hiddenUserServer = "lid"
	// legacyUserServer is the older phone-number server. WhatsApp still writes it
	// on some stored values, and the two spellings are the same account.
	legacyUserServer = "c.us"
)

// waAddress is a WhatsApp address split into the two parts the server routes by.
// The parts are kept verbatim: an address is echoed to the caller, and only the
// comparisons below fold one spelling of an account into another.
type waAddress struct {
	user   string
	server string
}

// parseAddress splits an address into its user and server. A device suffix
// (`62811:12@s.whatsapp.net`) identifies a session of one account rather than a
// different account, so it is dropped here — that is what makes the two spellings
// of one sender compare equal in every check below.
func parseAddress(raw string) (waAddress, error) {
	address := strings.TrimSpace(raw)
	user, server, ok := strings.Cut(address, "@")
	if i := strings.IndexByte(user, ':'); i >= 0 {
		user = user[:i]
	}
	if !ok || user == "" || server == "" || !isAddressPart(user) || !isAddressPart(server) {
		return waAddress{}, fmt.Errorf("%q is not a WhatsApp address", raw)
	}
	return waAddress{user: user, server: server}, nil
}

// isAddressPart reports whether one half of an address is something WhatsApp could
// have written. The two halves are digits, letters and the few marks a server name
// or an id uses; a space, or the separators that structure the address itself,
// cannot appear inside one. This is deliberately not a character-class grammar: it
// is what keeps a malformed caller input from being echoed back as an address.
func isAddressPart(part string) bool {
	for _, r := range part {
		switch {
		case unicode.IsSpace(r), r == '/', r == '@', r == ',':
			return false
		}
	}
	return true
}

// String is the canonical spelling of the address, which is also what the routes
// echo back as the group they were asked about.
func (a waAddress) String() string {
	if a.user == "" || a.server == "" {
		return ""
	}
	return a.user + "@" + a.server
}

// isGroup reports whether the address names a group chat.
func (a waAddress) isGroup() bool { return a.server == groupServer }

// isUser reports whether the address names a person: their phone JID, or the LID
// a group that hides phone numbers lists them under.
func (a waAddress) isUser() bool { return a.server == userServer || a.server == hiddenUserServer }

// normalizeAddress reduces an address to the account it names: no device suffix,
// no surrounding space, one case. An address this worker cannot parse is returned
// as it came (minus space and case) rather than emptied, so two identical
// unparsable strings still compare equal — the comparison must never invent a
// match, but it must not lose one either.
func normalizeAddress(raw string) string {
	if address, err := parseAddress(raw); err == nil {
		return address.String()
	}
	return strings.ToLower(strings.TrimSpace(raw))
}

// sameAccount reports whether two addresses name the same account. An empty or
// unusable address matches nothing: a group read must not conclude that the
// linked account is an admin because both sides of the comparison were blank.
func sameAccount(one, other string) bool {
	address := normalizeAddress(one)
	return address != "" && address == normalizeAddress(other)
}
