import { describe, expect, test } from "bun:test";
import { estimate } from "../src/estimate";

// The 2026-11-18 全身徒手 session; 39:16 on the phone's clock plus the 8 s opening-line allowance = 39:23.
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
  test("matches the app timeline (39:16 + opening line)", () => {
    expect(estimate(items, get)).toEqual({ totalSec: 2363, workSec: 1013, restSec: 1350 });
  });
  test("item overrides, min 4 s transitions, last restAfter ignored", () => {
    const e = estimate([
      { exerciseId: "squat", sets: 2, reps: 10, tempoSec: 2, pauseSec: 1, restSec: 0, restAfterSec: 0 },
      { exerciseId: "plank", sets: 1, seconds: 30, restSec: 60, restAfterSec: 999 },
    ], get);
    // work 5 + 2*10*3 + 30 = 95; rest: 4 (between sets) + 4 (to plank)
    expect(e).toEqual({ totalSec: 110, workSec: 102, restSec: 8 });
  });
  test("null when unresolvable", () => {
    expect(estimate([{ exerciseId: "nope", sets: 1, reps: 1, restSec: 0, restAfterSec: 0 }], get)).toBeNull();
    expect(estimate([{ exerciseId: "plank", sets: 1, reps: 10, restSec: 0, restAfterSec: 0 }], get)).toBeNull();
  });
});
