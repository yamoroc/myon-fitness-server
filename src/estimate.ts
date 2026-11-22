// Session duration estimate. Mirrors ios/Fitness/Player/Timeline.swift (TimelineBuilder + TimelineConfig);
// change both together. The test pins the 2026-11 full-body session (39:23 with the 12 s intro allowance).

// The phone reads an opening line (session title, first exercise and target) off the clock, then a 4 s 3-2-1.
// The line's length depends on the voice; ~8 s covers a typical one.
export const INTRO_SEC = 4 + 8;
export const SWITCH_SIDE_SEC = 5;
export const MIN_TRANSITION_SEC = 4;

type Ex = { mode: "reps" | "time"; unilateral: boolean; tempoSec: number; pauseSec: number };
type Item = {
  exerciseId: string; sets: number; reps?: number; seconds?: number;
  tempoSec?: number; pauseSec?: number; restSec: number; restAfterSec: number;
};
export type Estimate = { totalSec: number; workSec: number; restSec: number };

/** Returns null if an exercise is unknown or an item lacks the target its mode needs. */
export function estimate(items: Item[], getEx: (id: string) => Ex | null): Estimate | null {
  let work = INTRO_SEC, rest = 0;
  for (const [i, it] of items.entries()) {
    const ex = getEx(it.exerciseId);
    if (!ex) return null;
    const target = ex.mode === "reps" ? it.reps : it.seconds;
    if (target == null) return null;
    const per = ex.mode === "reps" ? target * ((it.tempoSec ?? ex.tempoSec) + (it.pauseSec ?? ex.pauseSec)) : target;
    const sides = ex.unilateral ? 2 : 1;
    work += it.sets * sides * per + it.sets * (sides - 1) * SWITCH_SIDE_SEC;
    rest += (it.sets - 1) * Math.max(it.restSec, MIN_TRANSITION_SEC);
    if (i < items.length - 1) rest += Math.max(it.restAfterSec, MIN_TRANSITION_SEC);
  }
  const r = (x: number) => Math.round(x * 10) / 10;
  return { totalSec: r(work + rest), workSec: r(work), restSec: r(rest) };
}
