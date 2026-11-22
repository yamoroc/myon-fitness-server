import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app";
import { builtinPlans } from "../src/builtin";
import { openDb, slugExercises, splitSessions } from "../src/db";

const APP = "app-token", COACH = "coach-token";
let app: ReturnType<typeof createApp>;
let db: ReturnType<typeof openDb>;

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "fitness-test-"));
  db = openDb(join(dir, "t.db"));
  app = createApp({ db, mediaDir: join(dir, "media"), tokens: { [APP]: "app", [COACH]: "coach" },
    now: () => new Date("2026-11-19T04:00:00Z") });
});

async function call(method: string, path: string, body?: unknown, token = APP, headers: Record<string, string> = {}) {
  const init: RequestInit = { method, headers: { authorization: `Bearer ${token}`, ...headers } };
  if (body instanceof Uint8Array) init.body = body as unknown as BodyInit;
  else if (body !== undefined) {
    init.body = JSON.stringify(body);
    (init.headers as Record<string, string>)["content-type"] = "application/json";
  }
  const res = await app.request(path, init);
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

const squat = { name: "徒手深蹲", mode: "reps", tempoSec: 3, cues: ["目视前方", "起身放慢"], setup: "身后放椅子" };
const plank = { name: "平板支撑", mode: "time" };

/** A plan with this content put on `date` (what POST /v1/sessions took before sessions pointed at plans). */
async function sched(body: any, token = APP) {
  const { date, title, note, items, difficulty, remindAt, remindNote, skipped } = body;
  const plan = await call("POST", "/v1/plans", { title, note, items, difficulty }, token);
  if (plan.status !== 201) return plan;
  return call("POST", "/v1/sessions", { date, planId: plan.body.id, remindAt, remindNote, skipped }, token);
}

async function seed() {
  const s = (await call("POST", "/v1/exercises", squat)).body;
  const p = (await call("POST", "/v1/exercises", plank)).body;
  return { s, p };
}

test("prototype keys are not tokens", async () => {
  for (const k of ["__proto__", "constructor", "toString", "valueOf"]) {
    expect((await call("GET", "/v1/exercises", undefined, k)).status).toBe(401);
  }
});

describe("auth & meta", () => {
  test("health is public, v1 needs a valid token", async () => {
    expect((await app.request("/health")).status).toBe(200);
    expect((await call("GET", "/v1/exercises", undefined, "")).status).toBe(401);
    expect((await call("GET", "/v1/exercises", undefined, "wrong")).status).toBe(401);
  });

  test("openapi document lists the routes", async () => {
    const doc = await (await app.request("/openapi.json")).json() as { paths: Record<string, unknown> };
    for (const p of ["/v1/exercises", "/v1/sessions/{id}", "/v1/workouts", "/v1/changes"]) expect(doc.paths[p]).toBeDefined();
  });
});

describe("exercises", () => {
  test("create applies defaults and records the actor", async () => {
    const r = await call("POST", "/v1/exercises", plank, COACH);
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ name: "平板支撑", unilateral: false, tempoSec: 3, pauseSec: 0, images: [], archived: false, updatedBy: "coach" });
  });

  test("rejects invalid input", async () => {
    expect((await call("POST", "/v1/exercises", { name: "", mode: "reps" })).status).toBe(400);
    expect((await call("POST", "/v1/exercises", { name: "x", mode: "jump" })).status).toBe(400);
    expect((await call("POST", "/v1/exercises", { name: "x", mode: "reps", tempoSec: 0 })).status).toBe(400);
  });

  test("archive hides from list but keeps it fetchable", async () => {
    const { s } = await seed();
    await call("POST", `/v1/exercises/${s.id}/archive`);
    expect((await call("GET", "/v1/exercises")).body).toHaveLength(1);
    expect((await call("GET", "/v1/exercises?includeArchived=true")).body).toHaveLength(2);
    expect((await call("GET", `/v1/exercises/${s.id}`)).body.archived).toBe(true);
  });

  test("session dates must be real calendar days", async () => {
    const { s } = await seed();
    const item = { exerciseId: s.id, sets: 2, reps: 10, restSec: 60, restAfterSec: 90 };
    for (const date of ["2026-99-99", "2026-02-30", "2026-13-01", "2026-11-00"]) {
      expect((await sched({ date, title: "t", items: [item] })).status).toBe(400);
    }
    expect((await sched({ date: "2026-11-31", title: "t", items: [item] })).status).toBe(400);
    expect((await call("GET", "/v1/sessions?from=2026-02-30&to=2026-03-01")).status).toBe(400);
  });

  test("mode cannot change while scheduled", async () => {
    const { s } = await seed();
    await sched({ date: "2026-11-19", title: "t", items: [{ exerciseId: s.id, sets: 2, reps: 10, restSec: 60, restAfterSec: 90 }] });
    const r = await call("PUT", `/v1/exercises/${s.id}`, { ...squat, mode: "time" });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("mode_change_in_use");
  });

  test("images must reference uploaded media", async () => {
    const bad = await call("POST", "/v1/exercises", { ...plank, images: [{ file: "a".repeat(64) + ".png", phase: "" }] });
    expect(bad.body.error).toBe("unknown_media");
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    const up = await call("POST", "/v1/media", png, APP, { "content-type": "image/png" });
    expect(up.status).toBe(201);
    const ok = await call("POST", "/v1/exercises", { ...plank, images: [{ file: up.body.file, phase: "保持" }] });
    expect(ok.status).toBe(201);
    const res = await app.request(`/v1/media/${up.body.file}`, { headers: { authorization: `Bearer ${APP}` } });
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(png);
  });

  test("video must reference an uploaded mp4", async () => {
    const video = { file: "b".repeat(64) + ".mp4", turnSec: 2, durationSec: 4.5, aspect: 0.8 };
    expect((await call("POST", "/v1/exercises", { ...squat, video })).body.error).toBe("unknown_media");
    const mp4 = new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70]);
    const up = await call("POST", "/v1/media", mp4, APP, { "content-type": "video/mp4" });
    expect(up.body.file).toMatch(/\.mp4$/);
    const ok = await call("POST", "/v1/exercises", { ...squat, video: { ...video, file: up.body.file } });
    expect(ok.status).toBe(201);
    expect(ok.body.video.turnSec).toBe(2);
    const res = await app.request(`/v1/media/${up.body.file}`, { headers: { authorization: `Bearer ${APP}` } });
    expect(res.headers.get("content-type")).toBe("video/mp4");
    // an image name is not a video
    expect((await call("POST", "/v1/exercises", { ...squat, name: "x", video: { ...video, file: "c".repeat(64) + ".jpg" } })).status).toBe(400);
  });

  test("media rejects unsupported types and bad names", async () => {
    expect((await call("POST", "/v1/media", new Uint8Array([1]), APP, { "content-type": "image/gif" })).status).toBe(400);
    expect((await call("GET", "/v1/media/..%2Fsecrets.env")).status).toBe(404);
  });
});

