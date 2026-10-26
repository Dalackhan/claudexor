import SwiftUI
import ClaudexorKit

/// An in-memory adapter for the mockup. IDs, never array offsets, own the mounted
/// island. Engine paging can replace this source without changing the controls.
@MainActor @Observable final class ConversationFeedState {
    struct NavigationAnchor: Hashable, Sendable { let turnID: String; let request: Int }
    enum Viewport { case followingTail, reading(anchor: String?) }
    var viewport: Viewport = .followingTail
    var mountedIDs: [String] = []
    var position = ScrollPosition(idType: NavigationAnchor.self)
    var newCount = 0
    var atBottom = true
    var viewportHeight: CGFloat = 600
    var width: CGFloat = 680
    var floatingControlHeight: CGFloat = 0
    var earlierState: HistoryControlState = .ready
    var laterState: HistoryControlState = .ready
    var presentation = ConversationPresentation()
    var navigationRevision = 0
    var navigationTarget: String?
    var navigationAnchor: UnitPoint = .top
    private var observedLastID: String?
    static let limit = 20
    static let topID = "history:top"
    static let bottomID = "history:bottom"

    var follows: Bool { if case .followingTail = viewport { true } else { false } }
    var positionedTurnID: String? { position.viewID(type: NavigationAnchor.self)?.turnID }

    func markerID(for turnID: String) -> NavigationAnchor {
        NavigationAnchor(turnID: turnID, request: navigationRevision)
    }

    func visible(_ turns: [ThreadTurnInfo]) -> [ThreadTurnInfo] {
        guard !mountedIDs.isEmpty else { return Array(turns.suffix(Self.limit)) }
        let wanted = Set(mountedIDs)
        return Array(turns.filter { wanted.contains($0.id) }.prefix(Self.limit))
    }

    func install(_ turns: [ThreadTurnInfo]) {
        if mountedIDs.isEmpty { mountedIDs = turns.suffix(Self.limit).map(\.id) }
        observedLastID = turns.last?.id
        presentation.receiveLatest(turns.last?.id)
    }

    func receive(_ turns: [ThreadTurnInfo]) {
        let previous = observedLastID
        observedLastID = turns.last?.id
        presentation.receiveLatest(turns.last?.id)
        guard previous != observedLastID else { return }
        if follows {
            mountedIDs = turns.suffix(Self.limit).map(\.id)
        } else if let previous, let index = turns.firstIndex(where: { $0.id == previous }) {
            newCount += turns.count - index - 1
        }
    }

    func latest(_ turns: [ThreadTurnInfo]) {
        mountedIDs = turns.suffix(Self.limit).map(\.id)
        viewport = .followingTail
        newCount = 0
        navigate(to: Self.bottomID, anchor: .bottom)
    }

    func earlier(_ turns: [ThreadTurnInfo], retaining: Int) {
        guard let first = visible(turns).first,
              let index = turns.firstIndex(where: { $0.id == first.id }), index > 0 else { return }
        // Keep enough rows BELOW the anchor to avoid the scroll clamp. All-fit
        // windows travel by one and land at the declared top edge (owner Q5).
        let step = min(index, max(1, Self.limit - min(Self.limit - 1, retaining)))
        let start = index - step
        mountedIDs = turns[start..<min(turns.count, start + Self.limit)].map(\.id)
        viewport = .reading(anchor: first.id)
        navigate(to: first.id, anchor: .top)
    }

    func later(_ turns: [ThreadTurnInfo]) {
        guard let last = visible(turns).last,
              let index = turns.firstIndex(where: { $0.id == last.id }), index < turns.count - 1 else { return }
        let end = min(turns.count, index + 1 + Self.limit / 2)
        mountedIDs = turns[max(0, end - Self.limit)..<end].map(\.id)
        viewport = .reading(anchor: last.id)
        navigate(to: last.id, anchor: .top)
    }

    func navigate(to id: String, anchor: UnitPoint) {
        navigationTarget = id
        navigationAnchor = anchor
        navigationRevision += 1
    }

    func commitNavigation() {
        guard let navigationTarget else { return }
        // ScrollPosition coalesces repeated requests for the same target. Only
        // the zero-height marker changes identity; retained TurnCards and their
        // native selections keep their stable turn IDs through the reveal.
        position.scrollTo(id: markerID(for: navigationTarget), anchor: navigationAnchor)
    }

    func geometry(bottom: Bool, tailMounted: Bool) {
        atBottom = bottom
        if bottom && tailMounted {
            viewport = .followingTail
            newCount = 0
        } else if follows {
            viewport = .reading(anchor: positionedTurnID)
        }
    }
}

struct ConversationFeed: View {
    @Environment(AppModel.self) private var model
    @Environment(\.conversationTextOptions) private var options
    @Bindable var state: ConversationFeedState
    let detail: ThreadDetailResponse
    let routingOptions: TurnOptions
    var sessions: AnyView = AnyView(EmptyView())

