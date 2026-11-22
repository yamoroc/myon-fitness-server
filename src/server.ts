import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { createApp } from "./app";
import { bundledExercises } from "./builtin";
import { type Config, ConfigError, readConfig } from "./config";
import { openDb, seedExercises } from "./db";
import { snapshotIfDue } from "./snapshot";

/** The data server both entry points share: main.ts (Myon's, with the AI-coach relay) and selfhost.ts. */

/** The environment's config, or exit with the reason. */
export function configOrExit(): Config {
  try {
    return readConfig(process.env);
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    console.error(e.message);
    process.exit(1);
  }
}

/** Opens (and migrates) the database and builds the API. If bundled exercises exist locally (the private app repo),
 *  an empty server seeds them; a public self-hosted server starts empty and receives them from the app on connect. */
export function openServer(cfg: Config) {
  const db = openDb(join(cfg.dataDir, "fitness.db"));
  const seeded = seedExercises(db, bundledExercises());
  if (seeded) console.log(`seeded ${seeded} bundled exercises`);
  const shift = todayShiftMs();
  const app = createApp({
    db, mediaDir: join(cfg.dataDir, "media"), tokens: cfg.tokens,
    ...(shift ? { now: () => new Date(Date.now() + shift) } : {}),
  });
  return { db, app };
}

/** Test instances only: FITNESS_TODAY=YYYY-MM-DD moves the clock by whole days so that date is "today" (UTC+8), for
 *  simulator E2E runs that cross days. Needs its own FITNESS_DATA_DIR. */
function todayShiftMs(): number {
  const t = process.env.FITNESS_TODAY;
  if (!t) return 0;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(t) || Number.isNaN(Date.parse(t))) throw new Error("FITNESS_TODAY must be YYYY-MM-DD");
  if (!process.env.FITNESS_DATA_DIR) throw new Error("FITNESS_TODAY needs FITNESS_DATA_DIR (never the real data)");
  const real = new Date(Date.now() + 8 * 3_600_000).toISOString().slice(0, 10);
  console.warn(`FITNESS_TODAY=${t}: today is shifted from ${real}`);
  return Date.parse(t) - Date.parse(real);
}

/** A clean daily copy of each live WAL database from 04:00 local (14 kept, in <dataDir>/snapshots); checked every
 *  5 minutes. */
export function startSnapshots(dataDir: string, dbs: [string, Database][]) {
  const dir = join(dataDir, "snapshots");
  const maybe = () => {
    if (new Date().getHours() < 4) return;
    for (const [name, d] of dbs) {
      try {
        const p = snapshotIfDue(d, dir, new Date(), 14, name);
        if (p) console.log(`snapshot written: ${p}`);
      } catch (e) {
        console.error(`snapshot of ${name} failed`, e);
      }
    }
  };
  setInterval(maybe, 5 * 60 * 1000);
  maybe();
}

export function listen(app: { fetch: (r: Request) => Response | Promise<Response> }, cfg: Config, what: string) {
  Bun.serve({ hostname: cfg.host, port: cfg.port, fetch: app.fetch, maxRequestBodySize: 6 * 1024 * 1024,
    idleTimeout: 200 }); // coach replies with thinking can take a minute or more
  console.log(`${what} listening on ${cfg.host}:${cfg.port}`);
}
