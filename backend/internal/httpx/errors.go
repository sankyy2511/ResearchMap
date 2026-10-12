// Package httpx holds the Gin engine, middleware and the JSON error envelope
// that the frontend parses: {"error":{"code","message","details?"}} (frontend/lib/api/errors.ts).
package httpx

import (
	"errors"
	"log/slog"
	"net/http"

	"github.com/gin-gonic/gin"
)

// Error codes understood by the frontend (frontend/types/api.ts ApiErrorCode).
const (
	CodeBadRequest       = "bad_request"
	CodeUnauthorized     = "unauthorized"
	CodeForbidden        = "forbidden"
	CodeNotFound         = "not_found"
	CodeConflict         = "conflict"
	CodeValidationFailed = "validation_failed"
	CodeRateLimited      = "rate_limited"
	CodeAIUnavailable    = "ai_unavailable"
	CodeInternal         = "internal"
)

// Error is an API error with an HTTP status and a user-facing message.
type Error struct {
	Status  int
	Code    string
	Message string
	Details any // optional; e.g. the latest object on a 409 version conflict
}

func (e *Error) Error() string { return e.Code + ": " + e.Message }

func NewError(status int, code, msg string) *Error { return &Error{Status: status, Code: code, Message: msg} }

func BadRequest(msg string) *Error   { return NewError(http.StatusBadRequest, CodeBadRequest, msg) }
func Unauthorized(msg string) *Error { return NewError(http.StatusUnauthorized, CodeUnauthorized, msg) }
func Forbidden(msg string) *Error    { return NewError(http.StatusForbidden, CodeForbidden, msg) }
func NotFound(what string) *Error    { return NewError(http.StatusNotFound, CodeNotFound, what+" not found") }
func Validation(msg string) *Error {
	return NewError(http.StatusUnprocessableEntity, CodeValidationFailed, msg)
}
func RateLimited(msg string) *Error { return NewError(http.StatusTooManyRequests, CodeRateLimited, msg) }
func AIUnavailable(msg string) *Error {
	return NewError(http.StatusServiceUnavailable, CodeAIUnavailable, msg)
}

// Conflict returns a 409; latest is sent in error.details so the UI can replace its stale copy.
func Conflict(msg string, latest any) *Error {
	return &Error{Status: http.StatusConflict, Code: CodeConflict, Message: msg, Details: latest}
}

type envelope struct {
	Error envelopeBody `json:"error"`
}
type envelopeBody struct {
	Code    string `json:"code"`
	Message string `json:"message"`
	Details any    `json:"details,omitempty"`
}

// WriteError sends err as the standard envelope. Unknown errors are logged and hidden behind a
// generic 500 message so internal details never reach the client.
func WriteError(c *gin.Context, err error) {
	var apiErr *Error
	var tooBig *http.MaxBytesError
	switch {
	case errors.As(err, &apiErr):
	case errors.As(err, &tooBig):
		apiErr = NewError(http.StatusRequestEntityTooLarge, CodeBadRequest, "Request body is too large")
	default:
		slog.ErrorContext(c.Request.Context(), "unhandled error",
			"request_id", RequestID(c), "route", c.FullPath(), "err", err)
		apiErr = NewError(http.StatusInternalServerError, CodeInternal, "Something went wrong on the server")
	}
	c.AbortWithStatusJSON(apiErr.Status, envelope{envelopeBody{apiErr.Code, apiErr.Message, apiErr.Details}})
}

// H adapts a handler that returns an error into a gin.HandlerFunc.
func H(fn func(c *gin.Context) error) gin.HandlerFunc {
	return func(c *gin.Context) {
		if err := fn(c); err != nil {
			WriteError(c, err)
		}
	}
}
