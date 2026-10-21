import Foundation
import Testing
import ClaudexorKit
@testable import ClaudexorApp

private final class LateBuildHandshakeURLProtocol: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let body: String
        let status: Int
        switch request.url?.path {
        case "/healthz":
            status = 200
            body = #"{"ok":true}"#
        case "/v2/handshake":
            status = 200
            body = #"{"protocolMajor":3,"compatible":true,"operationsPath":"/v2/operations","engine":{"version":"3.2.0","sha":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","entry":"/fixtures/App-B"}}"#
        default:
            status = 503
            body = "{}"
        }
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: nil)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

struct LocalDaemonBuildSwitchTests {
    private let buildA = RuntimeClosureIdentity(version: "3.2.0", buildSha: String(repeating: "a", count: 40))
    private let buildB = RuntimeClosureIdentity(version: "3.2.0", buildSha: String(repeating: "b", count: 40))
    private let script = URL(fileURLWithPath: "/fixtures/App-B/claudexord.bundle.cjs")

    private func reconciler(
        _ daemon: ReconciliationDaemonStub,
        owner: LocalRuntimeLifecycleOwner = LocalRuntimeLifecycleOwner()
    ) -> LocalDaemonReconciler {
        LocalDaemonReconciler(
            daemon: daemon, lifecycleOwner: owner,
            targetClosure: { LocalRuntimeClosureSelection(scriptURL: script, authority: .installed(buildB)) },
            handshakePollInterval: 0, handshakePollTimeout: 0)
    }

    private func daemon() -> ReconciliationDaemonStub {
        let daemon = ReconciliationDaemonStub()
        daemon.targetIdentity = buildB
        daemon.servingIdentity = buildA
        daemon.runningIdentity = buildB
        return daemon
    }

    @Test func explicitSameVersionSwitchRunsOnceAndPassiveCopiesCannotSwitchItBack() async {
        let daemon = daemon()
        let sut = reconciler(daemon)
        let request = LocalDaemonBuildSwitch(serving: buildA, target: buildB)

        #expect(await sut.reconcile(switchBuild: request) == .replaced(buildB))
        #expect(await sut.reconcile() == .coherent(buildB))
        // A second app still selects A, but observes B after the explicit switch.
        let other = ReconciliationDaemonStub()
        other.targetIdentity = buildA
        other.servingIdentity = buildB
        let otherCopy = LocalDaemonReconciler(
            daemon: other, lifecycleOwner: LocalRuntimeLifecycleOwner(),
            targetClosure: { LocalRuntimeClosureSelection(scriptURL: script, authority: .installed(buildA)) })
        #expect(await otherCopy.reconcile() == .deferred(.explicitBuildSwitchRequired, serving: buildB, target: buildA))
        #expect(daemon.stoppedIdentities == [buildA])
        #expect(daemon.startedScripts == [script])
        #expect(other.stops == 0)
        #expect(other.starts == 0)
    }

    @Test(arguments: [true, false])
    func explicitSwitchCannotStopBusyOrUnknownDaemon(busy: Bool) async {
        let daemon = daemon()
        daemon.busy = busy ? true : nil
        let result = await reconciler(daemon).reconcile(
            switchBuild: LocalDaemonBuildSwitch(serving: buildA, target: buildB))
        #expect(result == .deferred(busy ? .busy : .activityUnknown, serving: buildA, target: buildB))
        #expect(daemon.stops == 0)
        #expect(daemon.starts == 0)
    }

    @Test(arguments: [RuntimeReplacementStopError.busy, .activityUnknown])
    func explicitSwitchPreservesDaemonAtomicRefusal(refusal: RuntimeReplacementStopError) async {
        let daemon = daemon()
        daemon.replacementStopRefusal = refusal
        let result = await reconciler(daemon).reconcile(
            switchBuild: LocalDaemonBuildSwitch(serving: buildA, target: buildB))
        #expect(result == .deferred(refusal == .busy ? .busy : .activityUnknown, serving: buildA, target: buildB))
        #expect(daemon.stoppedIdentities == [buildA])
        #expect(daemon.starts == 0)
    }

