import { planBlocks, type GroupableItem } from "./groups";

// Session duration estimate. Mirrors ios/Fitness/Player/Timeline.swift (TimelineBuilder + TimelineConfig);
// change both together. The opening line is spoken off the clock, so the timeline starts at the 4 s 3-2-1.

export const INTRO_SEC = 4;
export const SWITCH_SIDE_SEC = 5;
export const MIN_TRANSITION_SEC = 4;

type Ex = { mode: "reps" | "time"; unilateral: boolean; tempoSec: number; pauseSec: number };
type Item = GroupableItem & {
  exerciseId: string; sets: number; reps?: number; seconds?: number;
  tempoSec?: number; pauseSec?: number; restSec: number; restAfterSec: number;
};
export type Estimate = { totalSec: number; workSec: number; restSec: number };

/** Returns null if an exercise is unknown or an item lacks the target its mode needs. */
export function estimate(items: Item[], getEx: (id: string) => Ex | null): Estimate | null {
  let work = INTRO_SEC, rest = 0;
  const blocks = planBlocks(items);
  for (const [bIdx, block] of blocks.entries()) {
    for (let r = 0; r < block.rounds; r++) {
      for (const [j, { item: it }] of block.entries.entries()) {
        const ex = getEx(it.exerciseId);
        if (!ex) return null;
        const target = ex.mode === "reps" ? it.reps : it.seconds;
        if (target == null) return null;
        const per = ex.mode === "reps" ? target * ((it.tempoSec ?? ex.tempoSec) + (it.pauseSec ?? ex.pauseSec)) : target;
        const sides = ex.unilateral ? 2 : 1;
        work += it.sets * sides * per + it.sets * (sides - 1) * SWITCH_SIDE_SEC;
        rest += (it.sets - 1) * Math.max(it.restSec, MIN_TRANSITION_SEC);
        const isLastInRound = j === block.entries.length - 1;
        if (!isLastInRound) {
          rest += Math.max(it.restAfterSec, MIN_TRANSITION_SEC);
        } else if (r < block.rounds - 1) {
          rest += Math.max(block.roundRestSec, MIN_TRANSITION_SEC);
        } else if (bIdx < blocks.length - 1) {
          rest += Math.max(it.restAfterSec, MIN_TRANSITION_SEC);
        }
      }
    }
  }
  const r = (x: number) => Math.round(x * 10) / 10;
  return { totalSec: r(work + rest), workSec: r(work), restSec: r(rest) };
}

/** Rounded display minutes shown on cards and detail screens ("约 N 分钟"). */
export const estimateMinutes = (est: Estimate) => Math.round(est.totalSec / 60);

/** Allowed drift (minutes) from a target duration before rejecting: max(3, round(20%)). */
export const durationTolerance = (targetMinutes: number) => Math.max(3, Math.round(targetMinutes * 0.2));

/** Returns a problem description if actualMinutes drifts too far from targetMinutes, else null. */
export function checkTargetMinutes(actualMinutes: number, targetMinutes: number): string | null {
  const tol = durationTolerance(targetMinutes);
  const diff = actualMinutes - targetMinutes;
  if (Math.abs(diff) <= tol) return null;
  const dir = diff > 0 ? "longer" : "shorter";
  return `actual duration is ${actualMinutes} min (${Math.abs(diff)} min ${dir} than target ${targetMinutes} min; allowed ${targetMinutes - tol}-${targetMinutes + tol} min)`;
}

export type ItemDuration = { index: number; exerciseId: string; name?: string; totalSec: number; minutes: number };

