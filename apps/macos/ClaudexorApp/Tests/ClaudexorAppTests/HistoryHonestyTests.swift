import ClaudexorKit
import Foundation
import Testing
@testable import ClaudexorApp

@MainActor @Suite(.serialized)
struct HistoryHonestyTests {
    @Test func prunedRunsNeverReuseAnUnrelatedCachedReceipt() async throws {
        let page = try fixture("thread-history-not-retained")
        let store = ThreadHistoryStore(locationID: .local, threadID: page.threadId) { _, _, _ in page }
        await store.open()
        let row = try #require(store.rows.first { $0.runStatus == "not_retained" })
        #expect(!row.prompt.isEmpty && row.runId != nil && row.run == nil)
        #expect(store.renderedRun(for: row, live: nil) == nil)
        #expect(row.primaryOutputStatus == "not_retained")
        #expect(store.header?.headRunStatus == "not_retained")
    }

    @Test func unverifiableDecisionsDoNotEnableApplyAndFailureKeepsItsFullReference() throws {
        let page = try fixture("thread-history-unavailable-evidence")
        let row = try #require(page.turns.first { $0.run?.applyEligibilityCoverage == "unavailable" })
        let task = try #require(HistoryRunPresentation.task(row, thread: page.header.thread))
        #expect(task.operatorDecisionAction == nil && task.applyEligibility == nil)
        #expect(!DecisionApplyPresentation.showsApply(task))
        #expect(row.run?.unverifiedOperatorDecision?.action == "accept_risk")
        #expect(row.run?.failureMessageInfo?.truncated == true)
        #expect(row.run?.failure?.rawDetailRef != nil)
        #expect(HistoryRunPresentation.counts(row.run!)?.contains("2+") == true)
    }

    @Test func aLaterGestureCancelsPendingNavigationAndKeepsThePaintedIsland() async throws {
        let source = try HistoryTestSource(count: 45)
        var release: CheckedContinuation<Void, Never>?
        let store = ThreadHistoryStore(locationID: .local, threadID: source.detail.thread.id) { selector, limit, _ in
            if selector != nil { await withCheckedContinuation { release = $0 } }
            return try source.page(selector, limit: limit)
        }
        await store.open()
        let ids = store.mountedIDs
        let pending = Task { await store.earlier(retaining: 2) }
        while release == nil { await Task.yield() }
        store.cancelNavigation()
        release?.resume()
        await pending.value
        #expect(store.mountedIDs == ids && store.earlierState == .ready)
    }

    private func fixture(_ name: String) throws -> ThreadHistoryPage {
        let directory = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("ClaudexorKit/Tests/ClaudexorKitTests/Fixtures/wire")
        let json = try JSONSerialization.jsonObject(with: Data(contentsOf: directory.appendingPathComponent(name + ".json"))) as! [String: Any]
        return try JSONDecoder().decode(ThreadHistoryPage.self, from: JSONSerialization.data(withJSONObject: json["value"]!))
    }
}
