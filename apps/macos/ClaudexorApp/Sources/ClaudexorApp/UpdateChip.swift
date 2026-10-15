import ClaudexorKit
import SwiftUI

/// The bottom-left update chip (M7 / D-2). When the signature-VERIFIED CHECK
/// reports a runnable `.available` closure, the chip offers a one-click in-place
/// **Install** (download → verify → unpack → probe → idle-gate → stop → atomic
/// swap → relaunch → handshake → rollback) with honest per-phase progress, plus
/// a "View release" escape hatch for a manual download. While installing it
/// shows the live RuntimeInstallPhase status and a spinner. An attempt
/// keeps its historical outcome above any later Install and "View release"
/// actions. When there is no advertised update it renders
/// NOTHING except an honest status line for a finished install or the
/// app-update-required / failure / dev-build cases (never a fake "up to date").
struct UpdateChip: View {
    @Environment(AppModel.self) private var model
    @Environment(\.openURL) private var openURL

    /// The GitHub release page the chip links to for a manual download.
    /// `releases/latest` always resolves to the release whose runtime manifest
    /// the CHECK just read, so the linked page carries the advertised version.
    static let releaseURL = URL(
        string: "https://github.com/\(GitHubRuntimeReleaseTransport.repoSlug)/releases/latest")!

    /// Which state the chip shows, in priority order.
    enum Content: Equatable {
        case installing(String?)
        case reconciliationNotice(String)
        /// `outcome` is the last install attempt's status; a later check may
        /// offer another version without rewriting that historical result.
        case offer(UpdateAvailability, outcome: String?)
        case installOutcome(String)
        case checkStatus(String)
        case hidden
    }

    static func content(for model: AppModel) -> Content {
        if model.runtimeInstalling { return .installing(model.runtimeInstallStatus) }
        if let notice = model.localDaemonReconciliationNotice, !notice.isEmpty {
            return .reconciliationNotice(notice)
        }
        let outcome = model.runtimeInstallStatus.flatMap { $0.isEmpty ? nil : $0 }
        if let update = model.updateAvailability { return .offer(update, outcome: outcome) }
        if let outcome { return .installOutcome(outcome) }
        if let status = model.runtimeUpdateStatus, status != "Up to date" {
            return .checkStatus(status)
        }
        return .hidden
    }

    var body: some View {
        switch Self.content(for: model) {
        case let .installing(status):
            // Live install progress — honest per-phase text, no fake success.
            HStack(spacing: Theme.Spacing.xs) {
                ProgressView().controlSize(.mini)
                Text(status ?? "Updating…")
                    .font(.caption2).foregroundStyle(.secondary).lineLimit(2)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, Theme.Spacing.md)
            .padding(.vertical, Theme.Spacing.xs)
            .help(status ?? "Installing the engine update…")
        case let .reconciliationNotice(notice):
            // Closure coherence is a live safety state, so it stays visible even
            // when a cached update is also available. An active install remains
            // first because it currently owns the daemon lifecycle.
            HStack(spacing: Theme.Spacing.xs) {
                Image(systemName: "exclamationmark.circle")
                    .font(.caption2).foregroundStyle(Theme.status(.warn))
                Text(notice)
                    .font(.caption2).foregroundStyle(.secondary).lineLimit(2)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, Theme.Spacing.md)
            .padding(.vertical, Theme.Spacing.xs)
            .help(notice)
        case let .offer(update, outcome):
            VStack(alignment: .leading, spacing: 0) {
                // A failed, rolled-back or refused attempt stays readable above
                // the actions that retry it or download it manually.
                if let outcome { installOutcomeLine(outcome) }
                // A newer, signature-verified runtime exists (D-2): the primary
                // action installs it in place; "View release" stays as a manual
                // escape hatch; a trailing control re-checks.
                HStack(spacing: Theme.Spacing.xs) {
                    Image(systemName: "arrow.down.circle.fill")
                        .font(.caption).foregroundStyle(Theme.accent)
                    Text("Update available")
                        .font(.caption).foregroundStyle(.secondary)
                    Image(systemName: "arrow.right").font(.caption2).foregroundStyle(.tertiary)
                    Text("v\(update.version)")
                        .font(.caption.weight(.medium)).foregroundStyle(Theme.accent)
                        .monospacedDigit()
                    Spacer(minLength: 0)
                    Button("Install") { Task { await model.installRuntimeUpdate() } }
                        .buttonStyle(.borderedProminent)
                        .controlSize(.mini)
                        .help("Download, verify, and install engine v\(update.version) in place")
                    Button("View release") { openURL(update.url.flatMap(URL.init) ?? Self.releaseURL) }
                        .buttonStyle(.bordered)
                        .controlSize(.mini)
                        .help("Open the GitHub release to download the update manually")
                    Button {
                        Task { await model.checkForRuntimeUpdate() }
                    } label: {
                        Image(systemName: "arrow.clockwise").font(.caption2)
                    }
                    .buttonStyle(.plain)
                    .help("Re-check for updates")
                }
                .padding(.horizontal, Theme.Spacing.md)
                .padding(.vertical, Theme.Spacing.xs)
                .help("Update to v\(update.version) is available — install in place or download manually.")
            }
        case let .installOutcome(status):
            // An install outcome with no remaining offer (installed, including
            // recovery-only): quiet, verbatim line.
            installOutcomeLine(status)
        case let .checkStatus(status):
            // App-update-required / failure / unknown: a quiet, verbatim line.
            HStack(spacing: Theme.Spacing.xs) {
                Image(systemName: "exclamationmark.circle")
                    .font(.caption2).foregroundStyle(.tertiary)
                Text(status)
                    .font(.caption2).foregroundStyle(.secondary).lineLimit(2)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, Theme.Spacing.md)
            .padding(.vertical, Theme.Spacing.xs)
            .help(status)
        case .hidden:
            EmptyView()
        }
    }

    /// The last install attempt's verbatim outcome: two lines, full text on hover.
    private func installOutcomeLine(_ status: String) -> some View {
        HStack(spacing: Theme.Spacing.xs) {
            Image(systemName: "info.circle")
                .font(.caption2).foregroundStyle(.tertiary)
            Text(status).font(.caption2).foregroundStyle(.secondary).lineLimit(2)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, Theme.Spacing.md)
        .padding(.vertical, Theme.Spacing.xs)
        .help(status)
    }
}