/** Per-item total seconds (work + attributed rest across all rounds), sorted longest first. */
export function topDurationItems(
  items: Item[],
  getEx: (id: string) => (Ex & { name?: string }) | null,
  limit = 3,
): ItemDuration[] {
  const totals = items.map((it, index) => ({ index, exerciseId: it.exerciseId, name: getEx(it.exerciseId)?.name, totalSec: 0 }));
  const blocks = planBlocks(items);
  for (const [bIdx, block] of blocks.entries()) {
    for (let r = 0; r < block.rounds; r++) {
      for (const [j, { index, item: it }] of block.entries.entries()) {
        const ex = getEx(it.exerciseId);
        if (!ex) continue;
        const target = ex.mode === "reps" ? it.reps : it.seconds;
        if (target == null) continue;
        const per = ex.mode === "reps" ? target * ((it.tempoSec ?? ex.tempoSec) + (it.pauseSec ?? ex.pauseSec)) : target;
        const sides = ex.unilateral ? 2 : 1;
        let sec = it.sets * sides * per + it.sets * (sides - 1) * SWITCH_SIDE_SEC
          + (it.sets - 1) * Math.max(it.restSec, MIN_TRANSITION_SEC);
        const isLastInRound = j === block.entries.length - 1;
        if (!isLastInRound) {
          sec += Math.max(it.restAfterSec, MIN_TRANSITION_SEC);
        } else if (r < block.rounds - 1) {
          sec += Math.max(block.roundRestSec, MIN_TRANSITION_SEC);
        } else if (bIdx < blocks.length - 1) {
          sec += Math.max(it.restAfterSec, MIN_TRANSITION_SEC);
        }
        totals[index]!.totalSec += sec;
      }
    }
  }
  return totals
    .sort((a, b) => b.totalSec - a.totalSec)
    .slice(0, limit)
    .map((x) => ({
      index: x.index,
      exerciseId: x.exerciseId,
      ...(x.name ? { name: x.name } : {}),
      totalSec: Math.round(x.totalSec * 10) / 10,
      minutes: Math.round((x.totalSec / 60) * 10) / 10,
    }));
}

export type DurationMention = {
  raw: string;
  kind: "exact" | "max" | "min" | "range";
  min: number;
  max: number;
};

const ZH_DIGIT: Record<string, number> = {
  零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
};

function parseZhInt(s: string): number | null {
  if (/^\d+(?:\.\d+)?$/.test(s)) return Number(s);
  if (s === "半") return 0.5;
  let total = 0;
  let cur = 0;
  let seen = false;
  for (const ch of s) {
    if (ch in ZH_DIGIT) {
      cur = ZH_DIGIT[ch]!;
      seen = true;
    } else if (ch === "十") {
      total += (seen ? cur : 1) * 10;
      cur = 0;
      seen = false;
    } else if (ch === "百") {
      total += (seen ? cur : 1) * 100;
      cur = 0;
      seen = false;
    } else {
      return null;
    }
  }
  const out = total + cur;
  return out > 0 ? out : null;
}

const EN_WORDS: Record<string, number> = {
  five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15,
  sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
  twenty: 20, "twenty-five": 25, "twenty five": 25,
  thirty: 30, "thirty-five": 35, "thirty five": 35,
  forty: 40, "forty-five": 45, "forty five": 45,
  fifty: 50, sixty: 60,
};

const ZH_NOTE_SKIP_BEFORE = /(?:休息|休|歇|组间|轮间|间歇|换动作|保持|撑|每组|每侧|单侧|热身|体感|评分|满分|打|得)\s*$/;
const EN_NOTE_SKIP_BEFORE = /\b(?:rest|break|hold|recovery|warm[- ]?up|cool[- ]?down|per\s+set|per\s+side|between\s+\w+)\s*(?:for\s+|of\s+)?$/i;
const EN_NOTE_SKIP_AFTER = /^\s*[-]?(?:rest|break|hold|warm[- ]?up|cool[- ]?down)\b/i;

const ZH_CAP_BEFORE = /(?:不到|不超过|不超|少于|至多|最多|≤|<=)\s*$/;
const ZH_MIN_BEFORE = /(?:至少|不少于|超过|高于|≥|>=)\s*$/;
const EN_CAP_BEFORE = /\b(?:under|within|less\s+than|up\s+to|at\s+most|below)\s*$/i;
const EN_MIN_BEFORE = /\b(?:at\s+least|over|more\s+than)\s*$/i;
const EN_CAP_AFTER = /^\s*(?:or\s+(?:less|under))\b/i;
const EN_MIN_AFTER = /^\s*(?:or\s+(?:more|over)|\+)/i;

