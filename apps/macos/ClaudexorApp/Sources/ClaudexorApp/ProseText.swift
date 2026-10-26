import AppKit
import SwiftUI

/// One measuring stack, with precisely the same TextKit 1 geometry as the displayed host.
/// Width is keyed by its exact floating-point bits: rounding can clip a final line.
@MainActor final class ProseMeasurer {
    static let shared = ProseMeasurer()
    private let storage = NSTextStorage()
    private let layout = NSLayoutManager()
    private let container = NSTextContainer(size: .zero)
    private let cache = NSCache<NSString, NSValue>()
    private(set) var layoutCount = 0

    init() {
        container.lineFragmentPadding = 0
        container.widthTracksTextView = false
        layout.addTextContainer(container)
        storage.addLayoutManager(layout)
        cache.countLimit = 50_000
    }

    func size(_ document: ProseDocument, width: CGFloat) -> CGSize {
        precondition(width.isFinite && width > 0)
        let key = "\(document.id):\(document.style.generation):\(Double(width).bitPattern)" as NSString
        if let hit = cache.object(forKey: key) { return hit.sizeValue }
        storage.setAttributedString(document.text)
        container.containerSize = CGSize(width: width, height: CGFloat.greatestFiniteMagnitude)
        layout.ensureLayout(for: container)
        let rect = layout.usedRect(for: container)
        let value = CGSize(width: min(width, ceil(rect.maxX)), height: max(1, ceil(rect.maxY)))
        cache.setObject(NSValue(size: value), forKey: key)
        layoutCount += 1
        return value
    }

    func height(_ document: ProseDocument, width: CGFloat) -> CGFloat { size(document, width: width).height }
}

struct ProseText: NSViewRepresentable {
    let document: ProseDocument
    var hugs = false
    var cap: CGFloat = Theme.Layout.conversationMaxWidth
    var accessibilityName = "Message text"
    var onSelectionChange: ((Bool) -> Void)?
    var onFocusChange: ((Bool) -> Void)?
    @Environment(\.proseLinkGate) private var linkGate
    @Environment(\.proseMessageID) private var messageID
    @Environment(ConversationPresentation.self) private var presentation: ConversationPresentation?

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeNSView(context: Context) -> ProseTextView {
        let view = ProseTextView.make()
        view.delegate = context.coordinator
        updateNSView(view, context: context)
        return view
    }

    func updateNSView(_ view: ProseTextView, context: Context) {
        context.coordinator.gate = linkGate
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
        guard view.shownID != document.id else { return }
        view.textStorage?.setAttributedString(document.text)
        view.shownID = document.id
    }

    func sizeThatFits(_ proposal: ProposedViewSize, nsView: ProseTextView, context: Context) -> CGSize? {
        let proposed = proposal.width.flatMap { $0.isFinite && $0 > 0 ? $0 : nil }
        var width = min(proposed ?? cap, cap)
        if hugs { width = max(1, ProseMeasurer.shared.size(document, width: width).width) }
        // Only the cache mutates. No SwiftUI state writes or asynchronous height feedback.
        return CGSize(width: width, height: ProseMeasurer.shared.height(document, width: width))
    }

    static func dismantleNSView(_ view: ProseTextView, coordinator: Coordinator) {
        view.delegate = nil
        view.focusChanged = nil
        view.textStorage?.setAttributedString(NSAttributedString(string: ""))
        view.shownID = nil
    }

    @MainActor final class Coordinator: NSObject, NSTextViewDelegate {
        var gate: ProseLinkGate?
        var selectionChanged: ((Bool) -> Void)?

        func textView(_ textView: NSTextView, clickedOnLink link: Any, at charIndex: Int) -> Bool {
            if let url = link as? URL ?? (link as? String).flatMap(URL.init(string:)) { gate?.handle(url) }
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
        return pasteboard.setString((string as NSString).substring(with: range), forType: .string) || richWritten
    }

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
        }
        // Owner fork Q4: printable keys are swallowed until the composer is clicked.
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

/// The alternative fence deliberately starts a new native selection region.
struct ScrollingCodeProse: View {
    let document: ProseDocument
    var body: some View {
        let size = ProseMeasurer.shared.size(document, width: 100_000)
        ScrollView(.horizontal) {
            ProseText(document: document, cap: max(1, size.width), accessibilityName: "Code block")
                .frame(width: max(1, size.width))
                .padding(Theme.Spacing.md)
        }
        .codeSurface(Theme.Radius.control)
    }
}
