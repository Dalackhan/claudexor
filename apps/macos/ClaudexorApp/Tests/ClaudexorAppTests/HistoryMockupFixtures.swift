import AppKit
import ClaudexorKit
import SwiftUI
@testable import ClaudexorApp

@MainActor enum HistoryMockupFixtures {
    static let threadID = "mock-history"
    static let longCodeLine = "let artifact = Artifact(path: \"apps/macos/ClaudexorApp/Sources/ClaudexorApp/ConversationHistoryWindow.swift\", sha256: \"9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08\", verified: true)"
    static let code = "let revision = history.revision\n" + longCodeLine + "\nlet turns = history.turns.suffix(20)\nreturn turns.map(\\.id)"
    static let selectionAnswer = """
    ## Keep the passage in view

    The saved conversation is ready. Select this paragraph, the list, the Swift code and the closing paragraph in one gesture.

    - Keep the current turn as the reading anchor.
    - Prepare the new text before committing the window.
    - Preserve source lines when copying. Проверка репозитория.

    ```swift
    \(code)
    ```

    The next refresh keeps this passage visible. Long paths wrap within the column; copied code still contains the original source lines.
    """

    static func prompt(_ index: Int) -> String {
        var text = "Turn \(index + 1): review the saved-history implementation and preserve the reader’s place.\n\n"
        var section = 0
        while text.count < 8_000 {
            text += "Review note \(section + 1): " + paragraph(index + section) + "\n\n"
            text += "/workspace/claudexor/apps/macos/ClaudexorApp/Sources/ClaudexorApp/ConversationHistoryWindow.swift\n"
            text += "sha256: 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08\n\n"
            section += 1
        }
        return String(text.prefix(8_000))
    }

    static func paragraph(_ index: Int) -> String {
        "The review of revision \(index + 1) follows the conversation from its first saved turn to the current reply. "
        + "Keep the project path, evidence and account context visible while checking the history window. "
        + "A reader may compare an earlier decision with the current implementation without losing a draft or a selected passage. "
        + "Проверка: сообщение и репозиторий остаются доступны. "
        + "The final answer records what changed, how it was verified and which questions still need a decision."
    }

    static var table: String {
        var text = "| Area | Status | Evidence |\n|---|---|---|\n"
        let areas = ["History window", "Prompt preview", "Answer selection", "Wrapped code", "Table copy", "Plan draft",
                     "Saved history", "Link scope", "Tail following", "Earlier turns", "Narrow column", "Dark appearance"]
        for (index, area) in areas.enumerated() {
            text += "| \(area) | \(index % 3 == 0 ? "Review" : "Verified") | "
                + "Revision \(index + 1): \(index % 4 == 0 ? paragraph(index) : "The passage and its source evidence remain available after the next refresh.") |\n"
        }
        return text
    }

    static func answer(_ index: Int) -> String {
        "## Review of turn \(index + 1)\n\n" + paragraph(index) + "\n\n" + table + "\n\n"
        + selectionAnswer + "\n\n" + (0..<8).map { paragraph(index + $0) }.joined(separator: "\n\n")
    }

    static func make(count: Int = 45, short: Bool = false) throws -> (ThreadDetailResponse, [TaskRun]) {
        var turns: [ThreadTurnInfo] = []
        var runs: [TaskRun] = []
        for index in 0..<count {
            let runID = "mock-run-\(index)"
            let text = short ? "Checkpoint \(index + 1): retain the saved passage." : prompt(index)
            turns.append(ThreadTurnInfo(id: "mock-turn-\(index)", threadId: threadID, runId: runID,
                parentRunId: nil, planRunId: nil, kind: nil, prompt: text, run: nil,
                createdAt: "2026-10-26T10:00:00.000Z"))
            var run = TaskRun(id: runID, title: "History review \(index + 1)", prompt: text,
                mode: .agent, phase: .succeeded, project: "History review", harnesses: [], n: 1,
                createdAt: Date(timeIntervalSince1970: 1_793_008_800), updatedAt: Date(timeIntervalSince1970: 1_793_008_860),
                spendUsd: 0, capUsd: 0, spendKnown: false, capKnown: false, routeProof: .unverified,
                attentionNote: nil, plan: [], activity: [], candidates: [], findings: [], diff: [])
            run.answerText = short ? "Verified checkpoint \(index + 1)." : answer(index)
            runs.append(run)
        }
        let json: [String: Any] = ["id": threadID, "title": "Saved history · review and implementation",
            "runIds": runs.map(\.id), "headRunId": runs.last?.id ?? "", "needsHuman": false,
            "createdAt": "2026-10-26T10:00:00.000Z", "updatedAt": "2026-10-26T10:01:00.000Z"]
        let thread = try JSONDecoder().decode(ThreadSummary.self, from: JSONSerialization.data(withJSONObject: json))
        return (ThreadDetailResponse(thread: thread, sessions: [], turns: turns), runs)
    }

