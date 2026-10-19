import ClaudexorKit
import Foundation

enum RemoteHarnessInstallVerification: String, Decodable, Equatable, Sendable {
    case releaseVerified = "release_verified"
    case deterministicOnly = "deterministic_only"
    case humanObserved = "human_observed"
}

/// How confirmation binds the disclosed npm version, as declared by the
/// remote CLI's dry-run. An older CLI omits it and rejects
/// `install --vendor-version`; its plain `--yes` installs exactly the fixed
/// version it disclosed. An unknown value is not decodable: no prompt.
enum RemoteHarnessInstallVersionBinding: String, Decodable, Equatable, Sendable {
    case vendorVersion = "vendor-version"
}

/// The CLI inside one immutable remote runtime closure (`versions/<id>`).
func remoteRuntimeCLI(_ runtimeTarget: String) -> String {
    "~/.claudexor/remote/" + SSHCommandFactory.posixQuote(runtimeTarget) + "/bin/claudexor"
}

/// A pending remote harness install, awaiting the user's confirmation. The
/// command/location/version fields are the remote CLI's own `--dry-run --json`
/// disclosure verbatim (issue #89). Confirmation runs the SAME runtime closure
/// that disclosed it, never the movable `current` pointer, and carries the
/// selected npm version back when that CLI declares the binding, so neither a
/// runtime switch nor a changed registry latest replaces what the user approved.
/// Script installers have no version to bind.
struct RemoteHarnessInstallPrompt: Identifiable, Equatable {
    let lease: RemoteActionLease
    let harness: String
    let runtimeTarget: String
    let command: String
    let installLocation: String
    let pinnedVersion: String?
    let verification: RemoteHarnessInstallVerification
    let versionBinding: RemoteHarnessInstallVersionBinding?

    var id: UUID { lease.token }
    var connectionID: UUID { lease.connectionID }

    var confirmedInstallCommand: String {
        var command = remoteRuntimeCLI(runtimeTarget) + " harness install "
            + SSHCommandFactory.posixQuote(harness)
        if versionBinding == .vendorVersion, let pinnedVersion {
            command += " --vendor-version " + SSHCommandFactory.posixQuote(pinnedVersion)
        }
        return command + " --yes"
    }
}

extension AppModel {
    /// A refused dry-run exits non-zero, so `execute` throws before its stdout
    /// JSON can be decoded; the CLI repeats the refusal on stderr for this path.
    nonisolated static func harnessInstallPreparationFailure(
        _ error: Error, harness: String
    ) -> String? {
        guard case let SSHConnectionError.commandFailed(detail) = error else { return nil }
        let vendor = HarnessFamily(rawValue: harness).label
        return detail.isEmpty
            ? "\(vendor) was not installed: the host reported no reason."
            : "\(vendor) was not installed: \(detail)"
    }

    /// The remote CLI's `--dry-run --json` answer is the ONLY source of the
    /// confirmation text. Strict: a non-disclosure payload (ok/dryRun false,
    /// harness mismatch, empty command) yields nil and therefore no install.
    nonisolated static func parseHarnessInstallDisclosure(
        _ data: Data,
        lease: RemoteActionLease,
        harness: String,
        runtimeTarget: String
    ) -> RemoteHarnessInstallPrompt? {
        struct Disclosure: Decodable {
            let ok: Bool
            let dryRun: Bool
            let harness: String
            let command: String
            let installLocation: String
            let pinnedVersion: String?
            let verification: RemoteHarnessInstallVerification
            let versionBinding: RemoteHarnessInstallVersionBinding?
        }
        guard let parsed = try? JSONDecoder().decode(Disclosure.self, from: data),
              parsed.ok, parsed.dryRun, parsed.harness == harness,
              !parsed.command.isEmpty
        else { return nil }
        switch parsed.verification {
        case .releaseVerified, .deterministicOnly:
            guard parsed.pinnedVersion?.trimmingCharacters(
                in: .whitespacesAndNewlines).isEmpty == false
            else { return nil }
        case .humanObserved:
            // No version to bind: a declared binding contradicts the payload.
            guard parsed.pinnedVersion == nil, parsed.versionBinding == nil else { return nil }
        }
        return RemoteHarnessInstallPrompt(
            lease: lease,
            harness: harness,
            runtimeTarget: runtimeTarget,
            command: parsed.command,
            installLocation: parsed.installLocation,
            pinnedVersion: parsed.pinnedVersion,
            verification: parsed.verification,
            versionBinding: parsed.versionBinding)
    }
}