describe("exercise metadata", () => {
  test("defaults, filters by pattern / muscle / equipment / tag", async () => {
    const { s } = await seed();
    expect(s.pattern).toBe("other");
    expect(s.equipment).toEqual([]);
    await call("POST", "/v1/exercises", { name: "保加利亚分腿蹲", mode: "reps", unilateral: true, pattern: "lunge",
      muscles: ["股四头肌", "臀大肌"], equipment: ["椅子"], level: 3, breathing: "下蹲吸气，起身呼气", tags: ["不压膝"] });
    const q = async (qs: string) => ((await call("GET", `/v1/exercises?${qs}`)).body as { name: string }[]).map((e) => e.name);
    expect(await q("pattern=lunge")).toEqual(["保加利亚分腿蹲"]);
    expect(await q(`muscle=${encodeURIComponent("臀大肌")}`)).toEqual(["保加利亚分腿蹲"]);
    expect(await q("equipment=none")).toEqual(["徒手深蹲", "平板支撑"]);
    expect(await q(`tag=${encodeURIComponent("不压膝")}`)).toEqual(["保加利亚分腿蹲"]);
    expect((await call("POST", "/v1/exercises", { ...plank, pattern: "jump" })).status).toBe(400);
    expect((await call("POST", "/v1/exercises", { ...plank, level: 6 })).status).toBe(400);
  });

  test("same exercise may repeat in a session (A, B, A) with sections", async () => {
    const { s, p } = await seed();
    const it = (exerciseId: string, extra: object) => ({ exerciseId, sets: 1, restSec: 0, restAfterSec: 30, ...extra });
    const r = await sched({ date: "2026-11-19", title: "abc", items: [
      it(s.id, { reps: 10, section: "warmup" }), it(p.id, { seconds: 30 }), it(s.id, { reps: 15 }), it(p.id, { seconds: 60, section: "cooldown" }),
    ] }, COACH);
    expect(r.status).toBe(201);
    expect(r.body.items.map((x: { section: string }) => x.section)).toEqual(["warmup", "main", "main", "cooldown"]);
  });
});

describe("sessions", () => {
  test("create, list by range, move, delete; content comes from the plan", async () => {
    const { s, p } = await seed();
    const input = {
      date: "2026-11-19", title: "全身徒手",
      items: [
        { exerciseId: s.id, sets: 3, reps: 15, restSec: 60, restAfterSec: 90 },
        { exerciseId: p.id, sets: 3, seconds: 30, restSec: 60, restAfterSec: 0 },
      ],
    };
    const created = await sched(input, COACH);
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ updatedBy: "coach", title: "全身徒手", note: "", difficulty: null });
    expect(created.body.items).toHaveLength(2);
    const planId = created.body.planId;
    await call("POST", "/v1/sessions", { date: "2026-11-25", planId });

    expect((await call("GET", "/v1/sessions?from=2026-11-19&to=2026-11-19")).body).toHaveLength(1);
    expect((await call("GET", "/v1/sessions?from=2026-11-01&to=2026-11-30")).body).toHaveLength(2);

    const upd = await call("PUT", `/v1/sessions/${created.body.id}`, { date: "2026-11-21", planId });
    expect([upd.body.date, upd.body.updatedBy]).toEqual(["2026-11-21", "app"]);
    // Content sent with a session is not the session's.
    const own = await call("PUT", `/v1/sessions/${created.body.id}`, { date: "2026-11-21", planId, title: "x", items: [] });
    expect([own.status, own.body.title, own.body.items.length]).toEqual([200, "全身徒手", 2]);
    expect((await call("POST", "/v1/sessions", { date: "2026-11-21" })).status).toBe(400);
    expect((await call("POST", "/v1/sessions", { date: "2026-11-21", planId: "nope" })).body.error).toBe("invalid_plan");

    expect((await call("DELETE", `/v1/sessions/${created.body.id}`)).status).toBe(204);
    expect((await call("GET", `/v1/sessions/${created.body.id}`)).status).toBe(404);
  });

  test.skipIf(builtinPlans().length === 0)("a built-in plan is scheduled by its slug", async () => {
    const r = await call("POST", "/v1/sessions", { date: "2026-11-20", planId: "full-body-starter" });
    expect(r.status).toBe(201);
    expect(r.body.title).toBe("全身基础激活");
    expect(r.body.items.length).toBeGreaterThan(3);
  });

  test("reminder time, note and skipped round-trip; bad times rejected", async () => {
    const { s } = await seed();
    const input = { date: "2026-11-20", title: "拉伸", items: [{ exerciseId: s.id, sets: 1, reps: 5, restSec: 0, restAfterSec: 0 }] };
    const plain = await sched(input);
    expect(plain.body.remindAt).toBeUndefined();
    const c = await sched({ ...input, remindAt: "10:30", remindNote: "10 分钟也算" }, COACH);
    expect(c.body.remindAt).toBe("10:30");
    expect(c.body.remindNote).toBe("10 分钟也算");
    const u = await call("PUT", `/v1/sessions/${c.body.id}`, { date: input.date, planId: c.body.planId, remindAt: null, skipped: true });
    expect(u.body.remindAt).toBeNull();
    expect(u.body.skipped).toBe(true);
    for (const bad of ["24:00", "7:30", "12:60", "noon"]) {
      expect((await sched({ ...input, remindAt: bad })).status).toBe(400);
    }
    expect((await sched({ ...input, remindNote: "x".repeat(61) })).status).toBe(400);
  });

  test("items must match exercise mode and exist", async () => {
    const { s, p } = await seed();
    const base = { date: "2026-11-19", title: "t" };
    const bad = [
      [{ exerciseId: s.id, sets: 3, seconds: 30, restSec: 60, restAfterSec: 0 }],
      [{ exerciseId: p.id, sets: 3, reps: 10, restSec: 60, restAfterSec: 0 }],
      [{ exerciseId: s.id, sets: 3, reps: 10, seconds: 10, restSec: 60, restAfterSec: 0 }],
      [{ exerciseId: "nope", sets: 3, reps: 10, restSec: 60, restAfterSec: 0 }],
    ];
    for (const items of bad) expect((await sched({ ...base, items })).body.error).toBe("invalid_items");
    expect((await sched({ ...base, items: [] })).status).toBe(400);
    expect((await sched({ ...base, date: "2026/11/19", items: bad[0] })).status).toBe(400);
  });

  test("archived exercise can stay in an existing plan but not be newly added", async () => {
    const { s } = await seed();
    const input = { title: "t", items: [{ exerciseId: s.id, sets: 2, reps: 10, restSec: 60, restAfterSec: 0 }] };
    const created = (await call("POST", "/v1/plans", input)).body;
    await call("POST", `/v1/exercises/${s.id}/archive`);
    expect((await call("PUT", `/v1/plans/${created.id}`, { ...input, title: "t2" })).status).toBe(200);
    expect((await call("POST", "/v1/plans", input)).status).toBe(400);
    // Keeping it doesn't allow adding another copy.
    const twice = { ...input, items: [input.items[0], input.items[0]] };
    expect((await call("PUT", `/v1/plans/${created.id}`, twice)).status).toBe(400);
  });
});

