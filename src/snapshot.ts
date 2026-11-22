import type { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

/** Local (machine timezone) YYYYMMDD. */
const stamp = (d: Date) =>
  `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;

/**
 * Write a consistent copy of a live DB (VACUUM INTO) once per day, as `<name>-YYYYMMDD.db`, so the 04:30 tarball of ~/data
 * always contains a clean snapshot even if it catches the WAL mid-write. Keeps the newest `keep` files.
 * Returns the path written, or null if today's snapshot already exists.
 */
export function snapshotIfDue(db: Database, dir: string, now = new Date(), keep = 14, name = "fitness"): string | null {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${name}-${stamp(now)}.db`);
  if (existsSync(path)) return null;
  db.query("VACUUM INTO ?").run(path);
  const files = readdirSync(dir).filter((f) => new RegExp(`^${name}-\\d{8}\\.db$`).test(f)).sort();
  for (const f of files.slice(0, Math.max(0, files.length - keep))) rmSync(join(dir, f));
  return path;
}
