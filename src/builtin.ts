import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** A built-in plan (预置计划): shipped with the app in plans.json, referenced by its slug. */
export type BuiltinPlan = {
  id: string; title: string; note: string; difficulty?: string | null; focus?: string;
  items: { exerciseId: string; [k: string]: unknown }[];
};

/** The app's bundled content (ios/Content in the app's private repository). Absent in the public self-hosted server,
 *  which receives exercises and on-demand presets from the app on connect. */
const CONTENT_DIR = [join(import.meta.dir, "..", "..", "ios", "Content")]
  .find((d) => existsSync(join(d, "exercises.json"))) ?? "";

function read<T>(file: string): T[] {
  try {
    return JSON.parse(readFileSync(join(CONTENT_DIR, file), "utf8")) as T[];
  } catch {
    return [];
  }
}

let plans: BuiltinPlan[] | null = null;

/** The app's built-in plans, read once. Empty if the file isn't there. */
export function builtinPlans(): BuiltinPlan[] {
  return (plans ??= read<BuiltinPlan>("plans.json"));
}

/** The app's bundled exercise library: id (a readable slug), name and the rest of an ExerciseInput. Empty if the
 *  file isn't there. */
export function bundledExercises(): { id: string; name: string; [k: string]: unknown }[] {
  return read("exercises.json");
}

let media: Set<string> | null = null;

/** Image and video files the bundled library uses. The app shows them from its own copy, so the server accepts them
 *  in an exercise without having the files. */
export function bundledMedia(): Set<string> {
  return (media ??= new Set(bundledExercises().flatMap((e) => [
    ...((e.images as { file?: unknown }[] | undefined) ?? []).map((i) => i.file),
    (e.video as { file?: unknown } | undefined)?.file,
  ]).filter((f): f is string => typeof f === "string")));
}
