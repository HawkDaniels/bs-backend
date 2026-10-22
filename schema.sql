-- Run this once in the Cloudflare dashboard: Storage & Databases -> D1 -> your database -> Console.
-- (Paste it all and press Execute. It is safe to run again: nothing is overwritten.)

CREATE TABLE IF NOT EXISTS users (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  username     TEXT    NOT NULL,
  lname        TEXT    NOT NULL UNIQUE,      -- lower-case username, used for uniqueness
  pass_salt    TEXT    NOT NULL,
  pass_hash    TEXT    NOT NULL,
  created_at   INTEGER NOT NULL,             -- milliseconds since 1970
  last_login   INTEGER,
  fails        INTEGER NOT NULL DEFAULT 0,   -- wrong passwords in a row
  locked_until INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT    PRIMARY KEY,            -- SHA-256 of the cookie value; the cookie value itself is never stored
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);

-- One row per achievement earned.
CREATE TABLE IF NOT EXISTS achievements (
  user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  achievement_id TEXT    NOT NULL,
  earned_at      INTEGER NOT NULL,
  PRIMARY KEY (user_id, achievement_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS achievements_by_id ON achievements(achievement_id);  -- rarity and leaderboards

CREATE TABLE IF NOT EXISTS quest_progress (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  quest_id   TEXT    NOT NULL,
  state      TEXT    NOT NULL,               -- small JSON object
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, quest_id)
) WITHOUT ROWID;

-- Attempt counters for rate limiting. k holds a salted hash, never a plain address.
CREATE TABLE IF NOT EXISTS throttle (
  k     TEXT    PRIMARY KEY,
  n     INTEGER NOT NULL,
  start INTEGER NOT NULL
);
