import AppKit
import SwiftUI

/// An explicit destination owned by this conversation, never the next editable
/// control in the window. Resolve its native field only on a printable key.
@MainActor final class ConversationComposerInput {
    weak var marker: NSView?
    var enabled = false

    func forward(_ event: NSEvent, from message: NSView) {
        guard enabled, let marker, let window = marker.window, message.window === window,
              !marker.isHiddenOrHasHiddenAncestor, let root = window.contentView,
              let field = field(under: marker, in: root), field.isEnabled, field.isEditable,
              !field.isHiddenOrHasHiddenAncestor, window.makeFirstResponder(field),
              let editor = field.currentEditor(), window.firstResponder === editor else { return }
        // Native insertion preserves the composer's selection, input method and
        // binding updates. The first key is delivered synchronously, exactly once.
        editor.keyDown(with: event)
    }

    private func field(under marker: NSView, in root: NSView) -> NSTextField? {
        // The marker is the text field's own background, before padding/chrome.
        // Hit-testing its centre resolves that native control, including SwiftUI
        // wrappers, without scanning for another editable field or moving focus.
        let centre = NSPoint(x: marker.bounds.midX, y: marker.bounds.midY)
        var hit = root.hitTest(marker.convert(centre, to: root.superview))
        while let view = hit {
            if let field = view as? NSTextField { return field }
            hit = view.superview
        }
        return nil
    }
}

struct ComposerInputRegistration: NSViewRepresentable {
    let input: ConversationComposerInput
    @Environment(\.isEnabled) private var enabled
    func makeNSView(context: Context) -> NSView { ComposerInputMarker() }
    func updateNSView(_ view: NSView, context: Context) { input.marker = view; input.enabled = enabled }
}

private final class ComposerInputMarker: NSView {
    override func hitTest(_ point: NSPoint) -> NSView? { nil }
}

private struct ConversationComposerInputKey: EnvironmentKey {
    static let defaultValue: ConversationComposerInput? = nil
}

extension EnvironmentValues {
    var conversationComposerInput: ConversationComposerInput? {
        get { self[ConversationComposerInputKey.self] }
        set { self[ConversationComposerInputKey.self] = newValue }
    }
}
