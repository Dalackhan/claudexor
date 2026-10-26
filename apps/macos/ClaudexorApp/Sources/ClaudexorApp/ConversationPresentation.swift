import SwiftUI

/// Presentation choices outlive a mounted row. Owned by one thread/location feed.
@MainActor @Observable final class ConversationPresentation {
    var expanded: [String: Bool] = [:]
    var transcripts: [String: Bool] = [:]
    var planText: [String: [String: String]] = [:]
    var planSelections: [String: [String: Set<String>]] = [:]
    var selectedMessages: Set<String> = []
    var focusedMessages: Set<String> = []
    var latestTurnID: String?

    func receiveLatest(_ id: String?) {
        // Arrival must not silently collapse a formerly newest message while it
        // is selected or being read. Persist its previous default presentation.
        if let previous = latestTurnID, previous != id {
            for key in ["prompt:" + previous, "answer:" + previous] where expanded[key] == nil {
                expanded[key] = true
            }
        }
        latestTurnID = id
    }

    func expansion(_ key: String, default value: Bool = false) -> Binding<Bool> {
        Binding(get: { self.expanded[key] ?? value }, set: { self.expanded[key] = $0 })
    }
}

struct PromptBubble: View {
    let prompt: String
    let turnID: String
    var presentation: PromptPresentation? = nil
    @Environment(\.conversationTextOptions) private var options
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(ConversationPresentation.self) private var store: ConversationPresentation?
    @State private var locallyExpanded = false

    private var expansion: Binding<Bool> {
        store?.expansion("prompt:" + turnID, default: store?.latestTurnID == turnID) ?? $locallyExpanded
    }

    var body: some View {
        let mode = presentation ?? options.prompt
        let long = TurnCard.isLongAnswer(prompt)
        let collapsed = mode == .collapse && long && !expansion.wrappedValue
        let bounded = Self.preview(prompt)
        let text = collapsed ? String(bounded.prefix(1_200)) : bounded
        VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
            ProseText(document: ProseBuilder.plain(text, style: .make(body: true, size: dynamicTypeSize)),
                hugs: !long, accessibilityName: "User message",
                onSelectionChange: { selected in
                    if selected { store?.selectedMessages.insert(turnID) }
                    else { store?.selectedMessages.remove(turnID) }
                }, onFocusChange: { focused in
                    if focused { store?.focusedMessages.insert(turnID) }
                    else { store?.focusedMessages.remove(turnID) }
                })
                .frame(maxHeight: collapsed ? 260 : nil, alignment: .top).clipped()
            if mode == .collapse && long {
                Button(expansion.wrappedValue ? "Show less" : "Show more") { expansion.wrappedValue.toggle() }
                    .buttonStyle(.borderless).font(.caption).foregroundStyle(Theme.accent)
                    .help(expansion.wrappedValue ? "Show only the start of this message." : "Show the rest of this message.")
                    .accessibilityLabel(expansion.wrappedValue ? "Show less of user message" : "Show more of user message")
            }
            if bounded.utf8.count < prompt.utf8.count {
                Text("Prompt preview — the first 32 KiB are shown.").font(.caption).foregroundStyle(.secondary)
                Button("Copy full prompt") {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(prompt, forType: .string)
                }.buttonStyle(.borderless).help("Copy the complete original prompt, including text beyond this preview.")
                    .accessibilityLabel("Copy full prompt")
            }
        }
        .padding(.horizontal, Theme.Spacing.md).padding(.vertical, Theme.Spacing.sm)
        .bubbleFill(tint: Theme.bubbleUser, radius: Theme.Radius.bubble)
        .padding(.leading, Theme.Spacing.xxl + Theme.Spacing.lg)
        .frame(maxWidth: .infinity, alignment: .trailing)
    }

    static func preview(_ source: String) -> String {
        guard source.utf8.count > 32 * 1024 else { return source }
        var bytes = 0
        return String(source.prefix { character in
            bytes += character.utf8.count
            return bytes <= 32 * 1024
        })
    }
}
