import AppKit
import ClaudexorKit
import SwiftUI
import Testing
@testable import ClaudexorApp

/// Active native selection for pictures only; this window is never ordered.
private final class HistoryCaptureWindow: NSWindow {
    var captureActiveSelection = false
    override var isKeyWindow: Bool { captureActiveSelection || super.isKeyWindow }
    override var canBecomeKey: Bool { true }
}

/// Explicit opt-in: a prohibited application and never-ordered borderless windows.
/// No client, saved state, credentials, daemon, or provider actions.
@MainActor @Suite(.serialized)
struct HistoryMockupRenderingTests {
    @Test(.enabled(if: ProcessInfo.processInfo.environment["CX_HISTORY_MOCKUP"] == "1"))
    func tailTextFocusKeepsJumpHiddenAndClearingResumesFollowing() async throws {
        let app = NSApplication.shared
        let policy = app.activationPolicy()
        app.setActivationPolicy(.prohibited)
        defer { app.setActivationPolicy(policy) }
        let source = try HistoryTestSource(count: 1)
        let model = HistoryMockupFixtures.model(detail: source.detail, runs: source.runs, source: source)
        let state = ConversationFeedState()
        let history = try #require(model.selectedHistory)
        let (host, window) = makeWindow(ThreadsScreen(feedState: state).environment(model), width: 1100, appearance: .aqua)
        defer { window.close() }
        await settle(host)
        let scroll = try #require(feedScroll(host))
        #expect(state.atBottom && history.following)
        let promptY = try proseY(host, prefix: "Checkpoint 1:")
        let viewportY = scroll.contentView.convert(scroll.contentView.bounds, to: host).minY
        #expect(abs(promptY - viewportY - Theme.Spacing.lg - 8) <= 1)
        print("WHOLE THREAD: prompt=\(promptY) viewport=\(viewportY)")
        history.presentation.focusedMessages.insert("mock-turn-0")
        history.presentation.selectedMessages.insert("mock-turn-0")
        await settle(host)
        #expect(scroll.contentInsets.bottom == 0)
        history.presentation.focusedMessages.removeAll()
        history.presentation.selectedMessages.removeAll()
        await settle(host)
        #expect(history.following && history.readingAnchor == nil)
    }

