import { describe, expect, it } from "vitest";
import {
  RUN_HEARTBEAT_DEFAULT_MS,
  RUN_HEARTBEAT_MAX_MS,
  RUN_HEARTBEAT_MIN_MS,
  resolveRunHeartbeatMs,
} from "./run-heartbeat.js";

describe("resolveRunHeartbeatMs", () => {
  it("defaults when unset or empty", () => {
    expect(resolveRunHeartbeatMs(undefined)).toBe(RUN_HEARTBEAT_DEFAULT_MS);
    expect(resolveRunHeartbeatMs("")).toBe(RUN_HEARTBEAT_DEFAULT_MS);
    expect(resolveRunHeartbeatMs("   ")).toBe(RUN_HEARTBEAT_DEFAULT_MS);
  });

  it("defaults rather than reaching zero on unusable values", () => {
    for (const raw of ["abc", "12abc", "0", "-1", "NaN", "Infinity", "1e999"]) {
      expect(resolveRunHeartbeatMs(raw)).toBe(RUN_HEARTBEAT_DEFAULT_MS);
    }
  });

  it("clamps a usable value into the supported range", () => {
    expect(resolveRunHeartbeatMs("1000")).toBe(RUN_HEARTBEAT_MIN_MS);
    expect(resolveRunHeartbeatMs("999999")).toBe(RUN_HEARTBEAT_MAX_MS);
  });

  it("takes a value inside the range, rounding and trimming it", () => {
    expect(resolveRunHeartbeatMs("8000")).toBe(8000);
    expect(resolveRunHeartbeatMs(" 12000 ")).toBe(12000);
    expect(resolveRunHeartbeatMs("3000.7")).toBe(3001);
  });
});
