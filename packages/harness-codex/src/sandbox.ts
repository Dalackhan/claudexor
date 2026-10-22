import type { AccessProfile, HarnessRunSpec } from "@claudexor/schema";

/** Codex's native sandbox mode for an access profile; inherit_native sends none. */
export function codexSandboxMode(access: AccessProfile): string | null {
  if (access === "readonly") return "read-only";
  if (access === "workspace_write") return "workspace-write";
  if (access === "full") return "danger-full-access";
  return null;
}

/** `codex exec` has no per-turn policy: a `-c` writable root would persist in the
 * native session and could not be revoked by a later turn, so it is refused. */
export function assertCodexExecSpec(spec: Pick<HarnessRunSpec, "auxiliary_writable_roots">): void {
  // An embedder's unparsed spec may omit the field: omission is no grant.
  if ((spec.auxiliary_writable_roots ?? []).length > 0)
    throw new Error(
      "the codex exec transport cannot apply revocable auxiliary writable roots; use the app-server transport",
    );
}
