import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { controlApiFetch, type ControlApiAddress } from "./live.js";

/** Replay the engine's timer notices, without inventing ACP-local timer state. */
export class AcpTimeLimitFeed {
  private readonly abort = new AbortController();
  private task: Promise<void> | undefined;

  constructor(
    private readonly addr: ControlApiAddress,
    private readonly emit: (event: unknown) => void,
  ) {}

  start(runId: string): void {
    if (this.task) return;
    this.task = this.consume(runId).catch(() => {
      if (!this.abort.signal.aborted) this.warn();
    });
  }

  async close(drain: boolean): Promise<void> {
    if (!this.task) return;
    if (drain) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const complete = await Promise.race([
          this.task.then(() => true),
          new Promise<boolean>((resolve) => {
            timer = setTimeout(() => resolve(false), 2_000);
          }),
        ]);
        if (!complete) this.warn();
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
    this.abort.abort();
    await this.task;
  }

  private warn(): void {
    this.emit({
      type: "surface.warning",
      payload: {
        message:
          "Live time-limit updates unavailable; inspect the run's events with claudexor follow.",
      },
    });
  }

  private async consume(runId: string): Promise<void> {
    const response = await controlApiFetch(this.addr, `/runs/${encodeURIComponent(runId)}/events`, {
      headers: { Accept: "text/event-stream" },
      signal: this.abort.signal,
    });
    if (!response.ok || !response.body) throw new Error("Run events unavailable");
    const stream = Readable.fromWeb(response.body as never);
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    const stop = () => {
      // Destroying the HTTP body alone does not release readline's pending next().
      lines.close();
      stream.destroy();
    };
    this.abort.signal.addEventListener("abort", stop, { once: true });
    let type = "",
      data = "";
    try {
      if (this.abort.signal.aborted) return;
      for await (const line of lines) {
        if (line === "") {
          if (type === "end") return;
          if (type === "control.applied" && data) {
            const event = JSON.parse(data);
            if (event.type === "control.applied" && event.payload?.control?.kind === "time_limit")
              this.emit(event);
          }
          type = "";
          data = "";
        } else if (line.startsWith("event:")) type = line.slice(6).trim();
        else if (type === "control.applied" && line.startsWith("data:")) {
          data += `${line.slice(5).trimStart()}\n`;
          if (data.length > 32_000) throw new Error("Timer event too large");
        }
      }
      if (!this.abort.signal.aborted) throw new Error("Run events disconnected");
    } finally {
      this.abort.signal.removeEventListener("abort", stop);
      lines.close();
      stream.destroy();
    }
  }
}
