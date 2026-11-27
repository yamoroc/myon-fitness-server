import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkDurationCopy, checkTargetMinutes, estimate, estimateMinutes, topDurationItems } from "./estimate";
import { effectiveSets } from "./groups";
import { autoDifficulty } from "./difficulty";
import { builtinPlans, bundledMedia } from "./builtin";
import {
  Actor, Change, ErrorBody, Exercise, ExerciseInput, ExerciseSyncInput, ExerciseSyncResult, ListQuery, Pattern, Plan,
  PlanInput, Session, SessionInput, SessionItem, Workout, WorkoutInput,
} from "./schemas";

type Items = z.infer<typeof SessionItem>[];

export interface AppConfig {
  db: Database;
  mediaDir: string;
  tokens: Record<string, Actor>; // token -> actor
  /** Clock for the schedulable date range (tests pin it). */
  now?: () => Date;
}

/** Sessions can be scheduled from today to this many days ahead (same as the app, SessionLimits.daysAhead). */
export const DAYS_AHEAD = 14;
/** yyyy-mm-dd at UTC+`tz` hours, `offset` days from `t`. */
const dayAt = (t: Date, tz: number, offset = 0) => new Date(t.getTime() + tz * 3_600_000 + offset * 86_400_000).toISOString().slice(0, 10);

type Env = { Variables: { actor: Actor } };

type Row = { id: string; data: string; created_at: string; updated_at: string; updated_by: Actor };

const now = () => new Date().toISOString();
/** A row's stored input as of today's schema: fields added since it was written get their defaults. Unknown keys are
 *  kept; a row the schema no longer accepts (e.g. a limit tightened since) still gets the missing defaults. */
const stored = <T extends z.ZodTypeAny>(schema: T, data: string): z.infer<T> => {
  const raw = JSON.parse(data);
  const r = schema.safeParse(raw);
  if (r.success) return { ...raw, ...(r.data as object) };
  const defaults: Record<string, unknown> = {};
  if (schema instanceof z.ZodObject) {
    for (const [k, f] of Object.entries(schema.shape as Record<string, z.ZodTypeAny>)) {
      const d = f.safeParse(undefined);
      if (d.success && d.data !== undefined) defaults[k] = d.data;
    }
  }
  return { ...defaults, ...raw };
};
const IdParam = z.object({ id: z.string().openapi({ param: { name: "id", in: "path" } }) });
const json = <T extends z.ZodType>(schema: T, description: string) => ({
  content: { "application/json": { schema } },
  description,
});
const err = (description: string) => json(ErrorBody, description);
const security = [{ bearer: [] as string[] }];

const MEDIA_TYPES: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "video/mp4": "mp4" };
const EXT_TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", webp: "image/webp", mp4: "video/mp4" };

