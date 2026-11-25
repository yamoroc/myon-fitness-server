import { z } from "@hono/zod-openapi";
import { DIFFICULTIES } from "./difficulty";
import { validateGroups } from "./groups";

export const Actor = z.enum(["app", "coach"]);
export type Actor = z.infer<typeof Actor>;

/** yyyy-mm-dd that is a real calendar day (2026-02-30 and 2026-99-99 are not). */
export const isCalendarDay = (s: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number) as [number, number, number];
  const t = new Date(Date.UTC(2000, m - 1, d));
  t.setUTCFullYear(y); // Date.UTC maps years 0-99 to 1900-1999
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
};
const CalendarDay = z.string().refine(isCalendarDay, { message: "Expected a real calendar day, yyyy-mm-dd" });
const DateStr = CalendarDay.openapi({ example: "2026-11-19", description: "Local calendar day (UTC+8)" });
const MediaFile = z.string().regex(/^[a-f0-9]{64}\.(png|jpg|webp)$/);

export const ExerciseImage = z.object({
  file: MediaFile.openapi({ description: "File name returned by POST /v1/media" }),
  phase: z.string().max(20).default("").openapi({ description: "Phase label, e.g. 站立 / 下蹲 / 底部 / 起身" }),
});

export const ExerciseVideo = z
  .object({
    file: z.string().regex(/^[a-f0-9]{64}\.mp4$/).openapi({ description: "File name returned by POST /v1/media (video/mp4)" }),
    turnSec: z.number().min(0).max(60).openapi({ description: "Time of the far point of the move (bottom of a squat, top of a bridge), where a pause is held" }),
    durationSec: z.number().positive().max(60).openapi({ description: "One full cycle: start pose -> far point -> start pose" }),
    aspect: z.number().positive().max(10).openapi({ description: "Width / height" }),
  })
  .openapi({ description: "One repetition (reps mode) or one cycle (time mode), played in step with the tempo" });

export const Pattern = z
  .enum(["squat", "hinge", "lunge", "push", "pull", "core", "calf", "mobility", "cardio", "other"])
  .openapi({ description: "Movement pattern: squat 蹲, hinge 髋铰链/桥, lunge 弓步/分腿, push 推, pull 拉, core 核心, calf 小腿, mobility 拉伸/活动度, cardio 有氧, other" });
export const Section = z.enum(["warmup", "main", "cooldown"]).openapi({ description: "warmup 热身 / main 正式 / cooldown 放松" });
const Tag = z.string().trim().min(1).max(20);
export const Difficulty = z.enum(DIFFICULTIES).openapi({ description: "beginner 入门 / intermediate 中级 / advanced 进阶 / expert 高阶" });

export const ExerciseInput = z
  .object({
    name: z.string().trim().min(1).max(60),
    mode: z.enum(["reps", "time"]).openapi({ description: "reps: counted by tempo; time: held for N seconds" }),
    unilateral: z.boolean().default(false).openapi({ description: "Each set is done left then right; reps/seconds are per side" }),
    tempoSec: z.number().min(0.5).max(20).default(3).openapi({ description: "Seconds per rep (reps mode)" }),
    pauseSec: z.number().min(0).max(30).default(0).openapi({ description: "Hold inside each rep, e.g. 2 for 顶端停 2 秒" }),
    pauseAt: z.string().max(20).default("").openapi({ description: "Where the pause happens, e.g. 顶端" }),
    cues: z.array(z.string().max(200)).max(20).default([]).openapi({ description: "Technique points, in order" }),
    mistakes: z.array(z.string().max(200)).max(20).default([]),
    setup: z.string().max(300).default("").openapi({ description: "Equipment / placement, e.g. 身后放椅子" }),
    images: z.array(ExerciseImage).max(8).default([]).openapi({ description: "1 image for static holds, 2-4 phase frames for movements" }),
    video: ExerciseVideo.optional(),
    // ---- metadata for planning; the player only displays/announces it ----
    pattern: Pattern.default("other"),
    muscles: z.array(Tag).max(10).default([]).openapi({ description: "Target muscles, primary first, e.g. 臀大肌, 股四头肌" }),
    equipment: z.array(Tag).max(10).default([]).openapi({ description: "Required equipment, e.g. 椅子, 哑铃, 瑜伽垫. Empty = bodyweight, no props" }),
    level: z.number().int().min(1).max(5).optional().openapi({ description: "Rough difficulty 1 (easiest) - 5" }),
    breathing: z.string().max(100).default("").openapi({ description: "e.g. 下蹲吸气，起身呼气" }),
    tags: z.array(Tag).max(20).default([]).openapi({ description: "Free planning tags, e.g. 低冲击, 安静（适合夜间）, 不压膝" }),
  })
  .openapi("ExerciseInput");

