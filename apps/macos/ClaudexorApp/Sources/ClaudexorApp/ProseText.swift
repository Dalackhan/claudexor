import AppKit
import SwiftUI

/// One measuring stack, with precisely the same TextKit 1 geometry as the displayed host.
/// Width is keyed by its exact floating-point bits: rounding can clip a final line.
@MainActor final class ProseMeasurer {
    static let shared = ProseMeasurer()
    private let storage = NSTextStorage()
    private let layout = NSLayoutManager()
    private let container = NSTextContainer(size: .zero)
    private final class Measurement {
        let size: CGSize
        let lines: [CGRect]
        init(size: CGSize, lines: [CGRect]) { self.size = size; self.lines = lines }
    }
    private let cache = NSCache<NSString, Measurement>()
    private(set) var layoutCount = 0

    init() {
        container.lineFragmentPadding = 0
        container.widthTracksTextView = false
        layout.addTextContainer(container)
        storage.addLayoutManager(layout)
        cache.countLimit = 50_000
        cache.totalCostLimit = 16 * 1024 * 1024
    }

    private func measure(_ document: ProseDocument, width: CGFloat) -> Measurement {
        precondition(width.isFinite && width > 0)
        let key = "\(document.id):\(document.style.generation):\(Double(width).bitPattern)" as NSString
        if let hit = cache.object(forKey: key) { return hit }
        storage.setAttributedString(document.text)
        container.containerSize = CGSize(width: width, height: CGFloat.greatestFiniteMagnitude)
        layout.ensureLayout(for: container)
        let rect = layout.usedRect(for: container)
        let value = CGSize(width: min(width, ceil(rect.maxX)), height: max(1, ceil(rect.maxY)))
        var lines: [CGRect] = []
        layout.enumerateLineFragments(forGlyphRange: layout.glyphRange(for: container)) { _, used, _, _, _ in
            lines.append(used)
        }
        let measured = Measurement(size: value, lines: lines)
        cache.setObject(measured, forKey: key, cost: lines.count * MemoryLayout<CGRect>.stride + 64)
        layoutCount += 1
        return measured
    }

    func size(_ document: ProseDocument, width: CGFloat) -> CGSize { measure(document, width: width).size }
    func height(_ document: ProseDocument, width: CGFloat) -> CGFloat { size(document, width: width).height }
    func lines(_ document: ProseDocument, width: CGFloat) -> [CGRect] { measure(document, width: width).lines }
    func wholeLineHeight(_ document: ProseDocument, width: CGFloat, limit: CGFloat) -> CGFloat {
        let measured = measure(document, width: width)
        guard measured.size.height > limit else { return measured.size.height }
        return measured.lines.filter { ceil($0.maxY) <= limit }.last.map { ceil($0.maxY) } ?? 0
    }
}

struct ProseText: NSViewRepresentable {
    let document: ProseDocument
    var hugs = false
    var cap: CGFloat = Theme.Layout.conversationMaxWidth
    var heightLimit: CGFloat? = nil
    var accessibilityName = "Message text"
    var onSelectionChange: ((Bool) -> Void)?
    var onFocusChange: ((Bool) -> Void)?
    @Environment(\.proseLinkGate) private var linkGate
    @Environment(\.proseMessageID) private var messageID
    @Environment(\.conversationComposerInput) private var composerInput
    @Environment(\.proseMessageSource) private var messageSource
    @Environment(\.proseMessageCopyAction) private var copyMessageAction
    @Environment(\.conversationReadingPosition) private var readingPosition
    @Environment(ConversationPresentation.self) private var presentation: ConversationPresentation?

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeNSView(context: Context) -> ProseTextView {
        let view = ProseTextView.make()
        view.delegate = context.coordinator
        updateNSView(view, context: context)
        return view
    }

