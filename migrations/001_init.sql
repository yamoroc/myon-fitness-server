CREATE TABLE exercises (
  id          TEXT PRIMARY KEY,
  data        TEXT NOT NULL,           -- JSON: ExerciseInput
  archived    INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  updated_by  TEXT NOT NULL
);

CREATE TABLE sessions (
  id          TEXT PRIMARY KEY,
  date        TEXT NOT NULL,           -- YYYY-MM-DD, local (UTC+8) calendar day
  data        TEXT NOT NULL,           -- JSON: SessionInput
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  updated_by  TEXT NOT NULL
);
CREATE INDEX sessions_date ON sessions(date);

CREATE TABLE workouts (
  id          TEXT PRIMARY KEY,        -- client-generated UUID (idempotent upload)
  session_id  TEXT,
  date        TEXT NOT NULL,
  data        TEXT NOT NULL,           -- JSON: WorkoutInput
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  updated_by  TEXT NOT NULL
);
CREATE INDEX workouts_date ON workouts(date);

CREATE TABLE changes (
  seq         INTEGER PRIMARY KEY AUTOINCREMENT,
  at          TEXT NOT NULL,
  actor       TEXT NOT NULL,           -- app | coach
  entity      TEXT NOT NULL,           -- exercise | session | workout
  entity_id   TEXT NOT NULL,
  action      TEXT NOT NULL,           -- create | update | delete | archive
  before      TEXT,
  after       TEXT
);