    @Test func changedServingIdentityInvalidatesTheDisplayedSwitch() async {
        let daemon = daemon()
        daemon.servingIdentity = RuntimeClosureIdentity(version: "3.2.0", buildSha: String(repeating: "c", count: 40))
        #expect(await reconciler(daemon).reconcile(
            switchBuild: LocalDaemonBuildSwitch(serving: buildA, target: buildB)) == .supersededBeforeLifecycle)
        #expect(daemon.stops == 0)
        #expect(daemon.starts == 0)
    }

    @Test func servingIdentityIsRecheckedAfterTheAdvisoryBusyAwait() async {
        let daemon = daemon()
        let gate = SuspendedReconciliationEffect()
        daemon.busyGate = gate
        let sut = reconciler(daemon)
        let task = Task { await sut.reconcile(switchBuild: LocalDaemonBuildSwitch(serving: buildA, target: buildB)) }
        await gate.waitUntilEntered()
        daemon.setServingIdentity(buildB)
        await gate.release()
        #expect(await task.value == .supersededBeforeLifecycle)
        #expect(daemon.stops == 0)
        #expect(daemon.starts == 0)
    }

    @Test func explicitActionWaitingBehindPassiveObservationIsNotConsumed() async throws {
        let daemon = daemon()
        let gate = SuspendedReconciliationEffect()
        daemon.probeGate = gate
        let owner = LocalRuntimeLifecycleOwner()
        let sut = reconciler(daemon, owner: owner)
        let passive = Task { await sut.reconcile() }
        await gate.waitUntilEntered()
        let explicit = Task { await sut.reconcile(switchBuild: LocalDaemonBuildSwitch(serving: buildA, target: buildB)) }
        await Task.yield()
        await gate.release()
        #expect(await passive.value == .deferred(.explicitBuildSwitchRequired, serving: buildA, target: buildB))
        #expect(await explicit.value == .replaced(buildB))
        #expect(daemon.stops == 1)
        #expect(daemon.starts == 1)
        let lease = try #require(owner.claim(.installation))
        owner.release(lease)
    }

    @Test func explicitActionDoesNotAuthorizeADowngrade() async {
        let daemon = daemon()
        let newer = RuntimeClosureIdentity(version: "3.3.0", buildSha: buildA.buildSha)
        daemon.servingIdentity = newer
        #expect(await reconciler(daemon).reconcile(switchBuild: LocalDaemonBuildSwitch(serving: newer, target: buildB))
            == .deferred(.targetNotNewer, serving: newer, target: buildB))
        #expect(daemon.stops == 0)
        #expect(daemon.starts == 0)
    }

    @MainActor
    @Test func settingsActionIsSeparateFromPassiveReconnectPolicy() async {
        let daemon = daemon()
        let model = AppModel(requestNotificationAuthorization: false)
        model.localDaemonReconciler = reconciler(daemon, owner: model.localRuntimeLifecycleOwner)
        model.engineIdentity = EngineBuildIdentity(version: buildA.version, sha: buildA.buildSha, entry: "/fixtures/App-A")

        _ = await model.localDaemonPolicy(for: model.engineIdentity)
        #expect(daemon.stops == 0)
        #expect(model.localDaemonBuildSwitch == LocalDaemonBuildSwitch(serving: buildA, target: buildB))
        let request = LocalDaemonBuildSwitch(serving: buildA, target: buildB)
        let receipt = await model.switchLocalDaemonBuild(request)
        #expect(receipt == model.connectionGeneration)
        #expect(model.localDaemonBuildSwitch == nil)
        #expect(model.engineIdentity == nil)
        #expect(daemon.stoppedIdentities == [buildA])
        #expect(daemon.starts == 1)
        #expect(await model.switchLocalDaemonBuild(request) == nil)
    }

    @MainActor
    @Test(arguments: [false, true])
    func staleExplicitCallbackCannotOverwriteANewerConnection(admitted: Bool) async {
        let daemon = daemon()
        let model = AppModel(requestNotificationAuthorization: false)
        model.localDaemonReconciler = reconciler(daemon, owner: model.localRuntimeLifecycleOwner)
        model.localDaemonBuildSwitch = LocalDaemonBuildSwitch(serving: buildA, target: buildB)
        let gate = SuspendedReconciliationEffect()
        if admitted { daemon.stopGate = gate } else { daemon.busyGate = gate }
        let request = LocalDaemonBuildSwitch(serving: buildA, target: buildB)
        let task = Task { @MainActor in await model.switchLocalDaemonBuild(request) }
        await gate.waitUntilEntered()
        model.connectionGeneration += 1
        model.localDaemonReconciliationNotice = "Successor owns this state"
        model.localDaemonBuildSwitch = LocalDaemonBuildSwitch(serving: buildB, target: buildA)
        await gate.release()
        #expect(await task.value == nil)
        #expect(model.localDaemonReconciliationNotice == "Successor owns this state")
        #expect(model.localDaemonBuildSwitch == LocalDaemonBuildSwitch(serving: buildB, target: buildA))
        #expect(daemon.stops == (admitted ? 1 : 0))
        #expect(daemon.starts == (admitted ? 1 : 0))
    }

    @MainActor
    @Test(arguments: [false, true])
    func queuedButtonIntentCannotSwitchThePairPublishedByALaterPoll(targetChanged: Bool) async {
        let daemon = daemon()
        let model = AppModel(requestNotificationAuthorization: false)
        model.localDaemonReconciler = reconciler(daemon, owner: model.localRuntimeLifecycleOwner)
        let displayed = LocalDaemonBuildSwitch(serving: buildA, target: buildB)
        model.localDaemonBuildSwitch = displayed
        let buildC = RuntimeClosureIdentity(version: "3.2.0", buildSha: String(repeating: "c", count: 40))
        let latest = targetChanged
            ? LocalDaemonBuildSwitch(serving: buildA, target: buildC)
            : LocalDaemonBuildSwitch(serving: buildC, target: buildB)
        model.localDaemonBuildSwitch = latest // a poll before the button Task runs
        let generation = model.connectionGeneration
        #expect(await model.switchLocalDaemonBuild(displayed) == nil)
        #expect(model.connectionGeneration == generation)
        #expect(model.localDaemonBuildSwitch == latest)
        #expect(daemon.stops == 0)
        #expect(daemon.starts == 0)
    }

    @MainActor
    @Test func failedSwitchProofCleansOfflineStateAndLateBuildReconnectsWithoutAnotherLaunch() async throws {
        let daemon = daemon()
        daemon.runningIdentity = nil // the zero-budget post-start proof expires
        let model = AppModel(requestNotificationAuthorization: false)
        defer { model.cancelAllStreams() }
        model.localDaemonReconciler = reconciler(daemon, owner: model.localRuntimeLifecycleOwner)
        model.engineIdentity = EngineBuildIdentity(version: buildA.version, sha: buildA.buildSha, entry: "/fixtures/App-A")
        let request = LocalDaemonBuildSwitch(serving: buildA, target: buildB)
        model.localDaemonBuildSwitch = request
        model.secretBackend = "stale fixture projection"
        model.settingsStatus = "stale fixture settings"
        let epoch = model.settingsEpoch
        let receipt = try #require(await model.switchLocalDaemonBuild(request))
        #expect(model.health == .offline)
        #expect(model.secretBackend == "unknown")
        #expect(model.settingsStatus == nil)
        #expect(model.settingsEpoch > epoch)
        #expect(model.localDaemonReconciliationNotice?.contains("Reconnecting") == true)

        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [LateBuildHandshakeURLProtocol.self]
        let client = GatewayClient(baseURL: URL(string: "http://127.0.0.1:1234")!, token: "fixture",
            session: URLSession(configuration: configuration))
        var probes = 0
        var fallbackStarts = 0
        let recovery = LocalConnectionRecoveryLoop(
            generation: receipt, currentGeneration: { model.connectionGeneration },
            lifecycleOwner: model.localRuntimeLifecycleOwner, prepareProbe: {},
            probe: {
                probes += 1
                if probes == 1 { return .unavailable }
                return await model.tryConnect(candidate: client, endpoint: "fixture", generation: receipt)
            },
            pollConnected: {
                #expect(model.health == .connected)
                #expect(model.engineIdentity?.sha == buildB.buildSha)
                model.connectionGeneration += 1
                return .superseded
            },
            startDaemon: { _ in fallbackStarts += 1; return false },
            enterOffline: { model.enterHardOffline() },
            pause: { daemon.runningIdentity = buildB; await Task.yield() })
        await recovery.run(launchAvailable: false)
        #expect(probes == 2)
        #expect(fallbackStarts == 0)
        #expect(daemon.stoppedIdentities == [buildA])
        #expect(daemon.starts == 1)
        #expect(model.health == .connected)
    }

    @MainActor
    @Test func switchReconnectReceiptCannotRetireANewerGeneration() async {
        let model = AppModel(requestNotificationAuthorization: false)
        model.connectionGeneration = 4
        model.engineIdentity = EngineBuildIdentity(version: buildB.version, sha: buildB.buildSha, entry: "/fixtures/successor")
        model.health = .connected
        await model.connect(ifCurrentGeneration: 3, allowInitialLaunch: false)
        #expect(model.connectionGeneration == 4)
        #expect(model.engineIdentity?.sha == buildB.buildSha)
        #expect(model.health == .connected)
    }
}
