import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { WorkProduct, WorkspaceFilesManifest } from "@claudexor/schema";
import { sha256, readFileUtf8BoundedSync } from "@claudexor/util";
import { safeArtifactPath } from "./artifact-paths.js";
import type { DaemonRunRecord } from "./run-record.js";

/** Exact immutable result, shared by apply, display, and artifact streaming. */
export function readFilesWorkProduct(record: DaemonRunRecord, maxBytes?: number) {
  const read = (path: string) =>
    maxBytes === undefined ? readFileSync(path, "utf8") : readFileUtf8BoundedSync(path, maxBytes);
  if (!record.runDir) return null;
  const wpPath = safeArtifactPath(record.runDir, "final/work_product.yaml");
  if (!wpPath) return null;
  const workProduct = WorkProduct.parse(parseYaml(read(wpPath)));
  if (workProduct.kind !== "files") return null;
  const manifestPath = workProduct.files.manifest;
  const manifestSha256 = workProduct.meta.manifest_sha256;
  if (typeof manifestPath !== "string" || typeof manifestSha256 !== "string")
    throw new Error("Files work product has no immutable manifest reference");
  const path = safeArtifactPath(record.runDir, manifestPath);
  if (!path) throw new Error("Files work product manifest is unavailable");
  const text = read(path);
  if (sha256(text) !== manifestSha256) throw new Error("Files manifest digest mismatch");
  return {
    workProduct,
    manifest: WorkspaceFilesManifest.parse(JSON.parse(text)),
    manifestPath,
    manifestSha256,
    artifactRoot: record.runDir,
    text,
  };
}
