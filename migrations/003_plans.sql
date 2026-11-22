-- The user's own plans (我的计划): reusable content without a date. Adding one to a day copies it into a session
-- (session data carries planId).
CREATE TABLE plans (
  id          TEXT PRIMARY KEY,
  data        TEXT NOT NULL,           -- JSON: PlanInput
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  updated_by  TEXT NOT NULL
);
CREATE INDEX plans_updated_at ON plans(updated_at);
