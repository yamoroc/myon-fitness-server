import { join } from "node:path";
import type { Actor } from "./schemas";

/** What main.ts reads from the environment. Pure, so a self-hosted setup's mistakes are caught by tests. */
export type Config = {
  dataDir: string;
  tokens: Record<string, Actor>;
  host: string;
  port: number;
};

export class ConfigError extends Error {}

const MIN_TOKEN = 16;

export function readConfig(env: Record<string, string | undefined>): Config {
  const home = env.HOME ?? "";
  const dataDir = env.FITNESS_DATA_DIR || join(home, "data", "fitness");
  const appToken = env.FITNESS_APP_TOKEN?.trim();
  const coachToken = env.FITNESS_COACH_TOKEN?.trim() || undefined;
  if (!appToken) throw new ConfigError("FITNESS_APP_TOKEN must be set (the token the app signs in with)");
  if (appToken.length < MIN_TOKEN) throw new ConfigError(`FITNESS_APP_TOKEN must be at least ${MIN_TOKEN} characters`);
  if (coachToken !== undefined) {
    if (coachToken === appToken) throw new ConfigError("FITNESS_COACH_TOKEN must differ from FITNESS_APP_TOKEN");
    if (coachToken.length < MIN_TOKEN) throw new ConfigError(`FITNESS_COACH_TOKEN must be at least ${MIN_TOKEN} characters`);
  }
  const port = Number(env.PORT ?? 8720);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ConfigError("PORT must be 1-65535");
  const host = env.HOST?.trim() || "127.0.0.1";
  const tokens: Record<string, Actor> = { [appToken]: "app" };
  if (coachToken) tokens[coachToken] = "coach";
  return { dataDir, tokens, host, port };
}
