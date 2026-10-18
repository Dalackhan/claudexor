import { existsSync, lstatSync, realpathSync, renameSync } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { parse as yamlParse } from "yaml";
import { fsyncDirectoryAsync } from "@claudexor/util";

/** Private, same-filesystem claims; never ordinary run/artifact candidates. */
export const RETIRING = ".retiring";
const TOMBSTONE = "tombstone.yaml";
type Intent = { version: 1; name: string; tombstone: string | null };

function validateIntent(value: unknown, kind: "runs" | "reviews"): Intent {
  const intent = value as Intent | null;
  if (
    !intent ||
    intent.version !== 1 ||
    typeof intent.name !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(intent.name)
  )
    throw new Error("invalid retirement intent");
  if (kind === "reviews") {
    if (!intent.name.startsWith("diff-") || intent.tombstone !== null)
      throw new Error("invalid review retirement intent");
  } else {
    if (typeof intent.tombstone !== "string") throw new Error("missing retirement tombstone");
    const marker = yamlParse(intent.tombstone);
    if (
      marker?.run_id !== intent.name ||
      marker?.reason !== "retention" ||
      !Number.isFinite(Date.parse(marker?.deleted_at))
    )
      throw new Error("invalid retirement tombstone");
  }
  return intent;
}

async function durableText(path: string, text: string): Promise<void> {
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(text);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Preparing may yield. The caller MUST recheck every protection immediately
 * before commit(), which does not yield between detachment and tombstone publish.
 * A crash after detachment leaves an intent the next pass can finish. */
export class Retirement {
  readonly tree: string;
  private committed: boolean;
  private readonly parentReal: string;
  private readonly holdingIdentity;
  private readonly claimIdentity;
  constructor(
    readonly parent: string,
    readonly claim: string,
    readonly intent: Intent,
  ) {
    this.tree = join(claim, "tree");
    this.committed = existsSync(this.tree);
    this.parentReal = realpathSync(parent);
    this.holdingIdentity = lstatSync(join(parent, RETIRING));
    this.claimIdentity = lstatSync(claim);
  }
  private assertHolding(): void {
    const current = lstatSync(join(this.parent, RETIRING));
    const claim = lstatSync(this.claim);
    if (
      !current.isDirectory() ||
      current.dev !== this.holdingIdentity.dev ||
      current.ino !== this.holdingIdentity.ino ||
      realpathSync(this.parent) !== this.parentReal ||
      !claim.isDirectory() ||
      claim.dev !== this.claimIdentity.dev ||
      claim.ino !== this.claimIdentity.ino
    )
      throw new Error("retirement directory changed");
  }
  commit(): void {
    this.assertHolding();
    renameSync(join(this.parent, this.intent.name), this.tree);
    this.committed = true;
    this.publishTombstone();
  }
  private publishTombstone(): void {
    if (this.intent.tombstone === null) return;
    const target = join(this.parent, this.intent.name);
    if (existsSync(target)) throw new Error("retirement target already exists");
    renameSync(join(this.claim, "marker"), target);
  }
  /** Publish was interrupted, or completed before a crash. Never replace new
   * data at the original path when recovering a claim. */
  async recover(): Promise<void> {
    this.assertHolding();
    const target = join(this.parent, this.intent.name);
    if (this.intent.tombstone !== null && existsSync(target)) {
      if (
        !lstatSync(target).isDirectory() ||
        (await readdir(target)).join() !== TOMBSTONE ||
        (await readFile(join(target, TOMBSTONE), "utf8")) !== this.intent.tombstone
      )
        throw new Error("retirement target has changed; kept detached tree");
    } else if (existsSync(target)) {
      throw new Error("review retirement target has changed; kept detached tree");
    } else {
      if (this.intent.tombstone !== null && !existsSync(join(this.claim, "marker"))) {
        await mkdir(join(this.claim, "marker"), { mode: 0o700 });
        await durableText(join(this.claim, "marker", TOMBSTONE), this.intent.tombstone);
        await fsyncDirectoryAsync(join(this.claim, "marker"));
        await fsyncDirectoryAsync(this.claim);
      }
      this.assertHolding();
      this.publishTombstone();
    }
  }
  async finish(): Promise<string[]> {
    this.assertHolding();
    // Persist the detach and tombstone BEFORE removing any detached bytes.
    await fsyncDirectoryAsync(this.claim);
    await fsyncDirectoryAsync(this.parent);
    await rm(this.tree, { recursive: true, force: true });
    // Physical deletion is now a fact; a failed bookkeeping unlink must not
    // erase it from the receipt. Empty claims are harmless and retried later.
    try {
      await rm(this.claim, { recursive: true, force: true });
      return [];
    } catch (error) {
      return [`retirement bookkeeping: ${String(error)}`];
    }
  }
  async abandon(): Promise<void> {
    if (!this.committed) await rm(this.claim, { recursive: true, force: true });
  }
}

export async function prepareRetirement(
  parent: string,
  name: string,
  tombstone: string | null,
): Promise<Retirement> {
  const intent = validateIntent(
    { version: 1, name, tombstone },
    tombstone === null ? "reviews" : "runs",
  );
  const holding = join(parent, RETIRING);
  await mkdir(holding, { recursive: true, mode: 0o700 });
  if (!(await lstat(holding)).isDirectory())
    throw new Error("retirement requires a plain directory");
  const claim = await mkdtemp(join(holding, "claim-"));
  try {
    await durableText(join(claim, "intent.json"), JSON.stringify(intent));
    if (tombstone !== null) {
      await mkdir(join(claim, "marker"), { mode: 0o700 });
      await durableText(join(claim, "marker", TOMBSTONE), tombstone);
      await fsyncDirectoryAsync(join(claim, "marker"));
    }
    await fsyncDirectoryAsync(claim);
    await fsyncDirectoryAsync(holding);
    await fsyncDirectoryAsync(parent);
    return new Retirement(parent, claim, intent);
  } catch (error) {
    await rm(claim, { recursive: true, force: true });
    throw error;
  }
}

/** Recovery only removes claims from a previously committed expiration.
 * Prepared-but-uncommitted claims are discarded without touching the source. */
export async function* pendingRetirements(
  parent: string,
  kind: "runs" | "reviews",
  dryRun: boolean,
  errors: string[],
): AsyncGenerator<Retirement> {
  const holding = join(parent, RETIRING);
  let entries;
  try {
    if (!(await lstat(holding)).isDirectory())
      throw new Error("retirement requires a plain directory");
    entries = await readdir(holding, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      errors.push(`${holding}: ${String(error)}`);
    return;
  }
  for (const entry of entries) {
    const claim = join(holding, entry.name);
    try {
      if (!entry.isDirectory() || !entry.name.startsWith("claim-"))
        throw new Error("unrecognized retirement claim");
      const intentPath = join(claim, "intent.json");
      if (!(await lstat(intentPath)).isFile())
        throw new Error("retirement intent is not a plain file");
      const intent = validateIntent(JSON.parse(await readFile(intentPath, "utf8")), kind);
      const retirement = new Retirement(parent, claim, intent);
      if (!existsSync(retirement.tree)) {
        if (!dryRun) await retirement.abandon();
      } else if (!lstatSync(retirement.tree).isDirectory()) {
        throw new Error("retired tree is not a plain directory");
      } else {
        yield retirement;
      }
    } catch (error) {
      errors.push(`${claim}: ${String(error)}`);
    }
  }
}
