import AppKit
import SwiftUI
import Testing
import ClaudexorKit
@testable import ClaudexorApp

/// Suites that move AppKit first responders run one at a time. SwiftUI text
/// fields share one field editor in the process, so focusing a field in one
/// test window ends editing in another test's window.
@Suite(.serialized) struct KeyboardFocusTests {}

extension KeyboardFocusTests {
@MainActor @Suite(.serialized)
struct ConversationNativeRoutingTests {
    @Test(arguments: [0, 8, 14]) func firstKeyPreservesExistingComposerDraftAndInsertionPoint(cursor: Int) async throws {
        let policy = NSApplication.shared.activationPolicy()
        NSApplication.shared.setActivationPolicy(.prohibited)
        defer { NSApplication.shared.setActivationPolicy(policy) }
        let source = try HistoryTestSource(count: 1)
        let model = HistoryMockupFixtures.model(detail: source.detail, runs: source.runs, source: source)
        let (host, window) = window(ThreadsScreen().environment(model))
        defer { window.close() }
        await settle(host)
        let message = try #require(views(host).compactMap { $0 as? ProseTextView }.first)
        let composer = try #require(views(host).compactMap { $0 as? NSTextField }.first { $0.isEditable })
        #expect(window.makeFirstResponder(composer))
        let editor = try #require(composer.currentEditor() as? NSTextView)
        editor.insertText("existing draft", replacementRange: NSRange(location: NSNotFound, length: 0))
        editor.setSelectedRange(NSRange(location: cursor, length: 0))
        await settle(host)
        #expect(composer.stringValue == "existing draft")
        #expect(window.makeFirstResponder(message))
        message.setSelectedRange(NSRange(location: 0, length: 0))
        #expect(composer.stringValue == "existing draft")
        window.sendEvent(try key("x", code: 7, window: window))
        await settle(host)
        print("FIRST KEY EXISTING DRAFT: \(composer.stringValue.debugDescription), responder=\(String(describing: window.firstResponder))")
        let expected = ("existing draft" as NSString).replacingCharacters(in: NSRange(location: cursor, length: 0), with: "x")
        #expect(composer.stringValue == expected)
        #expect(window.firstResponder === composer.currentEditor())
    }

    @Test(arguments: [false, true])
    func nativeTabDispatchLeavesMessageForAnEditableField(backward: Bool) async throws {
        let policy = NSApplication.shared.activationPolicy()
        NSApplication.shared.setActivationPolicy(.prohibited)
        defer { NSApplication.shared.setActivationPolicy(policy) }
        let root = NSView(frame: NSRect(x: 0, y: 0, width: 500, height: 300))
        let message = ProseTextView.make()
        message.frame = NSRect(x: 0, y: 80, width: 400, height: 200)
        message.string = "A selectable message"
        let before = NSTextField(frame: NSRect(x: 0, y: 0, width: 200, height: 30))
        let after = NSTextField(frame: NSRect(x: 0, y: 40, width: 200, height: 30))
        for view in [before, message, after] as [NSView] { root.addSubview(view) }
        let (_, window) = window(EmptyView())
        defer { window.close() }
        window.contentView = root
        window.autorecalculatesKeyViewLoop = false
        let native = NSTextView(frame: message.frame)
        native.string = message.string
        native.isEditable = false
        native.isSelectable = true
        root.addSubview(native)
        before.nextKeyView = native
        native.nextKeyView = after
        after.nextKeyView = before
        #expect(window.makeFirstResponder(native))
        window.sendEvent(try key(backward ? "\u{19}" : "\t", code: 48,
            modifiers: backward ? .shift : [], window: window))
        print("NATIVE TAB backward=\(backward), responder=\(String(describing: window.firstResponder))")
        #expect(window.firstResponder !== native)
        #expect((backward ? before : after).currentEditor() != nil)
        native.removeFromSuperview()
        before.nextKeyView = message
        message.nextKeyView = after
        after.nextKeyView = before
        #expect(window.makeFirstResponder(message))
        window.sendEvent(try key(backward ? "\u{19}" : "\t", code: 48,
            modifiers: backward ? .shift : [], window: window))
        print("TAB backward=\(backward), responder=\(String(describing: window.firstResponder))")
        #expect(window.firstResponder !== message)
        #expect((backward ? before : after).currentEditor() != nil)
    }

