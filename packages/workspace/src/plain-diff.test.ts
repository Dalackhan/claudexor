import { describe, expect, it } from "vitest";
import { excludePlainDiffPathPrefix, relativizePlainDiffHeaders } from "./plain-diff.js";

const ownedPrefix = ".claudexor-artifacts/run-1";

describe("relativizePlainDiffHeaders", () => {
  it("relativizes a bare GNU diff 3.8 binary record that follows a hunk with no `diff` echo (#252)", () => {
    // diff 3.8 emits the binary stub straight after the previous file's
    // hunks — no `diff -ruN …` command echo resets the parser state — while
    // 3.10 echoes the command first. Both shapes must relativize, or the
    // absolute paths escape the exact-prefix exclusion and every
    // repo-relative policy glob.
    const baseline = "/tmp/baseline";
    const live = "/tmp/live";
    const bare = [
      `diff -ruN ${baseline}/a.txt ${live}/a.txt`,
      `--- ${baseline}/a.txt\t2026-09-03 20:16:06.627019220 +0000`,
      `+++ ${live}/a.txt\t2026-09-03 20:16:06.627019220 +0000`,
      "@@ -1 +1 @@",
      "-one",
      "+two",
      `Binary files ${baseline}/${ownedPrefix}/browser/shot.png and ${live}/${ownedPrefix}/browser/shot.png differ`,
      "",
    ].join("\n");

    const relativized = relativizePlainDiffHeaders(bare, baseline, live);

    expect(relativized).toContain(
      `Binary files a/${ownedPrefix}/browser/shot.png and b/${ownedPrefix}/browser/shot.png differ`,
    );
    expect(relativized).not.toContain(baseline);
    expect(relativized).not.toContain(live);
    // …and the owned binary record is then excluded by exact prefix while the
    // unrelated text record survives.
    const filtered = excludePlainDiffPathPrefix(relativized, ownedPrefix);
    expect(filtered).toContain("+two");
    expect(filtered).not.toContain("shot.png");
  });

  it("still relativizes the diff 3.10 shape where a `diff` echo precedes the binary record", () => {
    const baseline = "/tmp/baseline";
    const live = "/tmp/live";
    const echoed = [
      `diff -ruN ${baseline}/user.bin ${live}/user.bin`,
      `Binary files ${baseline}/user.bin and ${live}/user.bin differ`,
      "",
    ].join("\n");

    expect(relativizePlainDiffHeaders(echoed, baseline, live)).toBe(
      ["diff -ruN a/user.bin b/user.bin", "Binary files a/user.bin and b/user.bin differ", ""].join(
        "\n",
      ),
    );
  });
});

function textRecord(path: string, line: string): string {
  return [
    `diff -ruN a/${path} b/${path}`,
    `--- a/${path}\t2026-08-09 00:00:00.000000000 +0300`,
    `+++ b/${path}\t2026-08-09 00:00:01.000000000 +0300`,
    "@@ -0,0 +1 @@",
    `+${line}`,
    "",
  ].join("\n");
}

describe("excludePlainDiffPathPrefix", () => {
  it.each([
    ownedPrefix,
    `${ownedPrefix}////`,
    `./${ownedPrefix}/`,
    `.\\${ownedPrefix.replaceAll("/", "\\")}\\\\`,
  ])("normalizes only the selected prefix %j", (prefix) => {
    const kept = textRecord(`${ownedPrefix}-other/keep.txt`, "keep");
    const diff = textRecord(`${ownedPrefix}/log.txt`, "generated") + kept;
    expect(excludePlainDiffPathPrefix(diff, prefix)).toBe(kept);
  });

  it.each([
    "",
    "/",
    "./",
    ".",
    "..",
    `/${ownedPrefix}`,
    `${ownedPrefix}/..`,
    `${ownedPrefix}//bad`,
  ])("keeps all data for an invalid prefix %j", (prefix) => {
    const diff = textRecord(`${ownedPrefix}/log.txt`, "keep");
    expect(excludePlainDiffPathPrefix(diff, prefix)).toBe(diff);
  });

  it("handles a long non-trailing slash run without regexp backtracking", () => {
    const diff = textRecord(`${ownedPrefix}/log.txt`, "keep");
    expect(excludePlainDiffPathPrefix(diff, `a${"/".repeat(200_000)}z`)).toBe(diff);
    expect(excludePlainDiffPathPrefix(diff, `${ownedPrefix}${"/".repeat(200_000)}`)).toBe("");
  });

  it("separates an owned text record from a following user binary record", () => {
    const diff = `${textRecord(`${ownedPrefix}/log.txt`, "generated")}Binary files a/user.bin and b/user.bin differ\n`;

    const filtered = excludePlainDiffPathPrefix(diff, ownedPrefix);

    expect(filtered).toBe("Binary files a/user.bin and b/user.bin differ\n");
  });

  it("separates a user text record from a following owned binary record", () => {
    const userRecord = textRecord("notes.txt", "keep me");
    const diff = `${userRecord}Binary files a/${ownedPrefix}/shot.png and b/${ownedPrefix}/shot.png differ\n`;

    const filtered = excludePlainDiffPathPrefix(diff, ownedPrefix);

    expect(filtered).toBe(userRecord);
  });

  it("preserves input without a structural record boundary", () => {
    const ambiguous = "unparsed output mentioning .claudexor-artifacts/run-1/log.txt\n";

    expect(excludePlainDiffPathPrefix(ambiguous, ownedPrefix)).toBe(ambiguous);
  });
});
