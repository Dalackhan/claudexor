import SwiftUI

/// One non-lazy history page. Callers must bound the mounted turn collection
/// with ConversationHistoryWindow; all stored turns remain untouched.
///
/// On macOS 26.5, reopening a long selectable history can send LazyVStack's
/// geometry estimation into an AttributeGraph layout/allocation feedback loop.
/// Keep the actual production container shared with the live rendering check.
struct ConversationHistoryStack<Content: View>: View {
    private let content: Content

    init(@ViewBuilder content: () -> Content) {
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            content
        }
        .padding(Theme.Spacing.lg)
        // Selectable prose opts back in at the individual text nodes.
        .textSelection(.disabled)
    }
}
