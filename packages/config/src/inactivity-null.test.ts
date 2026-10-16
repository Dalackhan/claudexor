import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig, updateGlobalConfig } from "./index.js";

afterEach(() => vi.unstubAllEnvs());

describe("persisted disabled inactivity watchdog", () => {
  it("round-trips null through YAML and honors an explicit numeric environment override", () => {
    const scratch = resolve(import.meta.dirname, "../../../tmp");
    mkdirSync(scratch, { recursive: true });
    const root = mkdtempSync(join(scratch, "inactivity-config-"));
    vi.stubEnv("CLAUDEXOR_CONFIG_DIR", join(root, "config"));
    vi.stubEnv("CLAUDEXOR_HARNESS_INACTIVITY_TIMEOUT_MS", "");
    const saved = updateGlobalConfig((config) => ({
      ...config,
      runtime: { ...config.runtime, harness_inactivity_timeout_ms: null },
    }));
    expect(readFileSync(saved.path, "utf8")).toContain("harness_inactivity_timeout_ms: null");
    expect(loadConfig(root).global.runtime.harness_inactivity_timeout_ms).toBeNull();
    vi.stubEnv("CLAUDEXOR_HARNESS_INACTIVITY_TIMEOUT_MS", "60000");
    expect(loadConfig(root).global.runtime.harness_inactivity_timeout_ms).toBe(60000);
  });
});
