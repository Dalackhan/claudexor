import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  birthEpochSeconds,
  createProcessTableReader,
  descendantProcessRows,
  parseProcessTableRow,
  type ProcessTableRow,
} from "./process-table.js";

describe("process table rows", () => {
  it("parses pid/ppid/pgid/lstart rows, including a space-padded day, and rejects anything else", () => {
    expect(parseProcessTableRow("13235 90801 13235 Mon Oct 12 14:08:47 2026    ")).toEqual({
      pid: 13235,
      ppid: 90801,
      pgid: 13235,
      birth: "Mon Oct 12 14:08:47 2026",
    });
    expect(parseProcessTableRow("    1     0     1 Sat Oct  5 20:10:23 2026")).toEqual({
      pid: 1,
      ppid: 0,
      pgid: 1,
      birth: "Sat Oct 5 20:10:23 2026",
    });
    expect(parseProcessTableRow("garbage")).toBeNull();
    expect(parseProcessTableRow("12 34 56")).toBeNull();
    expect(parseProcessTableRow("")).toBeNull();
  });

  it("orders births by epoch seconds and refuses unparseable text", () => {
    const a = birthEpochSeconds("Mon Oct 12 14:00:00 2026")!;
    const b = birthEpochSeconds("Mon Oct 12 14:00:05 2026")!;
    expect(b - a).toBe(5);
    expect(birthEpochSeconds("not a date")).toBeNull();
  });

  it("walks descendants by ppid, including a setsid grandchild in its own group and the root itself", () => {
    const rows: ProcessTableRow[] = [
      { pid: 1, ppid: 0, pgid: 1, birth: "x" },
      { pid: 100, ppid: 1, pgid: 100, birth: "x" },
      { pid: 200, ppid: 100, pgid: 200, birth: "x" },
      { pid: 210, ppid: 200, pgid: 200, birth: "x" },
      { pid: 999, ppid: 1, pgid: 999, birth: "x" },
    ];
    expect(descendantProcessRows(100, rows).map((r) => r.pid)).toEqual([100, 200, 210]);
    expect(descendantProcessRows(555, rows)).toEqual([]);
  });
});

describe.runIf(process.platform !== "win32")("createProcessTableReader (real ps)", () => {
  it("reads one pid's row, reports a vanished pid as null, and lists itself in the snapshot", async () => {
    const reader = createProcessTableReader();
    const self = await reader.row(process.pid);
    expect(self).toMatchObject({ pid: process.pid });
    expect(typeof (self as ProcessTableRow).birth).toBe("string");
    expect(birthEpochSeconds((self as ProcessTableRow).birth)).not.toBeNull();
    const rows = await reader.snapshot();
    expect(rows?.some((r) => r.pid === process.pid)).toBe(true);
    const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
    const pid = child.pid!;
    await new Promise<void>((resolve) => child.once("close", () => resolve()));
    expect(await reader.row(pid)).toBeNull();
  });
});
