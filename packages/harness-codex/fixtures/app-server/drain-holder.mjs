// A fake protocol writer, not a model or an OS death-proof implementation.
// Cleanup is an exact per-fixture stop file; a hard lifetime also bounds leaks.
// Every ordering step is a file the test or this writer creates, never a delay.
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const plan = JSON.parse(readFileSync(process.argv[2], "utf8"));
const parent = process.ppid;
process.on("SIGINT", () => {});
process.on("SIGTERM", () => {});
process.stdout.on("error", () => {}); // EPIPE is not process death.
process.stderr.on("error", () => {});
writeFileSync(
  plan.identity,
  JSON.stringify({
    pid: process.pid,
    parent,
    markers: Object.keys(process.env).filter((key) => key.startsWith("CLAUDEXOR_RUN_SCOPE_")),
  }),
);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (path) => {
  while (!existsSync(path)) await sleep(10);
};
// Resolves once the bytes were handed to the OS pipe (or the write failed).
const write = (text) => new Promise((resolve) => process.stdout.write(text, () => resolve()));
const life = setTimeout(() => process.exit(2), 45000);
// Benign frames in ONE write before the root may exit; the test holds them
// unconsumed, so the reader is blocked on capacity when the root exits.
await write(plan.hold.map((frame) => JSON.stringify(frame) + "\n").join(""));
await until(plan.held);
process.send("ready");
process.disconnect();
for (;;) {
  try {
    process.kill(parent, 0);
  } catch {
    break;
  }
  await sleep(10);
}
writeFileSync(plan.afterExit, "root exited\n");
if (plan.afterDrain) await until(plan.afterDrain); // negative control: only after forced closure
for (const frame of plan.frames) {
  const wire = JSON.stringify(frame) + "\n";
  if (plan.split) {
    const mid = Math.floor(wire.length / 2);
    await write(wire.slice(0, mid));
    await sleep(20);
    await write(wire.slice(mid));
  } else await write(wire);
}
if (plan.partial) await write('{"method":"turn/started","params":');
writeFileSync(plan.written, "late frames handed to the pipe\n");
if (plan.mode === "finite") {
  clearTimeout(life);
  process.stdout.end();
} else {
  let count = 0;
  while (!existsSync(plan.stop)) {
    if (plan.mode === "continuous") {
      process.stdout.write(
        JSON.stringify({
          method: "thread/status/changed",
          params: { threadId: "child", status: { type: "idle" }, count: count++ },
        }) + "\n",
      );
    }
    await sleep(20);
  }
  clearTimeout(life);
  process.stdout.end();
}
