-- Plan lock (read-only master template) and shelf (reversible archive hidden from the active list and default coach reads).
ALTER TABLE plans ADD COLUMN locked INTEGER NOT NULL DEFAULT 0;
ALTER TABLE plans ADD COLUMN shelved INTEGER NOT NULL DEFAULT 0;
