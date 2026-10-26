import AppKit
import SwiftUI
import Testing
@testable import ClaudexorApp

@MainActor @Suite(.serialized)
struct ProseTextTests {
    private func document(_ source: String, code: CodeFencePresentation = .wrap) throws -> ProseDocument {
        let segments = ProseBuilder.segments(source, style: .init(), code: code)
        return try #require(segments.compactMap { segment in
            if case .prose(let value) = segment.content { return value }
            return nil
        }.first)
    }

    @Test func wrappedCodeStaysInOneSelectionAndCopiesExactSourceLines() throws {
        let source = HistoryMockupFixtures.selectionAnswer
        let segments = ProseBuilder.segments(source, style: .init(), code: .wrap)
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

    @Test func scrollCodeAndTablesSplitOnlyAtTheirBoundaries() {
        let segments = ProseBuilder.segments(HistoryMockupFixtures.selectionAnswer, style: .init(), code: .scroll)
        #expect(segments.count == 3)
        if case .code = segments[1].content {} else { Issue.record("Fence must be a separate selection region") }
        let table = ProseBuilder.segments("Before\n\n| A | B |\n|---|---|\n| x | y |\n\nAfter", style: .init(), code: .wrap)
        #expect(table.count == 3)
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

    @Test func historyWindowIsAnchoredBoundedAndIgnoresArrivalsWhileReading() throws {
        let (detail, _) = try HistoryMockupFixtures.make(count: 45, short: true)
        let state = ConversationFeedState()
        state.install(detail.turns)
        let anchor = try #require(state.mountedIDs.first)
        state.earlier(detail.turns, retaining: 8)
        #expect(state.mountedIDs.count == 20 && state.mountedIDs.contains(anchor))
        let ids = state.mountedIDs
        let (appended, _) = try HistoryMockupFixtures.make(count: 46, short: true)
        state.receive(appended.turns)
        #expect(state.mountedIDs == ids && state.newCount == 1)
        #expect(state.presentation.expanded["prompt:mock-turn-44"] == true)
        #expect(state.presentation.expanded["answer:mock-turn-44"] == true)
        state.presentation.planText["plan"] = ["question": "Keep this draft"]
        state.latest(appended.turns)
        #expect(state.mountedIDs.count == 20 && state.mountedIDs.last == "mock-turn-45")
        #expect(state.follows && state.newCount == 0)
        #expect(state.presentation.planText["plan"]?["question"] == "Keep this draft")
        state.geometry(bottom: false, tailMounted: true)
        #expect(!state.follows)
        state.geometry(bottom: true, tailMounted: true)
        #expect(state.follows)
    }
}
