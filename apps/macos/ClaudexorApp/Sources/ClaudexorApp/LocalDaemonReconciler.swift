import Foundation
import ClaudexorKit

@usableFromInline
enum LocalDaemonBootPolicy {
    /// A large recovered journal can keep the daemon below handshake readiness
    /// for more than 30 seconds even though startup is making healthy progress.
    @usableFromInline static let handshakeTimeout: TimeInterval = 90
    /// Cadence of the bounded post-launch handshake poll.
    @usableFromInline static let handshakePollInterval: TimeInterval = 0.5
}

enum LocalDaemonReconciliationDeferral: Sendable, Equatable {
    case busy
    case activityUnknown
    case explicitBuildSwitchRequired
    case targetNotNewer
}

/// One user action bound to the two builds shown by Settings. Never persisted
/// or replayed by connection polling, and invalidated by a changed observation.
struct LocalDaemonBuildSwitch: Sendable, Equatable {
    let serving: RuntimeClosureIdentity
    let target: RuntimeClosureIdentity
}

enum LocalDaemonReconciliationFailure: Sendable, Equatable {
    /// The shared lifecycle lock is unusable; nothing was observed or changed.
    case lifecycleUnavailable(LocalRuntimeLifecycleRefusal)
    case targetScriptUnavailable
    case targetAuthorityUnavailable
    case targetProbeFailed
    case targetAuthorityMismatch(
        expected: RuntimeClosureIdentity,
        got: RuntimeClosureIdentity)
    case servingIdentityUnavailable
    case stopFailed
    case startFailed
    case postStartMismatch(expected: RuntimeClosureIdentity, got: RuntimeClosureIdentity)
    case postStartUnreachable(expected: RuntimeClosureIdentity)
}

enum LocalDaemonReconciliationResult: Sendable, Equatable {
    case coherent(RuntimeClosureIdentity)
    case replaced(RuntimeClosureIdentity)
    case deferred(
        LocalDaemonReconciliationDeferral,
        serving: RuntimeClosureIdentity,
        target: RuntimeClosureIdentity)
    case deferredForLifecycle
    case failed(LocalDaemonReconciliationFailure)
    /// The requesting connection generation retired before destructive
    /// lifecycle admission. No stop or start was attempted.
    case supersededBeforeLifecycle
}

/// The AppModel-facing policy for a reconciliation result. Keeping this
/// reduction beside the lifecycle owner prevents connect and steady-state poll
/// from drifting into subtly different safety decisions.
enum LocalDaemonReconciliationPolicy: Sendable, Equatable {
    /// The protocol-compatible daemon remains usable. A non-nil notice explains
    /// why exact closure coherence could not be established yet.
    case useCompatible(notice: String?)
    /// Another lifecycle owner held the lease, so nothing was observed or
    /// changed. The daemon remains usable; facts published from an earlier
    /// observation are neither confirmed nor retired by this result.
    case unobserved
    /// The reconciler replaced the daemon. Discovery/token/client state must be
    /// reacquired before any daemon-owned projection is hydrated.
    case reconnect
    /// A lifecycle transition began but did not finish with the exact target.
    /// The previous client is no longer safe to use.
    case failOffline(notice: String)
    /// A coalesced older generation retired before lifecycle admission. The
    /// current caller should re-probe without launching a fallback.
    case retry
    /// A newer connection generation owns every subsequent publication.
    case superseded

    init(_ result: LocalDaemonReconciliationResult) {
        switch result {
        case .coherent:
            self = .useCompatible(notice: nil)
        case .replaced:
            self = .reconnect
        case .deferred(.busy, _, _):
            self = .useCompatible(
                notice: "Engine refresh is deferred while work is active.")
        case .deferred(.activityUnknown, _, _):
            self = .useCompatible(
                notice: "Engine refresh is deferred until active work can be checked.")
        case .deferred(.explicitBuildSwitchRequired, _, _):
            self = .useCompatible(
                notice: "A different build of this engine version is running. Use Settings → General → Switch Engine Build when work is idle.")
        case .deferred(.targetNotNewer, _, _):
            self = .useCompatible(
                notice: "The running engine is newer, or version order cannot be verified. Continuing with the compatible running engine.")
        case .deferredForLifecycle:
            self = .unobserved
        case let .failed(.lifecycleUnavailable(refusal)):
            self = .useCompatible(
                notice: "Engine refresh is unavailable: \(refusal.reason). Continuing with the compatible running engine.")
        case .failed(.targetScriptUnavailable), .failed(.targetAuthorityUnavailable),
             .failed(.targetProbeFailed), .failed(.targetAuthorityMismatch(_, _)):
            self = .useCompatible(
                notice: "Could not verify the selected engine runtime; continuing with the compatible running engine.")
        case .failed(.servingIdentityUnavailable):
            self = .useCompatible(
                notice: "Could not verify the running engine build; continuing with its compatible protocol.")
        case .failed(.stopFailed):
            self = .failOffline(
                notice: "Engine refresh could not safely stop the previous engine. Reconnecting.")
        case .failed(.startFailed):
            self = .failOffline(
                notice: "Engine refresh stopped the previous engine but could not start the selected runtime. Reconnecting.")
        case .failed(.postStartMismatch):
            self = .failOffline(
                notice: "The refreshed engine identity did not match the selected runtime. Reconnecting.")
        case .failed(.postStartUnreachable):
            self = .failOffline(
                notice: "The refreshed engine did not come online. Reconnecting.")
        case .supersededBeforeLifecycle:
            self = .retry
        }
    }
}