describe("plans", () => {
  test("create, list, update; sessions follow the plan", async () => {
    const { s, p } = await seed();
    const input = {
      title: "我的上肢", note: "慢一点",
      items: [
        { exerciseId: s.id, sets: 3, reps: 12, restSec: 60, restAfterSec: 60 },
        { exerciseId: p.id, sets: 2, seconds: 40, restSec: 30, restAfterSec: 0 },
      ],
    };
    const c = await call("POST", "/v1/plans", input);
    expect(c.status).toBe(201);
    expect(c.body).toMatchObject({ updatedBy: "app", archived: false });
    expect(c.body.difficulty).toBeUndefined();
    expect(c.body.estimate.totalSec).toBeGreaterThan(0);
    const sess = await call("POST", "/v1/sessions", { date: "2026-11-19", planId: c.body.id });
    expect([sess.body.planId, sess.body.title, sess.body.note]).toEqual([c.body.id, "我的上肢", "慢一点"]);

    await Bun.sleep(5);
    const mark = new Date().toISOString();
    const u = await call("PUT", `/v1/plans/${c.body.id}`, { ...input, items: [input.items[0]], difficulty: "advanced" });
    expect(u.status).toBe(200);
    expect(u.body.items).toHaveLength(1);
    expect(u.body.difficulty).toBe("advanced");
    expect((await call("GET", "/v1/plans")).body.map((x: { id: string }) => x.id)).toEqual([c.body.id]);
    const after = (await call("GET", `/v1/sessions/${sess.body.id}`)).body;
    expect([after.items.length, after.difficulty]).toEqual([1, "advanced"]);
    // Bumped, so an updatedSince pull sees the new content.
    expect((await call("GET", `/v1/sessions?updatedSince=${encodeURIComponent(mark)}`)).body).toHaveLength(1);
  });

  test("delete takes its untrained sessions from today on; one sessions still need is archived", async () => {
    const { s } = await seed();
    const input = { title: "下肢", items: [{ exerciseId: s.id, sets: 1, reps: 10, restSec: 0, restAfterSec: 0 }] };
    const plain = (await call("POST", "/v1/plans", input)).body;
    const a = (await call("POST", "/v1/sessions", { date: "2026-11-20", planId: plain.id })).body;
    const del = await call("DELETE", `/v1/plans/${plain.id}`);
    expect(del.body).toEqual({ archived: false, deletedSessions: [a.id] });
    expect((await call("GET", "/v1/plans")).body).toEqual([]);
    expect((await call("GET", `/v1/sessions/${a.id}`)).status).toBe(404);
    expect((await call("DELETE", `/v1/plans/${plain.id}`)).status).toBe(404);

    const kept = (await call("POST", "/v1/plans", input)).body;
    const trained = (await call("POST", "/v1/sessions", { date: "2026-11-19", planId: kept.id })).body;
    const next = (await call("POST", "/v1/sessions", { date: "2026-11-21", planId: kept.id })).body;
    await call("POST", "/v1/workouts", { id: crypto.randomUUID(), sessionId: trained.id, date: "2026-11-19",
      startedAt: "2026-11-19T21:00:00+08:00", endedAt: "2026-11-19T21:10:00+08:00", status: "completed",
      sets: [{ itemIndex: 0, exerciseId: s.id, set: 1, actualReps: 10, status: "done" }] });
    const t = new Date().toISOString();
    db.query("INSERT INTO sessions (id, date, data, created_at, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, 'app')")
      .run("missed", "2026-11-10", JSON.stringify({ date: "2026-11-10", planId: kept.id }), t, t);
    const arch = await call("DELETE", `/v1/plans/${kept.id}`);
    expect(arch.body).toEqual({ archived: true, deletedSessions: [next.id] });
    expect((await call("GET", "/v1/plans")).body.map((x: { archived: boolean }) => x.archived)).toEqual([true]);
    // Still resolved for the sessions left; no longer scheduled or changed.
    expect((await call("GET", `/v1/sessions/${trained.id}`)).body.title).toBe("下肢");
    expect((await call("GET", "/v1/sessions/missed")).body.title).toBe("下肢");
    expect((await call("POST", "/v1/sessions", { date: "2026-11-22", planId: kept.id })).body.error).toBe("invalid_plan");
    // Moving the missed one to a new day would schedule the deleted plan again; it can still be marked skipped.
    expect((await call("PUT", "/v1/sessions/missed", { date: "2026-11-22", planId: kept.id })).body.error).toBe("invalid_plan");
    expect((await call("PUT", "/v1/sessions/missed", { date: "2026-11-10", planId: kept.id, skipped: true })).status).toBe(200);
    expect((await call("PUT", `/v1/plans/${kept.id}`, input)).status).toBe(409);
    expect((await call("DELETE", `/v1/plans/${kept.id}`)).status).toBe(404);
  });

  test("items are checked like a session's", async () => {
    const { s } = await seed();
    const bad = { title: "x", items: [{ exerciseId: s.id, sets: 1, seconds: 30, restSec: 0, restAfterSec: 0 }] };
    expect((await call("POST", "/v1/plans", bad)).status).toBe(400);
    expect((await call("POST", "/v1/plans", { title: "x", items: [] })).status).toBe(400);
    expect((await call("POST", "/v1/plans", { title: "x", items: [{ exerciseId: "nope", sets: 1, reps: 1, restSec: 0, restAfterSec: 0 }] })).status).toBe(400);
  });
});

