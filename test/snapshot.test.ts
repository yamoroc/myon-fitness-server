import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db";
import { snapshotIfDue } from "../src/snapshot";

test("one snapshot per day, readable, pruned to keep", () => {
  const dir = mkdtempSync(join(tmpdir(), "fitness-snap-"));
  const db = openDb(join(dir, "live.db"));
  const snaps = join(dir, "snapshots");
  const p = snapshotIfDue(db, snaps, new Date(2026, 10, 18, 4, 0));
  expect(p).toEndWith("fitness-20261118.db");
  expect(snapshotIfDue(db, snaps, new Date(2026, 10, 18, 5, 0))).toBeNull();
  const copy = new Database(p!, { readonly: true });
  expect(copy.query("SELECT count(*) AS n FROM schema_migrations").get()).toEqual({ n: 6 });
  for (let d = 19; d <= 22; d++) snapshotIfDue(db, snaps, new Date(2026, 10, d, 4, 0), 3);
  expect(readdirSync(snaps).sort()).toEqual(["fitness-20261120.db", "fitness-20261121.db", "fitness-20261122.db"]);
});

test("a second database keeps its own snapshots and pruning", () => {
  const dir = mkdtempSync(join(tmpdir(), "fitness-snap-"));
  const db = openDb(join(dir, "live.db"));
  const coach = new Database(join(dir, "coach.db"), { create: true });
  coach.exec("PRAGMA journal_mode = WAL; CREATE TABLE usage (user TEXT); INSERT INTO usage VALUES ('a');");
  const snaps = join(dir, "snapshots");
  for (let d = 18; d <= 20; d++) {
    snapshotIfDue(db, snaps, new Date(2026, 10, d, 4, 0), 2);
    snapshotIfDue(coach, snaps, new Date(2026, 10, d, 4, 0), 2, "coach");
  }
  expect(readdirSync(snaps).sort()).toEqual(
    ["coach-20261119.db", "coach-20261120.db", "fitness-20261119.db", "fitness-20261120.db"]);
  const copy = new Database(join(snaps, "coach-20261120.db"), { readonly: true });
  expect(copy.query("SELECT user FROM usage").all()).toEqual([{ user: "a" }]);
});
