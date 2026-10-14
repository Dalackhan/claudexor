// Credential-free protocol peer. The adapter and process teardown remain real.
import { createInterface } from "node:readline";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

if (process.argv.includes("--wrapper")) {
  process.stderr.write(`fixture-pid:${process.pid}\n`);
  const child = spawn(
    process.execPath,
    [fileURLToPath(import.meta.url), ...process.argv.slice(2).filter((arg) => arg !== "--wrapper")],
    { stdio: "inherit" },
  );
  child.on("exit", (code) => process.exit(code ?? 1));
} else {
  const slow = process.argv.includes("--wait-for-cancel");
  const lateError = process.argv.includes("--late-system-error");
  const drainPlan = process.env.CX_FIXTURE_DRAIN_PLAN;
  if (lateError || drainPlan) {
    process.on("SIGINT", () => {});
    process.on("SIGTERM", () => {});
  }
  const text = process.env.CX_FIXTURE_ANSWER ?? '{"verdict":"PASS"}';
  const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
  process.stderr.write(`fixture-pid:${process.pid}\n`);
  const terminal = (status) =>
    send({
      method: "turn/completed",
      params: { threadId: "root", turn: { id: "turn", status, items: [] } },
    });
  const lines = createInterface({ input: process.stdin });
  lines.on("line", (line) => {
    const { id, method } = JSON.parse(line);
    if (method === "initialize") send({ id, result: {} });
    if (method === "thread/start") send({ id, result: { thread: { id: "root" } } });
    if (method === "turn/start") {
      send({ id, result: { turn: { id: "turn" } } });
      send({ method: "turn/started", params: { threadId: "root", turn: { id: "turn" } } });
      if (!slow) {
        send({
          method: "item/completed",
          params: {
            threadId: "root",
            turnId: "turn",
            item: { id: "answer", type: "agentMessage", text },
          },
        });
        terminal("completed");
      }
    }
    if (method === "thread/read") send({ id, result: { thread: { status: { type: "idle" } } } });
    if (method === "thread/goal/get") send({ id, result: { goal: null } });
    if (method === "thread/backgroundTerminals/list") send({ id, result: { data: [] } });
    if (method === "turn/interrupt") {
      send({ id, result: {} });
      terminal("interrupted");
    }
  });
  lines.on("close", () => {
    if (drainPlan) {
      // Only the joined drain fixture: a descendant inherits the real pipes,
      // acknowledges readiness, and emits its frames AFTER this root exits.
      const holder = spawn(
        process.execPath,
        [fileURLToPath(new URL("./drain-holder.mjs", import.meta.url)), drainPlan],
        { stdio: ["ignore", "inherit", "inherit", "ipc"] },
      );
      holder.once("message", () => process.exit(0));
    } else if (lateError)
      process.stdout.write(
        JSON.stringify({
          method: "thread/status/changed",
          params: { threadId: "root", status: { type: "systemError" } },
        }) + "\n",
        () => process.exit(0),
      );
    else process.exit(0);
  });
}
