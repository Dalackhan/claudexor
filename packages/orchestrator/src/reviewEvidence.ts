/**
 * Review evidence preflight and cleanup for candidate review (`candidateReview.ts`):
 * the evidence packet is an external runtime artifact that ReviewEngine copies
 * into its own reviewer workspace; nothing is ever written into the candidate tree.
 */
import { existsSync } from "node:fs";
import type { ArtifactStore } from "@claudexor/artifact-store";
import { preflightEvidence } from "@claudexor/context";

export function prepareReviewEvidenceDir(sourceDir: string, _candidateCwd: string): string {
  // Evidence is an external runtime artifact. ReviewEngine builds a separate
  // reviewer workspace and copies the packet there; writing/copying it into
  // the candidate tree would contaminate the Git diff and, worse, overwrite a
  // user-owned path with the same name.
  if (!existsSync(sourceDir)) {
    throw new Error(`review evidence preflight failed for ${sourceDir}: source packet missing`);
  }
  return requireReviewEvidence(sourceDir);
}

function requireReviewEvidence(dir: string): string {
  const result = preflightEvidence(dir);
  if (result.ok) return dir;
  const missing = result.missing.length ? `missing=${result.missing.join(",")}` : "";
  const empty = result.empty.length ? `empty=${result.empty.join(",")}` : "";
  throw new Error(
    `review evidence preflight failed for ${dir}: ${[missing, empty].filter(Boolean).join(" ")}`,
  );
}

function cleanupReviewEvidenceDir(
  _candidateEvidenceDir: string,
  _candidateCwd: string,
): Record<string, string> | null {
  // No candidate-tree packet exists in v2; external runtime retention is
  // governed by the artifact/journal lifecycle rather than best-effort rm.
  return null;
}

export function recordReviewEvidenceCleanup(
  store: ArtifactStore,
  metadataPath: string,
  attemptId: string,
  candidateEvidenceDir: string,
  candidateCwd: string,
): void {
  const cleanupMetadata = cleanupReviewEvidenceDir(candidateEvidenceDir, candidateCwd);
  if (!cleanupMetadata) return;
  try {
    store.writeYaml(metadataPath, {
      ...cleanupMetadata,
      attempt_id: attemptId,
    });
  } catch {
    // Cleanup telemetry must not mask the review/revalidation failure that
    // triggered best-effort cleanup.
  }
}
