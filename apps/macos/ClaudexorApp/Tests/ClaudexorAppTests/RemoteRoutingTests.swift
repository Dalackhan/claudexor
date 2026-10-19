import ClaudexorKit
import Foundation
import Testing
@testable import ClaudexorApp

@Suite struct RemoteSetupLoginRoutingTests {
    @Test func currentEngineFactSelectsExactTransport() {
        #expect(RemoteSetupLoginRouting.decision(harness: .claude, capability: .inApp)
            == .transport(.daemon))
        #expect(RemoteSetupLoginRouting.decision(harness: .codex, capability: .externalTerminal)
            == .transport(.clientPty))
    }

    @Test func decodedLegacyRowKeepsOldFallback() {
        #expect(RemoteSetupLoginRouting.decision(harness: .codex, capability: .legacyAbsent)
            == .transport(.daemon))
        #expect(RemoteSetupLoginRouting.decision(harness: .cursor, capability: .legacyAbsent)
            == .transport(.clientPty))
    }

    @Test func explicitNullAndMissingCurrentProjectionRefuseLoudly() {
        guard case .unavailable(let message) = RemoteSetupLoginRouting.decision(
            harness: .agy, capability: .unavailable)
        else { Issue.record("explicit null must refuse"); return }
        #expect(message.contains("no managed login"))

        for projection: [HarnessInfo]? in [nil, []] {
            guard case .unavailable(let gap) = RemoteSetupLoginRouting.decision(
                harness: .claude, in: projection)
            else { Issue.record("missing current row must refuse"); continue }
            #expect(gap.contains("current managed-login capability"))
        }
    }

    @MainActor @Test func coldRoutingAwaitsTheCurrentProjectionBeforeSelectingTransport() async {
        for family in [HarnessFamily.claude, .cursor] {
            var loadCompleted = false
            let decision = await RemoteSetupLoginRouting
                .decisionAfterLoadingCurrentProjection(
                    harness: SetupHarness(rawValue: family.rawValue)!) {
                        await Task.yield()
                        loadCompleted = true
                        return [HarnessInfo(
                            family: family, health: .ok, version: "current", auth: "ready",
                            intents: ["implement"], setupLogin: .inApp)]
                    }
            #expect(loadCompleted)
            #expect(decision == .transport(.daemon))
        }

        let oldEngineDecision = await RemoteSetupLoginRouting
            .decisionAfterLoadingCurrentProjection(harness: .codex) {
                [HarnessInfo(
                    family: .codex, health: .ok, version: "old", auth: "ready",
                    intents: ["implement"], setupLogin: .legacyAbsent)]
            }
        #expect(oldEngineDecision == .transport(.daemon))
    }

    @MainActor @Test func attemptedProjectionLoadThatReturnsNothingIsALoudGap() async {
        var loadAttempts = 0
        let decision = await RemoteSetupLoginRouting
            .decisionAfterLoadingCurrentProjection(harness: .claude) {
                loadAttempts += 1
                await Task.yield()
                return nil
            }
        #expect(loadAttempts == 1)
        guard case .unavailable(let message) = decision else {
            Issue.record("an attempted load with no current row must refuse")
            return
        }
        #expect(message.contains("current managed-login capability"))
    }
}

@Suite struct RemoteRoutingTests {
    private func task(id: String, phase: RunPhase) -> TaskRun {
        TaskRun(
            id: id, title: id, prompt: "", mode: .agent, phase: phase,
            project: "Project", harnesses: [], n: 1,
            createdAt: .now, updatedAt: .now,
            spendUsd: 0, capUsd: 0, spendKnown: false, capKnown: false,
            routeProof: .unverified, attentionNote: nil, plan: [], activity: [],
            candidates: [], findings: [], diff: [])
    }

    @MainActor
    @Test func duplicateDaemonRunIdsRemainLocationScoped() {
        let model = AppModel(client: nil, requestNotificationAuthorization: false)
        let locationID = ExecutionLocationID.remote(UUID())
        model.liveTasks = [task(id: "same-run", phase: .running)]
        model.remoteTasks[locationID] = [task(id: "same-run", phase: .succeeded)]

        #expect(model.task("same-run", at: .local)?.phase == .running)
        #expect(model.task("same-run", at: locationID)?.phase == .succeeded)

        model.mutateTask("same-run", at: locationID) { $0.phase = .cancelled }
        #expect(model.task("same-run", at: .local)?.phase == .running)
        #expect(model.task("same-run", at: locationID)?.phase == .cancelled)
    }