describe("stored rows", () => {
  test("an exercise stored before later fields existed reads with its defaults", async () => {
    const t = "2026-11-01T00:00:00Z";
    db.run("INSERT INTO exercises (id, data, archived, created_at, updated_at, updated_by) VALUES (?, ?, 0, ?, ?, 'app')",
      ["ex-old", JSON.stringify({ name: "旧动作", mode: "reps" }), t, t]);
    const ex = await call("GET", "/v1/exercises/ex-old");
    expect(ex.status).toBe(200);
    expect(ex.body).toMatchObject({ pattern: "other", muscles: [], equipment: [], breathing: "", tags: [], tempoSec: 3 });
  });

  test("sessions with their own content get plans (004)", async () => {
    const t = "2026-11-01T00:00:00Z";
    const it = (reps: number) => [{ exerciseId: "ex-old", sets: 3, reps, restSec: 60, restAfterSec: 60 }];
    db.run("INSERT INTO plans (id, data, created_at, updated_at, updated_by) VALUES ('mine', ?, ?, ?, 'app')",
      [JSON.stringify({ title: "我的", note: "", items: it(10) }), t, t]);
    const builtinItems = [{ exerciseId: "ex-old", section: "main", sets: 2, reps: 10, restSec: 45, restAfterSec: 60 }];
    const presets = [{ id: "full-body-starter", title: "全身入门", note: "", difficulty: "beginner", items: builtinItems }];
    const row = (id: string, date: string, d: object) => db.run(
      "INSERT INTO sessions (id, date, data, created_at, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, 'app')",
      [id, date, JSON.stringify({ date, ...d }), t, t]);
    row("same", "2026-11-19", { title: "我的", items: it(10), planId: "mine", remindAt: "19:00" });
    row("drifted", "2026-11-19", { title: "我的", items: it(12), planId: "mine" });
    row("preset", "2026-11-19", { title: "Full body", items: builtinItems, planId: "full-body-starter" });
    row("old1", "2026-11-01", { title: "旧课", note: "n", items: it(8), difficulty: "beginner" });
    row("old2", "2026-11-02", { title: "旧课", note: "n", items: it(8), difficulty: "beginner" });
    row("harder", "2026-11-03", { title: "旧课", note: "n", items: it(8), difficulty: "advanced" }); // its own plan
    row("presetHard", "2026-11-19", { title: "Full body", items: builtinItems, planId: "full-body-starter", difficulty: "advanced" });
    splitSessions(db, "2026-11-19", presets);
    const get = (id: string) => JSON.parse(db.query<{ data: string }, [string]>("SELECT data FROM sessions WHERE id = ?").get(id)!.data);
    expect(get("same")).toEqual({ date: "2026-11-19", planId: "mine", remindAt: "19:00" });
    expect(get("preset").planId).toBe("full-body-starter");
    const drifted = get("drifted").planId;
    expect(drifted).not.toBe("mine");
    expect(get("old1").planId).toBe(get("old2").planId);
    const plans = db.query<{ id: string; data: string; archived: number }, []>("SELECT * FROM plans").all();
    const by = (id: string) => plans.find((p) => p.id === id)!;
    expect(get("harder").planId).not.toBe(get("old1").planId);
    expect(get("presetHard").planId).not.toBe("full-body-starter");
    expect([plans.length, by(drifted).archived, by(get("old1").planId).archived]).toEqual([5, 0, 1]);
    expect(JSON.parse(by(get("old1").planId).data)).toMatchObject({ title: "旧课", note: "n", difficulty: "beginner" });
    splitSessions(db, "2026-11-19", presets); // nothing left to do
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM plans").get()!.n).toBe(5);
  });
});