    private var turns: [ThreadTurnInfo] { state.visible(detail.turns) }
    private var tailMounted: Bool { turns.last?.id == detail.turns.last?.id }

    var body: some View {
        ScrollView {
            ConversationHistoryStack(spacing: 0) {
                if !turns.isEmpty {
                    EarlierTurnsControl(hasEarlier: turns.first?.id != detail.turns.first?.id,
                        state: state.earlierState, action: showEarlier)
                        .frame(maxWidth: .infinity).padding(.bottom, Theme.Spacing.md)
                        .id(state.markerID(for: ConversationFeedState.topID))
                }
                ForEach(turns) { turn in
                    Color.clear.frame(height: 0).id(state.markerID(for: turn.id))
                    TurnCard(turn: turn, target: model.turnStartTarget(
                        locationID: model.selectedExecutionLocation, thread: detail.thread),
                        routingOptions: routingOptions,
                        executionRoot: ThreadWorkspacePanel.executionRoot(for: detail.thread))
                        .conversationMeasure().padding(.bottom, Theme.Spacing.md).id(turn.id)
                }
                if !tailMounted {
                    LaterTurnsControl(state: state.laterState, showJump: state.atBottom,
                        newCount: state.newCount,
                        later: { state.later(detail.turns) }, latest: { state.latest(detail.turns) })
                        .frame(maxWidth: .infinity).padding(.bottom, Theme.Spacing.md)
                } else if !detail.sessions.isEmpty { sessions }
                Color.clear.frame(height: 1).id(state.markerID(for: ConversationFeedState.bottomID))
            }
        }
        .defaultScrollAnchor(.bottom, for: .initialOffset)
        .defaultScrollAnchor(state.follows ? .bottom : .top, for: .sizeChanges)
        .defaultScrollAnchor(.top, for: .alignment)
        .scrollPosition($state.position, anchor: .top)
        .onChange(of: state.navigationRevision) { state.commitNavigation() }
        .onScrollGeometryChange(for: Bool.self) { geometry in
            geometry.contentOffset.y + geometry.containerSize.height >= geometry.contentSize.height + geometry.contentInsets.bottom - 1
        } action: { _, bottom in
            state.geometry(bottom: bottom, tailMounted: tailMounted)
        }
        .onGeometryChange(for: CGSize.self) { $0.size } action: { size in
            state.viewportHeight = size.height
            state.width = min(680, max(1, size.width - 2 * Theme.Spacing.lg))
        }
        .modifier(ConversationJumpInset(isPresented: !state.follows && !(state.atBottom && !tailMounted),
            newCount: state.newCount, measuredHeight: { state.floatingControlHeight = $0 },
            latest: { state.latest(detail.turns) }))
        .environment(state.presentation)
        .onAppear { state.install(detail.turns) }
        .onChange(of: detail.turns.map(\.id)) { state.receive(detail.turns) }
        .onChange(of: state.presentation.selectedMessages) { _, selected in
            if !selected.isEmpty { state.viewport = .reading(anchor: state.positionedTurnID) }
        }
        .onChange(of: state.presentation.focusedMessages) { _, focused in
            if !focused.isEmpty { state.viewport = .reading(anchor: state.positionedTurnID) }
        }
    }

    private func showEarlier() {
        // Prepare the incoming prose at the current exact column width before the
        // synchronous ID/anchor commit. No asynchronous per-card hydration here.
        guard let first = turns.first,
              let index = detail.turns.firstIndex(where: { $0.id == first.id }) else { return }
        var retained = 0
        var height: CGFloat = 0
        for turn in turns {
            retained += 1
            height += prepare(turn)
            if height >= state.viewportHeight { break }
        }
        for turn in detail.turns[max(0, index - 19)..<index] { _ = prepare(turn) }
        state.earlier(detail.turns, retaining: retained)
    }

    private func prepare(_ turn: ThreadTurnInfo) -> CGFloat {
        let prompt = PromptBubble.preview(turn.prompt)
        let expanded = state.presentation.expanded["prompt:" + turn.id] ?? (state.presentation.latestTurnID == turn.id)
        let text = options.prompt == .collapse && !expanded ? String(prompt.prefix(1_200)) : prompt
        let promptHeight = ProseMeasurer.shared.height(ProseBuilder.plain(text), width: max(1, state.width - 72))
        // A conservative minimum includes bubble padding, receipt and row spacing.
        // Tables/images only increase this floor, so the retained suffix remains sufficient.
        if let answer = turn.runId.flatMap({ model.task($0)?.answerText }) {
            let shown = state.presentation.expanded["answer:" + turn.id] == true ? answer : String(answer.prefix(1_200))
            for segment in ProseBuilder.segments(shown, style: .init(), code: options.code) {
                if case .prose(let doc) = segment.content {
                    _ = ProseMeasurer.shared.height(doc, width: max(1, state.width - 48))
                }
            }
        }
        return min(260, promptHeight) + 64
    }
}
