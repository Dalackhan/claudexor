import AppKit
import SwiftUI
import Testing
@testable import ClaudexorApp

extension KeyboardFocusTests {
@MainActor @Suite(.serialized)
struct ProseTextTests {
    private func document(_ source: String) throws -> ProseDocument {
        let segments = ProseBuilder.segments(source, style: .init())
        return try #require(segments.compactMap { segment in
            if case .prose(let value) = segment.content { return value }
            return nil
        }.first)
    }

    @Test func wrappedCodeStaysInOneSelectionAndCopiesExactSourceLines() throws {
        let source = HistoryMockupFixtures.selectionAnswer
        let segments = ProseBuilder.segments(source, style: .init())
        #expect(segments.count == 1)
        let doc = try document(source)
        let text = ProseTextView.make()
        text.textStorage?.setAttributedString(doc.text)
        text.frame.size = CGSize(width: 420, height: ProseMeasurer.shared.height(doc, width: 420))
        let range = (text.string as NSString).range(of: HistoryMockupFixtures.code)
        #expect(range.location != NSNotFound)
        let app = NSApplication.shared
        let previousPolicy = app.activationPolicy()
        app.setActivationPolicy(.prohibited)
        let window = NSWindow(contentRect: text.frame, styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = text
        window.makeFirstResponder(text)
        defer { window.close(); app.setActivationPolicy(previousPolicy) }
        text.setSelectedRange(range)
        #expect(text.selectedRange() == range)
        let board = NSPasteboard.withUniqueName()
        defer { board.releaseGlobally() }
        board.declareTypes([.string], owner: nil)
        #expect(text.writeSelection(to: board, types: [.string]))
        #expect(board.string(forType: .string) == HistoryMockupFixtures.code)
        #expect(!text.string.contains("\u{2028}"))
        let p = try #require(doc.text.attribute(.paragraphStyle, at: range.location, effectiveRange: nil) as? NSParagraphStyle)
        #expect(p.headIndent > p.firstLineHeadIndent && p.textBlocks.count == 1)
    }

    @Test func tablesSplitProseAtTheirBoundaries() {
        let table = ProseBuilder.segments("Before\n\n| A | B |\n|---|---|\n| x | y |\n\nAfter", style: .init())
        #expect(table.count == 3)
    }

    @Test func wrappedCodeKeepsWordsWholeAndPreviewEndsOnALine() throws {
        let doc = try document(HistoryMockupFixtures.selectionAnswer)
        for width: CGFloat in [420, 680] {
            let view = ProseTextView.make()
            view.textStorage?.setAttributedString(doc.text)
            view.setFrameSize(CGSize(width: width, height: ProseMeasurer.shared.height(doc, width: width)))
            let manager = try #require(view.layoutManager)
            let container = try #require(view.textContainer)
            manager.ensureLayout(for: container)
            var lines: [NSRange] = []
            manager.enumerateLineFragments(forGlyphRange: manager.glyphRange(for: container)) { _, _, _, glyphs, _ in
                lines.append(manager.characterRange(forGlyphRange: glyphs, actualGlyphRange: nil))
            }
            for word in ["ConversationHistoryWindow", "verified"] {
                let range = (doc.text.string as NSString).range(of: word)
                #expect(lines.contains { NSIntersectionRange($0, range).length == range.length })
            }
            let prompt = ProseBuilder.plain(HistoryMockupFixtures.prompt(0))
            let clipped = ProseMeasurer.shared.wholeLineHeight(prompt, width: width, limit: 260)
            let rects = ProseMeasurer.shared.lines(prompt, width: width)
            #expect(clipped <= 260 && clipped > 230)
            #expect(rects.contains { ceil($0.maxY) == clipped })
            #expect(!rects.contains { $0.minY < clipped && ceil($0.maxY) > clipped })
        }
    }

    @Test func exactFractionalWidthsHaveSeparateCacheEntriesAndMatchDisplay() throws {
        let docs = try [document(HistoryMockupFixtures.selectionAnswer),
                        ProseBuilder.plain(HistoryMockupFixtures.prompt(0)),
                        ProseBuilder.plain(String(repeating: "путь/日本語/🙂/", count: 120))]
        let measurer = ProseMeasurer()
        for doc in docs {
            for width: CGFloat in [420, 420.125, 420.25, 680] {
                let before = measurer.layoutCount
                let height = measurer.height(doc, width: width)
                #expect(measurer.height(doc, width: width) == height)
                #expect(measurer.layoutCount == before + 1)
                let view = ProseTextView.make()
                view.textStorage?.setAttributedString(doc.text)
                view.setFrameSize(CGSize(width: width, height: height))
                let container = try #require(view.textContainer)
                let manager = try #require(view.layoutManager)
                manager.ensureLayout(for: container)
                #expect(ceil(manager.usedRect(for: container).maxY) == height)
            }
        }
    }

    @Test func identityFontsAndNativeHostContract() throws {
        let first = try document("**Strong**, *emphasis*, `code` and [a link](https://example.org).")
        let rebuilt = ProseDocument(identity: "plain:same", text: NSAttributedString(string: "same"), style: .init())
        let other = ProseDocument(identity: "plain:same", text: NSAttributedString(string: "same"), style: .init())
        #expect(rebuilt.id == other.id)
        let changed = ProseDocument(identity: "plain:same", text: other.text, style: .init(bodySize: 20))
        #expect(changed.id != other.id)
        let font = try #require(first.text.attribute(.font, at: 0, effectiveRange: nil) as? NSFont)
        #expect(NSFontManager.shared.traits(of: font).contains(.boldFontMask))
        let link = (first.text.string as NSString).range(of: "a link").location
        #expect(first.text.attribute(.link, at: link, effectiveRange: nil) as? URL == URL(string: "https://example.org"))
        let view = ProseTextView.make()
        #expect(view.textLayoutManager == nil && view.layoutManager != nil)
        #expect(!view.isEditable && view.isSelectable && !view.canBecomeKeyView)
        #expect(!view.drawsBackground && !view.isVerticallyResizable)
        #expect(view.textContainerInset == .zero && view.textContainer?.lineFragmentPadding == 0)
        #expect(view.textContainer?.widthTracksTextView == true)
    }

    @Test func nativeDelegateConsumesFileLinksBeforeAnySystemOpen() {
        var opened: [URL] = []
        var notices: [String] = []
        let model = AppModel(client: nil, requestNotificationAuthorization: false, loadPersistedState: false)
        let coordinator = ProseText.Coordinator()
        coordinator.gate = ProseLinkGate(model: model, roots: [], notice: { if let text = $0 { notices.append(text) } },
            openSystem: { opened.append($0) })
        let view = ProseTextView.make()
        #expect(coordinator.textView(view, clickedOnLink: URL(fileURLWithPath: "/outside-scope.txt"), at: 0))
        #expect(opened.isEmpty && notices.count == 1)
        #expect(coordinator.textView(view, clickedOnLink: URL(string: "https://example.org")!, at: 0))
        #expect(opened.count == 1)
    }

    @Test func promptPreviewHasNoEightThousandCharacterCutAndRespectsUTF8() {
        let prompt = HistoryMockupFixtures.prompt(0) + " preserved after character 8000"
        #expect(PromptBubble.preview(prompt) == prompt)
        let large = String(repeating: "🙂я", count: 10_000)
        let bounded = PromptBubble.preview(large)
        #expect(bounded.utf8.count <= 32 * 1024 && large.hasPrefix(bounded))
    }

    @Test func historyWindowIsAnchoredBoundedAndIgnoresArrivalsWhileReading() async throws {
        let source = try HistoryTestSource(count: 45)
        let history = try source.store()
        await history.open()
        let anchor = try #require(history.mountedIDs.first)
        await history.earlier(retaining: 8)
        #expect(history.mountedIDs.count == 20 && history.mountedIDs.contains(anchor))
        let ids = history.mountedIDs
        (source.detail, source.runs) = try HistoryMockupFixtures.make(count: 46, short: true)
        await history.refresh()
        #expect(history.mountedIDs == ids && history.newCount == 1)
        #expect(history.presentation.expanded["prompt:mock-turn-44"] == true)
        #expect(history.presentation.expanded["answer:mock-turn-44"] == true)
        history.presentation.planText["plan"] = ["question": "Keep this draft"]
        await history.jump()
        #expect(history.mountedIDs.count == 20 && history.mountedIDs.last == "mock-turn-45")
        #expect(history.following && history.newCount == 0)
        #expect(history.presentation.planText["plan"]?["question"] == "Keep this draft")
        let state = ConversationFeedState()
        // macOS 26.6 reports growth before the bottom anchor moves the offset.
        let rest = FeedEdge(offset: 400, content: 1_000, container: 600)
        let grown = FeedEdge(offset: 400, content: 1_300, container: 600)
        let anchored = FeedEdge(offset: 700, content: 1_300, container: 600)
        #expect(!state.geometry(grown, after: rest, tailMounted: true))
        #expect(state.follows && state.atBottom)
        #expect(!state.geometry(anchored, after: grown, tailMounted: true))
        #expect(!state.geometry(FeedEdge(offset: 700, content: 1_300, container: 560), after: anchored, tailMounted: true))
        #expect(state.follows && state.atBottom)
        // A 40pt move up hidden by 50pt of anchored growth in the same frame still leaves the tail.
        let masked = FeedEdge(offset: 710, content: 1_350, container: 600)
        #expect(state.geometry(masked, after: anchored, tailMounted: true))
        #expect(!state.follows && !state.atBottom)
        let tail = FeedEdge(offset: 750, content: 1_350, container: 600)
        #expect(state.geometry(tail, after: masked, tailMounted: true))
        #expect(state.follows)
        #expect(state.geometry(FeedEdge(offset: 700, content: 1_350, container: 600), after: tail, tailMounted: true))
        #expect(!state.follows)
        state.geometry(bottom: true, tailMounted: true)
        #expect(state.follows)
        state.geometry(bottom: false, tailMounted: true)
        #expect(!state.follows)
        state.geometry(bottom: true, tailMounted: true)
        #expect(state.follows)
        // Growth in consecutive frames: a sample carries the anchor for the previous one,
        // or the anchor lands two samples late.
        let chain = ConversationFeedState()
        let s0 = FeedEdge(offset: 400, content: 1_000, container: 600)
        let s1 = FeedEdge(offset: 400, content: 1_020, container: 600)
        let s2 = FeedEdge(offset: 420, content: 1_050, container: 600)
        let s3 = FeedEdge(offset: 420, content: 1_080, container: 600)
        let s4 = FeedEdge(offset: 480, content: 1_080, container: 600)
        #expect(!chain.geometry(s1, after: s0, tailMounted: true))
        #expect(!chain.geometry(s2, after: s1, tailMounted: true))
        #expect(!chain.geometry(s3, after: s2, tailMounted: true))
        #expect(!chain.geometry(s4, after: s3, tailMounted: true))
        #expect(chain.follows && chain.atBottom)
    }
}

}
