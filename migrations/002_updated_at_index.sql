CREATE INDEX sessions_updated_at ON sessions(updated_at);
CREATE INDEX workouts_updated_at ON workouts(updated_at);
CREATE INDEX workouts_session ON workouts(session_id);
