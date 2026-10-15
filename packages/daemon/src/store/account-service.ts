import { createHash } from "node:crypto";
import type { AccountLastService, CredentialProfile } from "@claudexor/schema";
import type { EngineStore } from "./store.js";

/** The try that served: dedupe and producer-bound retraction key. */
export interface ServiceProducer {
  runId: string;
  attemptId: string;
  tryIndex: number;
}

type BoundProfile = Pick<
  CredentialProfile,
  | "harness_id"
  | "profile_id"
  | "credential_kind"
  | "secret_ref"
  | "isolation_locator"
  | "created_at"
>;

/** A row's credential binding: only its non-secret registration identity.
 * Renaming or toggling a row keeps its service history; replacing what it
 * points at (locator, secret name, kind, re-creation) does not. */
export function accountBindingDigest(profile: BoundProfile): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        profile.credential_kind,
        profile.secret_ref ?? null,
        profile.isolation_locator ?? null,
        profile.created_at ?? null,
      ]),
    )
    .digest("hex");
}

const modelKey = (model: string | null): string => JSON.stringify(model);

/**
 * Durable "which account served this requested model last" (INV-135 tie-break)
 * in the engine store. One current fact per binding and requested model,
 * written synchronously by the single row writer; it carries no expiry, quota
 * or authentication meaning. Reads never write.
 */
export class AccountServiceStore {
  constructor(private readonly store: EngineStore) {}

  /** Record that this producer's try served; the same producer twice is a no-op. */
  serve(profile: BoundProfile, model: string | null, producer: ServiceProducer): void {
    const key = [
      profile.harness_id,
      profile.profile_id,
      modelKey(model),
      accountBindingDigest(profile),
    ];
    this.store.transaction(() => {
      const current = this.store
        .prepare(
          `SELECT run_id, attempt_id, try_index FROM account_last_service
           WHERE harness_id=? AND profile_id=? AND requested_model_key=? AND binding_digest=?`,
        )
        .get(...key) as { run_id: string; attempt_id: string; try_index: number } | undefined;
      if (
        current?.run_id === producer.runId &&
        current.attempt_id === producer.attemptId &&
        Number(current.try_index) === producer.tryIndex
      )
        return;
      // Allocated inside the writer's transaction: above every live row, so
      // the newest service always sorts first whatever the wall clock says.
      const { next } = this.store
        .prepare("SELECT coalesce(max(service_seq), 0) + 1 AS next FROM account_last_service")
        .get() as { next: number };
      this.store
        .prepare(
          `INSERT INTO account_last_service(harness_id, profile_id, requested_model_key, binding_digest,
             service_seq, observed_at, run_id, attempt_id, try_index) VALUES(?,?,?,?,?,?,?,?,?)
           ON CONFLICT(harness_id, profile_id, requested_model_key, binding_digest) DO UPDATE SET
             service_seq=excluded.service_seq, observed_at=excluded.observed_at, run_id=excluded.run_id,
             attempt_id=excluded.attempt_id, try_index=excluded.try_index`,
        )
        .run(
          ...key,
          Number(next),
          this.store.now().toISOString(),
          producer.runId,
          producer.attemptId,
          producer.tryIndex,
        );
    });
  }

  /** The try's own identity contradicted the row after it served: remove only
   * the fact THIS producer wrote, never a newer producer's. */
  retract(profile: BoundProfile, model: string | null, producer: ServiceProducer): void {
    this.store.transaction(() =>
      this.store
        .prepare(
          `DELETE FROM account_last_service WHERE harness_id=? AND profile_id=? AND requested_model_key=?
             AND binding_digest=? AND run_id=? AND attempt_id=? AND try_index=?`,
        )
        .run(
          profile.harness_id,
          profile.profile_id,
          modelKey(model),
          accountBindingDigest(profile),
          producer.runId,
          producer.attemptId,
          producer.tryIndex,
        ),
    );
  }

  /** A credential change voids the facts about it: one row's, or every row's. */
  clear(subject: { harnessId: string; profileId: string } | null): void {
    this.store.transaction(() => {
      if (subject)
        this.store
          .prepare("DELETE FROM account_last_service WHERE harness_id=? AND profile_id=?")
          .run(subject.harnessId, subject.profileId);
      else this.store.prepare("DELETE FROM account_last_service").run();
    });
  }

  /** Service order of each given row for one harness and requested model
   * (higher = served more recently); rows whose binding changed are absent. */
  orders(
    harnessId: string,
    model: string | null,
    profiles: readonly BoundProfile[],
  ): Map<string, number> {
    const digests = new Map(
      profiles
        .filter((profile) => profile.harness_id === harnessId)
        .map((profile) => [profile.profile_id, accountBindingDigest(profile)]),
    );
    const orders = new Map<string, number>();
    if (digests.size === 0) return orders;
    const rows = this.store
      .prepare(
        `SELECT profile_id, binding_digest, service_seq FROM account_last_service
         WHERE harness_id=? AND requested_model_key=?`,
      )
      .all(harnessId, modelKey(model)) as Array<{
      profile_id: string;
      binding_digest: string;
      service_seq: number;
    }>;
    for (const row of rows) {
      if (digests.get(row.profile_id) === row.binding_digest)
        orders.set(row.profile_id, Number(row.service_seq));
    }
    return orders;
  }

  /** The latest service of each given row per requested model, newest first. */
  latest(profiles: readonly BoundProfile[]): AccountLastService[] {
    const digests = new Map(
      profiles.map((profile) => [
        `${profile.harness_id}\0${profile.profile_id}`,
        accountBindingDigest(profile),
      ]),
    );
    const rows = this.store
      .prepare(
        `SELECT harness_id, profile_id, requested_model_key, binding_digest, observed_at
         FROM account_last_service ORDER BY service_seq DESC`,
      )
      .all() as Array<{
      harness_id: string;
      profile_id: string;
      requested_model_key: string;
      binding_digest: string;
      observed_at: string;
    }>;
    return rows
      .filter((row) => digests.get(`${row.harness_id}\0${row.profile_id}`) === row.binding_digest)
      .map((row) => ({
        harness_id: row.harness_id,
        profile_id: row.profile_id,
        requested_model: JSON.parse(row.requested_model_key) as string | null,
        observed_at: row.observed_at,
      }));
  }
}