    @Test(.enabled(if: ProcessInfo.processInfo.environment["CX_HISTORY_MOCKUP"] == "1"))
    func renderHistoryMockups() async throws {
        let app = NSApplication.shared
        let oldPolicy = app.activationPolicy()
        let oldAppearance = app.appearance
        app.setActivationPolicy(.prohibited)
        defer { app.setActivationPolicy(oldPolicy); app.appearance = oldAppearance }
        let output = try #require(ProcessInfo.processInfo.environment["CX_HISTORY_MOCKUP_OUTPUT"])
        let directory = URL(fileURLWithPath: output, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        var manifest: [[String: Any]] = []
        let (regularDetail, regularRuns) = try HistoryMockupFixtures.make()
        let (shortDetail, shortRuns) = try HistoryMockupFixtures.make(count: 21, short: true)
        let scenes = ["01-tail-bottom", "02-tail-top", "03-reading-new", "04-older-bottom",
                      "05-before-earlier", "05b-twenty-one-line-before", "06-beginning",
                      "07-loading", "07b-loading-earlier", "08-load-failed", "08b-earlier-failed",
                      "12-running-tail", "14-plan-draft"]
        for (appearance, name, scheme) in [(NSAppearance.Name.aqua, "light", ColorScheme.light),
                                           (.darkAqua, "dark", .dark)] {
            app.appearance = NSAppearance(named: appearance)
            try await checkInset(appearance: appearance)
            await checkTablePreview(appearance: appearance)
            for scene in scenes {
                let short = scene.hasPrefix("05b")
                let detail = short ? shortDetail : regularDetail
                var runs = short ? shortRuns : regularRuns
                if scene == "12-running-tail" {
                    runs[runs.count - 1].phase = .running
                    runs[runs.count - 1].isLive = true
                    runs[runs.count - 1].answerText = nil
                }
                if scene == "14-plan-draft" { HistoryMockupFixtures.plan(&runs[runs.count - 1]) }
                let source = HistoryTestSource(detail: detail, runs: runs)
                let model = HistoryMockupFixtures.model(detail: detail, runs: runs, source: source)
                let state = ConversationFeedState()
                let history = model.selectedHistory!
                state.synchronize(history)
                if scene == "04-older-bottom" {
                    await history.earlier(retaining: 5)
                    state.synchronize(history)
                    state.viewport = .reading(anchor: state.mountedIDs.last)
                }
                if scene == "06-beginning" {
                    await history.earlier(retaining: 1)
                    await history.earlier(retaining: 1)
                    state.synchronize(history)
                    state.viewport = .reading(anchor: state.mountedIDs.first)
                }
                if scene == "07-loading" || scene == "08-load-failed" { model.selectedHistory = nil }
                if scene == "08-load-failed" { model.threadStatus = "Could not load thread: the saved history is temporarily unavailable." }
                if scene == "07b-loading-earlier" { history.earlierState = .loading }
                if scene == "08b-earlier-failed" { history.earlierState = .failed }
                if scene == "14-plan-draft" {
                    state.presentation.planText["mock-run-44"] = ["code": "Wrap long source lines and keep copying exact."]
                    state.presentation.expanded["prompt:mock-turn-44"] = false
                }
                if scene == "12-running-tail" {
                    model.ensureLiveBox("mock-run-44").transcript.apply(BusEnvelope(seq: 1, kind: "harness.event",
                        event: .object(["type": .string("harness.event"), "payload": .object([
                            "type": .string("message"), "text": .string("Checking the exact-width cache and preparing the next saved-history window.\n\n" + HistoryMockupFixtures.selectionAnswer)
                        ])])))
                }
                let root = ThreadsScreen(feedState: state)
                    .environment(model).tint(Theme.accent)
                    // Never-ordered hosts need explicit AppKit semantic label
                    // colors; their default SwiftUI foreground stays light-mode.
                    .foregroundStyle(Color(nsColor: .labelColor), Color(nsColor: .secondaryLabelColor), Color(nsColor: .tertiaryLabelColor))
                    .preferredColorScheme(scheme)
                    .environment(\.colorScheme, scheme)
                    .environment(\.locale, Locale(identifier: "en_US_POSIX"))
                    .background(Theme.surfaceBase)
                let (host, window) = makeWindow(root, width: 1100, appearance: appearance)
                await settle(host)
                if scene == "02-tail-top" || scene == "06-beginning" || scene.contains("earlier") || short {
                    state.navigate(to: ConversationFeedState.topID, anchor: .top)
                    state.viewport = .reading(anchor: state.mountedIDs.first)
                }
                if short {
                    state.navigate(to: state.mountedIDs.first!, anchor: .top)
                }
                if scene == "03-reading-new" {
                    state.navigate(to: "mock-turn-42", anchor: .top)
                    state.viewport = .reading(anchor: "mock-turn-42")
                    await settle(host)
                    let (arrived, arrivedRuns) = try HistoryMockupFixtures.make(count: 46)
                    model.liveTasks = arrivedRuns
                    source.detail = arrived; source.runs = arrivedRuns
                    await history.refresh()
                }
                await settle(host)
                if scene == "02-tail-top" {
                    try await checkManualReading(host, state: state, history: history)
                }
                manifest.append(try capture(host, window: window, scene: scene, name: name,
                    directory: directory, claim: claim(scene), state: state))
                if scene == "05-before-earlier" || short {
                    let anchor = state.mountedIDs.first!
                    let oldIDs = state.mountedIDs
                    let prefix = String(detail.turns.first(where: { $0.id == anchor })!.prompt.prefix(60))
                    let beforeY = try proseY(host, prefix: prefix)
                    await history.earlier(retaining: short ? 8 : 2)
                    state.navigate(history)
                    await settle(host)
                    #expect(state.mountedIDs.count <= 20 && state.mountedIDs.contains(anchor))
                    #expect(state.mountedIDs != oldIDs)
                    let afterY = try proseY(host, prefix: prefix)
                    if short { #expect(abs(afterY - beforeY) <= 1) }
                    else { #expect(beforeY > afterY && abs(afterY - 8) <= 1) }
                    let after = short ? "05b-twenty-one-line-after" : "05-after-earlier"
                    let pairClaim = "The previous first prompt is at y = \(beforeY) pt before revealing earlier turns and y = \(afterY) pt after; the window remains bounded to 20 turns."
                    manifest[manifest.count - 1]["claim"] = short ? pairClaim : "Show earlier turns is visible above turn 26. " + pairClaim
                    manifest[manifest.count - 1]["anchor_y_before"] = beforeY
                    manifest[manifest.count - 1]["anchor_y_after"] = afterY
                    var captured = try capture(host, window: window, scene: after, name: name,
                        directory: directory, claim: pairClaim, state: state)
                    captured["anchor_y_before"] = beforeY
                    captured["anchor_y_after"] = afterY
                    manifest.append(captured)
                }
                window.close()
            }
            let compactState = ConversationFeedState()
            let compactHistory = try HistoryTestSource(detail: regularDetail, runs: regularRuns).store(loaded: true)
            compactState.synchronize(compactHistory)
            let compact = HistoryClampSurface(state: compactState, history: compactHistory)
                .environment(\.colorScheme, scheme).environment(\.locale, Locale(identifier: "en_US_POSIX"))
            let (compactHost, compactWindow) = makeWindow(compact, width: 1100, appearance: appearance)
            await settle(compactHost)
            for after in [false, true] {
                if after { await compactHistory.earlier(retaining: 20); await settle(compactHost) }
                let scroll = try #require(views(compactHost).compactMap { $0 as? NSScrollView }.first)
                #expect((scroll.documentView?.frame.height ?? 0) <= scroll.contentView.bounds.height)
                manifest.append(try capture(compactHost, window: compactWindow,
                    scene: after ? "05b-clamp-after" : "05b-clamp-before", name: name, directory: directory,
                    claim: "With twenty one-line prose rows fitting on screen, earlier travel clamps to the declared top edge; it cannot place the previous first row flush at the top.", state: compactState))
            }
            compactWindow.close()
            for width: CGFloat in [680, 420] {
                for code in [CodeFencePresentation.wrap, .scroll] {
                    for selected in [false, true] {
                        let kind = code == .wrap ? "16a" : "16b"
                        let scene = "\(kind)-code-\(code.rawValue)-\(Int(width))-\(selected ? "selected" : "plain")"
                        let root = HistoryComparisonSurface(kind: kind, width: width)
                            .environment(\.conversationTextOptions, ConversationTextOptions(code: code))
                            .environment(\.colorScheme, scheme)
                            .environment(\.locale, Locale(identifier: "en_US_POSIX"))
                        let (host, window) = makeWindow(root, width: width == 420 ? 476 : 1100, appearance: appearance)
                        await settle(host)
                        if selected { selectProse(host, window: window, starting: "The saved conversation") }
                        manifest.append(try capture(host, window: window, scene: scene, name: name,
                            directory: directory, claim: code == .wrap
                            ? "At \(Int(width)) pt, a single native selection can cross the paragraph, list, wrapped source code and closing paragraph."
                            : "At \(Int(width)) pt, the separate horizontal code block stops the paragraph/list selection."))
                        window.close()
                    }
                }
                let scene = "16c-user-selection-\(Int(width))"
                let root = HistoryComparisonSurface(kind: "16c", width: width)
                    .environment(\.conversationTextOptions, ConversationTextOptions(prompt: .full))
                    .environment(\.colorScheme, scheme).environment(\.locale, Locale(identifier: "en_US_POSIX"))
                let (host, window) = makeWindow(root, width: width == 420 ? 452 : 1100, appearance: appearance)
                await settle(host)
                selectProse(host, window: window, starting: "Turn 45", maxLength: 900)
                manifest.append(try capture(host, window: window, scene: scene, name: name, directory: directory,
                    claim: "Native user-message selection remains legible over the tinted prompt bubble at \(Int(width)) pt."))
                window.close()
            }
            for (scene, options) in [
                ("17a-table-selectable-cells", ConversationTextOptions(table: .selectableCells)),
                ("17b-table-copy-table", ConversationTextOptions(table: .copyTable)),
                ("18a-long-prompt-collapsed", ConversationTextOptions(prompt: .collapse)),
                ("18b-long-prompt-full", ConversationTextOptions(prompt: .full))
            ] {
                let root = HistoryComparisonSurface(kind: String(scene.prefix(3)), width: 680)
                    .environment(\.conversationTextOptions, options)
                    .environment(\.colorScheme, scheme).environment(\.locale, Locale(identifier: "en_US_POSIX"))
                let (host, window) = makeWindow(root, width: 1100, appearance: appearance)
                await settle(host)
                manifest.append(try capture(host, window: window, scene: scene, name: name, directory: directory,
                    claim: claim(scene)))
                window.close()
            }
        }
        let value: [String: Any] = ["capture": "NSHostingView.cacheDisplay", "window_shown": false,
            "activation_policy": "prohibited", "locale": "en_US_POSIX", "turn_count": 45,
            "prompt_characters": 8_000, "code_line_characters": HistoryMockupFixtures.longCodeLine.count,
            "engine_paging": false, "scenes": manifest]
        try JSONSerialization.data(withJSONObject: value, options: [.prettyPrinted, .sortedKeys])
            .write(to: directory.appendingPathComponent("manifest.json"))
        #expect(manifest.count == 62)
    }

    private func makeWindow<V: View>(_ root: V, width: CGFloat, appearance: NSAppearance.Name) -> (NSHostingView<V>, NSWindow) {
        let host = NSHostingView(rootView: root)
        let rect = NSRect(x: 0, y: 0, width: width, height: 700)
        let window = HistoryCaptureWindow(contentRect: rect, styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = host
        window.appearance = NSAppearance(named: appearance)
        host.appearance = window.appearance
        host.frame = rect
        return (host, window)
    }

    private func checkInset(appearance: NSAppearance.Name) async throws {
        let state = HistoryInsetCaptureState()
        let (host, window) = makeWindow(HistoryInsetCaptureSurface(state: state), width: 1100, appearance: appearance)
        defer { window.close() }
        await settle(host)
        state.position.scrollTo(y: 400)
        await settle(host)
        let scroll = try #require(feedScroll(host))
        #expect((scroll.documentView?.frame.height ?? 0) > scroll.contentView.bounds.height)
        #expect(scroll.contentView.bounds.minY > 0)
        let before = try proseY(host, prefix: "Checkpoint 2:")
        for show in [true, false, true, false] {
            state.show = show
            await settle(host)
            let y = try proseY(host, prefix: "Checkpoint 2:")
            // Native insets update even when SwiftUI does not emit an
            // onScrollGeometryChange callback for an inset-only change.
            let inset = scroll.contentInsets.bottom
            #expect(abs(y - before) <= 1)
            #expect(abs(inset - (show ? state.buttonHeight + 8 : 0)) <= 1)
            print("INSET \(appearance.rawValue): visible=\(show) inset=\(inset) button=\(state.buttonHeight) anchor=\(before)->\(y)")
        }
    }

    private func checkTablePreview(appearance: NSAppearance.Name) async {
        func height(_ mode: TablePresentation, limit: CGFloat? = nil) async -> CGFloat {
            let root = MarkdownOutputView(tablePresentation: mode, markdown: HistoryMockupFixtures.table,
                bodyFont: .body, previewHeight: limit).frame(width: 680).fixedSize(horizontal: false, vertical: true)
            let (host, window) = makeWindow(root, width: 680, appearance: appearance)
            defer { window.close() }
            await settle(host)
            return host.fittingSize.height
        }
        let full = await height(.selectableCells)
        let copy = await height(.copyTable)
        let control = copy - full
        let preview = await height(.copyTable, limit: 260)
        let grid = await height(.selectableCells, limit: 260 - control)
        #expect(control > 0 && control < 30)
        #expect(preview <= 260 && preview > 230)
        #expect(abs(preview - grid - control) <= 1)
        print("PREVIEW \(appearance.rawValue): copy control=\(control) grid=\(grid) total=\(preview)")
    }

    private func checkManualReading(_ host: NSView, state: ConversationFeedState,
                                    history: ThreadHistoryStore) async throws {
        let scroll = try #require(feedScroll(host))
        let document = try #require(scroll.documentView)
        #expect(abs(scroll.contentInsets.bottom - 39) <= 1)
        let origin = scroll.contentView.bounds.origin
        let row = history.rows[3]
        let next = history.rows[4]
        let key = "prompt:" + row.id
        let expansion = history.presentation.expanded[key]
        func promptFrame(_ prompt: String) throws -> CGRect {
            let prose = try #require(views(host).compactMap { $0 as? ProseTextView }
                .first { $0.string.hasPrefix(String(prompt.prefix(60))) })
            return prose.convert(prose.bounds, to: document)
        }
        func check(_ y: CGFloat, label: String) async {
            scroll.contentView.scroll(to: CGPoint(x: origin.x, y: y))
            scroll.reflectScrolledClipView(scroll.contentView)
            await settle(host)
            #expect(abs(scroll.contentView.bounds.minY - y) <= 1)
            #expect(!history.following)
            #expect(state.visibleTurnID == row.id)
            #expect(history.readingAnchor == row.id)
            print("READING \(host.effectiveAppearance.name.rawValue) \(label): expected=\(row.id) visible=\(state.visibleTurnID ?? "nil") anchor=\(history.readingAnchor ?? "nil")")
        }
        // Native frames are a test oracle only; production observes no row geometry.
        await check(try promptFrame(row.prompt).midY, label: "inside prompt")
        await check(try promptFrame(next.prompt).minY - 80, label: "partial first card")
        history.presentation.expanded[key] = true
        await settle(host)
        let expanded = try promptFrame(row.prompt)
        #expect(expanded.height > 2 * scroll.contentView.bounds.height)
        await check(expanded.midY, label: "taller than viewport")
        history.presentation.expanded[key] = expansion
        await settle(host)
        scroll.contentView.scroll(to: origin)
        scroll.reflectScrolledClipView(scroll.contentView)
        await settle(host)
        #expect(state.visibleTurnID == history.mountedIDs.first)
    }

    private func settle(_ host: NSView) async {
        for _ in 0..<5 {
            host.effectiveAppearance.performAsCurrentDrawingAppearance { host.layoutSubtreeIfNeeded() }
            try? await Task.sleep(for: .milliseconds(60))
            host.displayIfNeeded()
        }
    }

    private func views(_ root: NSView) -> [NSView] { [root] + root.subviews.flatMap(views) }

    private func feedScroll(_ host: NSView) -> NSScrollView? {
        var ancestor = views(host).first { $0 is ProseTextView }?.superview
        while let view = ancestor {
            if let scroll = view as? NSScrollView, scroll.hasVerticalScroller { return scroll }
            ancestor = view.superview
        }
        return nil
    }

    private func proseY(_ host: NSView, prefix: String) throws -> CGFloat {
        let view = try #require(views(host).compactMap { $0 as? ProseTextView }.first { $0.string.hasPrefix(prefix) })
        return view.convert(view.bounds, to: host).minY
    }

    private func selectProse(_ host: NSView, window: NSWindow, starting: String, maxLength: Int? = nil) {
        guard let view = views(host).compactMap({ $0 as? ProseTextView }).first(where: { $0.string.contains(starting) }) else {
            Issue.record("No native prose view for selection: \(starting)")
            return
        }
        let start = (view.string as NSString).range(of: starting).location
        let length = min(maxLength ?? view.string.utf16.count, view.string.utf16.count - start)
        (window as? HistoryCaptureWindow)?.captureActiveSelection = true
        window.makeFirstResponder(view)
        view.setSelectedRange(NSRange(location: start, length: length))
        view.needsDisplay = true
    }

    private func capture(_ host: NSView, window: NSWindow, scene: String, name: String, directory: URL,
                         claim: String, state: ConversationFeedState? = nil) throws -> [String: Any] {
        #expect(!window.isVisible)
        #expect((state?.mountedIDs.count ?? 0) <= 20)
        host.layoutSubtreeIfNeeded()
        let bitmap = try #require(host.bitmapImageRepForCachingDisplay(in: host.bounds))
        window.appearance?.performAsCurrentDrawingAppearance { host.cacheDisplay(in: host.bounds, to: bitmap) }
        let filename = "\(scene)-\(name).png"
        try #require(bitmap.representation(using: .png, properties: [:]))
            .write(to: directory.appendingPathComponent(filename))
        let all = views(host)
        let prose = all.compactMap { $0 as? ProseTextView }
        let residuals = all.filter { String(describing: type(of: $0)).contains("SelectionTextField") }.count
        if scene == "17a-table-selectable-cells" { #expect(residuals == 39) }
        if scene == "17b-table-copy-table" { #expect(residuals == 0) }
        let selected = prose.filter { $0.selectedRange().length > 0 }
        if !selected.isEmpty { #expect(window.isKeyWindow && selected.contains { window.firstResponder === $0 }) }
        let labels = all.compactMap { $0.accessibilityLabel() }
        let visibleProse = prose.compactMap { view -> [String: Any]? in
            let rect = view.convert(view.bounds, to: host)
            guard rect.intersects(host.bounds) else { return nil }
            return ["prefix": String(view.string.prefix(100)), "y": rect.minY, "height": rect.height]
        }
        print("MOCKUP \(filename): mounted=\(state?.mountedIDs.count ?? 0), prose=\(prose.count)")
        return ["file": filename, "scene": scene, "appearance": name,
            "size": ["width": host.bounds.width, "height": host.bounds.height],
            "pixel_size": ["width": bitmap.pixelsWide, "height": bitmap.pixelsHigh], "claim": claim,
            "mounted_turn_ids": state?.mountedIDs ?? [], "new_count": state?.newCount ?? 0,
            "bottom_content_inset": state == nil ? 0 : feedScroll(host)?.contentInsets.bottom ?? 0,
            "floating_control_height": max(0, (feedScroll(host)?.contentInsets.bottom ?? 0) - 8),
            "native_prose_views": prose.count, "visible_prose": visibleProse,
            "residual_selection_fields": residuals,
            "selected_ranges": selected.map { ["location": $0.selectedRange().location, "length": $0.selectedRange().length] },
            "native_accessibility_labels": labels,
            "active_selection": !selected.isEmpty && window.isKeyWindow,
            "window_shown": window.isVisible]
    }

    private func claim(_ scene: String) -> String {
        switch scene {
        case "01-tail-bottom": "Opening the real screen lands on the latest answer with the persistent composer below."
        case "02-tail-top": "Show earlier turns is the first in-feed control above the mounted tail."
        case "03-reading-new": "A delivered arrival preserves the reading window and shows one floating Jump to latest with 1 new."
        case "04-older-bottom": "An older slice ends with Show later turns and one inline Jump to latest."
        case "05-before-earlier": "The first mounted turn is at the top before revealing earlier turns."
        case "05b-twenty-one-line-before": "Only 20 of 21 short turns mount, so earlier navigation must account for the viewport clamp."
        case "06-beginning": "The known beginning of in-memory saved history is stated explicitly."
        case "07-loading": "A selected thread awaiting detail shows Loading saved history, with a continue composer."
        case "07b-loading-earlier": "Loading earlier turns stays on the in-feed control above the existing passage."
        case "08-load-failed": "A failed load offers Retry loading messages and keeps the failure visible."
        case "08b-earlier-failed": "A failed earlier read retains the current slice and exposes its retry."
        case "12-running-tail": "The live tail shows the running receipt and transcript with Stop in the composer."
        case "14-plan-draft": "The real plan card displays a prefilled answer draft inside its bounded question scroller."
        case "17a-table-selectable-cells": "The existing bounded table grid retains native per-cell selection."
        case "17b-table-copy-table": "The same table has non-selectable cells and one Copy table action."
        case "18a-long-prompt-collapsed": "An 8,000-character prompt begins collapsed with an explicit Show more action."
        default: "An 8,000-character prompt remains fully available in the scrolling conversation."
        }
    }
}
