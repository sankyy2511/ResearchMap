package httpx

import (
	"net/http"

	"github.com/gin-gonic/gin"
)

type EngineOptions struct {
	Production     bool
	MaxBodyBytes   int64
	TrustedProxies []string
}

// NewEngine returns a Gin engine with the standard middleware and envelope 404/405 responses.
func NewEngine(o EngineOptions) (*gin.Engine, error) {
	if o.Production {
		gin.SetMode(gin.ReleaseMode)
	}
	e := gin.New()
	if err := e.SetTrustedProxies(o.TrustedProxies); err != nil {
		return nil, err
	}
	// Path params such as radar item ids ("concept:machine%2Flearning") arrive URL-encoded.
	e.UseRawPath = true
	e.UnescapePathValues = true
	e.RedirectTrailingSlash = false
	e.HandleMethodNotAllowed = true

	e.Use(RequestIDMiddleware(), LoggerMiddleware(), RecoveryMiddleware(),
		SecurityHeadersMiddleware(), BodyLimitMiddleware(o.MaxBodyBytes))

	e.NoRoute(func(c *gin.Context) {
		WriteError(c, NewError(http.StatusNotFound, CodeNotFound, "No route for "+c.Request.Method+" "+c.Request.URL.Path))
	})
	e.NoMethod(func(c *gin.Context) {
		WriteError(c, NewError(http.StatusMethodNotAllowed, CodeBadRequest, "Method not allowed"))
	})
	return e, nil
}