export const Exercise = ExerciseInput.extend({
  id: z.string(),
  archived: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
  updatedBy: Actor,
}).openapi("Exercise");

export const ExerciseSyncItem = ExerciseInput.extend({
  id: z.string().trim().min(1).max(100),
}).openapi("ExerciseSyncItem");

export const ExerciseSyncInput = z.object({
  exercises: z.array(ExerciseSyncItem).max(1000),
}).openapi("ExerciseSyncInput");

export const ExerciseSyncResult = z.object({
  added: z.number().int().min(0),
  total: z.number().int().min(0),
}).openapi("ExerciseSyncResult");

export const SessionItem = z
  .object({
    exerciseId: z.string().openapi({ description: "The same exercise may appear in several items (A, B, A ...)" }),
    section: Section.default("main"),
    sets: z.number().int().min(1).max(20),
    reps: z.number().int().min(1).max(200).optional().openapi({ description: "Per set (per side if unilateral). Required for reps-mode exercises" }),
    seconds: z.number().int().min(1).max(3600).optional().openapi({ description: "Per set (per side if unilateral). Required for time-mode exercises" }),
    tempoSec: z.number().min(0.5).max(20).optional().openapi({ description: "Override exercise default" }),
    pauseSec: z.number().min(0).max(30).optional().openapi({ description: "Override exercise default" }),
    weightKg: z.number().min(0).max(500).multipleOf(0.25).optional().openapi({ description: "External load per set in kg (dumbbell, vest). Omit for bodyweight" }),
    restSec: z.number().int().min(0).max(600).openapi({ description: "Rest between sets of this item" }),
    restAfterSec: z.number().int().min(0).max(900).openapi({ description: "Rest after the last set, before the next item (or next exercise inside a group)" }),
    groupId: z.string().trim().min(1).max(40).optional().openapi({ description: "Consecutive items sharing the same groupId form a superset (2 items) or circuit (3+ items)" }),
    rounds: z.number().int().min(2).max(20).optional().openapi({ description: "Total rounds for the group (required on the first item of a group, 2-20)" }),
    roundRestSec: z.number().int().min(0).max(900).optional().openapi({ description: "Rest between rounds of the group (on the first item, default 0)" }),
  })
  .openapi("SessionItem");

export const SessionInput = z
  .object({
    date: DateStr,
    planId: z.string().trim().min(1).max(100)
      .openapi({ description: "The plan to train that day: a user plan's id (GET /v1/plans, not archived) or a built-in plan's slug. A session has no content of its own: title, note, items, difficulty and the estimate are the plan's, so editing the plan changes every session that uses it. To train something different once, create a new plan and point the session at it" }),
    remindAt: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).nullable().optional()
      .openapi({ example: "19:00", description: "Local time (HH:mm) of a phone notification on the session's day; null or absent = no reminder" }),
    remindNote: z.string().trim().max(60).nullable().optional()
      .openapi({ description: "Notification text written by the coach; absent = the app's default" }),
    skipped: z.boolean().optional()
      .openapi({ description: "The user said they won't train this one (hidden from the app's missed list, kept for the coach)" }),
  })
  .openapi("SessionInput");

