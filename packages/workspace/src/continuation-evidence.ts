/** Shared evidence facts for admission and the successor's carrier planner. */
import { existsSync, lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse as yamlParse } from "yaml";
import { RunResumable, RunTelemetry, SessionCapsule } from "@claudexor/schema";
import { readRunEvents, retainedOutput } from "@claudexor/event-log";
import { readTextSafe } from "@claudexor/util";

export function runFilesExpired(runDir: string): boolean {
  try {
    lstatSync(join(runDir, "tombstone.yaml"));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export function readSessionCapsule(attemptDir: string): SessionCapsule | null {
  try {
    const text = readTextSafe(join(attemptDir, "session-capsule.json"));
    return text === null ? null : SessionCapsule.parse(JSON.parse(text));
  } catch {
    return null;
  }
}

function yaml(path: string): unknown {
  const text = readTextSafe(path);
  if (text === null) return null;
  try {
    return yamlParse(text);
  } catch {
    return null;
  }
}

export function readContinuationEvidence(runDir: string) {
  const finalDir = join(runDir, "final");
  const resumable = RunResumable.safeParse(yaml(join(finalDir, "resumable.yaml"))).data;
  const telemetry = RunTelemetry.safeParse(yaml(join(finalDir, "telemetry.yaml"))).data;
  const attemptsDir = join(runDir, "attempts");
  const sessions = existsSync(attemptsDir)
    ? readdirSync(attemptsDir)
        .sort()
        .flatMap((attemptId) => {
          const capsule = readSessionCapsule(join(attemptsDir, attemptId));
          return capsule ? [{ attemptId, capsule }] : [];
        })
    : [];
  const held =
    sessions.find(
      (entry) => entry.capsule.nativeSessionId === resumable?.session?.nativeSessionId,
    ) ??
    sessions.reduce<(typeof sessions)[number] | null>(
      (newest, entry) =>
        newest && (newest.capsule.mtimeMs ?? 0) > (entry.capsule.mtimeMs ?? 0) ? newest : entry,
      null,
    );
  const attemptId = held?.attemptId ?? telemetry?.final_attempt_id ?? "a01";
  const attempt = telemetry?.attempts.find((entry) => entry.attempt_id === attemptId);
  const patch =
    readTextSafe(join(attemptsDir, attemptId, "patch.diff")) ??
    readTextSafe(join(finalDir, "patch.diff")) ??
    "";
  const events = readRunEvents(join(runDir, "events.jsonl"));
  const output =
    readTextSafe(join(finalDir, "answer.md"))?.trim() ||
    readTextSafe(join(finalDir, "retained-output.md"))?.trim() ||
    retainedOutput(events.events, events.malformed) ||
    "";
  const hasEvidence =
    !!patch.trim() ||
    !!output ||
    events.events.some(
      (event) =>
        event.type === "harness.event" &&
        ["tool_call", "file_change"].includes(String(event.payload["type"])),
    );
  return { resumable, held, attemptId, attempt, patch, output, hasEvidence };
}
