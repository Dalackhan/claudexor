import type { ControlGcReceipt, ControlGcRequest } from "@claudexor/schema";

export type RetentionRunner = ((request: ControlGcRequest) => Promise<ControlGcReceipt>) & {
  hasMore?: (receipt?: ControlGcReceipt) => boolean;
  /** Cancel every already admitted pass and drain it before its store closes. */
  cancel?: () => Promise<void>;
};

/** Scheduled and manual passes share both serialization and shutdown. A later
 * invocation gets a new signal, so recovery can resume unfinished work. */
export function serializeRetention(
  runOnce: (request: ControlGcRequest, signal: AbortSignal) => Promise<ControlGcReceipt>,
): RetentionRunner {
  let inFlight: Promise<ControlGcReceipt> | null = null;
  const controllers = new Set<AbortController>();
  const run: RetentionRunner = (request) => {
    const controller = new AbortController();
    controllers.add(controller);
    const invoke = () => runOnce(request, controller.signal);
    const chained = (inFlight ?? Promise.resolve()).then(invoke, invoke);
    inFlight = chained;
    return chained.finally(() => {
      controllers.delete(controller);
      if (inFlight === chained) inFlight = null;
    });
  };
  run.cancel = async () => {
    for (const controller of controllers) controller.abort();
    await inFlight?.then(
      () => {},
      () => {},
    );
  };
  return run;
}

/** Keep post-processing inside the same close barrier as the core pass. */
export function afterRetention(
  run: RetentionRunner,
  after: (request: ControlGcRequest, receipt: ControlGcReceipt) => void | Promise<void>,
): RetentionRunner {
  const pending = new Set<Promise<ControlGcReceipt>>();
  const wrapped: RetentionRunner = (request) => {
    const flight = run(request).then(async (receipt) => {
      await after(request, receipt);
      return receipt;
    });
    pending.add(flight);
    return flight.finally(() => pending.delete(flight));
  };
  wrapped.hasMore = run.hasMore;
  wrapped.cancel = async () => {
    await run.cancel?.();
    await Promise.allSettled([...pending]);
  };
  return wrapped;
}