function sameClauseBefore(text: string, index: number): string {
  const slice = text.slice(Math.max(0, index - 24), index);
  const cut = slice.search(/[，。、；：！？\n,.!?;:()（）][^，。、；：！？\n,.!?;:()（）]*$/);
  return cut >= 0 ? slice.slice(cut + 1) : slice;
}

/**
 * Extract total-duration mentions (in minutes) from a plan title or note.
 * Per-set seconds (30秒/45s) and in-note rest/hold/warm-up lengths are ignored.
 * Mirrors ios/Fitness/Coach/PlanDurationCheck.swift and ios/scripts/check-l10n.py.
 */
export function durationMentions(text: string, field: "title" | "note" = "title"): DurationMention[] {
  const out: DurationMention[] = [];
  const used: [number, number][] = [];
  const overlaps = (start: number, end: number) => used.some(([a, b]) => start < b && end > a);
  const skip = (start: number, end: number) => {
    if (field !== "note") return false;
    const before = sameClauseBefore(text, start);
    const after = text.slice(end, end + 16);
    return ZH_NOTE_SKIP_BEFORE.test(before) || EN_NOTE_SKIP_BEFORE.test(before) || EN_NOTE_SKIP_AFTER.test(after);
  };
  const push = (start: number, end: number, m: DurationMention) => {
    if (overlaps(start, end) || skip(start, end)) return;
    used.push([start, end]);
    out.push(m);
  };
  const classify = (start: number, end: number, val: number, capSuffix = false, minSuffix = false): DurationMention => {
    const before = sameClauseBefore(text, start);
    const after = text.slice(end, end + 16);
    const raw = text.slice(start, end);
    if (capSuffix || ZH_CAP_BEFORE.test(before) || EN_CAP_BEFORE.test(before) || EN_CAP_AFTER.test(after)) {
      return { raw, kind: "max", min: val, max: val };
    }
    if (minSuffix || ZH_MIN_BEFORE.test(before) || EN_MIN_BEFORE.test(before) || EN_MIN_AFTER.test(after)) {
      return { raw, kind: "min", min: val, max: val };
    }
    return { raw, kind: "exact", min: val, max: val };
  };

  // 1. Ranges: "15-20 分钟", "15–20 min", "15 to 20 minutes"
  for (const m of text.matchAll(/(\d+|[一二两三四五六七八九十]+)\s*(?:[-–—~～到至]|to)\s*(\d+|[一二两三四五六七八九十]+)\s*(?:分钟|[- ]?min(?:ute)?s?\b)/gi)) {
    const a = parseZhInt(m[1]!), b = parseZhInt(m[2]!);
    if (a != null && b != null && b >= a) {
      push(m.index!, m.index! + m[0].length, { raw: m[0], kind: "range", min: Math.round(a), max: Math.round(b) });
    }
  }

  // 2. Chinese quarter-hour / half-hour / hours
  for (const m of text.matchAll(/一刻钟(以内|内)?/g)) {
    push(m.index!, m.index! + m[0].length, classify(m.index!, m.index! + m[0].length, 15, Boolean(m[1])));
  }
  for (const m of text.matchAll(/半个?小时(以内|内|以上)?/g)) {
    push(m.index!, m.index! + m[0].length, classify(m.index!, m.index! + m[0].length, 30, m[1] === "内" || m[1] === "以内", m[1] === "以上"));
  }
  for (const m of text.matchAll(/(?<![\d.])(\d+(?:\.\d+)?|[一二两三])\s*个?小时(以内|内|以上)?/g)) {
    const v = parseZhInt(m[1]!);
    if (v != null) {
      push(m.index!, m.index! + m[0].length, classify(m.index!, m.index! + m[0].length, Math.round(v * 60), m[2] === "内" || m[2] === "以内", m[2] === "以上"));
    }
  }

  // 3. Chinese explicit "分钟"
  for (const m of text.matchAll(/(?<![\d.])(\d+(?:\.\d+)?|[一二两三四五六七八九十百]+)\s*分钟(以内|内|以上)?/g)) {
    const v = parseZhInt(m[1]!);
    if (v != null && v >= 1) {
      push(m.index!, m.index! + m[0].length, classify(m.index!, m.index! + m[0].length, Math.round(v), m[2] === "内" || m[2] === "以内", m[2] === "以上"));
    }
  }

  // 4. Chinese shorthand "分" (e.g. "十五分", "二十分", "20分") at word/clause boundary; excludes bare "十分" ("very")
  for (const m of text.matchAll(/(?<![\d.])(\d+|[二三四五六七八九]?十[一二三四五六七八九]?)\s*分(以内|内|以上)?(?=$|[\s，。、；：！？·—\-)）])/g)) {
    if (m[1] === "十") continue;
    const v = parseZhInt(m[1]!);
    if (v != null && v >= 5) {
      push(m.index!, m.index! + m[0].length, classify(m.index!, m.index! + m[0].length, Math.round(v), m[2] === "内" || m[2] === "以内", m[2] === "以上"));
    }
  }

  // 5. English quarter/half hour & hours
  for (const m of text.matchAll(/\b(?:a\s+)?quarter(?:\s+of\s+an)?\s+hour\b/gi)) {
    push(m.index!, m.index! + m[0].length, classify(m.index!, m.index! + m[0].length, 15));
  }
  for (const m of text.matchAll(/\b(?:a\s+)?half(?:\s+an)?\s+hour\b/gi)) {
    push(m.index!, m.index! + m[0].length, classify(m.index!, m.index! + m[0].length, 30));
  }
  for (const m of text.matchAll(/(?<![\d.])(\d+(?:\.\d+)?)\s*[-]?(?:hr|hour)s?\b/gi)) {
    push(m.index!, m.index! + m[0].length, classify(m.index!, m.index! + m[0].length, Math.round(Number(m[1]) * 60)));
  }

  // 6. English Arabic minutes ("15-min", "20 minutes", "10-Minute")
  for (const m of text.matchAll(/(?<![\d.])(\d+(?:\.\d+)?)\s*[-]?(?:min(?:ute)?s?)\b/gi)) {
    const v = Math.round(Number(m[1]));
    if (v >= 1) push(m.index!, m.index! + m[0].length, classify(m.index!, m.index! + m[0].length, v));
  }

  // 7. English word minutes ("fifteen minutes", "twenty-minute")
  const wordRe = /\b(twenty[- ]five|thirty[- ]five|forty[- ]five|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty)\s*[-]?(?:min(?:ute)?s?)\b/gi;
  for (const m of text.matchAll(wordRe)) {
    const v = EN_WORDS[m[1]!.toLowerCase()];
    if (v != null) push(m.index!, m.index! + m[0].length, classify(m.index!, m.index! + m[0].length, v));
  }

  return out;
}

/** Check whether any duration stated in `title` or `note` conflicts with `actualMinutes`. Empty = ok. */
export function checkDurationCopy(title: string, note: string, actualMinutes: number): string[] {
  const problems: string[] = [];
  for (const [field, text] of [["title", title], ["note", note]] as const) {
    for (const m of durationMentions(text, field)) {
      const ok = m.kind === "exact" ? actualMinutes === m.min
        : m.kind === "max" ? actualMinutes <= m.max
        : m.kind === "min" ? actualMinutes >= m.min
        : actualMinutes >= m.min && actualMinutes <= m.max;
      if (!ok) {
        const expected = m.kind === "max" ? `<=${m.max}` : m.kind === "min" ? `>=${m.min}` : m.kind === "range" ? `${m.min}-${m.max}` : `${m.min}`;
        problems.push(`${field} states "${m.raw}" (${expected} min) but actual duration is ${actualMinutes} min`);
      }
    }
  }
  return problems;
}