    func updateNSView(_ view: ProseTextView, context: Context) {
        let replacing = view.shownID != document.id || view.messageID != messageID
        if replacing {
            // Notify the old document's owners before installing new callbacks.
            context.coordinator.selectionChanged?(false)
            view.focusChanged?(false)
        }
        context.coordinator.gate = linkGate
        view.composerInput = composerInput
        view.messageID = messageID
        view.messageSource = messageSource
        view.copyMessageAction = copyMessageAction
        if view.readingPosition !== readingPosition {
            view.readingPosition?.unregister(view)
            view.readingPosition = readingPosition
            readingPosition?.register(view)
        }
        context.coordinator.selectionChanged = { selected in
            onSelectionChange?(selected)
            guard let messageID else { return }
            let key = messageID + ":" + document.id
            if selected { presentation?.selectedMessages.insert(key) }
            else { presentation?.selectedMessages.remove(key) }
        }
        view.focusChanged = { focused in
            onFocusChange?(focused)
            guard let messageID else { return }
            let key = messageID + ":" + document.id
            if focused { presentation?.focusedMessages.insert(key) }
            else { presentation?.focusedMessages.remove(key) }
        }
        view.setAccessibilityLabel(accessibilityName)
        // The content identity, not the cache object's address, owns replacement.
        if view.shownID != document.id {
            view.cancelCopyFeedback()
            view.textStorage?.setAttributedString(document.text)
            view.shownID = document.id
        }
        if replacing {
            context.coordinator.selectionChanged?(view.selectedRange().length > 0)
            view.focusChanged?(view.window?.firstResponder === view)
        }
    }

    func sizeThatFits(_ proposal: ProposedViewSize, nsView: ProseTextView, context: Context) -> CGSize? {
        let proposed = proposal.width.flatMap { $0.isFinite && $0 > 0 ? $0 : nil }
        var width = min(proposed ?? cap, cap)
        if hugs { width = max(1, ProseMeasurer.shared.size(document, width: width).width) }
        // Only the cache mutates. No SwiftUI state writes or asynchronous height feedback.
        let height = heightLimit.map { ProseMeasurer.shared.wholeLineHeight(document, width: width, limit: $0) }
            ?? ProseMeasurer.shared.height(document, width: width)
        return CGSize(width: width, height: height)
    }

    static func dismantleNSView(_ view: ProseTextView, coordinator: Coordinator) {
        view.cancelCopyFeedback()
        view.readingPosition?.unregister(view)
        coordinator.selectionChanged?(false)
        view.focusChanged?(false)
        coordinator.selectionChanged = nil
        view.delegate = nil
        view.focusChanged = nil
        view.textStorage?.setAttributedString(NSAttributedString(string: ""))
        view.shownID = nil
    }

    @MainActor final class Coordinator: NSObject, NSTextViewDelegate {
        var gate: ProseLinkGate?
        var selectionChanged: ((Bool) -> Void)?

        func textView(_ textView: NSTextView, clickedOnLink link: Any, at charIndex: Int) -> Bool {
            if let url = link as? URL ?? (link as? String).flatMap(URL.init(string:)) {
                if url.scheme == "claudexor-code-copy" {
                    (textView as? ProseTextView)?.copyCode(link: url, at: charIndex)
                } else { gate?.handle(url) }
            }
            return true // Never let AppKit's default file URL opener bypass the scope gate.
        }

        func textViewDidChangeSelection(_ notification: Notification) {
            guard let view = notification.object as? NSTextView else { return }
            selectionChanged?(view.selectedRange().length > 0)
        }
    }
}

private struct ProseMessageIDKey: EnvironmentKey {
    static let defaultValue: String? = nil
}

extension EnvironmentValues {
    var proseMessageID: String? {
        get { self[ProseMessageIDKey.self] }
        set { self[ProseMessageIDKey.self] = newValue }
    }
}

final class ProseTextView: NSTextView {
    var shownID: String?
    var messageID: String?
    weak var composerInput: ConversationComposerInput?
    weak var readingPosition: ConversationReadingPosition?
    var messageSource: String?
    var copyMessageAction: (@MainActor () -> Void)?
    var writeCopiedText: (String) -> Bool = { ProseCodeActions.write($0) }
    var copyFeedback: [URL: Task<Void, Never>] = [:]
    var focusChanged: ((Bool) -> Void)?
    override var canBecomeKeyView: Bool { false }

