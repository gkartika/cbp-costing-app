import type { GuideContext } from "./types";

/**
 * Typed accessors over app_config. A missing/malformed key means the guide
 * version is broken data that should never have been published — this is a
 * server-side integrity failure (bubbles up as INTERNAL_ERROR), not a
 * validation code a Costing User's input could ever trigger.
 */
export function getConfigNumber(ctx: GuideContext, key: string): number {
  const raw = ctx.config.get(key);
  if (raw === undefined) throw new Error(`Missing required app_config key: ${key}`);
  const value = Number(raw);
  if (Number.isNaN(value)) throw new Error(`app_config key ${key} is not numeric: ${raw}`);
  return value;
}

export function getConfigString(ctx: GuideContext, key: string): string {
  const raw = ctx.config.get(key);
  if (raw === undefined) throw new Error(`Missing required app_config key: ${key}`);
  return raw;
}

export function getConfigBoolean(ctx: GuideContext, key: string): boolean {
  const raw = getConfigString(ctx, key).toUpperCase();
  if (raw === "TRUE") return true;
  if (raw === "FALSE") return false;
  throw new Error(`app_config key ${key} is not boolean: ${raw}`);
}
