package app

import "testing"

func TestExtensionAllowed(t *testing.T) {
	allowed := []string{"/api/v1/capture/page", "/api/v1/goal/check", "/api/v1/goal/mark", "/api/v1/extension/state"}
	for _, r := range allowed {
		if !extensionAllowed("POST", r) {
			t.Errorf("extension token should reach %s", r)
		}
	}
	if extensionAllowed("DELETE", "/api/v1/workspaces/:id") {
		t.Error("extension token must not delete workspaces")
	}
}
