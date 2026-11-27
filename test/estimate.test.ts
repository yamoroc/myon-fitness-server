import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { builtinPlans, bundledExercises } from "../src/builtin";
import { checkDurationCopy, durationMentions, estimate, estimateMinutes } from "../src/estimate";

// The 2026-11-18 全身徒手 session; 39:15 on the phone's timeline (4 s intro).
const ex = {
  squat: { mode: "reps", unilateral: false, tempoSec: 3, pauseSec: 0 },
  lunge: { mode: "reps", unilateral: true, tempoSec: 3, pauseSec: 0 },
  pushup: { mode: "reps", unilateral: false, tempoSec: 3, pauseSec: 0 },
  bss: { mode: "reps", unilateral: true, tempoSec: 3, pauseSec: 0 },
  bridge: { mode: "reps", unilateral: false, tempoSec: 2, pauseSec: 2 },
  plank: { mode: "time", unilateral: false, tempoSec: 3, pauseSec: 0 },
  calf: { mode: "reps", unilateral: true, tempoSec: 2, pauseSec: 1 },
} as const;
const items = [
  { exerciseId: "squat", sets: 3, reps: 15, restSec: 75, restAfterSec: 90 },
  { exerciseId: "lunge", sets: 3, reps: 10, restSec: 75, restAfterSec: 90 },
  { exerciseId: "pushup", sets: 3, reps: 10, restSec: 75, restAfterSec: 90 },
  { exerciseId: "bss", sets: 2, reps: 8, restSec: 75, restAfterSec: 90 },
  { exerciseId: "bridge", sets: 3, reps: 15, restSec: 60, restAfterSec: 90 },
  { exerciseId: "plank", sets: 3, seconds: 35, restSec: 60, restAfterSec: 90 },
  { exerciseId: "calf", sets: 2, reps: 15, restSec: 45, restAfterSec: 0 },
];
const get = (id: string) => (ex as Record<string, (typeof ex)[keyof typeof ex]>)[id] ?? null;

describe("estimate", () => {
  test("matches the app timeline (39:15 with 4 s intro)", () => {
    const e = estimate(items, get)!;
    expect(e).toEqual({ totalSec: 2355, workSec: 1005, restSec: 1350 });
    expect(estimateMinutes(e)).toBe(39);
  });
  test("item overrides, min 4 s transitions, last restAfter ignored", () => {
    const e = estimate([
      { exerciseId: "squat", sets: 2, reps: 10, tempoSec: 2, pauseSec: 1, restSec: 0, restAfterSec: 0 },
      { exerciseId: "plank", sets: 1, seconds: 30, restSec: 60, restAfterSec: 999 },
    ], get);
    // work 4 + 2*10*3 + 30 = 94; rest: 4 (between sets) + 4 (to plank)
    expect(e).toEqual({ totalSec: 102, workSec: 94, restSec: 8 });
  });
  test("null when unresolvable", () => {
    expect(estimate([{ exerciseId: "nope", sets: 1, reps: 1, restSec: 0, restAfterSec: 0 }], get)).toBeNull();
    expect(estimate([{ exerciseId: "plank", sets: 1, reps: 10, restSec: 0, restAfterSec: 0 }], get)).toBeNull();
  });
  test("superset / circuit repeats rounds with roundRestSec between rounds and last restAfterSec at end", () => {
    const e = estimate([
      { exerciseId: "squat", sets: 1, reps: 10, restSec: 0, restAfterSec: 10, groupId: "g1", rounds: 3, roundRestSec: 45 },
      { exerciseId: "plank", sets: 1, seconds: 20, restSec: 0, restAfterSec: 60, groupId: "g1" },
      { exerciseId: "pushup", sets: 1, reps: 10, restSec: 0, restAfterSec: 0 },
    ], get);
    // Round work: (10*3 + 20) * 3 = 150, plus pushup 10*3 = 30 -> work = 4 + 180 = 184
    // Rest: inside rounds 10 * 3 = 30; between rounds 45 * 2 = 90; after group 60 -> rest = 180
    expect(e).toEqual({ totalSec: 364, workSec: 184, restSec: 180 });
  });
});

