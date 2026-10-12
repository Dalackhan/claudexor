import { describe, expect, it } from "vitest";
import {
  CLAUDEXOR_HOME_SCOPED_ENV,
  CLAUDEXOR_OPERATOR_HOME_ENV,
  PLAYWRIGHT_BROWSERS_PATH_ENV,
  harnessHostFactsEnv,
  playwrightCacheDir,
} from "./host-facts.js";

const operator = { HOME: "/Users/op", PATH: "/usr/bin" };

function stat(existing: string[]) {
  const calls: string[] = [];
  return {
    calls,
    exists: (path: string) => {
      calls.push(path);
      return existing.includes(path);
    },
  };
}

describe("harnessHostFactsEnv (CX item 6)", () => {
  it("states the scoped home and the operator home when the spec HOME is rebased", () => {
    const probe = stat([]);
    const env = harnessHostFactsEnv(
      { HOME: "/tmp/scoped/home" },
      { source: operator, platform: "darwin", directoryExists: probe.exists },
    );
    expect(env[CLAUDEXOR_HOME_SCOPED_ENV]).toBe("1");
    expect(env[CLAUDEXOR_OPERATOR_HOME_ENV]).toBe("/Users/op");
    expect(PLAYWRIGHT_BROWSERS_PATH_ENV in env).toBe(false);
  });

  it("says nothing about scoping when the harness inherits the operator HOME", () => {
    const probe = stat([]);
    for (const specEnv of [undefined, {}, { HOME: "/Users/op" }]) {
      const env = harnessHostFactsEnv(specEnv, {
        source: operator,
        platform: "darwin",
        directoryExists: probe.exists,
      });
      expect(CLAUDEXOR_HOME_SCOPED_ENV in env).toBe(false);
      expect(CLAUDEXOR_OPERATOR_HOME_ENV in env).toBe(false);
    }
  });

  it("exports the Playwright cache only when the one platform location exists (one stat, no walk)", () => {
    const cache = "/Users/op/Library/Caches/ms-playwright";
    const present = stat([cache]);
    const env = harnessHostFactsEnv(
      { HOME: "/tmp/scoped/home" },
      { source: operator, platform: "darwin", directoryExists: present.exists },
    );
    expect(env[PLAYWRIGHT_BROWSERS_PATH_ENV]).toBe(cache);
    expect(present.calls).toEqual([cache]);

    const absent = stat([]);
    const none = harnessHostFactsEnv(
      { HOME: "/tmp/scoped/home" },
      { source: operator, platform: "darwin", directoryExists: absent.exists },
    );
    expect(PLAYWRIGHT_BROWSERS_PATH_ENV in none).toBe(false);
    expect(absent.calls).toEqual([cache]);
  });

  it("an explicit operator value wins, including the special 0, and is carried without a stat", () => {
    for (const explicit of ["0", "/opt/pw-browsers"]) {
      const probe = stat(["/Users/op/Library/Caches/ms-playwright"]);
      const env = harnessHostFactsEnv(
        { HOME: "/tmp/scoped/home" },
        {
          source: { ...operator, PLAYWRIGHT_BROWSERS_PATH: explicit },
          platform: "darwin",
          directoryExists: probe.exists,
        },
      );
      expect(env[PLAYWRIGHT_BROWSERS_PATH_ENV]).toBe(explicit);
      expect(probe.calls).toEqual([]);
    }
  });

  it("resolves the cache location per platform from the UNSCOPED operator env", () => {
    expect(playwrightCacheDir({ HOME: "/home/op" }, "linux")).toBe("/home/op/.cache/ms-playwright");
    expect(playwrightCacheDir({ HOME: "/home/op", XDG_CACHE_HOME: "/xdg" }, "linux")).toBe(
      "/xdg/ms-playwright",
    );
    expect(playwrightCacheDir({ HOME: "/Users/op" }, "darwin")).toBe(
      "/Users/op/Library/Caches/ms-playwright",
    );
    expect(
      playwrightCacheDir({ USERPROFILE: "C:\\Users\\op", LOCALAPPDATA: "C:\\L" }, "win32"),
    ).toBe("C:\\L\\ms-playwright");
    expect(playwrightCacheDir({ USERPROFILE: "C:\\Users\\op" }, "win32")).toBeNull();
    expect(playwrightCacheDir({}, "darwin")).toBeNull();
  });

  it("never rewrites the spec env it was given", () => {
    const specEnv = { HOME: "/tmp/scoped/home", CLAUDEXOR_X: "keep" };
    const env = harnessHostFactsEnv(specEnv, {
      source: operator,
      platform: "linux",
      directoryExists: () => false,
    });
    expect(specEnv).toEqual({ HOME: "/tmp/scoped/home", CLAUDEXOR_X: "keep" });
    expect("HOME" in env).toBe(false);
  });
});