export function createApp(cfg: AppConfig) {
  const { db, mediaDir } = cfg;
  const clock = cfg.now ?? (() => new Date());
  mkdirSync(mediaDir, { recursive: true });

  const app = new OpenAPIHono<Env>({
    defaultHook: (result, c) => {
      if (!result.success) return c.json({ error: "validation_failed", details: z.treeifyError(result.error) }, 400);
    },
  });

  app.openAPIRegistry.registerComponent("securitySchemes", "bearer", { type: "http", scheme: "bearer" });

  app.get("/health", (c) => c.json({ ok: true }));
  app.doc31("/openapi.json", {
    openapi: "3.1.0",
    info: {
      title: "Fitness API",
      version: "1",
      description:
        "Backend for the 健身训练 iOS app. All numbers are explicit: sets, reps or seconds, tempo, rest. " +
        "Exercises are referenced by id from session items. Dates are local calendar days (UTC+8).",
    },
  });

  // ---- auth ----
  app.use("/v1/*", async (c, next) => {
    const h = c.req.header("authorization") ?? "";
    const token = h.startsWith("Bearer ") ? h.slice(7) : "";
    // Own keys only: "__proto__", "constructor" etc. would otherwise come back truthy from the prototype.
    const actor = token && Object.hasOwn(cfg.tokens, token) ? cfg.tokens[token] : undefined;
    if (!token || !actor) return c.json({ error: "unauthorized" }, 401);
    c.set("actor", actor);
    await next();
  });

  // ---- helpers ----
  const logChange = (actor: Actor, entity: string, entityId: string, action: string, before: unknown, after: unknown) =>
    db.query("INSERT INTO changes (at, actor, entity, entity_id, action, before, after) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(now(), actor, entity, entityId, action, before == null ? null : JSON.stringify(before), after == null ? null : JSON.stringify(after));

  const toExercise = (r: Row & { archived: number }): z.infer<typeof Exercise> => ({
    ...stored(ExerciseInput, r.data), id: r.id, archived: r.archived === 1, createdAt: r.created_at, updatedAt: r.updated_at, updatedBy: r.updated_by,
  });
  const toSession = (r: Row): z.infer<typeof Session> => {
    // By instant, not string: endedAt may carry different UTC offsets.
    const ws = db.query<{ id: string; ended: string; status: string }, [string]>(
      `SELECT id, json_extract(data, '$.endedAt') AS ended, json_extract(data, '$.status') AS status
       FROM workouts WHERE session_id = ? ORDER BY julianday(ended), created_at`,
    ).all(r.id);
    const data = stored(SessionInput, r.data);
    // Settled at upload (see `settled`): "completed" already means it covered the plan as it was then. One ended
    // early leaves the session open (but locked, see PUT).
    const done = ws.filter((w) => w.status === "completed");
    const plan = content(data.planId);
    return {
      date: data.date, planId: data.planId, remindAt: data.remindAt, remindNote: data.remindNote, skipped: data.skipped,
      id: r.id, title: plan.title, note: plan.note, items: plan.items, difficulty: plan.difficulty,
      completedAt: done.at(-1)?.ended ?? null, workoutIds: ws.map((w) => w.id),
      estimate: estimate(plan.items, getExercise), autoDifficulty: autoDifficulty(plan.items, getExercise),
      createdAt: r.created_at, updatedAt: r.updated_at, updatedBy: r.updated_by,
    };
  };
  const toWorkout = (r: Row): z.infer<typeof Workout> => ({
    ...stored(WorkoutInput, r.data), createdAt: r.created_at, updatedAt: r.updated_at, updatedBy: r.updated_by,
  });

  /** Every set of every item logged done (both sides of a one-sided move), and no row pointing at an item that
   *  isn't there. */
  const covers = (items: Items,
    sets: { itemIndex: number; exerciseId: string; set: number; status: string; side?: string | null }[]) => {
    const totals = items.map((_, i) => effectiveSets(items, i));
    // Every row belongs to a planned set: the app has no extra sets, so one beyond the plan isn't the session as planned.
    if (sets.some((x) => items[x.itemIndex]?.exerciseId !== x.exerciseId || x.status !== "done" || x.set > (totals[x.itemIndex] ?? 0))) {
      return false;
    }
    return items.every((it, i) => {
      const mine = sets.filter((x) => x.itemIndex === i);
      const twoSided = getExercise(it.exerciseId)?.unilateral === true;
      // One row per set, or for a one-sided move left and right; a row without a side counts whole (as before
      // sides were logged apart). A whole row beside side rows is a conflicting record, not a done set.
      const has = (n: number) => {
        const sides = mine.filter((x) => x.set === n).map((x) => x.side ?? null);
        if (sides.length === 1) return sides[0] === null || !twoSided;
        return twoSided && sides.length === 2 && sides.includes("left") && sides.includes("right");
      };
      const total = totals[i] ?? it.sets;
      for (let n = 1; n <= total; n++) if (!has(n)) return false;
      return true;
    });
  };
  /**
   * "completed" is only kept for a record that has sets and covers its session's plan (when the session is known);
   * otherwise it is stored as ended_early, so progress and badges don't count a partial record as a whole one.
   * Not refused: the upload would then be stuck in the app's queue.
   */
  const settled = <W extends z.infer<typeof WorkoutInput>>({ planned, ...w }: W): W => {
    if (w.status !== "completed") return w as W;
    const r = w.sessionId ? db.query<Row, [string]>("SELECT * FROM sessions WHERE id = ?").get(w.sessionId) : null;
    // Against the plan as trained (it may have been edited since the workout started).
    const items = planned ?? (r ? content(stored(SessionInput, r.data).planId).items : null);
    const whole = w.sets.length > 0 && (!items || covers(items, w.sets));
    return (whole ? w : { ...w, status: "ended_early" }) as W;
  };
  /** A workout changes its session's completedAt / workoutIds: bump the session so updatedSince pulls see it. */
  const touchSessions = (...ids: (string | null | undefined)[]) => {
    const t = now();
    for (const id of new Set(ids)) if (id) db.query("UPDATE sessions SET updated_at = ? WHERE id = ?").run(t, id);
  };

  const getExercise = (id: string) => {
    const r = db.query<Row & { archived: number }, [string]>("SELECT * FROM exercises WHERE id = ?").get(id);
    return r ? toExercise(r) : null;
  };
  const getSession = (id: string) => {
    const r = db.query<Row, [string]>("SELECT * FROM sessions WHERE id = ?").get(id);
    return r ? toSession(r) : null;
  };
  type PlanRow = Row & { archived: number; locked: number; shelved: number };
  const toPlan = (r: PlanRow): z.infer<typeof Plan> => {
    const data = stored(PlanInput, r.data);
    return {
      ...data, id: r.id, archived: r.archived === 1, locked: r.locked === 1, shelved: r.shelved === 1,
      autoDifficulty: autoDifficulty(data.items, getExercise),
      estimate: estimate(data.items, getExercise), createdAt: r.created_at, updatedAt: r.updated_at, updatedBy: r.updated_by,
    };
  };
  const getPlan = (id: string) => {
    const r = db.query<PlanRow, [string]>("SELECT * FROM plans WHERE id = ?").get(id);
    return r ? toPlan(r) : null;
  };
  const builtin = () => new Map(builtinPlans().map((p) => [p.id, p]));
  const getPreset = (id: string): { title: string; note: string; items: Items; difficulty: z.infer<typeof Session>["difficulty"] } | null => {
    const r = db.query<{ data: string }, [string]>("SELECT data FROM presets WHERE id = ?").get(id);
    if (r) {
      const p = stored(PlanInput, r.data);
      return { title: p.title, note: p.note, items: p.items, difficulty: p.difficulty ?? null };
    }
    const b = builtin().get(id);
    if (b) {
      const items = SessionItem.array().safeParse(b.items);
      return { title: b.title, note: b.note ?? "", items: items.success ? items.data : [], difficulty: (b.difficulty as never) ?? null };
    }
    return null;
  };
  /** A session's content: its plan's (one of the user's, archived ones too, or a synced/built-in preset). A plan that
   *  is gone (a built-in plan a newer app dropped) leaves an empty session named after its id. */
  const content = (planId: string): { title: string; note: string; items: Items; difficulty: z.infer<typeof Session>["difficulty"] } => {
    const p = getPlan(planId);
    if (p) return { title: p.title, note: p.note, items: p.items, difficulty: p.difficulty ?? null };
    return getPreset(planId) ?? { title: planId, note: "", items: [], difficulty: null };
  };
  /** Error message if a session can't be put on this plan: it must exist, not be archived, and (for coach) not shelved. */
  const checkPlan = (planId: string, actor: Actor): string | null => {
    const p = getPlan(planId);
    if (p) {
      if (p.archived) return `plan ${planId} was deleted`;
      if (p.shelved && actor === "coach") return `plan ${planId} is shelved; unshelve it or pick an active plan`;
      return null;
    }
    return getPreset(planId) ? null : `unknown planId ${planId}`;
  };
  const getWorkout = (id: string) => {
    const r = db.query<Row, [string]>("SELECT * FROM workouts WHERE id = ?").get(id);
    return r ? toWorkout(r) : null;
  };

  const missingMedia = (input: z.infer<typeof ExerciseInput>, allowed?: Set<string>) =>
    [...input.images.map((i) => i.file), ...(input.video ? [input.video.file] : [])].filter(
      (f) => !existsSync(join(mediaDir, f)) && !bundledMedia().has(f) && !allowed?.has(f),
    );

  /** Returns an error message if a plan's items don't fit the referenced exercises. */
  const checkItems = (input: { items: Items }, existing?: { items: Items }): string | null => {
    for (const [i, item] of input.items.entries()) {
      const ex = getExercise(item.exerciseId);
      if (!ex) return `items[${i}]: unknown exerciseId ${item.exerciseId}`;
      // Archived exercises may stay in an existing plan (as many times as they were), but cannot be newly added.
      const had = existing?.items.filter((it) => it.exerciseId === ex.id).length ?? 0;
      const has = input.items.slice(0, i + 1).filter((it) => it.exerciseId === ex.id).length;
      if (ex.archived && has > had) return `items[${i}]: exercise ${ex.id} is archived`;
      if (ex.mode === "reps" && (item.reps == null || item.seconds != null))
        return `items[${i}]: ${ex.name} is a reps exercise; set reps, not seconds`;
      if (ex.mode === "time" && (item.seconds == null || item.reps != null))
        return `items[${i}]: ${ex.name} is a time exercise; set seconds, not reps`;
    }
    return null;
  };

  /** Error message if `date` is outside today .. DAYS_AHEAD. `keep` = the session's current date, allowed as is. */
  const checkDate = (date: string, keep?: string): string | null => {
    if (date === keep) return null;
    // "Today" on the phone is its own time zone's day: accept any day that is today somewhere (UTC-12 .. UTC+14).
    const t = clock(), from = dayAt(t, -12), to = dayAt(t, 14, DAYS_AHEAD);
    return date < from || date > to ? `date must be from ${from} to ${to} (today to ${DAYS_AHEAD} days ahead)` : null;
  };

  /** WHERE clause for list endpoints: date range and/or updatedSince. */
  const listFilter = (q: z.infer<typeof ListQuery>) => {
    const conds: string[] = [], args: string[] = [];
    if (q.from && q.to) { conds.push("date BETWEEN ? AND ?"); args.push(q.from, q.to); }
    if (q.updatedSince) { conds.push("updated_at >= ?"); args.push(new Date(q.updatedSince).toISOString()); }
    return { where: conds.join(" AND "), args };
  };

  // ---- exercises ----
  app.openapi(
    createRoute({
      method: "get", path: "/v1/exercises", tags: ["exercises"], security, summary: "List exercises",
      request: {
        query: z.object({
          includeArchived: z.enum(["true", "false"]).default("false"),
          pattern: Pattern.optional(),
          muscle: z.string().optional().openapi({ description: "Exact match against muscles[]" }),
          equipment: z.string().optional().openapi({ description: "Exact match against equipment[]; use 'none' for bodyweight-only" }),
          tag: z.string().optional(),
        }),
      },
      responses: { 200: json(z.array(Exercise), "Exercises") },
    }),
    (c) => {
      const q = c.req.valid("query");
      const rows = db.query<Row & { archived: number }, []>(
        `SELECT * FROM exercises ${q.includeArchived === "true" ? "" : "WHERE archived = 0"} ORDER BY created_at`,
      ).all();
      // The library is small; filter in memory.
      const out = rows.map(toExercise).filter((e) =>
        (!q.pattern || e.pattern === q.pattern) &&
        (!q.muscle || e.muscles.includes(q.muscle)) &&
        (!q.equipment || (q.equipment === "none" ? e.equipment.length === 0 : e.equipment.includes(q.equipment))) &&
        (!q.tag || e.tags.includes(q.tag)));
      return c.json(out, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post", path: "/v1/exercises", tags: ["exercises"], security, summary: "Create exercise",
      request: { body: json(ExerciseInput, "Exercise") },
      responses: { 201: json(Exercise, "Created"), 400: err("Invalid") },
    }),
    (c) => {
      const input = c.req.valid("json");
      const missing = missingMedia(input);
      if (missing.length) return c.json({ error: "unknown_media", details: missing }, 400);
      const id = crypto.randomUUID(), t = now(), actor = c.get("actor");
      db.transaction(() => {
        db.query("INSERT INTO exercises (id, data, archived, created_at, updated_at, updated_by) VALUES (?, ?, 0, ?, ?, ?)")
          .run(id, JSON.stringify(input), t, t, actor);
        logChange(actor, "exercise", id, "create", null, input);
      })();
      return c.json(getExercise(id)!, 201);
    },
  );

  app.openapi(
    createRoute({
      method: "post", path: "/v1/exercises/sync", tags: ["exercises"], security,
      summary: "Seed missing exercises from the app's bundled library (idempotent: existing ids, archived included, are left untouched)",
      request: { body: json(ExerciseSyncInput, "Bundled exercises") },
      responses: { 200: json(ExerciseSyncResult, "Synced"), 400: err("Invalid") },
    }),
    (c) => {
      const { exercises } = c.req.valid("json");
      const actor = c.get("actor"), t = now();
      const exists = db.query<{ ok: number }, [string]>("SELECT 1 AS ok FROM exercises WHERE id = ?");
      const insert = db.query("INSERT INTO exercises (id, data, archived, created_at, updated_at, updated_by) VALUES (?, ?, 0, ?, ?, ?)");
      let added = 0;
      db.transaction(() => {
        for (const { id, ...rest } of exercises) {
          if (exists.get(id)) continue;
          insert.run(id, JSON.stringify(rest), t, t, actor);
          added++;
        }
      })();
      const total = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM exercises").get()!.n;
      return c.json({ added, total }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get", path: "/v1/exercises/{id}", tags: ["exercises"], security, summary: "Get exercise",
      request: { params: IdParam },
      responses: { 200: json(Exercise, "Exercise"), 404: err("Not found") },
    }),
    (c) => {
      const ex = getExercise(c.req.valid("param").id);
      return ex ? c.json(ex, 200) : c.json({ error: "not_found" }, 404);
    },
  );

  app.openapi(
    createRoute({
      method: "put", path: "/v1/exercises/{id}", tags: ["exercises"], security, summary: "Replace exercise",
      request: { params: IdParam, body: json(ExerciseInput, "Exercise") },
      responses: { 200: json(Exercise, "Updated"), 400: err("Invalid"), 404: err("Not found") },
    }),
    (c) => {
      const { id } = c.req.valid("param");
      const input = c.req.valid("json");
      const before = getExercise(id);
      if (!before) return c.json({ error: "not_found" }, 404);
      const keptMedia = new Set([...before.images.map((i) => i.file), ...(before.video ? [before.video.file] : [])]);
      const missing = missingMedia(input, keptMedia);
      if (missing.length) return c.json({ error: "unknown_media", details: missing }, 400);
      if (input.mode !== before.mode) {
        const used = db.query<{ n: number }, [string]>(
          "SELECT COUNT(*) AS n FROM plans, json_each(plans.data, '$.items') WHERE json_extract(json_each.value, '$.exerciseId') = ?",
        ).get(id)!.n + db.query<{ n: number }, [string]>(
          "SELECT COUNT(*) AS n FROM presets, json_each(presets.data, '$.items') WHERE json_extract(json_each.value, '$.exerciseId') = ?",
        ).get(id)!.n + builtinPlans().flatMap((p) => p.items).filter((it) => it.exerciseId === id).length;
        if (used) return c.json({ error: "mode_change_in_use", details: `used by ${used} plan item(s)` }, 400);
      }
      const actor = c.get("actor");
      db.transaction(() => {
        db.query("UPDATE exercises SET data = ?, updated_at = ?, updated_by = ? WHERE id = ?").run(JSON.stringify(input), now(), actor, id);
        logChange(actor, "exercise", id, "update", before, input);
      })();
      return c.json(getExercise(id)!, 200);
    },
  );

  for (const [path, archived, action] of [["archive", 1, "archive"], ["unarchive", 0, "unarchive"]] as const) {
    app.openapi(
      createRoute({
        method: "post", path: `/v1/exercises/{id}/${path}`, tags: ["exercises"], security,
        summary: archived ? "Archive exercise (hidden from library, kept for history)" : "Unarchive exercise",
        request: { params: IdParam },
        responses: { 200: json(Exercise, "Updated"), 404: err("Not found") },
      }),
      (c) => {
        const { id } = c.req.valid("param");
        if (!getExercise(id)) return c.json({ error: "not_found" }, 404);
        const actor = c.get("actor");
        db.transaction(() => {
          db.query("UPDATE exercises SET archived = ?, updated_at = ?, updated_by = ? WHERE id = ?").run(archived, now(), actor, id);
          logChange(actor, "exercise", id, action, null, null);
        })();
        return c.json(getExercise(id)!, 200);
      },
    );
  }

  // ---- sessions ----
  app.openapi(
    createRoute({
      method: "get", path: "/v1/sessions", tags: ["sessions"], security, summary: "List sessions by date range (inclusive) and/or updatedSince",
      request: { query: ListQuery },
      responses: { 200: json(z.array(Session), "Sessions"), 400: err("Invalid") },
    }),
    (c) => {
      const { where, args } = listFilter(c.req.valid("query"));
      const rows = db.query<Row, string[]>(`SELECT * FROM sessions WHERE ${where} ORDER BY date, created_at`).all(...args);
      return c.json(rows.map(toSession), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post", path: "/v1/sessions", tags: ["sessions"], security, summary: "Put a plan on a date (a session)",
      request: { body: json(SessionInput, "Session") },
      responses: { 201: json(Session, "Created"), 400: err("Invalid") },
    }),
    (c) => {
      const input = c.req.valid("json");
      const badDate = checkDate(input.date);
      if (badDate) return c.json({ error: "invalid_date", details: badDate }, 400);
      const actor = c.get("actor");
      const badPlan = checkPlan(input.planId, actor);
      if (badPlan) return c.json({ error: "invalid_plan", details: badPlan }, 400);
      const id = crypto.randomUUID(), t = now();
      db.transaction(() => {
        db.query("INSERT INTO sessions (id, date, data, created_at, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?)")
          .run(id, input.date, JSON.stringify(input), t, t, actor);
        logChange(actor, "session", id, "create", null, input);
      })();
      return c.json(getSession(id)!, 201);
    },
  );

  app.openapi(
    createRoute({
      method: "get", path: "/v1/sessions/{id}", tags: ["sessions"], security, summary: "Get session",
      request: { params: IdParam },
      responses: { 200: json(Session, "Session"), 404: err("Not found") },
    }),
    (c) => {
      const s = getSession(c.req.valid("param").id);
      return s ? c.json(s, 200) : c.json({ error: "not_found" }, 404);
    },
  );

  app.openapi(
    createRoute({
      method: "put", path: "/v1/sessions/{id}", tags: ["sessions"], security, summary: "Replace session (last write wins; every change is logged)",
      request: { params: IdParam, body: json(SessionInput, "Session") },
      responses: { 200: json(Session, "Updated"), 400: err("Invalid"), 404: err("Not found"), 409: err("Already trained") },
    }),
    (c) => {
      const { id } = c.req.valid("param");
      const input = c.req.valid("json");
      const before = getSession(id);
      if (!before) return c.json({ error: "not_found" }, 404);
      // Its workouts point at it: once trained (even partly) it stays on its day and plan. Reminder and skipped can
      // still change: a session ended early stays open until it's done or dropped.
      if (before.workoutIds.length > 0 && (input.date !== before.date || input.planId !== before.planId)) {
        return c.json({ error: "session_trained", details: "a trained session keeps its date and plan (only remindAt, remindNote, skipped change); create a new one" }, 409);
      }
      const badDate = checkDate(input.date, before.date);
      if (badDate) return c.json({ error: "invalid_date", details: badDate }, 400);
      // A new day schedules the plan again, so a deleted (archived) plan can't move either; it may stay where it is.
      const actor = c.get("actor");
      const badPlan = input.planId === before.planId && input.date === before.date ? null : checkPlan(input.planId, actor);
      if (badPlan) return c.json({ error: "invalid_plan", details: badPlan }, 400);
      db.transaction(() => {
        db.query("UPDATE sessions SET date = ?, data = ?, updated_at = ?, updated_by = ? WHERE id = ?")
          .run(input.date, JSON.stringify(input), now(), actor, id);
        logChange(actor, "session", id, "update", before, input);
      })();
      return c.json(getSession(id)!, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "delete", path: "/v1/sessions/{id}", tags: ["sessions"], security, summary: "Delete session (workout logs are kept)",
      request: { params: IdParam },
      responses: { 204: { description: "Deleted" }, 404: err("Not found") },
    }),
    (c) => {
      const { id } = c.req.valid("param");
      const before = getSession(id);
      if (!before) return c.json({ error: "not_found" }, 404);
      // Same as the app's local store: a trained session may go too; its workouts stay and keep the session's title.
      const actor = c.get("actor");
      db.transaction(() => {
        db.query("DELETE FROM sessions WHERE id = ?").run(id);
        logChange(actor, "session", id, "delete", before, null);
      })();
      return c.body(null, 204);
    },
  );

  // ---- plans (the user's own: content without a date; sessions point at one) ----
  const PlanDurationQuery = z.object({
    targetMinutes: z.coerce.number().int().min(1).max(240).optional().openapi({
      description: "Optional target duration in minutes; rejects with 400 duration_mismatch when actual duration drifts beyond max(3, round(20%))",
    }),
  });
  const checkPlanDuration = (input: z.infer<typeof PlanInput>, actor: Actor, targetMinutes?: number) => {
    const est = estimate(input.items, getExercise);
    if (!est) return null;
    const actualMinutes = estimateMinutes(est);
    const problems: string[] = [];
    // Only hard-block conflicting durations in title (notes may discuss rest/branch lengths).
    if (actor === "coach") problems.push(...checkDurationCopy(input.title, "", actualMinutes));
    if (targetMinutes != null) {
      const targetErr = checkTargetMinutes(actualMinutes, targetMinutes);
      if (targetErr) problems.push(targetErr);
    }
    if (problems.length === 0) return null;
    return {
      problems,
      actualMinutes,
      workMinutes: Math.round((est.workSec / 60) * 10) / 10,
      restMinutes: Math.round((est.restSec / 60) * 10) / 10,
      ...(targetMinutes != null ? { targetMinutes } : {}),
      topItems: topDurationItems(input.items, getExercise, 3),
      estimate: est,
      hint: "Remove minute counts from title (the app shows duration automatically) or adjust sets/reps/rest to match.",
    };
  };

  app.openapi(
    createRoute({
      method: "get", path: "/v1/plans", tags: ["plans"], security, summary: "List the user's plans (我的计划), archived ones too (flagged)",
      responses: { 200: json(z.array(Plan), "Plans") },
    }),
    (c) => c.json(db.query<PlanRow, []>("SELECT * FROM plans ORDER BY created_at").all().map(toPlan), 200),
  );

  app.openapi(
    createRoute({
      method: "post", path: "/v1/plans", tags: ["plans"], security, summary: "Create a plan",
      request: { query: PlanDurationQuery, body: json(PlanInput, "Plan") },
      responses: { 201: json(Plan, "Created"), 400: err("Invalid") },
    }),
    (c) => {
      const input = c.req.valid("json");
      const { targetMinutes } = c.req.valid("query");
      const problem = checkItems(input);
      if (problem) return c.json({ error: "invalid_items", details: problem }, 400);
      const id = crypto.randomUUID(), t = now(), actor = c.get("actor");
      const durationProblem = checkPlanDuration(input, actor, targetMinutes);
      if (durationProblem) return c.json({ error: "duration_mismatch", details: durationProblem }, 400);
      db.transaction(() => {
        db.query("INSERT INTO plans (id, data, created_at, updated_at, updated_by) VALUES (?, ?, ?, ?, ?)")
          .run(id, JSON.stringify(input), t, t, actor);
        logChange(actor, "plan", id, "create", null, input);
      })();
      return c.json(getPlan(id)!, 201);
    },
  );

  app.openapi(
    createRoute({
      method: "put", path: "/v1/plans/{id}", tags: ["plans"], security,
      summary: "Replace a plan. Every session that uses it changes with it (its trained ones keep their workout records)",
      request: { params: IdParam, query: PlanDurationQuery, body: json(PlanInput, "Plan") },
      responses: { 200: json(Plan, "Updated"), 400: err("Invalid"), 404: err("Not found"), 409: err("Archived or locked") },
    }),
    (c) => {
      const { id } = c.req.valid("param");
      const { targetMinutes } = c.req.valid("query");
      const input = c.req.valid("json");
      const before = getPlan(id);
      if (!before) return c.json({ error: "not_found" }, 404);
      if (before.archived) return c.json({ error: "plan_archived", details: "this plan was deleted; create a new one" }, 409);
      if (before.locked) {
        return c.json({
          error: "plan_locked",
          details: "this plan is locked; copy it into a new plan (POST /v1/plans) or unlock it in the app first",
        }, 409);
      }
      const problem = checkItems(input, before);
      if (problem) return c.json({ error: "invalid_items", details: problem }, 400);
      const actor = c.get("actor");
      const durationProblem = checkPlanDuration(input, actor, targetMinutes);
      if (durationProblem) return c.json({ error: "duration_mismatch", details: durationProblem }, 400);
      db.transaction(() => {
        db.query("UPDATE plans SET data = ?, updated_at = ?, updated_by = ? WHERE id = ?").run(JSON.stringify(input), now(), actor, id);
        // Their content changed: bump them so updatedSince pulls see it.
        db.query("UPDATE sessions SET updated_at = ? WHERE json_extract(data, '$.planId') = ?").run(now(), id);
        logChange(actor, "plan", id, "update", before, input);
      })();
      return c.json(getPlan(id)!, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "delete", path: "/v1/plans/{id}", tags: ["plans"], security,
      summary: "Delete a plan with its sessions from today on that aren't trained. If sessions still point at it (trained or past ones) it is archived instead: hidden from 我的计划, kept for them",
      request: { params: IdParam },
      responses: {
        200: json(z.object({ archived: z.boolean(), deletedSessions: z.array(z.string()) }), "Deleted (or archived)"),
        404: err("Not found"),
        409: err("Locked"),
      },
    }),
    (c) => {
      const { id } = c.req.valid("param");
      const before = getPlan(id);
      if (!before || before.archived) return c.json({ error: "not_found" }, 404);
      if (before.locked) {
        return c.json({ error: "plan_locked", details: "this plan is locked; unlock it in the app first" }, 409);
      }
      const actor = c.get("actor"), today = dayAt(clock(), 8);
      const rows = db.query<Row, [string]>("SELECT * FROM sessions WHERE json_extract(data, '$.planId') = ?").all(id);
      const doomed = rows.map(toSession).filter((s) => s.date >= today && s.workoutIds.length === 0);
      const archived = rows.length > doomed.length;
      db.transaction(() => {
        for (const s of doomed) {
          db.query("DELETE FROM sessions WHERE id = ?").run(s.id);
          logChange(actor, "session", s.id, "delete", s, null);
        }
        if (archived) {
          db.query("UPDATE plans SET archived = 1, updated_at = ?, updated_by = ? WHERE id = ?").run(now(), actor, id);
          logChange(actor, "plan", id, "archive", before, null);
        } else {
          db.query("DELETE FROM plans WHERE id = ?").run(id);
          logChange(actor, "plan", id, "delete", before, null);
        }
      })();
      return c.json({ archived, deletedSessions: doomed.map((s) => s.id) }, 200);
    },
  );

  for (const [path, locked, action] of [["lock", 1, "lock"], ["unlock", 0, "unlock"]] as const) {
    app.openapi(
      createRoute({
        method: "post", path: `/v1/plans/{id}/${path}`, tags: ["plans"], security,
        summary: locked ? "Lock plan (read-only master template; app only)" : "Unlock plan (app only)",
        request: { params: IdParam },
        responses: { 200: json(Plan, "Updated"), 403: err("App only"), 404: err("Not found"), 409: err("Archived") },
      }),
      (c) => {
        const actor = c.get("actor");
        if (actor !== "app") {
          return c.json({ error: "app_only", details: "only the user in the app can lock or unlock a plan" }, 403);
        }
        const { id } = c.req.valid("param");
        const before = getPlan(id);
        if (!before) return c.json({ error: "not_found" }, 404);
        if (before.archived) return c.json({ error: "plan_archived", details: "this plan was deleted" }, 409);
        db.transaction(() => {
          db.query("UPDATE plans SET locked = ?, updated_by = ? WHERE id = ?").run(locked, actor, id);
          logChange(actor, "plan", id, action, null, null);
        })();
        return c.json(getPlan(id)!, 200);
      },
    );
  }

  for (const [path, shelved, action] of [["shelve", 1, "shelve"], ["unshelve", 0, "unshelve"]] as const) {
    app.openapi(
      createRoute({
        method: "post", path: `/v1/plans/{id}/${path}`, tags: ["plans"], security,
        summary: shelved ? "Shelve plan into 已收起 (reversible archive)" : "Restore shelved plan to 我的计划",
        request: { params: IdParam },
        responses: { 200: json(Plan, "Updated"), 404: err("Not found"), 409: err("Archived or locked") },
      }),
      (c) => {
        const actor = c.get("actor");
        const { id } = c.req.valid("param");
        const before = getPlan(id);
        if (!before) return c.json({ error: "not_found" }, 404);
        if (before.archived) return c.json({ error: "plan_archived", details: "this plan was deleted" }, 409);
        if (before.locked && actor === "coach") {
          return c.json({ error: "plan_locked", details: "this plan is locked and cannot be shelved or unshelved by the coach" }, 409);
        }
        db.transaction(() => {
          db.query("UPDATE plans SET shelved = ?, updated_by = ? WHERE id = ?").run(shelved, actor, id);
          logChange(actor, "plan", id, action, null, null);
        })();
        return c.json(getPlan(id)!, 200);
      },
    );
  }

  // ---- presets (built-in plans synced from the app on demand; separate from 我的计划) ----
  app.openapi(
    createRoute({
      method: "put", path: "/v1/presets/{id}", tags: ["plans"], security,
      summary: "Register a built-in plan by slug so sessions can reference it without shipping plans.json on the server",
      request: { params: IdParam, body: json(PlanInput, "Preset plan") },
      responses: { 200: json(PlanInput.extend({ id: z.string() }), "Stored"), 400: err("Invalid") },
    }),
    (c) => {
      const { id } = c.req.valid("param");
      const input = c.req.valid("json");
      const problem = checkItems(input);
      if (problem) return c.json({ error: "invalid_items", details: problem }, 400);
      db.query(
        "INSERT INTO presets (id, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at",
      ).run(id, JSON.stringify(input), now());
      return c.json({ id, ...input }, 200);
    },
  );

  // ---- workouts ----
  app.openapi(
    createRoute({
      method: "post", path: "/v1/workouts", tags: ["workouts"], security,
      summary: "Upload a finished workout (idempotent by id: an existing id returns the stored copy unchanged)",
      request: { body: json(WorkoutInput, "Workout") },
      responses: { 201: json(Workout, "Created"), 200: json(Workout, "Already uploaded"), 400: err("Invalid") },
    }),
    (c) => {
      const input = settled(c.req.valid("json"));
      const existing = getWorkout(input.id);
      if (existing) return c.json(existing, 200);
      const t = now(), actor = c.get("actor");
      db.transaction(() => {
        db.query("INSERT INTO workouts (id, session_id, date, data, created_at, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?)")
          .run(input.id, input.sessionId, input.date, JSON.stringify(input), t, t, actor);
        touchSessions(input.sessionId);
        logChange(actor, "workout", input.id, "create", null, input);
      })();
      return c.json(getWorkout(input.id)!, 201);
    },
  );

  app.openapi(
    createRoute({
      method: "get", path: "/v1/workouts", tags: ["workouts"], security, summary: "List workouts by date range (inclusive) and/or updatedSince (for nightly / weekly review pulls)",
      request: { query: ListQuery },
      responses: { 200: json(z.array(Workout), "Workouts"), 400: err("Invalid") },
    }),
    (c) => {
      const { where, args } = listFilter(c.req.valid("query"));
      const rows = db.query<Row, string[]>(`SELECT * FROM workouts WHERE ${where} ORDER BY date, created_at`).all(...args);
      return c.json(rows.map(toWorkout), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get", path: "/v1/workouts/{id}", tags: ["workouts"], security, summary: "Get workout",
      request: { params: IdParam },
      responses: { 200: json(Workout, "Workout"), 404: err("Not found") },
    }),
    (c) => {
      const w = getWorkout(c.req.valid("param").id);
      return w ? c.json(w, 200) : c.json({ error: "not_found" }, 404);
    },
  );

  app.openapi(
    createRoute({
      method: "put", path: "/v1/workouts/{id}", tags: ["workouts"], security, summary: "Correct a workout after the fact",
      request: { params: IdParam, body: json(WorkoutInput, "Workout") },
      responses: { 200: json(Workout, "Updated"), 400: err("Invalid"), 404: err("Not found") },
    }),
    (c) => {
      const { id } = c.req.valid("param");
      const { planned: _, ...body } = c.req.valid("json");
      const before = getWorkout(id);
      if (body.id !== id) return c.json({ error: "id_mismatch" }, 400);
      if (!before) return c.json({ error: "not_found" }, 404);
      // Settled when it was uploaded (as in local mode): a correction keeps "completed" even if the plan has changed
      // since, and can't turn one ended early into a completed one.
      // Moved to another session, it is checked against that one's plan.
      const input = before.status !== "completed" ? { ...body, status: before.status }
        : body.sessionId !== before.sessionId ? settled(body) : body;
      const actor = c.get("actor");
      db.transaction(() => {
        db.query("UPDATE workouts SET session_id = ?, date = ?, data = ?, updated_at = ?, updated_by = ? WHERE id = ?")
          .run(input.sessionId, input.date, JSON.stringify(input), now(), actor, id);
        touchSessions(before.sessionId, input.sessionId);
        logChange(actor, "workout", id, "update", before, input);
      })();
      return c.json(getWorkout(id)!, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "delete", path: "/v1/workouts/{id}", tags: ["workouts"], security,
      summary: "Delete a workout (a test or mistaken record); its session counts as untrained again unless another workout covers it",
      request: { params: IdParam },
      responses: { 204: { description: "Deleted" }, 404: err("Not found") },
    }),
    (c) => {
      const { id } = c.req.valid("param");
      const before = getWorkout(id);
      if (!before) return c.json({ error: "not_found" }, 404);
      const actor = c.get("actor");
      db.transaction(() => {
        db.query("DELETE FROM workouts WHERE id = ?").run(id);
        touchSessions(before.sessionId);
        logChange(actor, "workout", id, "delete", before, null);
      })();
      return c.body(null, 204);
    },
  );

  // ---- changes ----
  app.openapi(
    createRoute({
      method: "get", path: "/v1/changes", tags: ["changes"], security, summary: "Change log (who changed what), oldest first after `since`",
      request: { query: z.object({ since: z.coerce.number().int().min(0).default(0), limit: z.coerce.number().int().min(1).max(500).default(100) }) },
      responses: { 200: json(z.array(Change), "Changes") },
    }),
    (c) => {
      const { since, limit } = c.req.valid("query");
      type C = z.infer<typeof Change>;
      type CR = { seq: number; at: string; actor: Actor; entity: C["entity"]; entity_id: string; action: C["action"]; before: string | null; after: string | null };
      const rows = db.query<CR, [number, number]>("SELECT * FROM changes WHERE seq > ? ORDER BY seq LIMIT ?").all(since, limit);
      return c.json(
        rows.map((r) => ({
          seq: r.seq, at: r.at, actor: r.actor, entity: r.entity, entityId: r.entity_id, action: r.action,
          before: r.before ? JSON.parse(r.before) : null, after: r.after ? JSON.parse(r.after) : null,
        })),
        200,
      );
    },
  );

  // ---- media ----
  app.post("/v1/media", async (c) => {
    const type = (c.req.header("content-type") ?? "").split(";")[0]!.trim();
    const ext = MEDIA_TYPES[type];
    if (!ext) return c.json({ error: "unsupported_type", details: Object.keys(MEDIA_TYPES) }, 400);
    const buf = new Uint8Array(await c.req.arrayBuffer());
    if (buf.byteLength === 0 || buf.byteLength > 5 * 1024 * 1024) return c.json({ error: "bad_size" }, 400);
    const file = `${createHash("sha256").update(buf).digest("hex")}.${ext}`;
    const path = join(mediaDir, file);
    if (!existsSync(path)) writeFileSync(path, buf);
    return c.json({ file }, 201);
  });

  app.get("/v1/media/:file", async (c) => {
    const file = c.req.param("file");
    const m = /^[a-f0-9]{64}\.(png|jpg|webp|mp4)$/.exec(file);
    if (!m) return c.json({ error: "not_found" }, 404);
    const f = Bun.file(join(mediaDir, file));
    if (!(await f.exists())) return c.json({ error: "not_found" }, 404);
    // Content-addressed: never changes.
    return new Response(f, { headers: { "content-type": EXT_TYPES[m[1]!]!, "cache-control": "private, max-age=31536000, immutable" } });
  });

  return app;
}
