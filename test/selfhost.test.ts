import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app";
import { ConfigError, readConfig } from "../src/config";
import { openDb, seedExercises } from "../src/db";

const A = "a".repeat(32), C = "c".repeat(32);
const IMG = `${"1".repeat(64)}.jpg`;
const VID = `${"2".repeat(64)}.mp4`;

const FIXTURES = [
  {
    id: "bodyweight-squat",
    name: "徒手深蹲",
    mode: "reps" as const,
    unilateral: false,
    tempoSec: 3,
    pauseSec: 0,
    pauseAt: "",
    cues: ["臀部向后坐"],
    mistakes: ["膝盖内扣"],
    setup: "双脚与肩同宽",
    images: [{ file: IMG, phase: "站立" }],
    video: { file: VID, turnSec: 2, durationSec: 4, aspect: 0.8 },
    pattern: "squat" as const,
    muscles: ["股四头肌"],
    equipment: [],
    level: 2,
    breathing: "下蹲吸气",
    tags: ["安静"],
  },
  {
    id: "plank",
    name: "平板支撑",
    mode: "time" as const,
    unilateral: false,
    tempoSec: 3,
    pauseSec: 0,
    pauseAt: "",
    cues: ["收紧核心"],
    mistakes: ["塌腰"],
    setup: "铺瑜伽垫",
    images: [],
    pattern: "core" as const,
    muscles: ["腹横肌"],
    equipment: ["瑜伽垫"],
    level: 2,
    breathing: "匀速呼吸",
    tags: [],
  },
];

describe("config", () => {
  test("both tokens, loopback, 8720 by default", () => {
    const c = readConfig({ HOME: "/h", FITNESS_APP_TOKEN: A, FITNESS_COACH_TOKEN: C });
    expect(c).toEqual({ dataDir: "/h/data/fitness", tokens: { [A]: "app", [C]: "coach" }, host: "127.0.0.1", port: 8720 });
  });

  test("one token, any interface", () => {
    const c = readConfig({ FITNESS_APP_TOKEN: ` ${A} `, HOST: "0.0.0.0", PORT: "3000", FITNESS_DATA_DIR: "/data" });
    expect(c).toEqual({ dataDir: "/data", tokens: { [A]: "app" }, host: "0.0.0.0", port: 3000 });
  });

  test("an empty coach token is no coach token", () => {
    expect(readConfig({ FITNESS_APP_TOKEN: A, FITNESS_COACH_TOKEN: "  " }).tokens).toEqual({ [A]: "app" });
  });

  test.each([
    [{}, "FITNESS_APP_TOKEN must be set"],
    [{ FITNESS_APP_TOKEN: "short" }, "at least 16"],
    [{ FITNESS_APP_TOKEN: A, FITNESS_COACH_TOKEN: A }, "must differ"],
    [{ FITNESS_APP_TOKEN: A, FITNESS_COACH_TOKEN: "short" }, "FITNESS_COACH_TOKEN must be at least 16"],
    [{ FITNESS_APP_TOKEN: A, PORT: "0" }, "PORT"],
    [{ FITNESS_APP_TOKEN: A, PORT: "http" }, "PORT"],
  ] as [Record<string, string>, string][])("refuses %p", (env, msg) => {
    expect(() => readConfig(env)).toThrow(ConfigError);
    expect(() => readConfig(env)).toThrow(msg);
  });
});