describe("workouts", () => {
  test("a row stored before later fields existed reads with their defaults", async () => {
    const old = { date: "2026-11-01", startedAt: "2026-11-01T10:00:00+08:00", endedAt: "2026-11-01T10:20:00+08:00",
      status: "completed", sets: [] };
    db.run("INSERT INTO workouts (id, session_id, date, data, created_at, updated_at, updated_by) VALUES (?, NULL, ?, ?, ?, ?, 'app')",
      ["old-1", old.date, JSON.stringify({ id: "old-1", ...old }), "2026-11-01T02:20:00Z", "2026-11-01T02:20:00Z"]);
    const r = await call("GET", "/v1/workouts?from=2026-11-01&to=2026-11-01");
    expect(r.status).toBe(200);
    expect(r.body[0]).toMatchObject({ id: "old-1", efforts: [], effort: null, note: "", sessionTitle: "", pausedSec: 0 });
    // One today's schema rejects (a limit tightened since) still gets the defaults.
    db.run("INSERT INTO workouts (id, session_id, date, data, created_at, updated_at, updated_by) VALUES (?, NULL, ?, ?, ?, ?, 'app')",
      ["old-2", old.date, JSON.stringify({ id: "old-2", ...old, pausedSec: -1 }), "2026-11-01T02:21:00Z", "2026-11-01T02:21:00Z"]);
    const all = (await call("GET", "/v1/workouts?from=2026-11-01&to=2026-11-01")).body;
    expect(all.find((w: { id: string }) => w.id === "old-2")).toMatchObject({ efforts: [], pausedSec: -1, note: "" });
  });

  const w = (id: string) => ({
    id, sessionId: null, date: "2026-11-19",
    startedAt: "2026-11-19T21:00:00+08:00", endedAt: "2026-11-19T21:24:00+08:00", status: "completed",
    sets: [{ itemIndex: 0, exerciseId: "x", set: 1, side: null, plannedReps: 15, actualReps: 15, status: "done" }],
  });

  test("a trained session can't be moved or switched, but can be deleted", async () => {
    const { s } = await seed();
    const input = { date: "2026-11-19", title: "t", items: [{ exerciseId: s.id, sets: 2, reps: 10, restSec: 60, restAfterSec: 90 }] };
    const created = (await sched(input)).body;
    expect((await call("POST", "/v1/workouts", { ...w(crypto.randomUUID()), sessionId: created.id })).status).toBe(201);
    const put = await call("PUT", `/v1/sessions/${created.id}`, { date: "2026-11-20", planId: created.planId });
    expect(put.status).toBe(409);
    expect(put.body.error).toBe("session_trained");
    // Its content is the plan's: an edit of the plan shows (the workout keeps what was trained).
    await call("PUT", `/v1/plans/${created.planId}`, { title: "t2", items: input.items });
    expect((await call("GET", `/v1/sessions/${created.id}`)).body.title).toBe("t2");
    expect((await call("DELETE", `/v1/sessions/${created.id}`)).status).toBe(204);
    const kept = await call("GET", "/v1/workouts?updatedSince=2000-01-01T00:00:00Z");
    expect(kept.body.some((x: { sessionId: string }) => x.sessionId === created.id)).toBe(true);
  });

  test("delete: gone from lists, its session untrained again, logged", async () => {
    const { s } = await seed();
    const items = [{ exerciseId: s.id, sets: 1, reps: 15, restSec: 60, restAfterSec: 0 }];
    const created = (await sched({ date: "2026-11-19", title: "t", items })).body;
    const id = crypto.randomUUID();
    const wk = { ...w(id), sessionId: created.id, sets: [{ ...w(id).sets[0], exerciseId: s.id }] };
    expect((await call("POST", "/v1/workouts", wk)).status).toBe(201);
    expect((await call("GET", `/v1/sessions/${created.id}`)).body.completedAt).toBeTruthy();
    expect((await call("DELETE", `/v1/workouts/${id}`)).status).toBe(204);
    expect((await call("GET", `/v1/workouts/${id}`)).status).toBe(404);
    expect((await call("GET", "/v1/workouts?from=2026-11-19&to=2026-11-19")).body).toHaveLength(0);
    const after = (await call("GET", `/v1/sessions/${created.id}`)).body;
    expect(after.completedAt ?? null).toBeNull();
    // Untrained again, so it can be moved.
    expect((await call("PUT", `/v1/sessions/${created.id}`, { date: "2026-11-20", planId: created.planId })).status).toBe(200);
    const log = (await call("GET", "/v1/changes?limit=500")).body.at(-2);
    expect(log).toMatchObject({ entity: "workout", entityId: id, action: "delete", after: null });
    expect((await call("DELETE", `/v1/workouts/${id}`)).status).toBe(404);
  });

  test("migration 005: exercises take the bundled slugs and every reference follows", async () => {
    const sq = (await call("POST", "/v1/exercises", squat)).body;
    const odd = (await call("POST", "/v1/exercises", { name: "不在 App 里的动作", mode: "reps" })).body;
    const items = [{ exerciseId: sq.id, sets: 2, reps: 10, restSec: 60, restAfterSec: 0 },
                   { exerciseId: odd.id, sets: 1, reps: 5, restSec: 30, restAfterSec: 0 }];
    const created = (await sched({ date: "2026-11-19", title: "t", items })).body;
    const wk = { ...w(crypto.randomUUID()), sessionId: created.id,
                 sets: [{ itemIndex: 0, exerciseId: sq.id, set: 1, side: null, plannedReps: 10, actualReps: 10, status: "done" }] };
    expect((await call("POST", "/v1/workouts", wk)).status).toBe(201);
    slugExercises(db, [{ id: "bodyweight-squat", name: "徒手深蹲" }]);
    expect((await call("GET", "/v1/exercises/bodyweight-squat")).body.name).toBe("徒手深蹲");
    expect((await call("GET", `/v1/exercises/${sq.id}`)).status).toBe(404);
    expect((await call("GET", `/v1/exercises/${odd.id}`)).status).toBe(200); // not bundled: keeps its id
    const plan = (await call("GET", "/v1/plans")).body.find((x: { id: string }) => x.id === created.planId);
    expect(plan.items.map((i: { exerciseId: string }) => i.exerciseId)).toEqual(["bodyweight-squat", odd.id]);
    expect((await call("GET", `/v1/workouts/${wk.id}`)).body.sets[0].exerciseId).toBe("bodyweight-squat");
    const log = db.query<{ n: number }, [string, string]>("SELECT COUNT(*) AS n FROM changes WHERE entity_id = ? OR after LIKE '%' || ? || '%'");
    expect(log.get(sq.id, sq.id)!.n).toBe(0);
    slugExercises(db, [{ id: "bodyweight-squat", name: "徒手深蹲" }]); // nothing left to do
    expect((await call("GET", "/v1/exercises/bodyweight-squat")).status).toBe(200);
  });

  test("all-time ranges: years before 100 are real days too", async () => {
    const { isCalendarDay } = await import("../src/schemas");
    expect(isCalendarDay("0000-01-01")).toBe(true);
    expect(isCalendarDay("0099-12-31")).toBe(true);
    expect(isCalendarDay("2026-02-29")).toBe(false);
    expect(isCalendarDay("2024-02-29")).toBe(true);
    expect((await call("GET", "/v1/workouts?from=0000-01-01&to=9999-12-31")).status).toBe(200);
  });

  test("difficulty: hand-set label round-trips, autoDifficulty from the exercises' levels", async () => {
    const ex = (await call("POST", "/v1/exercises", { name: "难度测试", mode: "time", level: 4 })).body;
    const input = { title: "d", items: [{ exerciseId: ex.id, sets: 1, seconds: 30, restSec: 0, restAfterSec: 0 }] };
    const auto = await sched({ ...input, date: "2026-11-20" });
    expect([auto.body.difficulty, auto.body.autoDifficulty]).toEqual([null, "expert"]);
    const set = await call("PUT", `/v1/plans/${auto.body.planId}`, { ...input, difficulty: "intermediate" });
    expect([set.body.difficulty, set.body.autoDifficulty]).toEqual(["intermediate", "expert"]);
    expect((await call("GET", `/v1/sessions/${auto.body.id}`)).body.difficulty).toBe("intermediate");
    expect((await call("POST", "/v1/plans", { ...input, difficulty: "hard" })).status).toBe(400);
  });
  test("a session ended early stays open but locked; reminder and skipped can still change", async () => {
    const { s } = await seed();
    const input = { date: "2026-11-19", title: "t", items: [{ exerciseId: s.id, sets: 2, reps: 10, restSec: 60, restAfterSec: 90 }] };
    const created = (await sched(input)).body;
    await call("POST", "/v1/workouts", { ...w(crypto.randomUUID()), sessionId: created.id, status: "ended_early" });
    const got = (await call("GET", `/v1/sessions/${created.id}`)).body;
    expect(got.completedAt).toBeNull();
    expect(got.workoutIds).toHaveLength(1);
    const other = (await call("POST", "/v1/plans", { title: "o", items: input.items })).body;
    expect((await call("PUT", `/v1/sessions/${created.id}`, { date: input.date, planId: other.id })).status).toBe(409);
    const r = await call("PUT", `/v1/sessions/${created.id}`, { date: input.date, planId: created.planId, remindAt: "19:00", skipped: true });
    expect(r.status).toBe(200);
    expect([r.body.remindAt, r.body.skipped]).toEqual(["19:00", true]);
    expect((await call("DELETE", `/v1/sessions/${created.id}`)).status).toBe(204);
  });

  test("paused seconds are kept and can't exceed the workout", async () => {
    const id = crypto.randomUUID();
    expect((await call("POST", "/v1/workouts", { ...w(id), pausedSec: 3600 })).status).toBe(400);
    const ok = await call("POST", "/v1/workouts", { ...w(id), pausedSec: 600 });
    expect(ok.status).toBe(201);
    expect(ok.body.pausedSec).toBe(600);
    expect((await call("POST", "/v1/workouts", w(crypto.randomUUID()))).body.pausedSec).toBe(0);
    const titled = await call("POST", "/v1/workouts", { ...w(crypto.randomUUID()), sessionTitle: "下肢" });
    expect(titled.body.sessionTitle).toBe("下肢");
  });

  test("upload is idempotent and editable", async () => {
    const id = crypto.randomUUID();
    expect((await call("POST", "/v1/workouts", w(id))).status).toBe(201);
    const again = await call("POST", "/v1/workouts", { ...w(id), note: "changed" });
    expect(again.status).toBe(200);
    expect(again.body.note).toBe("");

    const fixed = { ...w(id), sets: [{ ...w(id).sets[0], actualReps: 12, status: "partial" }] };
    const upd = await call("PUT", `/v1/workouts/${id}`, { ...fixed, status: "ended_early" }, COACH);
    expect(upd.body.sets[0].actualReps).toBe(12);
    expect((await call("PUT", `/v1/workouts/${crypto.randomUUID()}`, fixed)).status).toBe(400);
    expect((await call("GET", "/v1/workouts?from=2026-11-19&to=2026-11-19")).body).toHaveLength(1);
  });

  test("weight and per-exercise effort round-trip; effort range enforced", async () => {
    const id = crypto.randomUUID();
    const body = { ...w(id), sets: [{ ...w(id).sets[0], weightKg: 7.5 }], efforts: [{ itemIndex: 0, effort: 7 }] };
    const r = await call("POST", "/v1/workouts", body);
    expect(r.body.sets[0].weightKg).toBe(7.5);
    expect(r.body.efforts).toEqual([{ itemIndex: 0, effort: 7 }]);
    expect((await call("POST", "/v1/workouts", { ...w(crypto.randomUUID()), efforts: [{ itemIndex: 0, effort: 11 }] })).status).toBe(400);
    expect((await call("POST", "/v1/workouts", { ...w(crypto.randomUUID()), efforts: [{ itemIndex: 0, effort: 3 }, { itemIndex: 0, effort: 4 }] })).status).toBe(400);
    const old = (await call("POST", "/v1/workouts", w(crypto.randomUUID()))).body;
    expect(old.efforts).toEqual([]);
    expect(old.effort).toBeNull();
    const overall = (await call("POST", "/v1/workouts", { ...w(crypto.randomUUID()), effort: 8 })).body;
    expect(overall.effort).toBe(8);
    expect((await call("POST", "/v1/workouts", { ...w(crypto.randomUUID()), effort: 0 })).status).toBe(400);
    expect(old.sets[0].weightKg).toBeNull();
  });

  test("watch heart rate and energy are optional and range-checked", async () => {
    const id = crypto.randomUUID();
    const r = await call("POST", "/v1/workouts", { ...w(id), heartRateAvg: 118, heartRateMax: 162, activeKcal: 143 });
    expect(r.status).toBe(201);
    expect([r.body.heartRateAvg, r.body.heartRateMax, r.body.activeKcal]).toEqual([118, 162, 143]);
    const plain = await call("POST", "/v1/workouts", w(crypto.randomUUID()));
    expect([plain.body.heartRateAvg, plain.body.activeKcal]).toEqual([null, null]);
    expect((await call("POST", "/v1/workouts", { ...w(crypto.randomUUID()), heartRateMax: 400 })).status).toBe(400);
  });

  test("updatedSince returns only newer rows; list needs a filter", async () => {
    const a = (await call("POST", "/v1/workouts", w(crypto.randomUUID()))).body;
    await Bun.sleep(5);
    const b = (await call("POST", "/v1/workouts", w(crypto.randomUUID()))).body;
    const since = encodeURIComponent(a.updatedAt);
    const got = (await call("GET", `/v1/workouts?updatedSince=${since}`, undefined, COACH)).body;
    // Inclusive: the row at the cursor itself comes back too, so one written in the same millisecond isn't missed.
    expect(got.map((x: { id: string }) => x.id)).toEqual([a.id, b.id]);
    const later = encodeURIComponent(new Date(Date.parse(b.updatedAt) + 1).toISOString());
    expect((await call("GET", `/v1/workouts?updatedSince=${later}`)).body).toHaveLength(0);
    expect((await call("GET", "/v1/workouts?updatedSince=2026-01-01T00:00:00%2B08:00")).body).toHaveLength(2);
    expect((await call("GET", "/v1/workouts")).status).toBe(400);
    expect((await call("GET", "/v1/sessions?updatedSince=nope")).status).toBe(400);
  });

  test("session shows completion once a workout references it", async () => {
    const { s } = await seed();
    const sess = (await sched({ date: "2026-11-19", title: "t", items: [{ exerciseId: s.id, sets: 2, reps: 10, restSec: 60, restAfterSec: 90 }] }, COACH)).body;
    expect(sess.completedAt).toBeNull();
    const item = (await sched({ date: "2026-11-19", title: "t", items: [{ exerciseId: s.id, sets: 2, reps: 10, weightKg: 2.5, restSec: 60, restAfterSec: 90 }] })).body;
    expect(item.items[0].weightKg).toBe(2.5);
    const wid = crypto.randomUUID();
    const set = (n: number) => ({ ...w(wid).sets[0], exerciseId: s.id, set: n });
    await call("POST", "/v1/workouts", { ...w(wid), sessionId: sess.id, sets: [set(1), set(2)] });
    const after = (await call("GET", `/v1/sessions/${sess.id}`)).body;
    expect(after.completedAt).toBe("2026-11-19T21:24:00+08:00");
    expect(after.workoutIds).toEqual([wid]);
  });

  test("unilateral sets keep left and right apart; duplicates rejected", async () => {
    const base = w(crypto.randomUUID()).sets[0]!;
    const L = { ...base, side: "left", plannedReps: 8, actualReps: 8 };
    const R = { ...base, side: "right", plannedReps: 8, actualReps: 6, status: "partial" };
    const r = await call("POST", "/v1/workouts", { ...w(crypto.randomUUID()), status: "ended_early", sets: [L, R] });
    expect(r.body.sets.map((x: { side: string; actualReps: number }) => [x.side, x.actualReps])).toEqual([["left", 8], ["right", 6]]);
    expect((await call("POST", "/v1/workouts", { ...w(crypto.randomUUID()), sets: [L, L] })).status).toBe(400);
  });

  test("a workout completes its session only if its sets match the items", async () => {
    const { s } = await seed();
    const input = { date: "2026-11-19", title: "t", items: [{ exerciseId: s.id, sets: 2, reps: 10, restSec: 60, restAfterSec: 90 }] };
    const sess = (await sched(input)).body;
    const set = (n: number, over: Record<string, unknown> = {}) => ({ ...w("x").sets[0], exerciseId: s.id, set: n, ...over });
    // "completed" with a skipped set is a contradiction.
    expect((await call("POST", "/v1/workouts", { ...w(crypto.randomUUID()), sessionId: sess.id,
      sets: [set(1), set(2, { status: "skipped" })] })).status).toBe(400);
    // Another exercise, an item that isn't there, or a missing set: stored, but the session stays open.
    for (const sets of [[set(1, { exerciseId: "other" }), set(2)], [set(1), set(2), set(1, { itemIndex: 3 })], [set(1)]]) {
      expect((await call("POST", "/v1/workouts", { ...w(crypto.randomUUID()), sessionId: sess.id, sets })).status).toBe(201);
    }
    expect((await call("GET", `/v1/sessions/${sess.id}`)).body.completedAt).toBeNull();
  });

  test("a one-sided move needs both sides of every set to complete the session", async () => {
    const one = (await call("POST", "/v1/exercises", { ...squat, name: "单腿臀桥", unilateral: true })).body;
    const sess = (await sched({ date: "2026-11-19", title: "t",
      items: [{ exerciseId: one.id, sets: 1, reps: 10, restSec: 60, restAfterSec: 90 }] })).body;
    const side = (s: string) => ({ ...w("x").sets[0], exerciseId: one.id, set: 1, side: s });
    await call("POST", "/v1/workouts", { ...w(crypto.randomUUID()), sessionId: sess.id, sets: [side("left")] });
    expect((await call("GET", `/v1/sessions/${sess.id}`)).body.completedAt).toBeNull();
    const both = { ...w(crypto.randomUUID()), sessionId: sess.id, sets: [side("left"), side("right"), { ...side("x"), side: null }] };
    expect((await call("POST", "/v1/workouts", both)).body.status).toBe("ended_early"); // whole and sides of one set
    await call("POST", "/v1/workouts", { ...w(crypto.randomUUID()), sessionId: sess.id, sets: [side("left"), side("right")] });
    expect((await call("GET", `/v1/sessions/${sess.id}`)).body.completedAt).not.toBeNull();
  });

  test("a record that doesn't cover its session (or has no sets) is stored as ended early", async () => {
    const { s } = await seed();
    const sess = (await sched({ date: "2026-11-19", title: "t",
      items: [{ exerciseId: s.id, sets: 2, reps: 10, restSec: 60, restAfterSec: 90 }] })).body;
    const first = { ...w("x").sets[0], exerciseId: s.id, set: 1 };
    const part = (await call("POST", "/v1/workouts", { ...w(crypto.randomUUID()), sessionId: sess.id, sets: [first] })).body;
    expect(part.status).toBe("ended_early");
    expect((await call("POST", "/v1/workouts", { ...w(crypto.randomUUID()), sessionId: sess.id, sets: [] })).body.status).toBe("ended_early");
    const whole = (await call("POST", "/v1/workouts", { ...w(crypto.randomUUID()), sessionId: sess.id,
      sets: [first, { ...first, set: 2 }] })).body;
    expect(whole.status).toBe("completed");
    const extra = (await call("POST", "/v1/workouts", { ...w(crypto.randomUUID()), sessionId: sess.id,
      sets: [first, { ...first, set: 2 }, { ...first, set: 3 }] })).body;
    expect(extra.status).toBe("ended_early");
  });

  test("a record is settled against the plan as trained; a later correction keeps it", async () => {
    const { s } = await seed();
    const sess = (await sched({ date: "2026-11-19", title: "t",
      items: [{ exerciseId: s.id, sets: 1, reps: 10, restSec: 60, restAfterSec: 90 }] })).body;
    const planned = sess.items;
    // The plan gains a set while the workout is under way.
    const plan = (await call("GET", "/v1/plans")).body.find((p: { id: string }) => p.id === sess.planId);
    await call("PUT", `/v1/plans/${plan.id}`, { title: plan.title, note: plan.note, items: [{ ...planned[0], sets: 2 }] });
    const sets = [{ ...w("x").sets[0], exerciseId: s.id, set: 1 }];
    const asTrained = (await call("POST", "/v1/workouts", { ...w(crypto.randomUUID()), sessionId: sess.id, sets, planned })).body;
    expect(asTrained.status).toBe("completed");
    expect(asTrained.planned).toBeUndefined(); // not stored
    // Without the snapshot (older apps): the plan as it is now.
    expect((await call("POST", "/v1/workouts", { ...w(crypto.randomUUID()), sessionId: sess.id, sets })).body.status).toBe("ended_early");
    // Rating it later doesn't settle it again against the edited plan.
    const fixed = (await call("PUT", `/v1/workouts/${asTrained.id}`, { ...asTrained, effort: 5 })).body;
    expect(fixed.status).toBe("completed");
    expect(fixed.effort).toBe(5);
    // Nor can a correction complete one that was settled as ended early.
    const early = (await call("POST", "/v1/workouts", { ...w(crypto.randomUUID()), sessionId: sess.id, sets })).body;
    const full = [...sets, { ...sets[0], set: 2 }];
    expect((await call("PUT", `/v1/workouts/${early.id}`, { ...early, sets: full, status: "completed" })).body.status).toBe("ended_early");
  });

  test("completion follows the real instant across UTC offsets; workout changes bump the session", async () => {
    const { s } = await seed();
    const input = { date: "2026-11-19", title: "t", items: [{ exerciseId: s.id, sets: 1, reps: 10, restSec: 60, restAfterSec: 90 }] };
    const sess = (await sched(input)).body;
    const sets = [{ ...w("x").sets[0], exerciseId: s.id }];
    const early = { ...w(crypto.randomUUID()), sessionId: sess.id, sets,
      startedAt: "2026-11-19T09:40:00+02:00", endedAt: "2026-11-19T10:00:00+02:00" }; // 08:00Z
    const late = { ...w(crypto.randomUUID()), sessionId: sess.id, sets,
      startedAt: "2026-11-19T09:10:00Z", endedAt: "2026-11-19T09:30:00Z" };
    await call("POST", "/v1/workouts", late);
    await call("POST", "/v1/workouts", early);
    const got = (await call("GET", `/v1/sessions/${sess.id}`)).body;
    expect(got.completedAt).toBe(late.endedAt);
    expect(got.workoutIds).toEqual([early.id, late.id]);
    await Bun.sleep(5);
    const mark = new Date().toISOString();
    await Bun.sleep(5);
    await call("PUT", `/v1/workouts/${late.id}`, { ...late, status: "ended_early" });
    const pulled = (await call("GET", `/v1/sessions?updatedSince=${encodeURIComponent(mark)}`)).body;
    expect(pulled.map((x: { id: string }) => x.id)).toEqual([sess.id]);
    expect(pulled[0].completedAt).toBe(early.endedAt);
  });

  test("sessions are scheduled today to 14 days ahead; an existing date may stay", async () => {
    const { s } = await seed();
    const plan = (await call("POST", "/v1/plans", { title: "t", items: [{ exerciseId: s.id, sets: 1, reps: 10, restSec: 60, restAfterSec: 90 }] })).body;
    const input = { planId: plan.id };
    // now = 2026-11-19 12:00 UTC+8; any zone's today counts (UTC-12 is still the 18th).
    for (const date of ["2026-11-17", "2026-12-05"]) expect((await call("POST", "/v1/sessions", { ...input, date })).status).toBe(400);
    for (const date of ["2026-11-18", "2026-12-03"]) expect((await call("POST", "/v1/sessions", { ...input, date })).status).toBe(201);
    const t = new Date().toISOString();
    db.query("INSERT INTO sessions (id, date, data, created_at, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, 'app')")
      .run("past", "2026-11-01", JSON.stringify({ ...input, date: "2026-11-01" }), t, t);
    expect((await call("PUT", "/v1/sessions/past", { ...input, date: "2026-11-01", skipped: true })).status).toBe(200);
    expect((await call("PUT", "/v1/sessions/past", { ...input, date: "2026-12-30" })).status).toBe(400);
  });

  test("the largest valid session's sets fit: 30 items x 20 sets x 2 sides", async () => {
    const base = w(crypto.randomUUID()).sets[0]!;
    const sets = [];
    for (let i = 0; i < 30; i++) for (let n = 1; n <= 20; n++) for (const side of ["left", "right"])
      sets.push({ ...base, itemIndex: i, set: n, side });
    expect((await call("POST", "/v1/workouts", { ...w(crypto.randomUUID()), sets })).status).toBe(201);
    expect((await call("POST", "/v1/workouts", { ...w(crypto.randomUUID()), sets: [...sets, { ...base, itemIndex: 30 }] })).status).toBe(400);
  });

  test("rejects non-uuid id and bad timestamps", async () => {
    expect((await call("POST", "/v1/workouts", w("abc"))).status).toBe(400);
    expect((await call("POST", "/v1/workouts", { ...w(crypto.randomUUID()), startedAt: "yesterday" })).status).toBe(400);
  });
});

