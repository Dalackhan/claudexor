export function threadHistoryFixtures(schema) {
  const revision = { epoch: "11111111-1111-4111-8111-111111111111", sequence: 42 };
  const { runIds: _runIds, ...thread } = schema.ControlThread.parse({
    id: "th-history",
    createdAt: "2026-10-26T10:00:00Z",
    updatedAt: "2026-10-26T10:00:00Z",
  });
  const empty = schema.ThreadHistoryPage.parse({
    storeId: "22222222-2222-4222-8222-222222222222",
    threadId: thread.id,
    epoch: "partition-epoch",
    revision,
    header: {
      thread,
      latestTurnId: null,
      latestAdmission: null,
      headRun: null,
      sessions: [],
      sessionsComplete: true,
    },
    turns: [],
    hasOlder: false,
    hasNewer: false,
    olderCursor: null,
    newerCursor: null,
    replayCursor: null,
    replayNextCursor: null,
    limitedBy: null,
  });
  const refusal = schema.ThreadHistoryTurn.parse({
    id: "turn-refused",
    threadId: thread.id,
    createdAt: thread.createdAt,
    ordinal: 0,
    revision,
    prompt: "Question 😀",
    promptInfo: { textBytes: 13, totalTextBytes: 13, truncated: false },
    run: null,
    primaryOutput: null,
    answeredByTurnId: null,
    answeredByPrompt: null,
    planAnswerComplete: true,
    enqueueError: {
      message: "Choose an available route",
      retryable: false,
      failedAt: thread.createdAt,
    },
  });
  const settled = schema.ThreadHistoryTurn.parse({
    ...refusal,
    id: "turn-settled",
    ordinal: 1,
    runId: "run-history",
    enqueueError: null,
    run: schema.ThreadHistoryRun.parse({
      state: "succeeded",
      mode: "plan",
      harnesses: ["fake"],
      startedAt: thread.createdAt,
      finishedAt: thread.updatedAt,
      spendUsd: null,
      spendEstimated: true,
      toolCount: { value: 2, coverage: "partial" },
      fileCount: { value: null, coverage: "unavailable" },
      applyEligibilityCoverage: "complete",
      outputReadyState: "ready",
      planReadiness: { state: "needs_answers", questionCount: 1 },
      planQuestions: [{ id: "q", kind: "text", prompt: "Which direction?" }],
      requiredActions: [{ id: "provide_required_input", detail: "Answer the plan question" }],
    }),
    answeredByTurnId: "off-page-answer",
    answeredByPrompt: {
      id: "off-page-answer",
      prompt: "Continue",
      promptInfo: { textBytes: 8, totalTextBytes: 8, truncated: false },
    },
    primaryOutput: {
      kind: "plan",
      path: "final/plan.md",
      text: "Plan 😀",
      bytes: 9,
      textBytes: 9,
      totalTextBytes: 9,
      truncated: false,
    },
  });
  const withRows = schema.ThreadHistoryPage.parse({
    ...empty,
    header: {
      ...empty.header,
      latestTurnId: settled.id,
      latestAdmission: {
        id: settled.id,
        runId: settled.runId,
        enqueueError: null,
        jobId: "job-settled",
        state: "succeeded",
      },
      headRun: { runId: settled.runId, run: schema.ControlTurnRunCard.parse(settled.run) },
    },
    turns: [refusal, settled],
    replayCursor: "opaque-replay",
    hasOlder: true,
    olderCursor: "opaque-older",
    limitedBy: "turns",
  });
  const part = schema.ThreadPromptPart.parse({
    threadId: thread.id,
    turnId: refusal.id,
    totalBytes: 13,
    sha256: "a".repeat(64),
    offset: 0,
    nextOffset: 13,
    text: refusal.prompt,
  });
  return [
    { name: "thread-history-empty", schema: "ThreadHistoryPage", value: empty },
    { name: "thread-history-receipts", schema: "ThreadHistoryPage", value: withRows },
    { name: "thread-prompt-part", schema: "ThreadPromptPart", value: part },
  ];
}