    static func make() -> ProseTextView {
        let storage = NSTextStorage()
        let layout = NSLayoutManager()
        let container = NSTextContainer(size: CGSize(width: 680, height: CGFloat.greatestFiniteMagnitude))
        storage.addLayoutManager(layout)
        layout.addTextContainer(container)
        container.lineFragmentPadding = 0
        container.widthTracksTextView = true
        let view = ProseTextView(frame: .zero, textContainer: container)
        view.isEditable = false
        view.isSelectable = true
        view.isRichText = true
        view.importsGraphics = false
        view.drawsBackground = false
        view.textContainerInset = .zero
        view.isVerticallyResizable = false
        view.isHorizontallyResizable = false
        view.autoresizingMask = []
        view.allowsUndo = false
        view.usesFindBar = false
        view.usesFontPanel = false
        view.isAutomaticLinkDetectionEnabled = false
        view.isAutomaticDataDetectionEnabled = false
        view.isContinuousSpellCheckingEnabled = false
        view.writingToolsBehavior = .none
        view.linkTextAttributes = [.foregroundColor: NSColor(Theme.accent), .cursor: NSCursor.pointingHand]
        return view
    }

    override func becomeFirstResponder() -> Bool {
        let accepted = super.becomeFirstResponder()
        if accepted { focusChanged?(true) }
        return accepted
    }

    override func resignFirstResponder() -> Bool {
        let accepted = super.resignFirstResponder()
        if accepted { focusChanged?(false) }
        return accepted
    }

    override func writeSelection(to pasteboard: NSPasteboard, types: [NSPasteboard.PasteboardType]) -> Bool {
        let range = selectedRange()
        guard range.length > 0, NSMaxRange(range) <= (string as NSString).length else { return false }
        // Preserve native rich export, but make plain text an explicit source
        // projection. Text-block formatting and soft wraps must never alter it.
        let richTypes = types.filter { $0 != .string }
        let richWritten = !richTypes.isEmpty && super.writeSelection(to: pasteboard, types: richTypes)
        guard types.contains(.string) else { return richWritten }
        pasteboard.addTypes([.string], owner: nil)
        guard let textStorage else { return richWritten }
        return pasteboard.setString(ProseCodeActions.plainText(textStorage, range: range), forType: .string) || richWritten
    }

    override func menu(for event: NSEvent) -> NSMenu? {
        let menu = super.menu(for: event) ?? NSMenu()
        if messageSource != nil {
            let item = NSMenuItem(title: "Copy message", action: #selector(copyMessage(_:)), keyEquivalent: "")
            item.target = self
            item.toolTip = "Copy this message's Markdown source."
            menu.addItem(.separator())
            menu.addItem(item)
        }
        return menu
    }

    override func accessibilityChildren() -> [Any]? { (super.accessibilityChildren() ?? []) + codeAccessibilityActions() }

    override func scrollWheel(with event: NSEvent) {
        if abs(event.scrollingDeltaY) >= abs(event.scrollingDeltaX), let feed = verticalScrollView {
            feed.scrollWheel(with: event)
        } else { nextResponder?.scrollWheel(with: event) }
    }

    override func keyDown(with event: NSEvent) {
        let arrow = [123, 124, 125, 126].contains(event.keyCode)
        if event.modifierFlags.contains(.command)
            || (arrow && (event.modifierFlags.contains(.shift) || selectedRange().length > 0)) {
            super.keyDown(with: event)
        } else if [49, 115, 116, 119, 121].contains(event.keyCode) || arrow {
            verticalScrollView?.keyDown(with: event)
        } else if !event.modifierFlags.contains(.control),
                  let characters = event.characters, !characters.isEmpty,
                  characters.unicodeScalars.allSatisfy({ !CharacterSet.controlCharacters.contains($0) && !(0xF700...0xF8FF).contains($0.value) }) {
            composerInput?.forward(event, from: self)
        }
    }

    private var verticalScrollView: NSScrollView? {
        var ancestor = superview
        while let view = ancestor {
            if let scroll = view as? NSScrollView, scroll.hasVerticalScroller { return scroll }
            ancestor = view.superview
        }
        return nil
    }
}