describe("change log", () => {
  test("records actor, action and before/after", async () => {
    const { s } = await seed();
    await call("PUT", `/v1/exercises/${s.id}`, { ...squat, tempoSec: 4 }, COACH);
    const all = (await call("GET", "/v1/changes")).body;
    expect(all.map((c: { action: string }) => c.action)).toEqual(["create", "create", "update"]);
    const last = all.at(-1);
    expect(last).toMatchObject({ actor: "coach", entity: "exercise", entityId: s.id });
    expect(last.before.tempoSec).toBe(3);
    expect(last.after.tempoSec).toBe(4);
    expect((await call("GET", `/v1/changes?since=${last.seq}`)).body).toHaveLength(0);
  });
});

describe("session estimate", () => {
  test("returned on create, get and list", async () => {
    const { s, p } = await seed();
    const created = await sched({ date: "2026-11-19", title: "e", items: [
      { exerciseId: s.id, sets: 2, reps: 10, restSec: 60, restAfterSec: 90 },
      { exerciseId: p.id, sets: 1, seconds: 30, restSec: 60, restAfterSec: 0 },
    ] }, COACH);
    const want = { totalSec: 12 + 60 + 60 + 90 + 30, workSec: 12 + 60 + 30, restSec: 150 };
    expect(created.body.estimate).toEqual(want);
    expect((await call("GET", `/v1/sessions/${created.body.id}`)).body.estimate).toEqual(want);
    expect((await call("GET", "/v1/sessions?from=2026-11-19&to=2026-11-19")).body[0].estimate).toEqual(want);
  });
});