function fresh() {
  const dir = mkdtempSync(join(tmpdir(), "fitness-selfhost-"));
  const db = openDb(join(dir, "t.db"));
  const app = createApp({ db, mediaDir: join(dir, "media"), tokens: { [A]: "app" }, now: () => new Date("2026-12-01T00:00:00Z") });
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await app.request(path, {
      method, headers: { authorization: `Bearer ${A}`, ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  return { db, call };
}

describe("syncing bundled exercises from the app", () => {
  test("inserts exercises under their slug ids without needing media files on disk", async () => {
    const { db, call } = fresh();
    const res = await call("POST", "/v1/exercises/sync", { exercises: FIXTURES });
    expect(res).toEqual({ status: 200, body: { added: 2, total: 2 } });
    const list = await call("GET", "/v1/exercises");
    expect(list.status).toBe(200);
    expect(list.body.map((e: { id: string }) => e.id)).toEqual(["bodyweight-squat", "plank"]);
    // Sync writes nothing to the change feed.
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM changes").get()!.n).toBe(0);
  });

  test("idempotent: never overwrites edited or archived exercises, only adds missing ones", async () => {
    const { call } = fresh();
    await call("POST", "/v1/exercises/sync", { exercises: [FIXTURES[0]!] });
    // Edit squat and archive it
    const { body } = await call("GET", "/v1/exercises/bodyweight-squat");
    const { id, archived, createdAt, updatedAt, updatedBy, ...input } = body;
    const edited = await call("PUT", `/v1/exercises/${id}`, { ...input, setup: "自定义场地" });
    expect(edited.status).toBe(200);
    expect(edited.body.setup).toBe("自定义场地");
    await call("POST", "/v1/exercises/bodyweight-squat/archive");

    // Re-sync both: squat stays edited and archived, plank is added
    const res = await call("POST", "/v1/exercises/sync", { exercises: FIXTURES });
    expect(res).toEqual({ status: 200, body: { added: 1, total: 2 } });
    const squat = await call("GET", "/v1/exercises/bodyweight-squat");
    expect(squat.body.setup).toBe("自定义场地");
    expect(squat.body.archived).toBe(true);
  });

  test("editing a synced exercise keeps its bundled media but still rejects unknown new media", async () => {
    const { call } = fresh();
    await call("POST", "/v1/exercises/sync", { exercises: [FIXTURES[0]!] });
    const { body } = await call("GET", "/v1/exercises/bodyweight-squat");
    const { id, archived, createdAt, updatedAt, updatedBy, ...input } = body;
    // Keeping existing bundled image/video succeeds
    expect((await call("PUT", `/v1/exercises/${id}`, { ...input, setup: "客厅" })).status).toBe(200);
    // Pointing at an unuploaded random file fails
    const bad = await call("PUT", `/v1/exercises/${id}`, { ...input, images: [{ file: `${"9".repeat(64)}.jpg`, phase: "x" }] });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe("unknown_media");
  });
});

describe("on-demand presets", () => {
  const preset = {
    title: "测试预置计划",
    note: "十分钟",
    difficulty: "beginner",
    items: [{ exerciseId: "bodyweight-squat", section: "main", sets: 2, reps: 10, restSec: 30, restAfterSec: 30 }],
  };

  test("registering a preset lets sessions schedule it without putting it in 我的计划", async () => {
    const { call } = fresh();
    await call("POST", "/v1/exercises/sync", { exercises: FIXTURES });

    // Unknown before registration
    const before = await call("POST", "/v1/sessions", { date: "2026-12-01", planId: "test-preset" });
    expect(before.status).toBe(400);

    // Register preset on demand
    const put = await call("PUT", "/v1/presets/test-preset", preset);
    expect(put.status).toBe(200);
    expect(put.body.id).toBe("test-preset");

    // Not listed in 我的计划
    expect((await call("GET", "/v1/plans")).body).toEqual([]);

    // Can now be scheduled and resolves title/items/estimate
    const created = await call("POST", "/v1/sessions", { date: "2026-12-01", planId: "test-preset" });
    expect(created.status).toBe(201);
    expect(created.body.title).toBe("测试预置计划");
    expect(created.body.items).toHaveLength(1);
    expect(created.body.estimate.totalSec).toBeGreaterThan(0);

    // Mode change on an exercise used by a stored preset is blocked
    const { body: ex } = await call("GET", "/v1/exercises/bodyweight-squat");
    const { id, archived, createdAt, updatedAt, updatedBy, ...input } = ex;
    const modeChange = await call("PUT", `/v1/exercises/${id}`, { ...input, mode: "time" });
    expect(modeChange.status).toBe(400);
    expect(modeChange.body.error).toBe("mode_change_in_use");
  });
});

describe("seeding helper (private repo)", () => {
  test("seeds an empty db, skips when non-empty, skips invalid entries", () => {
    const { db } = fresh();
    expect(seedExercises(db, [{ id: "ok", name: "好", mode: "reps" }, { id: "bad", name: "", mode: "fly" }, { id: "", name: "无", mode: "reps" }])).toBe(1);
    expect(db.query("SELECT id FROM exercises").all()).toEqual([{ id: "ok" }]);
    expect(seedExercises(db, FIXTURES)).toBe(0);
  });
});

describe("a single-token server", () => {
  test("the app token works and nothing else does", async () => {
    const { call } = fresh();
    expect((await call("GET", "/v1/exercises")).status).toBe(200);
    const dir = mkdtempSync(join(tmpdir(), "fitness-selfhost-"));
    const app = createApp({ db: openDb(join(dir, "t.db")), mediaDir: join(dir, "media"), tokens: { [A]: "app" } });
    for (const auth of [`Bearer ${C}`, "Bearer ", ""]) {
      const res = await app.request("/v1/exercises", { headers: auth ? { authorization: auth } : {} });
      expect(res.status).toBe(401);
    }
  });
});
