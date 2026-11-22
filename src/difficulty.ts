// Session difficulty tier. Mirrors ios/Fitness/Data/PlanDifficulty.swift; change both together.
// The test pins the 24 preset plans' tiers (ios/Content/plans.json).

export const DIFFICULTIES = ["beginner", "intermediate", "advanced", "expert"] as const;
export type Difficulty = (typeof DIFFICULTIES)[number];

type Ex = { mode: "reps" | "time"; unilateral: boolean; tempoSec: number; pauseSec: number; level?: number };
type Item = { exerciseId: string; section?: string; sets: number; reps?: number; seconds?: number; tempoSec?: number; pauseSec?: number };

/** Upper bounds (exclusive) of the mean level for beginner, intermediate, advanced; anything higher is expert. */
export const TIER_BOUNDS = [2, 3.3, 4] as const;

/**
 * Mean exercise level (1-5) over the main section, weighted by working time (both sides, all sets); warm-up and
 * cool-down only count when there is no main section. Exercises without a level are left out. Null if nothing is rated.
 */
export function meanLevel(items: Item[], getEx: (id: string) => Ex | null): number | null {
  const main = items.filter((it) => (it.section ?? "main") === "main");
  let w = 0, sum = 0;
  for (const it of main.length ? main : items) {
    const ex = getEx(it.exerciseId);
    if (!ex?.level) continue;
    const per = ex.mode === "reps" ? (it.reps ?? 0) * ((it.tempoSec ?? ex.tempoSec) + (it.pauseSec ?? ex.pauseSec)) : (it.seconds ?? 0);
    const t = per * it.sets * (ex.unilateral ? 2 : 1);
    w += t; sum += t * ex.level;
  }
  return w > 0 ? sum / w : null;
}

export function tier(mean: number): Difficulty {
  const i = TIER_BOUNDS.findIndex((b) => mean < b);
  return DIFFICULTIES[i < 0 ? 3 : i]!;
}

export function autoDifficulty(items: Item[], getEx: (id: string) => Ex | null): Difficulty | null {
  const m = meanLevel(items, getEx);
  return m == null ? null : tier(m);
}
