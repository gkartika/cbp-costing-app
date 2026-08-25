-- Up Migration

CREATE TABLE roles (
  role_id     TEXT PRIMARY KEY,
  role_name   TEXT NOT NULL UNIQUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE users (
  user_id               TEXT PRIMARY KEY,
  username              TEXT NOT NULL UNIQUE,
  password_hash         TEXT NOT NULL,
  display_name          TEXT NOT NULL,
  active                BOOLEAN NOT NULL DEFAULT TRUE,
  must_reset_password   BOOLEAN NOT NULL DEFAULT FALSE,
  created_by            TEXT REFERENCES users(user_id),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE user_roles (
  user_role_id  TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(user_id),
  role_id       TEXT NOT NULL REFERENCES roles(role_id),
  valid_from    TIMESTAMPTZ NOT NULL DEFAULT now(),
  valid_to      TIMESTAMPTZ,
  created_by    TEXT REFERENCES users(user_id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Only one active (non end-dated) assignment of a given role per user
CREATE UNIQUE INDEX user_roles_active_unique
  ON user_roles (user_id, role_id)
  WHERE valid_to IS NULL;

CREATE TABLE sessions (
  session_id    TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(user_id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at    TIMESTAMPTZ NOT NULL,
  revoked_at    TIMESTAMPTZ
);

CREATE INDEX sessions_user_id_idx ON sessions (user_id);

CREATE TABLE password_reset_tokens (
  token_id      TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(user_id),
  token_hash    TEXT NOT NULL UNIQUE,
  expires_at    TIMESTAMPTZ NOT NULL,
  used_at       TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Down Migration

DROP TABLE IF EXISTS password_reset_tokens;
DROP TABLE IF EXISTS sessions;
DROP TABLE IF EXISTS user_roles;
DROP TABLE IF EXISTS users;
DROP TABLE IF EXISTS roles;
