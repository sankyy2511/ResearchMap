-- +goose Up
-- Google sign-in: accounts created with Google have no password.
ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;
ALTER TABLE users ADD COLUMN google_sub text UNIQUE;

-- One-time email codes for sign-up and password reset. A sign-up becomes a user only after the code is confirmed.
CREATE TABLE email_codes (
  email         text NOT NULL,
  purpose       text NOT NULL CHECK (purpose IN ('signup','reset')),
  code_hash     text NOT NULL,
  name          text,
  password_hash text,
  attempts      int NOT NULL DEFAULT 0,
  sent_at       timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  PRIMARY KEY (email, purpose)
);

-- +goose Down
DROP TABLE email_codes;
ALTER TABLE users DROP COLUMN google_sub;
