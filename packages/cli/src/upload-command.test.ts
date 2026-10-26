import { afterEach, describe, expect, it, vi } from "vitest";
import { parseArgs } from "./args.js";
import { commandFlagScopeError, commandPositionalError } from "./command-scope.js";
import { uploadCommand } from "./upload-command.js";

const mocks = vi.hoisted(() => ({ query: vi.fn(), print: vi.fn() }));
vi.mock("./upload-query.js", () => ({ uploadQuery: mocks.query }));
vi.mock("./cli-io.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./cli-io.js")>()),
  printJson: mocks.print,
}));
afterEach(() => vi.resetAllMocks());

describe("upload CLI controls", () => {
  it.each([
    [
      "upload-create",
      [
        "--request-json",
        '{"kind":"file","mime":"text/plain","name":"note.txt","sizeBytes":8}',
        "--idempotency-key",
        "create-key",
      ],
      {
        request: { kind: "file", mime: "text/plain", name: "note.txt", sizeBytes: 8 },
        idempotencyKey: "create-key",
      },
    ],
    ["upload-import-local", ["u", "/host/note.txt"], { uploadId: "u", path: "/host/note.txt" }],
    ["upload-status", ["u"], { uploadId: "u" }],
    [
      "upload-finalize",
      [
        "u",
        "--request-json",
        '{"expectedSha256":"sha256:saved"}',
        "--idempotency-key",
        "final-key",
      ],
      { uploadId: "u", request: { expectedSha256: "sha256:saved" }, idempotencyKey: "final-key" },
    ],
    ["upload-cancel", ["u"], { uploadId: "u" }],
  ] as const)("registers and forwards %s", async (command, tokens, expected) => {
    const args = parseArgs([command, ...tokens, "--json"]);
    expect(commandFlagScopeError(command, Object.keys(args.flags))).toBeNull();
    expect(commandPositionalError(command, args._.slice(1))).toBeNull();
    mocks.query.mockResolvedValue({ uploadId: "u" });
    expect(await uploadCommand(args, true)).toBe(0);
    expect(mocks.query).toHaveBeenCalledWith(
      command.slice("upload-".length).replaceAll("-", "_"),
      expected,
    );
    expect(mocks.print).toHaveBeenCalledWith({ uploadId: "u" });
  });
  it("keeps stage flags off unrelated commands", () => {
    expect(commandFlagScopeError("ask", ["request-json"])).toContain("--request-json");
    expect(commandFlagScopeError("upload-status", ["idempotency-key"])).toContain(
      "--idempotency-key",
    );
    expect(commandPositionalError("upload-import-local", ["u"])).toBeTruthy();
  });
});
