/**
 * How often a running worker renews its run lease and computer lease.
 *
 * Stop is cooperative across processes: the API marks the run cancelled, and the
 * worker only learns that when a renewal comes back empty, so it aborts. This
 * interval is therefore the floor on how long Stop appears to do nothing after
 * the click. Eight seconds keeps that under a heartbeat's worth of waiting, and
 * it costs one small UPDATE per running run per tick.
 */
export const RUN_HEARTBEAT_DEFAULT_MS = 8_000;
export const RUN_HEARTBEAT_MIN_MS = 2_000;
export const RUN_HEARTBEAT_MAX_MS = 30_000;

/**
 * Parses `RAKAZO_RUN_HEARTBEAT_MS`. A missing, unparsable, or non-positive value
 * falls back to the default; an out-of-range one clamps to the nearest bound
 * rather than becoming 0 (a hot loop) or a number large enough to hide a stop.
 */
export function resolveRunHeartbeatMs(raw: string | undefined): number {
  const text = raw?.trim();
  if (!text) return RUN_HEARTBEAT_DEFAULT_MS;
  const parsed = Number(text);
  if (!Number.isFinite(parsed) || parsed <= 0) return RUN_HEARTBEAT_DEFAULT_MS;
  return Math.min(RUN_HEARTBEAT_MAX_MS, Math.max(RUN_HEARTBEAT_MIN_MS, Math.round(parsed)));
}

/** The interval for the run about to start; a change needs the worker restarted. */
export function runHeartbeatMs(): number {
  return resolveRunHeartbeatMs(process.env.RAKAZO_RUN_HEARTBEAT_MS);
}
