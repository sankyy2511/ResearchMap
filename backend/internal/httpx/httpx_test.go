package httpx

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
)

func testEngine(t *testing.T) *gin.Engine {
	t.Helper()
	gin.SetMode(gin.TestMode)
	e, err := NewEngine(EngineOptions{MaxBodyBytes: 64, TrustedProxies: []string{"127.0.0.1"}})
	if err != nil {
		t.Fatal(err)
	}
	e.GET("/ok", func(c *gin.Context) { c.JSON(200, gin.H{"ok": true}) })
	e.GET("/api-error", H(func(c *gin.Context) error { return Conflict("stale", gin.H{"version": 3}) }))
	e.GET("/plain-error", H(func(c *gin.Context) error { return errors.New("db password=secret leaked") }))
	e.GET("/panic", func(c *gin.Context) { panic("boom") })
	e.POST("/echo", H(func(c *gin.Context) error {
		if _, err := io.ReadAll(c.Request.Body); err != nil {
			return err
		}
		c.Status(204)
		return nil
	}))
	e.GET("/item/:id", func(c *gin.Context) { c.String(200, c.Param("id")) })
	return e
}

type env struct {
	Error struct {
		Code    string         `json:"code"`
		Message string         `json:"message"`
		Details map[string]any `json:"details"`
	} `json:"error"`
}

func do(e *gin.Engine, method, path, body string) (*httptest.ResponseRecorder, env) {
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	if body == "" {
		req = httptest.NewRequest(method, path, nil)
	}
	w := httptest.NewRecorder()
	e.ServeHTTP(w, req)
	var out env
	_ = json.Unmarshal(w.Body.Bytes(), &out)
	return w, out
}

func TestEnvelopes(t *testing.T) {
	e := testEngine(t)
	cases := []struct {
		method, path, body string
		status             int
		code               string
	}{
		{"GET", "/missing", "", 404, CodeNotFound},
		{"POST", "/ok", "", 405, CodeBadRequest},
		{"GET", "/api-error", "", 409, CodeConflict},
		{"GET", "/plain-error", "", 500, CodeInternal},
		{"GET", "/panic", "", 500, CodeInternal},
		{"POST", "/echo", strings.Repeat("x", 100), 413, CodeBadRequest},
	}
	for _, tc := range cases {
		w, out := do(e, tc.method, tc.path, tc.body)
		if w.Code != tc.status || out.Error.Code != tc.code {
			t.Errorf("%s %s: got %d %q, want %d %q (body %s)", tc.method, tc.path, w.Code, out.Error.Code, tc.status, tc.code, w.Body)
		}
		if strings.Contains(w.Body.String(), "secret") || strings.Contains(w.Body.String(), "boom") {
			t.Errorf("%s leaked internal detail: %s", tc.path, w.Body)
		}
	}
	_, out := do(e, "GET", "/api-error", "")
	if out.Error.Details["version"] != float64(3) {
		t.Errorf("409 details missing latest object: %+v", out.Error.Details)
	}
}

func TestBodyUnderLimitPasses(t *testing.T) {
	w, _ := do(testEngine(t), "POST", "/echo", "small")
	if w.Code != 204 {
		t.Fatalf("got %d", w.Code)
	}
}

func TestRequestID(t *testing.T) {
	e := testEngine(t)
	w, _ := do(e, "GET", "/ok", "")
	if len(w.Header().Get("X-Request-ID")) != 24 {
		t.Fatalf("missing generated request id: %q", w.Header().Get("X-Request-ID"))
	}
	req := httptest.NewRequest("GET", "/ok", nil)
	req.Header.Set("X-Request-ID", "abcDEF123_-x")
	w2 := httptest.NewRecorder()
	e.ServeHTTP(w2, req)
	if w2.Header().Get("X-Request-ID") != "abcDEF123_-x" {
		t.Fatal("valid incoming id not reused")
	}
	req.Header.Set("X-Request-ID", "bad id\r\n")
	w3 := httptest.NewRecorder()
	e.ServeHTTP(w3, req)
	if w3.Header().Get("X-Request-ID") == "bad id\r\n" {
		t.Fatal("unsafe incoming id reused")
	}
}

func TestEncodedPathParam(t *testing.T) {
	req := httptest.NewRequest("GET", "/item/concept%3Amachine%2Flearning", nil)
	w := httptest.NewRecorder()
	testEngine(t).ServeHTTP(w, req)
	if w.Code != http.StatusOK || w.Body.String() != "concept:machine/learning" {
		t.Fatalf("got %d %q", w.Code, w.Body)
	}
}
