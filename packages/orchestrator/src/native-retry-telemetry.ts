import type { AttemptTelemetry } from "./attemptTelemetry.js";
import { newAttemptOutputMarkers } from "./attemptOutputMarkers.js";

/**
 * A3 per-try isolation, shared by the Agent and Ask/report loops: what a native
 * retry of the same attempt must not inherit. Progress markers restart, and the
 * catalog proof ends: it certified the try whose event set observedModel, and
 * a later try (a continuation, a transient retry or a rotated account) may run
 * another model or report none. observedModel stays first-wins, and a proof
 * only ever comes from the event that set it, so no later try's proof is
 * paired with an earlier try's string.
 */
export function beginNativeRetry(t: AttemptTelemetry): void {
  t.outputMarkers = newAttemptOutputMarkers();
  t.observedModelCatalogMatch = null;
}