export const Session = SessionInput.extend({
  id: z.string(),
  title: z.string().openapi({ description: "Read-only, the plan's" }),
  note: z.string().openapi({ description: "Read-only, the plan's" }),
  items: z.array(SessionItem).openapi({ description: "Read-only, the plan's (as it is now)" }),
  difficulty: Difficulty.nullable().openapi({ description: "Read-only, the plan's hand-set label" }),
  completedAt: z.string().nullable().openapi({ description: "endedAt of the latest completed (not ended_early) workout for this session, or null" }),
  workoutIds: z.array(z.string()).openapi({ description: "Workouts uploaded for this session, oldest first" }),
  autoDifficulty: Difficulty.nullable()
    .openapi({ description: "Read-only: tier of the main section's mean exercise level weighted by working time (<2 beginner, <3.3 intermediate, <4 advanced, else expert); null if no exercise has a level" }),
  estimate: z
    .object({
      totalSec: z.number().openapi({ description: "Played as scheduled, same timeline as the app" }),
      workSec: z.number().openapi({ description: "Intro + working sets + side switches: the floor if every rest is skipped" }),
      restSec: z.number().openapi({ description: "Rests between sets and between exercises (each at least 4 s)" }),
    })
    .nullable()
    .openapi({ description: "Read-only duration estimate; null if an exercise can't be resolved" }),
  createdAt: z.string(),
  updatedAt: z.string(),
  updatedBy: Actor,
}).openapi("Session");

export const PlanInput = z
  .object({
    title: z.string().trim().min(1).max(60),
    note: z.string().max(500).default(""),
    items: z.array(SessionItem).min(1).max(50),
    difficulty: Difficulty.nullable().optional()
      .openapi({ description: "Difficulty label set by hand; null or absent = the app shows autoDifficulty" }),
  })
  .superRefine((plan, ctx) => {
    for (const err of validateGroups(plan.items)) {
      ctx.addIssue({ code: "custom", path: ["items", err.index], message: err.message });
    }
  })
  .openapi("PlanInput");

export const Plan = PlanInput.extend({
  id: z.string(),
  archived: z.boolean().openapi({ description: "Deleted while sessions still pointed at it (trained or past ones): hidden from 我的计划 and can't be scheduled or changed, kept so those sessions still resolve" }),
  locked: z.boolean().openapi({ description: "Read-only master template locked by the user: cannot be modified, deleted, or shelved by the coach; unlock in the app first or copy into a new plan" }),
  shelved: z.boolean().openapi({ description: "Reversibly tucked into 已收起: hidden from the active list and default coach reads; cannot be scheduled by the coach until unshelved" }),
  autoDifficulty: Difficulty.nullable().openapi({ description: "Read-only, same rule as Session.autoDifficulty" }),
  estimate: Session.shape.estimate,
  createdAt: z.string(),
  updatedAt: z.string(),
  updatedBy: Actor,
}).openapi("Plan");

export const WorkoutSet = z
  .object({
    itemIndex: z.number().int().min(0),
    exerciseId: z.string(),
    set: z.number().int().min(1),
    side: z.enum(["left", "right"]).nullable().default(null),
    plannedReps: z.number().int().nullable().default(null),
    plannedSeconds: z.number().int().nullable().default(null),
    actualReps: z.number().int().min(0).nullable().default(null),
    actualSeconds: z.number().int().min(0).nullable().default(null),
    weightKg: z.number().min(0).max(500).nullable().default(null).openapi({ description: "Load actually used; null = bodyweight" }),
    status: z.enum(["done", "partial", "skipped"]),
  })
  .openapi("WorkoutSet");

