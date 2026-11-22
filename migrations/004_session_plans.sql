-- Sessions stop carrying content: a session is a plan on a day (date, planId, reminder, skipped). Sessions written
-- before this get a plan (see splitSessions in src/db.ts, run right after this file). A deleted plan that sessions
-- still point at (trained or past ones) is archived: hidden from 我的计划, kept so they still resolve.
ALTER TABLE plans ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;