    @Test(arguments: [false, true])
    func tabDispatchInActualThreadsScreenKeepsTheNativeExit(backward: Bool) async throws {
        let policy = NSApplication.shared.activationPolicy()
        NSApplication.shared.setActivationPolicy(.prohibited)
        defer { NSApplication.shared.setActivationPolicy(policy) }
        let source = try HistoryTestSource(count: 1)
        let model = HistoryMockupFixtures.model(detail: source.detail, runs: source.runs, source: source)
        let (host, window) = window(ThreadsScreen().environment(model))
        defer { window.close() }
        await settle(host)
        let message = try #require(views(host).compactMap { $0 as? ProseTextView }.first)
        #expect(window.makeFirstResponder(message))
        window.sendEvent(try key(backward ? "\u{19}" : "\t", code: 48,
            modifiers: backward ? .shift : [], window: window))
        #expect(window.firstResponder !== message)
        // The native key-view route really has a destination in this same screen.
        if backward { window.selectPreviousKeyView(message) }
        else { window.selectNextKeyView(message) }
        #expect(window.firstResponder !== message)
    }

    @Test func truncatedPromptContextMenuReadsFullSourceOnlyWhenClicked() async throws {
        let policy = NSApplication.shared.activationPolicy()
        NSApplication.shared.setActivationPolicy(.prohibited)
        defer { NSApplication.shared.setActivationPolicy(policy) }
        let facts = try JSONDecoder().decode(ThreadHistoryTextFacts.self, from: Data(#"{"truncated":true,"totalTextBytes":65536,"textBytes":15}"#.utf8))
        var reads = 0
        let (host, window) = window(PromptBubble(prompt: "Bounded preview", turnID: "t", promptInfo: facts, fullPrompt: {
            reads += 1
            throw CocoaError(.fileReadNoSuchFile)
        }))
        defer { window.close() }
        await settle(host)
        let view = try #require(views(host).compactMap { $0 as? ProseTextView }.first)
        #expect(reads == 0)
        let event = try #require(NSEvent.mouseEvent(with: .rightMouseDown, location: .zero,
            modifierFlags: [], timestamp: 0, windowNumber: window.windowNumber, context: nil,
            eventNumber: 0, clickCount: 1, pressure: 1))
        let menu = try #require(view.menu(for: event))
        let item = try #require(menu.items.first { $0.title == "Copy message" })
        menu.update()
        #expect(item.isEnabled)
        #expect(reads == 0)
        #expect(NSApp.sendAction(try #require(item.action), to: item.target, from: item))
        await settle(host)
        #expect(reads == 1)
        #expect(view.string == "Bounded preview")
    }