/// Reconciles the compatible local daemon already serving the app with the
/// exact closure selected by `DaemonLauncher`. Protocol compatibility remains
/// the Gateway's concern; this owner only prevents an app upgrade from silently
/// continuing on stale, app-owned engine bytes.
///
/// The actor coalesces overlapping reconnect polls into one lifecycle change.
/// It never stops a daemon unless exact target probing succeeded and active work
/// was authoritatively reported idle.
actor LocalDaemonReconciler {
    private let daemon: any RuntimeDaemonControl
    private let lifecycleOwner: LocalRuntimeLifecycleOwner
    private let targetClosure: @Sendable () -> LocalRuntimeClosureSelection?
    private let handshakePollInterval: TimeInterval
    private let handshakePollTimeout: TimeInterval
    private var inFlight: Task<LocalDaemonReconciliationResult, Never>?

    init(
        daemon: any RuntimeDaemonControl,
        lifecycleOwner: LocalRuntimeLifecycleOwner,
        targetClosure: @escaping @Sendable () -> LocalRuntimeClosureSelection? = {
            DaemonLauncher.resolvedRuntime()
        },
        handshakePollInterval: TimeInterval = LocalDaemonBootPolicy.handshakePollInterval,
        handshakePollTimeout: TimeInterval = LocalDaemonBootPolicy.handshakeTimeout
    ) {
        self.daemon = daemon
        self.lifecycleOwner = lifecycleOwner
        self.targetClosure = targetClosure
        self.handshakePollInterval = handshakePollInterval
        self.handshakePollTimeout = handshakePollTimeout
    }

    /// A connection observation is only a hint. Lifecycle decisions always use
    /// a fresh serving identity read while the lifecycle lease is held.
    func reconcile(
        serving _: RuntimeClosureIdentity? = nil,
        switchBuild: LocalDaemonBuildSwitch? = nil,
        isCurrent: @escaping @Sendable () async -> Bool = { true }
    ) async -> LocalDaemonReconciliationResult {
        if let inFlight {
            let result = await inFlight.value
            guard switchBuild != nil else { return result }
            // A passive task cannot consume an explicit action. Its ownership
            // is released before its result resolves; re-admit with fresh facts.
            return await reconcile(switchBuild: switchBuild, isCurrent: isCurrent)
        }
        guard await isCurrent() else { return .supersededBeforeLifecycle }
        // Exact session admission precedes target resolution and the first await.
        // It excludes RuntimeInstallCoordinator's independent actor from the same
        // stop/start lifecycle rather than relying on a sampled UI boolean.
        let lifecycleLease: LocalRuntimeLifecycleLease
        switch lifecycleOwner.claim(.reconciliation) {
        case let .acquired(lease): lifecycleLease = lease
        case .contended: return .deferredForLifecycle
        case let .refused(refusal): return .failed(.lifecycleUnavailable(refusal))
        }

        let daemon = self.daemon
        let targetClosure = self.targetClosure
        let pollInterval = handshakePollInterval
        let pollTimeout = handshakePollTimeout
        let task = Task {
            let result = await Self.perform(
                daemon: daemon, targetClosure: targetClosure, switchBuild: switchBuild,
                handshakePollInterval: pollInterval, handshakePollTimeout: pollTimeout,
                isCurrent: isCurrent)
            // Cleanup belongs to the task, so an old waiter cannot clear a
            // successor task or release its lease after this result resolves.
            inFlight = nil
            lifecycleOwner.release(lifecycleLease)
            return result
        }
        inFlight = task
        return await task.value
    }

    private static func perform(
        daemon: any RuntimeDaemonControl,
        targetClosure: @Sendable () -> LocalRuntimeClosureSelection?,
        switchBuild: LocalDaemonBuildSwitch?,
        handshakePollInterval: TimeInterval,
        handshakePollTimeout: TimeInterval,
        isCurrent: @escaping @Sendable () async -> Bool
    ) async -> LocalDaemonReconciliationResult {
        guard let selected = targetClosure() else { return .failed(.targetScriptUnavailable) }
        let expected: RuntimeClosureIdentity?
        switch selected.authority {
        case .installed(let pointerIdentity):
            guard let pointerIdentity else {
                return .failed(.targetAuthorityUnavailable)
            }
            expected = pointerIdentity
        case .bundledStampedProbe:
            expected = nil
        }
        guard let probed = await daemon.probeIdentity(scriptURL: selected.scriptURL) else {
            return .failed(.targetProbeFailed)
        }
        let target: RuntimeClosureIdentity
        if let expected {
            guard probed == expected else {
                return .failed(.targetAuthorityMismatch(expected: expected, got: probed))
            }
            target = expected
        } else {
            // The bundled script is inside the signed app closure; its stamped
            // exact probe is the authority for this launch target.
            target = probed
        }
        guard let serving = await daemon.handshakeIdentity() else {
            return .failed(.servingIdentityUnavailable)
        }
        if serving == target { return .coherent(target) }
        if let switchBuild,
           switchBuild != LocalDaemonBuildSwitch(serving: serving, target: target) {
            return .supersededBeforeLifecycle
        }
        if serving.version == target.version {
            guard switchBuild != nil else {
                return .deferred(.explicitBuildSwitchRequired, serving: serving, target: target)
            }
        } else {
            // SemanticVersion also accepts incomplete versions and strips
            // suffixes. Only the engine's stable x.y.z contract proves order.
            guard stableVersion(serving.version), stableVersion(target.version),
                  let current = SemanticVersion(serving.version),
                  let next = SemanticVersion(target.version), next > current else {
                return .deferred(.targetNotNewer, serving: serving, target: target)
            }
        }

        switch await daemon.isBusy() {
        case true:
            return .deferred(.busy, serving: serving, target: target)
        case nil:
            return .deferred(.activityUnknown, serving: serving, target: target)
        case false:
            break
        }

        // Everything above this point is side-effect-free observation. This is
        // the generation-bound admission point for the destructive lifecycle:
        // a request superseded before it stops the daemon performs no mutation.
        // Once stop is invoked the exact stop/start/proof transaction must run
        // to a safe terminal state even if a newer connect begins meanwhile.
        guard await isCurrent() else { return .supersededBeforeLifecycle }
        guard let freshServing = await daemon.handshakeIdentity() else {
            return .failed(.servingIdentityUnavailable)
        }
        guard freshServing == serving, await isCurrent() else {
            return .supersededBeforeLifecycle
        }

        do {
            try await daemon.stopForRuntimeReplacement(expectedIdentity: serving)
        } catch RuntimeReplacementStopError.busy {
            return .deferred(.busy, serving: serving, target: target)
        } catch RuntimeReplacementStopError.activityUnknown {
            return .deferred(.activityUnknown, serving: serving, target: target)
        } catch {
            return .failed(.stopFailed)
        }
        do {
            try daemon.start(scriptURL: selected.scriptURL)
        } catch {
            return .failed(.startFailed)
        }

        let deadline = Date().addingTimeInterval(max(0, handshakePollTimeout))
        while true {
            if let running = await daemon.handshakeIdentity() {
                return running == target
                    ? .replaced(target)
                    : .failed(.postStartMismatch(expected: target, got: running))
            }
            if Date() >= deadline { return .failed(.postStartUnreachable(expected: target)) }
            let nanoseconds = UInt64(max(0, handshakePollInterval) * 1_000_000_000)
            if nanoseconds == 0 {
                await Task.yield()
            } else {
                try? await Task.sleep(nanoseconds: nanoseconds)
            }
        }
    }

    private static func stableVersion(_ value: String) -> Bool {
        let parts = value.split(separator: ".", omittingEmptySubsequences: false)
        return parts.count == 3 && parts.allSatisfy { part in
            !part.isEmpty && part.utf8.allSatisfy { (48...57).contains($0) }
        }
    }
}