describe("checkDurationCopy", () => {
  test("parses exact, cap, range, Chinese and English expressions", () => {
    expect(checkDurationCopy("晨间十分钟唤醒", "十分钟内驱散困意", 10)).toEqual([]);
    expect(checkDurationCopy("轻快无跳燃脂", "一刻钟内痛快出汗", 14)).toEqual([]);
    expect(checkDurationCopy("核心一刻钟速练", "十五分钟紧凑腰腹", 15)).toEqual([]);
    expect(checkDurationCopy("15-Minute Core Express", "under fifteen minutes", 15)).toEqual([]);
    expect(checkDurationCopy("半小时全身", "25-30 分钟练透", 30)).toEqual([]);
    expect(checkDurationCopy("15 分钟核心", "", 23)).toHaveLength(1);
    expect(checkDurationCopy("轻快燃脂一刻钟", "一刻钟内", 14)).toHaveLength(1);
    expect(checkDurationCopy("20-Minute Full Body", "in under fifteen minutes", 19)).toHaveLength(2);
    expect(checkDurationCopy("晨间唤醒", "十分钟内完成", 11)).toHaveLength(1);
  });

  test("ignores per-set seconds, rest/hold times in note, and non-time words", () => {
    expect(durationMentions("深蹲分腿蹲组合", "title")).toEqual([]);
    expect(durationMentions("十分舒服的拉伸", "title")).toEqual([]);
    expect(durationMentions("4-7-8 助眠呼吸，30 秒一组，组间休息 1 分钟，轮间休 2 分钟，热身 3 分钟，体感 8 分", "note")).toEqual([]);
    expect(durationMentions("30-second rounds, 1-min rest between sets, 2 min hold, 3-min warm-up", "note")).toEqual([]);
    expect(checkDurationCopy("泡沫轴全身放松十五分", "", 12)).toHaveLength(1);
  });

  const bundledPlans = builtinPlans();
  test.skipIf(bundledPlans.length === 0)("every preset plan's ZH/EN copy matches computed duration and pinned store refs", () => {
    const exById = new Map(bundledExercises().map((e) => [e.id, e]));
    const getEx = (id: string) => (exById.get(id) ?? null) as any;
    const contentDir = join(import.meta.dir, "..", "..", "ios", "Content");
    const l10n = (lang: string) => {
      const f = join(contentDir, "l10n", `${lang}.json`);
      return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")).plans as Record<string, { title: string; note: string }>) : {};
    };
    const zh = l10n("zh-Hans"), en = l10n("en");
    const mismatches: string[] = [];
    const pinned: Record<string, number> = {
      "desk-neck-shoulder-relief": 8, // CPP "Desk & Neck Stretch" hero copy
      "morning-wake-up": 10, // New Year In-App Event deep link
    };
    for (const p of bundledPlans) {
      const est = estimate(p.items as any, getEx);
      expect(est).not.toBeNull();
      const mins = estimateMinutes(est!);
      if (p.id in pinned && mins !== pinned[p.id]) {
        mismatches.push(`${p.id}: pinned external ref expects ${pinned[p.id]}m, got ${mins}m`);
      }
      for (const msg of checkDurationCopy(p.title, p.note ?? "", mins)) mismatches.push(`${p.id} (plans.json): ${msg}`);
      if (zh[p.id]) {
        if (zh[p.id]!.title !== p.title || zh[p.id]!.note !== (p.note ?? "")) {
          mismatches.push(`${p.id} (zh-Hans.json): out of sync with plans.json`);
        }
      }
      if (en[p.id]) {
        for (const msg of checkDurationCopy(en[p.id]!.title, en[p.id]!.note, mins)) mismatches.push(`${p.id} (en.json): ${msg}`);
      }
    }
    expect(mismatches).toEqual([]);
  });
});
