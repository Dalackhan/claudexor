import AppKit
import SwiftUI

/// A settled reading passage, independent of the card's height. Native hosts
/// register weakly; geometry is read only after scrolling or width changes settle.
/// Restoration requests go through ConversationFeedState's one scroll path.
@MainActor final class ConversationReadingPosition {
    struct Passage {
        let turnID: String
        let documentID: String
        let character: Int
        let offset: CGFloat
    }
    private let hosts = NSHashTable<ProseTextView>.weakObjects()
    private weak var state: ConversationFeedState?
    private var captureTask: Task<Void, Never>?
    private var restoreTask: Task<Void, Never>?
    private var preservingNavigation = false
    private var heldWidth: CGFloat?
    private(set) var passage: Passage?
    private(set) var isResizing = false
    private(set) var isFollowingResize = false

    func attach(_ state: ConversationFeedState) { self.state = state }
    func register(_ view: ProseTextView) { hosts.add(view) }
    func unregister(_ view: ProseTextView) { hosts.remove(view) }
    func stop() {
        captureTask?.cancel(); restoreTask?.cancel()
        captureTask = nil; restoreTask = nil; passage = nil; isResizing = false; isFollowingResize = false
    }

    func gestureBegan() { stop() }

    func navigated() {
        if preservingNavigation { preservingNavigation = false; return }
        stop()
        captureAfterSettling()
    }

    func captureAfterSettling() {
        guard !isResizing else { return }
        captureTask?.cancel()
        captureTask = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .milliseconds(120))
            guard !Task.isCancelled else { return }
            self?.capture()
        }
    }

    func captureWhenReadingBegins() {
        guard !isResizing else { return }
        captureTask?.cancel()
        // Focus arrives outside layout. Capture before a subsequent resize can
        // cancel a delayed scroll-settling capture and lose the old-width passage.
        capture()
    }

    private func capture() {
        guard let state, !state.follows else { passage = nil; return }
        guard let turn = state.visibleTurnID, let scroll = scrollView, let document = scroll.documentView else { return }
        let top = scroll.contentView.bounds.minY
        let bottom = scroll.contentView.bounds.maxY
        let candidates = hosts.allObjects.filter { $0.messageID == turn && $0.window != nil }
            .sorted { $0.convert($0.bounds, to: document).minY < $1.convert($1.bounds, to: document).minY }
        guard let view = candidates.first(where: {
            let rect = $0.convert($0.bounds, to: document)
            return rect.maxY > top && rect.minY < bottom
        }), let layout = view.layoutManager, let container = view.textContainer,
            let identity = view.shownID, !view.string.isEmpty else { return }
        let point = view.convert(NSPoint(x: 0, y: top), from: document)
        let glyph = layout.glyphIndex(for: NSPoint(x: 0, y: max(0, point.y - view.textContainerOrigin.y)), in: container)
        guard glyph < layout.numberOfGlyphs else { return }
        let character = layout.characterIndexForGlyph(at: glyph)
        guard let y = lineY(in: view, character: character, document: document) else { return }
        passage = Passage(turnID: turn, documentID: identity, character: character, offset: y - top)
    }

    func widthChanged(_ width: CGFloat) {
        defer { heldWidth = width }
        guard let previous = heldWidth, previous != width, let state else { captureAfterSettling(); return }
        captureTask?.cancel(); restoreTask?.cancel()
        isResizing = true
        isFollowingResize = state.follows
        let navigation = state.navigationRevision
        let following = state.follows
        restoreTask = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .milliseconds(180))
            guard !Task.isCancelled, let self, let state = self.state else { return }
            self.isResizing = false
            self.isFollowingResize = false
            guard navigation == state.navigationRevision else { return }
            if following && state.follows {
                self.passage = nil
                state.viewport = .followingTail
                self.preservingNavigation = true
                state.navigate(to: ConversationFeedState.bottomID, anchor: .bottom)
            } else if let passage = self.passage, let scroll = self.scrollView, let document = scroll.documentView,
                      state.mountedIDs.contains(passage.turnID),
                      let view = self.hosts.allObjects.first(where: { $0.messageID == passage.turnID && $0.shownID == passage.documentID }),
                      let y = self.lineY(in: view, character: passage.character, document: document) {
                self.preservingNavigation = true
                state.navigate(toY: y - passage.offset)
            }
        }
    }

    func lineOffset(for passage: Passage) -> CGFloat? {
        guard let scroll = scrollView, let document = scroll.documentView,
              let view = hosts.allObjects.first(where: { $0.messageID == passage.turnID && $0.shownID == passage.documentID }),
              let y = lineY(in: view, character: passage.character, document: document) else { return nil }
        return y - scroll.contentView.bounds.minY
    }

    private func lineY(in view: ProseTextView, character: Int, document: NSView) -> CGFloat? {
        guard character < view.string.utf16.count, let layout = view.layoutManager, let container = view.textContainer else { return nil }
        layout.ensureLayout(for: container)
        let glyph = layout.glyphIndexForCharacter(at: character)
        let line = layout.lineFragmentUsedRect(forGlyphAt: glyph, effectiveRange: nil)
            .offsetBy(dx: view.textContainerOrigin.x, dy: view.textContainerOrigin.y)
        return view.convert(line, to: document).minY
    }

    private var scrollView: NSScrollView? {
        var current = hosts.allObjects.first(where: { $0.window != nil })?.superview
        var outer: NSScrollView?
        while let view = current {
            if let scroll = view as? NSScrollView, scroll.hasVerticalScroller { outer = scroll }
            current = view.superview
        }
        return outer
    }
}

private struct ConversationReadingPositionKey: EnvironmentKey { static let defaultValue: ConversationReadingPosition? = nil }
extension EnvironmentValues {
    var conversationReadingPosition: ConversationReadingPosition? {
        get { self[ConversationReadingPositionKey.self] }
        set { self[ConversationReadingPositionKey.self] = newValue }
    }
}
