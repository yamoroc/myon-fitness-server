/**
 * Grouping helpers for supersets and circuits: consecutive items sharing a `groupId` repeat together
 * for `rounds` rounds, with `roundRestSec` between rounds. Mirrors iOS `SessionItem.planBlocks` /
 * `Session.problems`; keep both in sync.
 */

export type GroupableItem = {
  section?: string;
  sets: number;
  groupId?: string;
  rounds?: number;
  roundRestSec?: number;
};

export type PlanBlock<T> = {
  isGroup: boolean;
  groupId?: string;
  rounds: number;
  roundRestSec: number;
  entries: { index: number; item: T }[];
};

/** Splits `items` into sequential single-item or multi-item loop blocks. */
export function planBlocks<T extends GroupableItem>(items: T[]): PlanBlock<T>[] {
  const out: PlanBlock<T>[] = [];
  let i = 0;
  while (i < items.length) {
    const first = items[i]!;
    const gid = first.groupId;
    if (gid) {
      let j = i + 1;
      while (j < items.length && items[j]!.groupId === gid) j++;
      const count = j - i;
      const rounds = first.rounds ?? 1;
      if (count >= 2 && rounds >= 2) {
        const entries = [];
        for (let k = i; k < j; k++) entries.push({ index: k, item: items[k]! });
        out.push({
          isGroup: true,
          groupId: gid,
          rounds,
          roundRestSec: first.roundRestSec ?? 0,
          entries,
        });
        i = j;
        continue;
      }
    }
    out.push({ isGroup: false, rounds: 1, roundRestSec: 0, entries: [{ index: i, item: first }] });
    i++;
  }
  return out;
}

/** Total sets executed for `items[index]`, multiplying by `rounds` when inside a loop block. */
export function effectiveSets<T extends GroupableItem>(items: T[], index: number): number {
  for (const b of planBlocks(items)) {
    for (const e of b.entries) {
      if (e.index === index) return b.rounds * e.item.sets;
    }
  }
  return items[index]?.sets ?? 0;
}

/** Validates group integrity: contiguous, >= 2 items, same section, valid rounds. */
export function validateGroups<T extends GroupableItem>(items: T[]): { index: number; message: string }[] {
  const errors: { index: number; message: string }[] = [];
  const seen = new Set<string>();
  let i = 0;
  while (i < items.length) {
    const first = items[i]!;
    const gid = first.groupId;
    if (!gid) {
      if (first.rounds !== undefined || first.roundRestSec !== undefined) {
        errors.push({ index: i, message: "rounds and roundRestSec require groupId" });
      }
      i++;
      continue;
    }
    if (seen.has(gid)) {
      errors.push({ index: i, message: `groupId '${gid}' must be contiguous` });
      i++;
      continue;
    }
    seen.add(gid);
    let j = i + 1;
    while (j < items.length && items[j]!.groupId === gid) j++;
    if (j - i < 2) {
      errors.push({ index: i, message: `groupId '${gid}' needs at least 2 items` });
    }
    const sec = first.section ?? "main";
    for (let k = i + 1; k < j; k++) {
      if ((items[k]!.section ?? "main") !== sec) {
        errors.push({ index: k, message: `all items in group '${gid}' must share the same section` });
      }
    }
    if (first.rounds === undefined) {
      errors.push({ index: i, message: `groupId '${gid}' requires rounds (2-20) on its first item` });
    }
    for (let k = i + 1; k < j; k++) {
      if (items[k]!.rounds !== undefined || items[k]!.roundRestSec !== undefined) {
        errors.push({ index: k, message: `only the first item of group '${gid}' may set rounds or roundRestSec` });
      }
    }
    i = j;
  }
  return errors;
}
