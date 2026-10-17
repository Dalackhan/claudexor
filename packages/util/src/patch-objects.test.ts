import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prunePatchObjects, writePatchObject } from "./patch-objects.js";
import { sha256 } from "./index.js";

vi.mock("node:fs", async (original) => {
  const actual = await original<typeof fs>();
  return { ...actual, linkSync: vi.fn(actual.linkSync) };
});

const roots: string[] = [];
const root = () => {
  const path = fs.mkdtempSync(join(tmpdir(), "patch-objects-"));
  roots.push(path);
  return path;
};
afterEach(() => {
  vi.mocked(fs.linkSync).mockReset();
  for (const path of roots.splice(0)) fs.rmSync(path, { recursive: true, force: true });
});

describe("immutable patch publication", () => {
  it("shares identical attempt/final/anchor bytes and replaces only the changed path", () => {
    const dir = root();
    const patch = "diff --git a/a b/a\n+" + "ordinary bytes\r\n".repeat(100_000);
    const paths = [
      "runs/r/attempts/a01/patch.diff",
      "runs/r/final/patch.diff",
      "anchors/objects/a.patch",
    ].map((path) => join(dir, path));
    for (const path of paths) writePatchObject(dir, path, patch);
    expect(new Set(paths.map((path) => fs.statSync(path).ino)).size).toBe(1);
    for (const path of paths) expect(fs.readFileSync(path, "utf8")).toBe(patch);
    writePatchObject(dir, paths[1], "replacement\n");
    expect(fs.readFileSync(paths[0], "utf8")).toBe(patch);
    expect(fs.readFileSync(paths[2], "utf8")).toBe(patch);
    expect(fs.readFileSync(paths[1], "utf8")).toBe("replacement\n");
    fs.rmSync(join(dir, "runs"), { recursive: true });
    expect(prunePatchObjects(dir, true)).toBe(Buffer.byteLength("replacement\n"));
    expect(prunePatchObjects(dir, false)).toBe(Buffer.byteLength("replacement\n"));
    expect(fs.readFileSync(paths[2], "utf8")).toBe(patch);
    fs.unlinkSync(paths[2]);
    expect(prunePatchObjects(dir, false)).toBe(Buffer.byteLength(patch));
    expect(fs.readdirSync(join(dir, "patches"))).toEqual([]);
  });

  it("separates different display/exact bytes and leaves old plain files readable", () => {
    const dir = root();
    const legacy = join(dir, "legacy.patch");
    fs.writeFileSync(legacy, "legacy bytes\n");
    writePatchObject(dir, join(dir, "display.patch"), "+[redacted]\n");
    writePatchObject(dir, join(dir, "exact.patch"), "+original bytes\n");
    expect(fs.statSync(join(dir, "display.patch")).ino).not.toBe(
      fs.statSync(join(dir, "exact.patch")).ino,
    );
    expect(fs.readFileSync(legacy, "utf8")).toBe("legacy bytes\n");
    expect(prunePatchObjects(dir, false)).toBe(0);
  });

  it("refuses a corrupt object without replacing a readable saved patch", () => {
    const dir = root();
    const target = join(dir, "patch.diff");
    writePatchObject(dir, target, "first");
    const corrupt = join(dir, "patches", `${sha256("next").slice(7)}.patch`);
    fs.writeFileSync(corrupt, "wrong");
    expect(() => writePatchObject(dir, target, "next")).toThrow("content digest");
    expect(fs.readFileSync(target, "utf8")).toBe("first");
  });

  it("copies when links are unsupported, but surfaces other publication failures", () => {
    const dir = root();
    const target = join(dir, "patch.diff");
    const link = vi.mocked(fs.linkSync).mockImplementation(() => {
      throw Object.assign(new Error("unsupported"), { code: "EXDEV" });
    });
    writePatchObject(dir, target, "same bytes\r\n");
    expect(fs.readFileSync(target, "utf8")).toBe("same bytes\r\n");
    expect(fs.readdirSync(join(dir, "patches"))).toEqual([]);
    link.mockImplementation(() => {
      throw Object.assign(new Error("full"), { code: "ENOSPC" });
    });
    expect(() => writePatchObject(dir, target, "new bytes")).toThrow("full");
    expect(fs.readFileSync(target, "utf8")).toBe("same bytes\r\n");
  });
});