export const WorkoutInput = z
  .object({
    id: z.uuid().openapi({ description: "Client-generated; re-uploading the same id is a no-op" }),
    sessionId: z.string().nullable().default(null),
    date: DateStr,
    startedAt: z.iso.datetime({ offset: true }),
    endedAt: z.iso.datetime({ offset: true }),
    status: z.enum(["completed", "ended_early"]),
    sets: z
      .array(WorkoutSet)
      // Enough for 50 items x 20 sets/rounds x 2 sides (with a generous headroom for grouped circuits).
      .max(5000)
      .refine(
        (ss) => new Set(ss.map((x) => `${x.itemIndex}/${x.set}/${x.side}`)).size === ss.length,
        "duplicate (itemIndex, set, side)",
      )
      .openapi({ description: "One row per set per side. Unilateral exercises have separate left and right rows, each with its own actual reps/seconds" }),
    effort: z
      .number().int().min(1).max(10).nullable().default(null)
      .openapi({ description: "Whole-workout effort, Apple Workout scale: 1-3 easy, 4-6 moderate, 7-8 hard, 9-10 all out. null = not rated. This is what the app records" }),
    efforts: z
      .array(z.object({ itemIndex: z.number().int().min(0), effort: z.number().int().min(1).max(10) }))
      .max(50)
      .refine((es) => new Set(es.map((e) => e.itemIndex)).size === es.length, "one effort per itemIndex")
      .default([])
      .openapi({ description: "Legacy per-exercise effort (same scale). The app no longer sends it; prefer `effort`" }),
    note: z.string().max(500).default(""),
    heartRateAvg: z.number().int().min(20).max(250).nullable().default(null)
      .openapi({ description: "Average heart rate (bpm) from the Apple Watch; null = no watch" }),
    heartRateMax: z.number().int().min(20).max(250).nullable().default(null)
      .openapi({ description: "Highest heart rate (bpm) from the Apple Watch; null = no watch" }),
    activeKcal: z.number().int().min(0).max(5000).nullable().default(null)
      .openapi({ description: "Active energy (kcal) from the Apple Watch; null = no watch" }),
    sessionTitle: z.string().max(60).default("")
      .openapi({ description: "The plan's title when it was trained, so the record keeps its name if the plan changes or the session is deleted" }),
    pausedSec: z.number().int().min(0).default(0)
      .openapi({ description: "Seconds paused between startedAt and endedAt. Training time = endedAt - startedAt - pausedSec" }),
    planned: z.array(SessionItem).max(50).optional()
      .openapi({ description: "Upload only, not stored: the plan's items as they were when training started, so a plan edited mid-workout doesn't change whether this record covered it. Absent = the session's plan as it is now" }),
  })
  .refine((w) => w.pausedSec * 1000 <= Date.parse(w.endedAt) - Date.parse(w.startedAt) + 1000, {
    message: "pausedSec is longer than the workout", path: ["pausedSec"],
  })
  .refine((w) => w.status !== "completed" || w.sets.every((x) => x.status === "done"), {
    message: "a completed workout has every set done; use ended_early otherwise", path: ["status"],
  })
  .openapi("WorkoutInput");

export const Workout = WorkoutInput.extend({
  createdAt: z.string(),
  updatedAt: z.string(),
  updatedBy: Actor,
}).openapi("Workout");

export const Change = z
  .object({
    seq: z.number().int(),
    at: z.string(),
    actor: Actor,
    entity: z.enum(["exercise", "session", "workout", "plan"]),
    entityId: z.string(),
    action: z.enum(["create", "update", "delete", "archive", "unarchive", "lock", "unlock", "shelve", "unshelve"]),
    before: z.unknown().nullable(),
    after: z.unknown().nullable(),
  })
  .openapi("Change");

const DateQ = CalendarDay;
export const ListQuery = z
  .object({
    from: DateQ.optional(),
    to: DateQ.optional(),
    updatedSince: z.iso.datetime({ offset: true }).optional().openapi({
      description: "Only rows created or changed at or after this instant (server time). Use the max updatedAt you saw last time; rows at exactly that instant come back again, so dedupe by id",
    }),
  })
  .refine((q) => q.updatedSince || (q.from && q.to), { message: "give from+to, or updatedSince" });

export const ErrorBody = z.object({ error: z.string(), details: z.unknown().optional() }).openapi("Error");
