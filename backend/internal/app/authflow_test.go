package app

import (
	"context"
	"testing"
)

func TestCheckPassword(t *testing.T) {
	cases := []struct {
		pw string
		ok bool
	}{
		{"Short1!", false},             // too short
		{"alllowercase1!", false},      // no uppercase
		{"NoNumbers!!", false},         // no number
		{"NoSymbols123", false},        // no symbol
		{"MyPassword1!", false},        // contains a common password
		{"Priya2026!x", false},         // contains the name
		{"Strong#Coffee42", true},      // meets every rule
		{"blue Ocean 7 Tiles", true},   // a space counts as a symbol
	}
	for _, c := range cases {
		if err := checkPassword(c.pw, "someone@example.com", "Priya Shah"); (err == nil) != c.ok {
			t.Errorf("checkPassword(%q) ok=%v, want %v (err %v)", c.pw, err == nil, c.ok, err)
		}
	}
	if checkPassword("Someone#2026x", "someone@example.com", "") == nil {
		t.Error("password containing the email name was accepted")
	}
}

func TestCheckName(t *testing.T) {
	for name, ok := range map[string]bool{"Priya Shah": true, "Jean-Luc O'Neil": true, "  A  ": false, "<script>": false, "Ana2": false} {
		if _, err := checkName(name); (err == nil) != ok {
			t.Errorf("checkName(%q) ok=%v, want %v", name, err == nil, ok)
		}
	}
}

func TestCheckEmailFormat(t *testing.T) {
	ctx := context.Background()
	for _, e := range []string{"not-an-email", "a@b", "Name <a@example.com>", "x@mailinator.com"} {
		if _, err := checkEmail(ctx, e); err == nil {
			t.Errorf("checkEmail(%q) accepted a bad address", e)
		}
	}
}

func TestSafeNextPath(t *testing.T) {
	for in, want := range map[string]string{"/w/1": "/w/1", "//evil.com": "/workspaces", "https://evil.com": "/workspaces", "/\\evil": "/workspaces", "": "/workspaces"} {
		if got := safeNextPath(in); got != want {
			t.Errorf("safeNextPath(%q)=%q, want %q", in, got, want)
		}
	}
}
