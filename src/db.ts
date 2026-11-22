import { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { builtinPlans, bundledExercises } from "./builtin";
import { ExerciseInput, SessionItem } from "./schemas";

const MIGRATIONS_DIR = join(import.meta.dir, "..", "migrations");

/** Data steps run in the same transaction right after the SQL file of the same name. */
const STEPS: Record<string, (db: Database) => void> = {
  "004_session_plans.sql": (db) => splitSessions(db),
  "005_exercise_slugs.sql": (db) => slugExercises(db),
};

export function openDb(path: string): Database {
  const db = new Database(path, { create: true, strict: true });
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  migrate(db);
  return db;
}

function migrate(db: Database) {
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
  const applied = new Set(
    db.query<{ name: string }, []>("SELECT name FROM schema_migrations").all().map((r) => r.name),
  );
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
  for (const f of files) {
    if (applied.has(f)) continue;
    const sql = readFileSync(join(MIGRATIONS_DIR, f), "utf8");
    db.transaction(() => {
      db.exec(sql);
      STEPS[f]?.(db);
      db.query("INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)").run(f, new Date().toISOString());
    })();
  }
}

/** Items as stored (schema defaults filled, schema key order), so the same content compares equal. */
const norm = (items: unknown) => JSON.stringify((Array.isArray(items) ? items : []).map((it) => {
  const r = SessionItem.safeParse(it);
  return r.success ? r.data : it;
}));

/**
 * Sessions written with their own content (title, note, items, difficulty) point at a plan instead: the one they came
 * from when the content still matches it (a built-in plan by its exercises only: its title may have been translated),
 * else a plan made from that content, one per distinct content. A made plan only past sessions use is archived.
 * Exported for the test.
 */
export function splitSessions(
  db: Database,
  today = new Date(Date.now() + 8 * 3_600_000).toISOString().slice(0, 10),
  presets = builtinPlans(),
) {
  type Row = { id: string; date: string; data: string };
  const t = new Date().toISOString();
  const plans = db.query<{ id: string; data: string }, []>("SELECT id, data FROM plans").all()
    .map((r) => ({ id: r.id, ...(JSON.parse(r.data) as { title: string; note?: string; items: unknown; difficulty?: string }) }));
  const builtin = new Map(presets.map((p) => [p.id, p]));
  const made = new Map<string, { id: string; future: boolean }>();
  for (const r of db.query<Row, []>("SELECT id, date, data FROM sessions").all()) {
    const d = JSON.parse(r.data) as Record<string, unknown>;
    if (!("items" in d)) continue;
    const title = String(d.title ?? ""), note = String(d.note ?? ""), items = norm(d.items);
    const difficulty = typeof d.difficulty === "string" ? d.difficulty : null;
    let planId = typeof d.planId === "string" ? d.planId : null;
    const same = (p: (typeof plans)[number]) => p.title === title && (p.note ?? "") === note && norm(p.items) === items
      && (p.difficulty ?? null) === difficulty;
    const mine = planId ? plans.find((p) => p.id === planId) : undefined;
    const keep = mine ? same(mine)
      : planId ? builtin.has(planId) && norm(builtin.get(planId)!.items) === items
        && (difficulty === null || builtin.get(planId)!.difficulty === difficulty) : false;
    if (!keep) {
      const key = JSON.stringify([title, note, items, difficulty]);
      let m = made.get(key);
      if (!m) {
        const found = plans.find(same);
        if (found) m = { id: found.id, future: true };
        else {
          m = { id: crypto.randomUUID(), future: false };
          const input = { title: title || "训练", note, items: JSON.parse(items), ...(d.difficulty ? { difficulty: d.difficulty } : {}) };
          db.query("INSERT INTO plans (id, data, created_at, updated_at, updated_by) VALUES (?, ?, ?, ?, 'app')")
            .run(m.id, JSON.stringify(input), t, t);
        }
        made.set(key, m);
      }
      if (r.date >= today) m.future = true;
      planId = m.id;
    }
    const out: Record<string, unknown> = { date: d.date, planId };
    for (const k of ["remindAt", "remindNote", "skipped"]) if (d[k] != null) out[k] = d[k];
    db.query("UPDATE sessions SET data = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(out), t, r.id);
  }
  for (const m of made.values()) if (!m.future) db.query("UPDATE plans SET archived = 1 WHERE id = ?").run(m.id);
}

/**
 * Exercises take the app's bundled ids (readable slugs, matched by name), so server mode runs on the same library as
 * the app's local mode: built-in plans and anything else written with bundled ids resolve the same way. Every
 * reference follows (plans, sessions, workouts, the change log); ids are swapped as whole JSON strings. Exercises the
 * app doesn't bundle keep their ids. Exported for the test.
 */
export function slugExercises(db: Database, bundled = bundledExercises()) {
  const slugs = new Map(bundled.map((e) => [e.name, e.id]));
  const rows = db.query<{ id: string; data: string }, []>("SELECT id, data FROM exercises").all();
  const taken = new Set(rows.map((r) => r.id));
  const map = new Map<string, string>();
  for (const r of rows) {
    const slug = slugs.get(String((JSON.parse(r.data) as { name?: unknown }).name ?? ""));
    if (!slug || slug === r.id || taken.has(slug)) continue;
    map.set(r.id, slug);
    taken.add(slug);
  }
  if (map.size === 0) return;
  const swap = (text: string) => {
    let t = text;
    for (const [from, to] of map) t = t.replaceAll(`"${from}"`, `"${to}"`);
    return t;
  };
  for (const [from, to] of map) db.query("UPDATE exercises SET id = ? WHERE id = ?").run(to, from);
  for (const table of ["plans", "sessions", "workouts"]) {
    for (const r of db.query<{ id: string; data: string }, []>(`SELECT id, data FROM ${table}`).all()) {
      const d = swap(r.data);
      if (d !== r.data) db.query(`UPDATE ${table} SET data = ? WHERE id = ?`).run(d, r.id);
    }
  }
  for (const r of db.query<{ seq: number; entity_id: string; before: string | null; after: string | null }, []>(
    "SELECT seq, entity_id, before, after FROM changes").all()) {
    const id = map.get(r.entity_id) ?? r.entity_id, before = r.before && swap(r.before), after = r.after && swap(r.after);
    if (id !== r.entity_id || before !== r.before || after !== r.after) {
      db.query("UPDATE changes SET entity_id = ?, before = ?, after = ? WHERE seq = ?").run(id, before, after, r.seq);
    }
  }
}

/**
 * A new server (no exercises at all) gets the app's bundled library under the same slugs, so it starts where the
 * app's local mode does and the built-in plans resolve. Never touches a server that has any exercise, archived ones
 * included. Entries that don't validate are skipped and reported. Returns how many were added.
 */
export function seedExercises(db: Database, bundled: { id: string; [k: string]: unknown }[], now = new Date()): number {
  const has = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM exercises").get()!.n;
  if (has || !bundled.length) return 0;
  const t = now.toISOString();
  const insert = db.query("INSERT INTO exercises (id, data, archived, created_at, updated_at, updated_by) VALUES (?, ?, 0, ?, ?, 'app')");
  let n = 0;
  db.transaction(() => {
    for (const { id, ...rest } of bundled) {
      const parsed = ExerciseInput.safeParse(rest);
      if (!id || !parsed.success) {
        console.error(`seed: skipped bundled exercise ${id || "(no id)"}: ${parsed.error?.message ?? "no id"}`);
        continue;
      }
      insert.run(id, JSON.stringify(parsed.data), t, t);
      n++;
    }
  })();
  return n;
}