    static func model(detail: ThreadDetailResponse, runs: [TaskRun]) -> AppModel {
        let model = AppModel(client: nil, requestNotificationAuthorization: false, loadPersistedState: false)
        model.liveTasks = runs
        model.threads = [detail.thread]
        model.selectedThreadId = detail.thread.id
        model.selectedThreadDetail = detail
        return model
    }

    static func plan(_ run: inout TaskRun) {
        run.mode = .plan
        run.answerText = "The history design is ready for your decisions. Your draft answers are retained while you read earlier turns."
        run.planReadiness = PlanReadiness(state: "needs_answers", questionCount: 5)
        run.planQuestions = [
            PlanQuestion(id: "code", kind: "text", prompt: "How should long Swift source lines appear?", options: [], allowText: true),
            PlanQuestion(id: "table", kind: "text", prompt: "Which table copy behavior works for your review?", options: [], allowText: true),
            PlanQuestion(id: "prompt", kind: "text", prompt: "Should older prompts start collapsed?", options: [], allowText: true),
            PlanQuestion(id: "typing", kind: "text", prompt: "Where should typing go after selecting message text?", options: [], allowText: true),
            PlanQuestion(id: "travel", kind: "text", prompt: "May explicit history travel end a selection in a turn that leaves the mounted window?", options: [], allowText: true)
        ]
    }
}

/// Focused comparison frames use exactly the production message/table hosts and fills.
struct HistoryComparisonSurface: View {
    let kind: String
    let width: CGFloat
    var body: some View {
        ScrollView {
            Group {
                if kind.hasPrefix("18") || kind == "16c" {
                    PromptBubble(prompt: HistoryMockupFixtures.prompt(44), turnID: "comparison")
                } else {
                    MarkdownOutputView(markdown: kind.hasPrefix("17")
                        ? HistoryMockupFixtures.table : HistoryMockupFixtures.selectionAnswer, bodyFont: .body)
                        .frame(width: width, alignment: .leading)
                        .padding(Theme.Spacing.md)
                        .bubbleFill(tint: Theme.surfaceRaisedHi, radius: Theme.Radius.control)
                }
            }
            .frame(width: kind.hasPrefix("18") || kind == "16c" ? width : width + 24, alignment: .leading)
            .padding(Theme.Spacing.lg)
            .frame(maxWidth: .infinity)
        }
        .textSelection(.disabled)
        .background(Theme.surfaceBase)
    }
}

/// Deliberately minimal row geometry to expose the physically unavoidable clamp.
/// The other 05b pair uses full production TurnCards with 21 short turns.
struct HistoryClampSurface: View {
    @Bindable var state: ConversationFeedState
    let detail: ThreadDetailResponse
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
                EarlierTurnsControl(hasEarlier: true) { state.earlier(detail.turns, retaining: 20) }
                    .frame(maxWidth: .infinity)
                ForEach(state.visible(detail.turns)) { turn in
                    ProseText(document: ProseBuilder.plain("\(turn.id): Keep this checkpoint available."))
                        .id(state.markerID(for: turn.id))
                }
                if state.mountedIDs.last != detail.turns.last?.id {
                    LaterTurnsControl(later: { state.later(detail.turns) }, latest: { state.latest(detail.turns) })
                }
            }.scrollTargetLayout().frame(width: 680).padding(Theme.Spacing.lg)
                .frame(maxWidth: .infinity)
        }
        .defaultScrollAnchor(.bottom, for: .initialOffset)
        .defaultScrollAnchor(.bottom, for: .sizeChanges)
        .defaultScrollAnchor(.top, for: .alignment)
        .scrollPosition($state.position)
        .onChange(of: state.navigationRevision) { state.commitNavigation() }
        .background(Theme.surfaceBase)
    }
}
