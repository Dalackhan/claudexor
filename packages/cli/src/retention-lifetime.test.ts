import { expect, it } from "vitest";
import type { ControlGcReceipt } from "@claudexor/schema";
import { afterRetention, serializeRetention } from "./retention-lifetime.js";
it("cancels admitted manual passes, drains the queue, and gives later passes a fresh signal", async () => {
  let ready!: () => void;
  const entered = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const seen: boolean[] = [];
  const receipt = {} as ControlGcReceipt;
  const run = serializeRetention(async (_request, signal) => {
    if (!seen.length && !signal.aborted) {
      ready();
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
    }
    seen.push(signal.aborted);
    return receipt;
  });
  const first = run({ dry_run: false });
  const queued = run({ dry_run: false });
  await entered;
  await run.cancel!();
  await Promise.all([first, queued]);
  expect(seen).toEqual([true, true]);
  await run({ dry_run: false });
  expect(seen).toEqual([true, true, false]);
});

it("drains post-processing before allowing storage to close", async () => {
  let ready!: () => void;
  let finish!: () => void;
  const started = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const barrier = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const run = afterRetention(
    serializeRetention(async () => ({}) as ControlGcReceipt),
    async () => {
      ready();
      await barrier;
    },
  );
  const pending = run({ dry_run: false });
  await started;
  let closed = false;
  const stopping = run.cancel!().then(() => {
    closed = true;
  });
  await Promise.resolve();
  await Promise.resolve();
  expect(closed).toBe(false);
  finish();
  await stopping;
  await pending;
  expect(closed).toBe(true);
});
