import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { windowsQuietChildrenPreload } from "./npm-launch.js";

// The preload runs inside a vendor's Node, so it is exercised there: real
// child processes of the test runtime, with and without `--require`.
const preload = windowsQuietChildrenPreload();
let root: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "quiet children ")));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function file(name: string, body: string): string {
  const path = join(root, name);
  writeFileSync(path, body);
  return path;
}

function node(args: string[], env: NodeJS.ProcessEnv = {}) {
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    encoding: "utf8",
    env: { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, ...env },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** Records what reaches Node's own spawn/spawnSync, loaded BEFORE the preload. */
const RECORDER = `
const cp = require("node:child_process");
globalThis.calls = [];
for (const name of ["spawn", "spawnSync"]) {
  cp[name] = function () {
    calls.push({ name, args: Array.prototype.slice.call(arguments) });
    return { pid: 0, on() { return this; } };
  };
}
require("node:module").syncBuiltinESMExports();
process.on("exit", () => process.stdout.write(JSON.stringify(calls)));
`;

describe("Windows quiet-children preload", () => {
  it("defaults windowsHide for CommonJS and ESM callers, keeping explicit choices", () => {
    const recorder = file("recorder.cjs", RECORDER);
    const esm = file(
      "entry.mjs",
      `import cp, {spawn, spawnSync} from "node:child_process";
      import * as ns from "child_process";
      const caller = {env: {MARKER: "profile"}, stdio: "inherit"};
      spawn("tool", ["one"], caller);
      spawnSync("tool", ["two"], {windowsHide: false});
      cp.spawn("tool");
      ns.spawnSync("tool", {cwd: "with spaces"});
      spawn("tool", null, {windowsHide: null});
      spawn("tool", undefined, {windowsHide: true});
      spawn("tool", {cwd: "second"}, {windowsHide: false});
      spawnSync("tool", ["inherited"], Object.create({env: {MARKER: "proto"}}));
      if (Object.keys(caller).join() !== "env,stdio") process.exit(9);`,
    );
    const cjs = file(
      "entry.cjs",
      `const {spawn} = require("child_process");
      spawn("tool", ["three"], {shell: false});`,
    );
    const esmRun = node(["--require", recorder, "--require", preload, esm]);
    expect(esmRun.status, esmRun.stderr).toBe(0);
    const esmCalls = JSON.parse(esmRun.stdout) as Array<{ name: string; args: unknown[] }>;
    expect(esmCalls.map((call) => [call.name, ...call.args])).toEqual([
      [
        "spawn",
        "tool",
        ["one"],
        { env: { MARKER: "profile" }, stdio: "inherit", windowsHide: true },
      ],
      ["spawnSync", "tool", ["two"], { windowsHide: false }],
      ["spawn", "tool", null, { windowsHide: true }],
      ["spawnSync", "tool", { cwd: "with spaces", windowsHide: true }],
      ["spawn", "tool", null, { windowsHide: null }],
      ["spawn", "tool", null, { windowsHide: true }],
      ["spawn", "tool", { cwd: "second", windowsHide: true }, { windowsHide: false }],
      ["spawnSync", "tool", ["inherited"], { windowsHide: true }],
    ]);
    const cjsRun = node(["--require", recorder, "--require", preload, cjs]);
    expect(cjsRun.status, cjsRun.stderr).toBe(0);
    expect(JSON.parse(cjsRun.stdout)).toEqual([
      { name: "spawn", args: ["tool", ["three"], { shell: false, windowsHide: true }] },
    ]);
  });

  it("treats options inherited through a prototype as the running Node does", () => {
    // Node 18 reads an inherited env/cwd; current Node ignores it. The copy keeps either.
    const entry = file(
      "inherited.cjs",
      `const {spawnSync} = require("node:child_process");
      const cwd = require("node:os").tmpdir();
      const options = Object.create({env: {...process.env, MARKER: "inherited"}, cwd});
      options.encoding = "utf8";
      const script = "process.stdout.write(String(process.env.MARKER) + ' ' + process.cwd())";
      process.stdout.write(spawnSync(process.execPath, ["-e", script], options).stdout);`,
    );
    const native = node([entry]);
    expect(native.status, native.stderr).toBe(0);
    expect(node(["--require", preload, entry])).toEqual(native);
  });

  it("leaves Node's own argument validation unchanged", () => {
    const entry = file(
      "validation.cjs",
      `const cp = require("node:child_process");
      // Never an existing program: an accepted call only reports ENOENT.
      const tool = "claudexor-no-such-tool-" + process.pid;
      const shapes = {
        nullOptions: [tool, [], null], arrayOptions: [tool, [], []],
        functionOptions: [tool, [], () => {}], stringOptions: [tool, [], "x"],
        numberOptions: [tool, [], 17], numberArgs: [tool, 17], stringArgs: [tool, "x"],
        functionArgs: [tool, () => {}], nullArgs: [tool, null], nullArgsOptions: [tool, null, {}],
        undefinedArgsNullOptions: [tool, undefined, null], optionsAsArgs: [tool, {}, null],
        nullHide: [tool, [], {windowsHide: null}], falseHide: [tool, [], {windowsHide: false}],
        emptyFile: ["", []], numberFile: [17], absent: [tool],
      };
      const outcomes = {};
      for (const name of ["spawn", "spawnSync"])
        for (const [shape, args] of Object.entries(shapes)) {
          try {
            const child = cp[name](...args);
            if (name === "spawn") child.on("error", () => {});
            outcomes[name + ":" + shape] = "accepted";
          } catch (error) {
            outcomes[name + ":" + shape] = error.code + ": " + error.message;
          }
        }
      process.stdout.write(JSON.stringify(outcomes));`,
    );
    const native = node([entry]);
    const preloaded = node(["--require", preload, entry]);
    expect(native.status, native.stderr).toBe(0);
    expect(preloaded.status, preloaded.stderr).toBe(0);
    const outcomes = JSON.parse(native.stdout) as Record<string, string>;
    expect(JSON.parse(preloaded.stdout)).toEqual(outcomes);
    expect(outcomes["spawn:nullOptions"]).toMatch(/^ERR_INVALID_ARG_TYPE/);
    expect(outcomes["spawnSync:arrayOptions"]).toMatch(/^ERR_INVALID_ARG_TYPE/);
    expect(outcomes["spawn:numberArgs"]).toMatch(/^ERR_INVALID_ARG_TYPE/);
    expect(outcomes["spawn:nullArgs"]).toBe("accepted");
    expect(outcomes["spawnSync:optionsAsArgs"]).toBe("accepted");
  });

  it("runs a CommonJS main, its exit status and failures exactly as Node does", () => {
    const entry = file(
      "main.cjs",
      `const mode = process.argv[2];
      if (mode === "identity") process.stdout.write(JSON.stringify({
        main: require.main === module, parent: module.parent, argv: process.argv.slice(2),
        options: process.env.NODE_OPTIONS ?? null,
      }));
      else if (mode === "exit") process.exit(3);
      else if (mode === "exitCode") process.exitCode = 4;
      else if (mode === "throw") throw new Error("boom-sync");
      else if (mode === "reject") Promise.reject(new Error("boom-async"));`,
    );
    for (const mode of ["identity", "exit", "exitCode", "throw", "reject"]) {
      const native = node([entry, mode, "with spaces"]);
      const preloaded = node(["--require", preload, entry, mode, "with spaces"]);
      expect(preloaded, mode).toEqual(native);
    }
    expect(JSON.parse(node(["--require", preload, entry, "identity"]).stdout)).toEqual({
      main: true,
      parent: null,
      argv: ["identity"],
      options: null,
    });
    expect(node([entry, "throw"])).toMatchObject({ status: 1 });
    expect(node([entry, "throw"]).stderr).toContain("boom-sync");
  });

  it("reaches Node children that inherit execArgv, not those given their own", () => {
    const report = `const quiet = Object.keys(require.cache).some((loaded) =>
      loaded.endsWith("windows-quiet-children.cjs"));`;
    const entry = file(
      "scope.cjs",
      `const {fork} = require("node:child_process");
      const {Worker} = require("node:worker_threads");
      if (process.argv[2] === "child") {
        ${report}
        process.send(quiet);
      } else {
        const seen = {};
        const worker = (key, options) => new Promise((done) => {
          const w = new Worker(\`const {parentPort} = require("node:worker_threads");
            ${report.replace(/`/g, "\\`")}
            parentPort.postMessage(quiet);\`, {eval: true, ...options});
          w.once("message", (quiet) => { seen[key] = quiet; });
          w.once("exit", done);
        });
        const child = (key, options) => new Promise((done) => {
          const c = fork(__filename, ["child"], options);
          c.once("message", (quiet) => { seen[key] = quiet; });
          c.once("exit", done);
        });
        (async () => {
          await child("forkInherited", {});
          await child("forkOwnExecArgv", {execArgv: []});
          await worker("workerInherited", {});
          await worker("workerOwnExecArgv", {execArgv: []});
          process.stdout.write(JSON.stringify(seen));
        })();
      }`,
    );
    const result = node(["--require", preload, entry]);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      forkInherited: true,
      forkOwnExecArgv: false,
      workerInherited: true,
      workerOwnExecArgv: false,
    });
  });
});

describe("Windows quiet-children preload packaging", () => {
  it("resolves beside the module, then in a bundle's deployed core runtime", () => {
    expect(realpathSync(preload)).toBe(
      realpathSync(fileURLToPath(new URL("./windows-quiet-children.cjs", import.meta.url))),
    );
    const resources = join(root, "Resources");
    mkdirSync(resources);
    const bundle = pathToFileURL(join(resources, "claudexord.bundle.cjs")).href;
    expect(() => windowsQuietChildrenPreload(bundle)).toThrow(
      "Windows background preload is missing",
    );
    const deployed = join(resources, "browser-mcp-runtime", "dist", "windows-quiet-children.cjs");
    mkdirSync(join(resources, "browser-mcp-runtime", "dist"), { recursive: true });
    writeFileSync(deployed, "");
    expect(windowsQuietChildrenPreload(bundle)).toBe(deployed);
    writeFileSync(join(resources, "windows-quiet-children.cjs"), "");
    expect(windowsQuietChildrenPreload(bundle)).toBe(join(resources, "windows-quiet-children.cjs"));
  });
});