    @Test func terminalSetupAndInstallAreOneShotBlockingOperations() {
        let id = UUID()
        let setupLease = RemoteActionLease(
            lane: .setupLogin, connectionID: id, generation: 1, token: UUID())
        let installLease = RemoteActionLease(
            lane: .harnessInstall, connectionID: id, generation: 1, token: UUID())
        #expect(RemoteTerminalPurpose.authentication(id, 1).blocksDismissalWhileRunning)
        #expect(RemoteTerminalPurpose.setup(setupLease, "setup-job").blocksDismissalWhileRunning)
        #expect(RemoteTerminalPurpose.install(installLease, "cursor").blocksDismissalWhileRunning)
        #expect(!RemoteTerminalPurpose.shell.blocksDismissalWhileRunning)
        #expect(!RemoteTerminalPurpose.log.blocksDismissalWhileRunning)
    }

    @Test func installDisclosureParsesOnlyTheRemoteCLIsOwnDryRunAnswer() {
        let id = UUID()
        let lease = RemoteActionLease(
            lane: .harnessInstall, connectionID: id, generation: 3, token: UUID())
        let valid = Data("""
        {"ok": true, "dryRun": true, "harness": "codex",
         "command": "npm install --global --prefix ~/.claudexor/remote/vendor @openai/codex@0.144.1",
         "installLocation": "~/.claudexor/remote/vendor/bin",
         "pinnedVersion": "0.144.1", "verification": "release_verified"}
        """.utf8)
        let prompt = AppModel.parseHarnessInstallDisclosure(
            valid, lease: lease, harness: "codex", runtimeTarget: "versions/test")
        #expect(prompt?.command.hasSuffix("@openai/codex@0.144.1") == true)
        #expect(prompt?.pinnedVersion == "0.144.1")
        #expect(prompt?.installLocation == "~/.claudexor/remote/vendor/bin")

        let cursor = Data("""
        {"ok": true, "dryRun": true, "harness": "cursor",
         "command": "curl --fail --silent --show-error --location https://cursor.com/install --output x/install.sh && /bin/sh x/install.sh",
         "installLocation": "~/.local/bin", "pinnedVersion": null,
         "verification": "human_observed"}
        """.utf8)
        #expect(AppModel.parseHarnessInstallDisclosure(
            cursor, lease: lease, harness: "cursor", runtimeTarget: "versions/test")?.pinnedVersion == nil)

        // Anything that is NOT the CLI's own affirmative dry-run disclosure
        // must yield nil — and therefore no install prompt at all.
        let refused = Data(
            #"{"ok": false, "dryRun": true, "harness": "codex", "command": "x", "installLocation": "y"}"#
                .utf8)
        #expect(AppModel.parseHarnessInstallDisclosure(
            refused, lease: lease, harness: "codex", runtimeTarget: "versions/test") == nil)
        let mismatched = Data(
            #"{"ok": true, "dryRun": true, "harness": "claude", "command": "x", "installLocation": "y"}"#
                .utf8)
        #expect(AppModel.parseHarnessInstallDisclosure(
            mismatched, lease: lease, harness: "codex", runtimeTarget: "versions/test") == nil)
        #expect(AppModel.parseHarnessInstallDisclosure(
            Data("not json".utf8), lease: lease, harness: "codex", runtimeTarget: "versions/test") == nil)

        let obsoleteVerification = Data("""
        {"ok": true, "dryRun": true, "harness": "codex", "command": "x",
         "installLocation": "y", "pinnedVersion": "0.144.1",
         "verification": "npm_registry_integrity"}
        """.utf8)
        #expect(AppModel.parseHarnessInstallDisclosure(
            obsoleteVerification, lease: lease, harness: "codex", runtimeTarget: "versions/test") == nil)

        let contradictoryVerification = Data("""
        {"ok": true, "dryRun": true, "harness": "cursor", "command": "x",
         "installLocation": "y", "pinnedVersion": "unexpected",
         "verification": "human_observed"}
        """.utf8)
        #expect(AppModel.parseHarnessInstallDisclosure(
            contradictoryVerification, lease: lease, harness: "cursor", runtimeTarget: "versions/test") == nil)
    }

    /// The exact confirmation strings the app sends over SSH. The consumer
    /// qualification script replays these templates against built CLIs.
    @Test func confirmationBindsTheDisclosingRuntimeAndOnlyADeclaredVersion() throws {
        let lease = RemoteActionLease(
            lane: .harnessInstall, connectionID: UUID(), generation: 1, token: UUID())
        let runtime = "versions/4.3.1-0123abcd"
        // The parser trusts the remote CLI's verification evidence, not a
        // local version table. Both evidence classes bind the approved target.
        for (version, verification) in [
            ("0.162.1", "release_verified"),
            ("0.200.0", "deterministic_only"),
            ("0.201.0-rc.1", "deterministic_only"),
        ] {
            let disclosure = """
            {"ok":true,"dryRun":true,"harness":"codex",
             "command":"npm install --global --prefix vendor @openai/codex@\(version)",
             "installLocation":"vendor/bin","pinnedVersion":"\(version)",
             "verification":"\(verification)"
            """
            // A current CLI declares the binding: confirm THAT exact version.
            let current = try #require(AppModel.parseHarnessInstallDisclosure(
                Data((disclosure + #","versionBinding":"vendor-version"}"#).utf8),
                lease: lease, harness: "codex", runtimeTarget: runtime))
            #expect(current.pinnedVersion == version)
            #expect(current.verification.rawValue == verification)
            #expect(current.versionBinding == .vendorVersion)
            #expect(current.confirmedInstallCommand ==
                "~/.claudexor/remote/'versions/4.3.1-0123abcd'/bin/claudexor"
                    + " harness install 'codex' --vendor-version '\(version)' --yes")
            #expect(!current.confirmedInstallCommand.contains("latest"))
            // An older CLI omits it and rejects the flag (exit 2): its plain
            // confirmation installs the fixed version it disclosed.
            let legacy = try #require(AppModel.parseHarnessInstallDisclosure(
                Data((disclosure + "}").utf8),
                lease: lease, harness: "codex", runtimeTarget: runtime))
            #expect(legacy.pinnedVersion == version)
            #expect(legacy.versionBinding == nil)
            #expect(legacy.confirmedInstallCommand ==
                "~/.claudexor/remote/'versions/4.3.1-0123abcd'/bin/claudexor"
                    + " harness install 'codex' --yes")
            // Neither form may follow the movable pointer to another CLI.
            for prompt in [current, legacy] {
                #expect(!prompt.confirmedInstallCommand.contains("/remote/current/"))
            }
        }
    }

    @Test func scriptInstallConfirmationDoesNotInventAVendorVersion() throws {
        let lease = RemoteActionLease(
            lane: .harnessInstall, connectionID: UUID(), generation: 1, token: UUID())
        for harness in ["agy", "cursor"] {
            let data = Data("""
            {"ok":true,"dryRun":true,"harness":"\(harness)",
             "command":"/bin/sh vendor/install.sh","installLocation":"~/.local/bin",
             "pinnedVersion":null,"verification":"human_observed"}
            """.utf8)
            let prompt = try #require(AppModel.parseHarnessInstallDisclosure(
                data, lease: lease, harness: harness, runtimeTarget: "versions/test"))
            #expect(prompt.verification == .humanObserved)
            #expect(prompt.pinnedVersion == nil)
            #expect(prompt.confirmedInstallCommand ==
                "~/.claudexor/remote/'versions/test'/bin/claudexor harness install '\(harness)' --yes")
            #expect(!prompt.confirmedInstallCommand.contains("--vendor-version"))
        }
    }

    @Test func malformedOrMissingNpmDisclosureNeverProducesAConfirmation() throws {
        let lease = RemoteActionLease(
            lane: .harnessInstall, connectionID: UUID(), generation: 1, token: UUID())
        let parse = { (payload: [String: Any], harness: String) throws in
            AppModel.parseHarnessInstallDisclosure(
                try JSONSerialization.data(withJSONObject: payload),
                lease: lease, harness: harness, runtimeTarget: "versions/test")
        }
        for verification in ["release_verified", "deterministic_only"] {
            let valid: [String: Any] = [
                "ok": true, "dryRun": true, "harness": "codex",
                "command": "npm install --global --prefix vendor @openai/codex@0.200.0",
                "installLocation": "vendor/bin", "pinnedVersion": "0.200.0",
                "verification": verification,
            ]
            // Each mutation isolates one defect in an otherwise valid payload.
            for field in valid.keys {
                var missing = valid
                missing.removeValue(forKey: field)
                #expect(try parse(missing, "codex") == nil)
            }
            let malformed: [(String, Any)] = [
                ("ok", false), ("dryRun", false), ("harness", "claude"),
                ("command", ""), ("verification", "unknown"),
                ("pinnedVersion", NSNull()), ("pinnedVersion", ""),
                ("pinnedVersion", " \n\t"), ("pinnedVersion", 200),
                // An unknown binding is not a capability this app can honor.
                ("versionBinding", "latest"), ("versionBinding", ""),
                ("versionBinding", true),
            ]
            for (field, value) in malformed {
                var payload = valid
                payload[field] = value
                #expect(try parse(payload, "codex") == nil)
            }
        }
        // A script disclosure has no version: a declared binding contradicts it.
        #expect(try parse([
            "ok": true, "dryRun": true, "harness": "cursor",
            "command": "/bin/sh vendor/install.sh", "installLocation": "~/.local/bin",
            "pinnedVersion": NSNull(), "verification": "human_observed",
            "versionBinding": "vendor-version",
        ], "cursor") == nil)
    }

    /// A refused dry-run exits non-zero, so the SSH manager throws
    /// `commandFailed(stderr)` and its stdout JSON is never decoded. The CLI
    /// repeats the refusal on stderr; this is the text the Settings row shows.
    @Test func refusedInstallPreparationShowsTheRemoteRefusal() {
        let refusal = "Install refused: the registry did not answer one exact latest version"
            + " for @openai/codex (npm exit 1); nothing was executed — retry when the npm"
            + " registry answers, or choose explicitly: --release-tested selects 0.162.1"
            + " without a latest lookup (installing it still needs the npm registry), or"
            + " --vendor-version <exact>"
        #expect(AppModel.harnessInstallPreparationFailure(
            SSHConnectionError.commandFailed(refusal), harness: "codex")
            == "Codex was not installed: " + refusal)
        // The pre-fix CLI wrote nothing to stderr: never a blank message.
        #expect(AppModel.harnessInstallPreparationFailure(
            SSHConnectionError.commandFailed(""), harness: "codex")
            == "Codex was not installed: the host reported no reason.")
        // Transport states keep the existing remote-error wording.
        #expect(AppModel.harnessInstallPreparationFailure(
            SSHConnectionError.unavailable("connect the host first"), harness: "codex") == nil)
    }

    /// The installer and the harness install share ONE pointer owner: only a
    /// single immutable `versions/<id>` closure may name the CLI that runs.
    @Test func runtimePointerTargetAcceptsOnlyOneImmutableVersionDirectory() throws {
        #expect(try RemoteRuntimeInstaller.currentPointerTarget(
            fromProbe: Data("versions/4.3.1-0123abcd\n".utf8)) == "versions/4.3.1-0123abcd")
        #expect(try RemoteRuntimeInstaller.currentPointerTarget(fromProbe: Data()) == nil)
        for unsafe in ["current", "versions/a/b", "versions/../x", "/abs/versions/x"] {
            #expect(throws: SSHConnectionError.self) {
                try RemoteRuntimeInstaller.currentPointerTarget(fromProbe: Data(unsafe.utf8))
            }
        }
    }

    /// The install guards refuse on a surface that does not need the
    /// connection's own row: a connection deleted between the disclosure
    /// dialog and the confirmation has no ForEach row left to render a
    /// per-connection message, so the refusal goes to threadStatus.
    @MainActor @Test func installGuardRefusalsAndStaleConfirmationAreDistinct() async {
        let model = AppModel(client: nil, requestNotificationAuthorization: false)
        let vanished = UUID()
        let staleLease = RemoteActionLease(
            lane: .harnessInstall, connectionID: vanished, generation: 0, token: UUID())

        await model.confirmRemoteHarnessInstall(
            RemoteHarnessInstallPrompt(
                lease: staleLease, harness: "codex", runtimeTarget: "versions/test",
                command: "npm install --global x", installLocation: "~/.claudexor",
                pinnedVersion: "0.144.1", verification: .releaseVerified, versionBinding: nil))
        // A completion retired by explicit removal is inert. The direct start
        // guard below remains loud because it is a new user action.
        #expect(model.threadStatus == nil)
        #expect(model.remoteConnectionMessages[vanished] == nil)

        model.threadStatus = nil
        await model.startRemoteHarnessInstall(connectionID: vanished, harness: "codex")
        #expect(model.threadStatus == "That connection no longer exists; nothing was installed.")

        model.threadStatus = nil
        await model.startRemoteHarnessInstall(connectionID: vanished, harness: "not-a-harness")
        #expect(
            model.threadStatus
                == "not-a-harness is not an installable harness; nothing was installed.")
    }

    @Test func onlyConnectionFailuresTriggerRemoteReadReconnect() {
        #expect(isRecoverableRemoteTransportFailure(
            URLError(.cannotConnectToHost)))
        #expect(isRecoverableRemoteTransportFailure(
            URLError(.networkConnectionLost)))
        #expect(isRecoverableRemoteTransportFailure(
            URLError(.timedOut)))

        #expect(!isRecoverableRemoteTransportFailure(
            URLError(.cancelled)))
        #expect(!isRecoverableRemoteTransportFailure(
            GatewayError.http(status: 404, body: "")))
        #expect(!isRecoverableRemoteTransportFailure(
            GatewayError.decoding("bad payload")))
    }

    @Test func deviceLoginReconcilesOnlyTheKnownProtocolFalseNegative() {
        #expect(remoteDeviceLoginRecoveredFromProtocolMismatch(
            jobState: .failed,
            selectionReason: .protocolViolation,
            effectiveRoute: .vendorNative,
            effectiveSource: .nativeSession,
            nativeSessionVerified: true,
            harnessRoutable: true))

        #expect(!remoteDeviceLoginRecoveredFromProtocolMismatch(
            jobState: .failed,
            selectionReason: .routeMismatch,
            effectiveRoute: .managedAPIKey,
            effectiveSource: .apiKeyEnvironment,
            nativeSessionVerified: true,
            harnessRoutable: true))
        #expect(!remoteDeviceLoginRecoveredFromProtocolMismatch(
            jobState: .failed,
            selectionReason: .protocolViolation,
            effectiveRoute: .vendorNative,
            effectiveSource: .nativeSession,
            nativeSessionVerified: false,
            harnessRoutable: true))
        #expect(!remoteDeviceLoginRecoveredFromProtocolMismatch(
            jobState: .cancelled,
            selectionReason: .protocolViolation,
            effectiveRoute: .vendorNative,
            effectiveSource: .nativeSession,
            nativeSessionVerified: true,
            harnessRoutable: true))

        let recovered = RemoteDeviceLoginTerminalPresentation(
            jobState: .failed,
            selectionReason: .protocolViolation,
            effectiveRoute: .vendorNative,
            effectiveSource: .nativeSession,
            nativeSessionVerified: true,
            harnessRoutable: true)
        #expect(recovered == .readyWithWarning)
        #expect(recovered.label == "Signed in; setup check failed")
        #expect(recovered.label != "Login verified")

        #expect(RemoteDeviceLoginTerminalPresentation(
            jobState: .succeeded,
            selectionReason: nil,
            effectiveRoute: nil,
            effectiveSource: nil,
            nativeSessionVerified: false,
            harnessRoutable: false
        ) == .verified)
    }

    @Test func profileReadinessUsesTheExactProfile() throws {
        let entry = try JSONDecoder().decode(
            CredentialProfileEntry.self,
            from: Data(#"{"profile":{"profile_id":"work","harness_id":"codex","display_name":"Work","credential_kind":"config_dir_login","enabled":true},"status":{"availability":"available","verification":"passed","detail":null,"last_verified_at":null}}"#.utf8))
        #expect(RemoteNativeLoginReadiness.profile(entry) == .init(
            nativeSessionVerified: true, harnessRoutable: true))

        let failed = try JSONDecoder().decode(
            CredentialProfileEntry.self,
            from: Data(#"{"profile":{"profile_id":"work","harness_id":"codex","display_name":"Work","credential_kind":"config_dir_login","enabled":true},"status":{"availability":"available","verification":"failed","detail":"wrong account","last_verified_at":null}}"#.utf8))
        #expect(RemoteNativeLoginReadiness.profile(failed) == .init(
            nativeSessionVerified: false, harnessRoutable: false))

    }
}
