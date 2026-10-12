package app

import (
	"crypto/tls"
	"fmt"
	"html"
	"log/slog"
	"mime"
	"net"
	"net/smtp"
	"strings"
	"time"
)

// sendCodeEmail sends a one-time code. Without SMTP settings (development) the code is only written to the log.
func (a *App) sendCodeEmail(to, name, code, purpose string) error {
	subject, intro := "Your Research Map sign-up code", "Use this code to confirm your email address and finish creating your account."
	if purpose == "reset" {
		subject, intro = "Your Research Map password reset code", "Use this code to set a new password for your account."
	}
	if a.cfg.SMTPUser == "" {
		slog.Warn("[MAIL] SMTP is not configured; email code written to the log instead", "to", to, "purpose", purpose, "code", code)
		return nil
	}
	greeting := "Hello,"
	if name = strings.TrimSpace(name); name != "" {
		greeting = "Hello " + html.EscapeString(name) + ","
	}
	plain := fmt.Sprintf("%s\n\n%s\n\nYour code: %s\n\nThe code is valid for 10 minutes. If you did not ask for it, you can ignore this email.\n\nResearch Map",
		strings.Trim(greeting, ","), intro, code)
	body := codeEmailHTML(greeting, intro, code)

	boundary := fmt.Sprintf("rm-%d", time.Now().UnixNano())
	var msg strings.Builder
	fmt.Fprintf(&msg, "From: %s\r\n", mime.QEncoding.Encode("utf-8", "Research Map")+" <"+a.cfg.MailFrom+">")
	fmt.Fprintf(&msg, "To: <%s>\r\n", to)
	fmt.Fprintf(&msg, "Subject: %s\r\n", mime.QEncoding.Encode("utf-8", subject))
	fmt.Fprintf(&msg, "Date: %s\r\n", time.Now().Format(time.RFC1123Z))
	fmt.Fprintf(&msg, "MIME-Version: 1.0\r\nContent-Type: multipart/alternative; boundary=%q\r\n\r\n", boundary)
	fmt.Fprintf(&msg, "--%s\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n%s\r\n", boundary, plain)
	fmt.Fprintf(&msg, "--%s\r\nContent-Type: text/html; charset=utf-8\r\n\r\n%s\r\n--%s--\r\n", boundary, body, boundary)
	return a.smtpSend(to, []byte(msg.String()))
}

// smtpSend uses STARTTLS on port 587 and direct TLS on port 465.
func (a *App) smtpSend(to string, msg []byte) error {
	addr := net.JoinHostPort(a.cfg.SMTPHost, a.cfg.SMTPPort)
	tlsCfg := &tls.Config{ServerName: a.cfg.SMTPHost}
	dialer := &net.Dialer{Timeout: 15 * time.Second}
	var conn net.Conn
	var err error
	if a.cfg.SMTPPort == "465" {
		conn, err = tls.DialWithDialer(dialer, "tcp", addr, tlsCfg)
	} else {
		conn, err = dialer.Dial("tcp", addr)
	}
	if err != nil {
		return err
	}
	_ = conn.SetDeadline(time.Now().Add(30 * time.Second))
	c, err := smtp.NewClient(conn, a.cfg.SMTPHost)
	if err != nil {
		conn.Close()
		return err
	}
	defer c.Close()
	if a.cfg.SMTPPort != "465" {
		if err := c.StartTLS(tlsCfg); err != nil {
			return err
		}
	}
	if err := c.Auth(smtp.PlainAuth("", a.cfg.SMTPUser, a.cfg.SMTPPassword, a.cfg.SMTPHost)); err != nil {
		return err
	}
	if err := c.Mail(a.cfg.MailFrom); err != nil {
		return err
	}
	if err := c.Rcpt(to); err != nil {
		return err
	}
	w, err := c.Data()
	if err != nil {
		return err
	}
	if _, err := w.Write(msg); err != nil {
		return err
	}
	if err := w.Close(); err != nil {
		return err
	}
	return c.Quit()
}

// codeEmailHTML uses the landing page colours: warm canvas, peach, yellow and sky.
func codeEmailHTML(greeting, intro, code string) string {
	return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<link href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;600;700&display=swap" rel="stylesheet"></head>
<body style="margin:0;padding:0;background:#faf8f5;font-family:Poppins,Arial,Helvetica,sans-serif;color:#12151c">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#faf8f5;padding:32px 12px">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border:1px solid #e6e2dc;border-radius:24px;overflow:hidden">
<tr><td style="height:8px;background:linear-gradient(90deg,#fbcfb6,#fde3b0,#bfe2f5);background-color:#fde3b0"></td></tr>
<tr><td style="padding:32px 32px 8px 32px">
<p style="margin:0;font-size:18px;font-weight:700;color:#12151c">Research Map</p>
</td></tr>
<tr><td style="padding:16px 32px 0 32px">
<p style="margin:0 0 12px 0;font-size:15px;line-height:24px">` + greeting + `</p>
<p style="margin:0;font-size:15px;line-height:24px;color:#2d323c">` + intro + `</p>
</td></tr>
<tr><td align="center" style="padding:28px 32px">
<div style="display:inline-block;background:#fff5e1;border:1px solid #fde3b0;border-radius:16px;padding:16px 28px;font-size:32px;font-weight:700;letter-spacing:10px;color:#12151c">` + code + `</div>
</td></tr>
<tr><td style="padding:0 32px 32px 32px">
<p style="margin:0;font-size:13px;line-height:21px;color:#666b75">The code is valid for 10 minutes. If you did not ask for this code, you can safely ignore this email. Nobody can sign in without it.</p>
</td></tr>
</table>
<p style="margin:16px 0 0 0;font-size:12px;color:#666b75">Research Map. Your research, organised on one canvas.</p>
</td></tr></table></body></html>`
}
