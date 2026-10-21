import Foundation
import ClaudexorKit

extension AppModel {
    private func daemonReconciliationOwner() -> LocalDaemonReconciler {
        if let localDaemonReconciler { return localDaemonReconciler }
        let reconciler = LocalDaemonReconciler(
            daemon: makeDaemonControl(), lifecycleOwner: localRuntimeLifecycleOwner)
        localDaemonReconciler = reconciler
        return reconciler
    }

    func localDaemonPolicy(
        for engine: EngineBuildIdentity?,
        generation: Int? = nil,
        switchBuild: LocalDaemonBuildSwitch? = nil
    ) async -> LocalDaemonReconciliationPolicy {
        let generation = generation ?? connectionGeneration
        let serving = engine.flatMap {
            AppRuntimeDaemonControl.runtimeIdentity(version: $0.version, buildSha: $0.sha)
        }
        let result = await daemonReconciliationOwner().reconcile(
            serving: serving, switchBuild: switchBuild,
            isCurrent: { @MainActor [weak self] in
                !Task.isCancelled && self?.connectionGeneration == generation
            })
        guard !Task.isCancelled, connectionGeneration == generation else { return .superseded }
        localDaemonBuildSwitch = nil
        // A fresh lifecycle observation must not authorize publishing the older
        // caller's handshake, even when both builds speak a compatible protocol.
        switch result {
        case let .coherent(observed):
            if observed != serving { return .retry }
        case let .deferred(_, observed, target):
            if observed != serving { return .retry }
            if observed.version == target.version, observed != target {
                localDaemonBuildSwitch = LocalDaemonBuildSwitch(serving: observed, target: target)
            }
        default:
            break
        }
        return LocalDaemonReconciliationPolicy(result)
    }

    /// Settings alone calls this bounded, one-shot action. Its caller starts an
    /// ordinary connection loop afterward only if this generation still owns it.
    /// Reconnect and passive polls never pass a build-switch request.
    func switchLocalDaemonBuild(_ request: LocalDaemonBuildSwitch) async -> Int? {
        guard localDaemonBuildSwitch == request, !runtimeInstalling else { return nil }
        connectionGeneration += 1
        let generation = connectionGeneration
        localDaemonBuildSwitch = nil
        let policy = await localDaemonPolicy(
            for: engineIdentity, generation: generation, switchBuild: request)
        guard connectionGeneration == generation, !Task.isCancelled else { return nil }
        switch policy {
        case let .useCompatible(notice):
            localDaemonReconciliationNotice = notice
        case let .failOffline(notice):
            enterHardOffline()
            localDaemonReconciliationNotice = notice
        case .reconnect:
            localDaemonReconciliationNotice = nil
            client = nil
            engineIdentity = nil
            endpoint = ""
            health = .connecting
            cancelAllStreams()
        case .retry:
            localDaemonReconciliationNotice = "The engine selection changed. Reconnecting before offering another build switch."
        case .superseded:
            return nil
        }
        return generation
    }
}
