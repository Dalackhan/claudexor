import SwiftUI
import ClaudexorKit

/// Settings › Harnesses: install a vendor CLI on a connected SSH host
/// (issue #89). The confirmation dialog shows the remote runtime's own
/// `harness install --dry-run --json` disclosure — exact command, install
/// destination, and selected version — and the installer itself runs in the
/// visible embedded terminal, where the user watches it like interactive
/// SSH auth. The host's runtime selects the exact version: a current runtime
/// resolves Codex's npm latest before confirmation and installs that exact
/// approved version; an older runtime offers its fixed release version. The
/// disclosure distinguishes release-verified
/// versions from deterministic targets without recorded verification fixtures;
/// the script vendors (Antigravity and Cursor) have their installer
/// downloaded in full and executed under the user's eyes because they
/// cannot be pinned. Every vendor NAME here comes from `HarnessFamily.label`
/// — never `id.capitalized`, which renders Antigravity as "Agy".
struct RemoteHarnessInstallSection: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        @Bindable var model = model
        if !model.remoteConnections.isEmpty {
            VStack(alignment: .leading, spacing: Theme.Spacing.md) {
                SectionLabel("Remote Harness Install", systemImage: "arrow.down.circle")
                Text(
                    "Puts a vendor CLI on an SSH host. The host's Claudexor runtime selects the exact version shown for confirmation: a current runtime resolves Codex's npm latest, which is not automatically release-verified; an older runtime offers its fixed release version. Claude, OpenCode and GitHub Copilot use exact version targets. The disclosure shows whether the selected version is covered by recorded verification fixtures. Antigravity and Cursor use unpinned installer scripts, downloaded in full and run in the embedded terminal where you watch them. Nothing is installed before you confirm the exact command, and confirmation uses that same runtime.")
                    .font(.caption).foregroundStyle(.secondary)
                ForEach(model.remoteConnections) { connection in
                    HStack {
                        Text(connection.displayName)
                        Spacer()
                        Menu("Install…") {
                            ForEach(installableRemoteHarnesses, id: \.self) {
                                harness in
                                Button(HarnessFamily(rawValue: harness).label) {
                                    Task {
                                        await model.startRemoteHarnessInstall(
                                            connectionID: connection.id, harness: harness)
                                    }
                                }
                            }
                        }
                        .frame(maxWidth: 140)
                        .help(
                            "Fetches the exact install command from \(connection.displayName) and asks for confirmation before anything is installed.")
                    }
                    if let message = model.remoteConnectionMessages[connection.id] {
                        // Unclipped and selectable: a refusal's remedy comes last.
                        Text(message).font(.caption2).foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                            .textSelection(.enabled)
                    }
                }
            }
            .padding(Theme.Spacing.lg)
            .background(
                Theme.surfaceRaised,
                in: RoundedRectangle(cornerRadius: Theme.Radius.control, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: Theme.Radius.control, style: .continuous)
                    .stroke(Theme.separator, lineWidth: 1))
            .confirmationDialog(
                "Install \(model.remoteHarnessInstallPrompt.map { HarnessFamily(rawValue: $0.harness).label } ?? "harness")?",
                isPresented: Binding(
                    get: { model.remoteHarnessInstallPrompt != nil },
                    set: { presented in
                        guard !presented, let prompt = model.remoteHarnessInstallPrompt else {
                            return
                        }
                        model.dismissRemoteHarnessInstallPrompt(prompt)
                    })
            ) {
                Button("Run installer") {
                    guard let prompt = model.remoteHarnessInstallPrompt,
                          model.acceptRemoteHarnessInstallPrompt(prompt)
                    else { return }
                    Task { await model.confirmRemoteHarnessInstall(prompt) }
                }
                Button("Cancel", role: .cancel) {
                    guard let prompt = model.remoteHarnessInstallPrompt else { return }
                    model.dismissRemoteHarnessInstallPrompt(prompt)
                }
            } message: {
                if let prompt = model.remoteHarnessInstallPrompt {
                    Text(Self.disclosureText(prompt, model: model))
                }
            }
        }
    }

    static func disclosureText(
        _ prompt: RemoteHarnessInstallPrompt, model: AppModel
    ) -> String {
        let host = model.remoteConnections
            .first(where: { $0.id == prompt.connectionID })?.displayName ?? "the remote host"
        // The vendor's own product name. The unpinnable branch used to say
        // "Cursor" outright, which named the wrong vendor the moment a second
        // script installer (Antigravity) reached it — in the most
        // security-sensitive dialog in the app.
        let vendor = HarnessFamily(rawValue: prompt.harness).label
        let pin: String
        switch prompt.verification {
        case .releaseVerified:
            pin = "Selected version: \(prompt.pinnedVersion!) "
                + "(exact; the version this release was verified against; "
                + "npm verifies its registry integrity checksum)"
        case .deterministicOnly:
            pin = "Selected version: \(prompt.pinnedVersion!) "
                + "(exact deterministic install target; not covered by recorded "
                + "verification fixtures; npm verifies its registry integrity checksum)"
        case .humanObserved:
            pin = "No version pin: \(vendor) ships no pinnable npm artifact; the vendor script "
                + "is downloaded in full, its size and SHA-256 print, and it runs in the "
                + "embedded terminal where you watch it"
        }
        return """
        Command: \(prompt.command)
        Install location: \(prompt.installLocation)
        \(pin)

        Runs on \(host) in the embedded terminal. Claudexor runs Harness Doctor afterward.
        """
    }
}
