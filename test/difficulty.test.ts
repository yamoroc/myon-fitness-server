import { describe, expect, test } from "bun:test";
import { builtinPlans, bundledExercises } from "../src/builtin";
import { autoDifficulty, meanLevel, tier } from "../src/difficulty";

const exercises = new Map(bundledExercises().map((e) => [e.id, e]));
const plans = builtinPlans() as unknown as { title: string; difficulty: string; items: Parameters<typeof autoDifficulty>[0] }[];
const get = (id: string) => (exercises.get(id) ?? null) as any;

describe("difficulty", () => {
  test("tier bounds", () => {
    expect([1, 1.99, 2, 3.29, 3.3, 3.99, 4, 5].map(tier)).toEqual(
      ["beginner", "beginner", "intermediate", "intermediate", "advanced", "advanced", "expert", "expert"]);
  });
  test.skipIf(plans.length === 0)("every preset plan's label matches the computed tier", () => {
    expect(plans.length).toBe(51);
    for (const p of plans) expect([p.title, autoDifficulty(p.items, get)]).toEqual([p.title, p.difficulty]);
  });
  test("main section only, weighted by time with both sides; unrated left out", () => {
    const ex: Record<string, any> = {
      easy: { mode: "time", unilateral: false, tempoSec: 3, pauseSec: 0, level: 1 },
      hard: { mode: "reps", unilateral: true, tempoSec: 2, pauseSec: 1, level: 5 },
      none: { mode: "time", unilateral: false, tempoSec: 3, pauseSec: 0 },
    };
    const g = (id: string) => ex[id] ?? null;
    // easy 60 s; hard 5 reps x 3 s x 2 sides x 2 sets = 60 s -> mean 3
    expect(meanLevel([
      { exerciseId: "easy", section: "warmup", sets: 1, seconds: 600 },
      { exerciseId: "easy", sets: 1, seconds: 60 },
      { exerciseId: "hard", section: "main", sets: 2, reps: 5 },
      { exerciseId: "none", sets: 5, seconds: 600 },
    ], g)).toBe(3);
    // No main section: everything counts.
    expect(autoDifficulty([{ exerciseId: "easy", section: "cooldown", sets: 1, seconds: 30 }], g)).toBe("beginner");
    expect(autoDifficulty([{ exerciseId: "none", sets: 1, seconds: 30 }], g)).toBeNull();
  });
});
