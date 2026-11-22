-- Built-in plans synced from the app on demand when scheduled, so self-hosted servers do not need to ship plans.json.
CREATE TABLE presets (
  id         TEXT PRIMARY KEY,
  data       TEXT NOT NULL,            -- JSON: PlanInput
  updated_at TEXT NOT NULL
);