    @Test(arguments: ["gesture", "navigation", "following"])
    func pendingPassageRestoreYieldsToNewerIntent(intent: String) async throws {
        let policy = NSApplication.shared.activationPolicy()
        NSApplication.shared.setActivationPolicy(.prohibited)
        defer { NSApplication.shared.setActivationPolicy(policy) }
        let source = try HistoryTestSource(count: 3)
        source.runs[1].answerText = (0..<40).map { "Passage \($0): " + HistoryMockupFixtures.paragraph($0) }.joined(separator: "\n\n")
        let model = HistoryMockupFixtures.model(detail: source.detail, runs: source.runs, source: source)
        let history = try #require(model.selectedHistory)
        history.presentation.expanded["answer:mock-turn-1"] = true
        let state = ConversationFeedState()
        let (host, window) = window(ConversationFeed(state: state, history: history, routingOptions: .init()).environment(model), width: 680)
        host.sizingOptions = []
        defer { window.close() }
        await settle(host, count: 10)
        let prose = try #require(views(host).compactMap { $0 as? ProseTextView }.first { $0.string.hasPrefix("Passage 0:") })
        let layout = try #require(prose.layoutManager)
        let container = try #require(prose.textContainer)
        layout.ensureLayout(for: container)
        let range = (prose.string as NSString).range(of: "Passage 20:")
        let line = layout.lineFragmentUsedRect(forGlyphAt: layout.glyphIndexForCharacter(at: range.location), effectiveRange: nil)
        var ancestor = prose.superview
        var scroll: NSScrollView?
        while let view = ancestor {
            if let candidate = view as? NSScrollView, candidate.hasVerticalScroller { scroll = candidate }
            ancestor = view.superview
        }
        let feed = try #require(scroll)
        let document = try #require(feed.documentView)
        state.viewport = .reading(anchor: "mock-turn-1")
        state.navigate(toY: prose.convert(line, to: document).minY + 4)
        await settle(host, count: 10)
        #expect(state.readingPosition.passage != nil)
        window.setContentSize(NSSize(width: 420, height: 700))
        host.setFrameSize(NSSize(width: 420, height: 700))
        await settle(host, count: 1)
        #expect(state.readingPosition.isResizing)
        if intent == "gesture" {
            state.readingPosition.gestureBegan() // production scroll-phase receiver
            feed.contentView.scroll(to: NSPoint(x: 0, y: 800))
            feed.reflectScrolledClipView(feed.contentView)
        } else if intent == "navigation" {
            state.navigate(toY: 800)
        } else { await history.jump() }
        await settle(host, count: 2)
        let revision = state.navigationRevision
        await settle(host, count: 10)
        #expect(state.navigationRevision == revision)
        #expect(!state.readingPosition.isResizing)
        if intent == "following" {
            print("FINAL \(intent) bottom=\(state.atBottom) follows=\(state.follows) y=\(feed.contentView.bounds.minY)")
            #expect(state.atBottom && history.following && state.follows)
        } else { #expect(abs(feed.contentView.bounds.minY - 800) <= 1) }
        #expect(!window.isVisible)
    }

    @Test(arguments: [false, true]) func focusingTheTailThenResizingKeepsItsVisiblePassage(captureOnFocus: Bool) async throws {
        let policy = NSApplication.shared.activationPolicy()
        NSApplication.shared.setActivationPolicy(.prohibited)
        defer { NSApplication.shared.setActivationPolicy(policy) }
        let source = try HistoryTestSource(count: 3)
        source.runs[2].answerText = (0..<40).map { "Tail passage \($0): " + HistoryMockupFixtures.paragraph($0) }.joined(separator: "\n\n")
        let model = HistoryMockupFixtures.model(detail: source.detail, runs: source.runs, source: source)
        let history = try #require(model.selectedHistory)
        let state = ConversationFeedState()
        let (host, window) = window(ConversationFeed(state: state, history: history, routingOptions: .init()).environment(model), width: 680)
        host.sizingOptions = []
        defer { window.close() }
        await settle(host, count: 10)
        await settle(host) { state.follows && state.atBottom }
        #expect(state.follows && state.atBottom)
        let prose = try #require(views(host).compactMap { $0 as? ProseTextView }.first { $0.string.hasPrefix("Tail passage 0:") })
        var ancestor = prose.superview
        var scroll: NSScrollView?
        while let view = ancestor {
            if let candidate = view as? NSScrollView, candidate.hasVerticalScroller { scroll = candidate }
            ancestor = view.superview
        }
        let feed = try #require(scroll)
        let document = try #require(feed.documentView)
        let layout = try #require(prose.layoutManager)
        let container = try #require(prose.textContainer)
        layout.ensureLayout(for: container)
        let point = prose.convert(NSPoint(x: 0, y: feed.contentView.bounds.minY), from: document)
        let glyph = layout.glyphIndex(for: NSPoint(x: 0, y: max(0, point.y - prose.textContainerOrigin.y)), in: container)
        let character = layout.characterIndexForGlyph(at: glyph)
        let line = layout.lineFragmentUsedRect(forGlyphAt: glyph, effectiveRange: nil)
        let before = prose.convert(line, to: document).minY - feed.contentView.bounds.minY
        #expect(window.makeFirstResponder(prose))
        prose.setSelectedRange(NSRange(location: character, length: 6))
        await settle(host)
        #expect(!state.follows && !history.following)
        if captureOnFocus { state.readingPosition.captureAfterSettling() }
        await settle(host)
        print("FOCUSED TAIL before character=\(character) offset=\(before) passage=\(String(describing: state.readingPosition.passage))")
        window.setContentSize(NSSize(width: 420, height: 700))
        host.setFrameSize(NSSize(width: 420, height: 700))
        await settle(host, count: 10)
        layout.ensureLayout(for: container)
        let afterLine = layout.lineFragmentUsedRect(forGlyphAt: layout.glyphIndexForCharacter(at: character), effectiveRange: nil)
        let after = prose.convert(afterLine, to: document).minY - feed.contentView.bounds.minY
        print("FOCUSED TAIL after offset=\(after), difference=\(after-before)")
        #expect(abs(after - before) <= line.height)
    }

    private func window<V: View>(_ root: V, width: CGFloat = 1100) -> (NSHostingView<V>, NSWindow) {
        let host = NSHostingView(rootView: root)
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: width, height: 700),
            styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = host
        host.frame = window.frame
        return (host, window)
    }
    private func views(_ view: NSView) -> [NSView] { [view] + view.subviews.flatMap(views) }
    private func settle(_ host: NSView, count: Int = 4) async {
        for _ in 0..<count { host.layoutSubtreeIfNeeded(); try? await Task.sleep(for: .milliseconds(60)) }
    }
    // Parallel suites keep the main actor busy, so the first layout passes can arrive late.
    private func settle(_ host: NSView, until ready: () -> Bool) async {
        for _ in 0..<50 where !ready() { await settle(host, count: 1) }
    }
    private func key(_ text: String, code: UInt16, modifiers: NSEvent.ModifierFlags = [], window: NSWindow) throws -> NSEvent {
        try #require(NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: modifiers,
            timestamp: 0, windowNumber: window.windowNumber, context: nil, characters: text,
            charactersIgnoringModifiers: text, isARepeat: false, keyCode: code))
    }
}

}
