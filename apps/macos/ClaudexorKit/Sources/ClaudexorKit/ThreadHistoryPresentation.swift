import Foundation

extension ThreadHistoryThread {
    /// Metadata adapter for existing composer/workspace-scope controls. This is
    /// not an archive run inventory; only the workspace detail read owns that.
    public var summary: ThreadSummary {
        ThreadSummary(id: id, title: title, folder: folder, repoRoot: repoRoot, mode: mode,
            workspaceMode: workspaceMode, workspaceRoot: workspaceRoot, authPreference: authPreference,
            credentialProfileId: credentialProfileId, primaryHarness: primaryHarness,
            eligibleHarnesses: eligibleHarnesses, access: access, state: state, trashedAt: trashedAt,
            purgeAfter: purgeAfter, runIds: [], headRunId: headRunId, needsHuman: needsHuman,
            createdAt: createdAt, updatedAt: updatedAt)
    }
}

extension ThreadHistoryTurn {
    public var turnInfo: ThreadTurnInfo {
        ThreadTurnInfo(id: id, threadId: threadId, runId: runId, parentRunId: parentRunId,
            answersPlanRunId: answersPlanRunId, planRunId: planRunId, kind: kind, prompt: prompt,
            run: run.map { value in
                TurnRunCard(state: value.state, mode: value.mode, strategy: value.strategy, n: value.n,
                    result: value.result, outcomeFacts: value.outcomeFacts, spendUsd: value.spendUsd,
                    outputReadyState: value.outputReadyState, waitingOnUser: value.waitingOnUser,
                    finishedAt: value.finishedAt, delegation: value.delegation,
                    delegatedChildRunIds: value.delegatedChildRunIds)
            }, planHash: planHash, planReadinessOverridden: planReadinessOverridden, enqueueError: enqueueError, continuity: continuity, createdAt: createdAt)
    }
}
