import Darwin
import Foundation
import Testing
@testable import ClaudexorApp

struct LocalRuntimeLifecycleOwnerTests {
    private func root() throws -> URL {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .appendingPathComponent("../../../../../tmp/lifecycle-\(UUID().uuidString)")
            .standardizedFileURL
        try FileManager.default.createDirectory(
            at: root, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        return root
    }

    @Test func independentAppOwnersShareOneTransactionAndReleaseOnlyExactLeases() throws {
        let root = try root()
        defer { try? FileManager.default.removeItem(at: root) }
        let first = LocalRuntimeLifecycleOwner(serviceRoot: root)
        let second = LocalRuntimeLifecycleOwner(serviceRoot: root)
        let original = try #require(first.claim(.installation))
        #expect(second.claim(.reconciliation) == nil)
        #expect(second.claim(.outageRecovery) == nil)
        first.release(original)
        let successor = try #require(second.claim(.reconciliation))
        first.release(original)
        #expect(first.claim(.installation) == nil)
        second.release(successor)
        let next = try #require(first.claim(.outageRecovery))
        first.release(original)
        #expect(second.claim(.installation) == nil)
        first.release(next)
    }

    @Test func distinctServiceRootsRemainIndependent() throws {
        let firstRoot = try root()
        let secondRoot = try root()
        defer {
            try? FileManager.default.removeItem(at: firstRoot)
            try? FileManager.default.removeItem(at: secondRoot)
        }
        let first = LocalRuntimeLifecycleOwner(serviceRoot: firstRoot)
        let second = LocalRuntimeLifecycleOwner(serviceRoot: secondRoot)
        let firstLease = try #require(first.claim(.installation))
        let secondLease = try #require(second.claim(.reconciliation))
        first.release(firstLease)
        second.release(secondLease)
    }

    @Test func createsOnlyPrivateMissingServiceDirectories() throws {
        let root = try root()
        defer { try? FileManager.default.removeItem(at: root) }
        let missing = root.appendingPathComponent("config/daemon")
        let owner = LocalRuntimeLifecycleOwner(serviceRoot: missing)
        let lease = try #require(owner.claim(.outageRecovery))
        let attributes = try FileManager.default.attributesOfItem(atPath: missing.path)
        #expect((attributes[.posixPermissions] as? NSNumber)?.intValue == 0o700)
        owner.release(lease)
        #expect(FileManager.default.fileExists(atPath: missing.appendingPathComponent("lifecycle.lock").path))
    }

    @MainActor
    @Test(arguments: [false, true])
    func cleanFirstLaunchCreatesTheMissingDefaultLayoutAndReachesConnected(existingOwnedDirectory: Bool) async throws {
        let fixtureHome = try root()
        defer { try? FileManager.default.removeItem(at: fixtureHome) }
        // The default discovery layout under an isolated synthetic HOME; do not
        // consult ambient config overrides or any actual discovery/token file.
        let serviceRoot = fixtureHome.appendingPathComponent(".claudexor/v3/daemon")
        if existingOwnedDirectory {
            try FileManager.default.createDirectory(
                at: serviceRoot, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o755])
        }
        #expect(FileManager.default.fileExists(atPath: serviceRoot.path) == existingOwnedDirectory)
        let owner = LocalRuntimeLifecycleOwner(serviceRoot: serviceRoot)
        let otherCopy = LocalRuntimeLifecycleOwner(serviceRoot: serviceRoot)
        var generation = 1
        var probes = 0
        var starts = 0
        var connectedPolls = 0
        let loop = LocalConnectionRecoveryLoop(
            generation: 1, currentGeneration: { generation }, lifecycleOwner: owner,
            prepareProbe: {},
            probe: {
                probes += 1
                return probes == 1 ? .unavailable : .connected
            },
            pollConnected: {
                connectedPolls += 1
                let lease = otherCopy.claim(.reconciliation)
                #expect(lease != nil)
                if let lease { otherCopy.release(lease) }
                generation += 1
                return .superseded
            },
            startDaemon: { _ in
                starts += 1
                #expect(FileManager.default.fileExists(atPath: serviceRoot.path))
                #expect(otherCopy.claim(.installation) == nil)
                return true // injected launcher only; no process is launched
            },
            enterOffline: { Issue.record("First launch unexpectedly denied") },
            pause: { await Task.yield() })
        await loop.run()
        #expect(starts == 1)
        #expect(probes == 2)
        #expect(connectedPolls == 1)
        let permissions = try FileManager.default.attributesOfItem(atPath: serviceRoot.path)[.posixPermissions] as? NSNumber
        #expect(permissions?.intValue == 0o700)
    }

    @Test(arguments: ["symlink", "hardlink", "directory", "permissions", "fifo"])
    func unsafeLockObjectsRefuseWithoutChangingTheirTargets(kind: String) throws {
        let root = try root()
        defer { try? FileManager.default.removeItem(at: root) }
        let leaf = root.appendingPathComponent("lifecycle.lock")
        let target = root.appendingPathComponent("untouched")
        let bytes = Data("fixture bytes".utf8)
        try bytes.write(to: target)
        switch kind {
        case "symlink":
            try FileManager.default.createSymbolicLink(at: leaf, withDestinationURL: target)
        case "hardlink":
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: target.path)
            try FileManager.default.linkItem(at: target, to: leaf)
        case "directory":
            try FileManager.default.createDirectory(at: leaf, withIntermediateDirectories: false)
        case "permissions":
            try bytes.write(to: leaf)
            try FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: leaf.path)
        default:
            #expect(mkfifo(leaf.path, 0o600) == 0)
        }
        #expect(LocalRuntimeLifecycleOwner(serviceRoot: root).claim(.reconciliation) == nil)
        #expect(try Data(contentsOf: target) == bytes)
    }

    @Test func symlinkServiceRootRefusesWithoutRepairingItsTarget() throws {
        let root = try root()
        defer { try? FileManager.default.removeItem(at: root) }
        let privateDirectory = root.appendingPathComponent("real")
        try FileManager.default.createDirectory(
            at: privateDirectory, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o755])
        let alias = root.appendingPathComponent("alias")
        try FileManager.default.createSymbolicLink(at: alias, withDestinationURL: privateDirectory)
        #expect(LocalRuntimeLifecycleOwner(serviceRoot: alias).claim(.installation) == nil)
        let permissions = try FileManager.default.attributesOfItem(atPath: privateDirectory.path)[.posixPermissions] as? NSNumber
        #expect(permissions?.intValue == 0o755)
        let owner = LocalRuntimeLifecycleOwner(serviceRoot: privateDirectory)
        let lease = try #require(owner.claim(.installation))
        owner.release(lease)
        let repaired = try FileManager.default.attributesOfItem(atPath: privateDirectory.path)[.posixPermissions] as? NSNumber
        #expect(repaired?.intValue == 0o700)
    }

    @Test func canonicalDirectoryRepairRejectsASymlinkAncestor() throws {
        let root = try root()
        defer { try? FileManager.default.removeItem(at: root) }
        let real = root.appendingPathComponent("real")
        let directory = real.appendingPathComponent("daemon")
        try FileManager.default.createDirectory(
            at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o755])
        let alias = root.appendingPathComponent("alias")
        try FileManager.default.createSymbolicLink(at: alias, withDestinationURL: real)
        #expect(LocalRuntimeLifecycleOwner(serviceRoot: alias.appendingPathComponent("daemon")).claim(.installation) == nil)
        let permissions = try FileManager.default.attributesOfItem(atPath: directory.path)[.posixPermissions] as? NSNumber
        #expect(permissions?.intValue == 0o755)
    }

    @Test func exactReleaseUnlocksEvenWhileADuplicateRetainsTheDescriptor() throws {
        let root = try root()
        defer { try? FileManager.default.removeItem(at: root) }
        let first = LocalRuntimeLifecycleOwner(serviceRoot: root)
        let second = LocalRuntimeLifecycleOwner(serviceRoot: root)
        let original = try #require(first.claim(.installation))
        defer { first.release(original) }
        // Observe only this fixture owner's private descriptor, without adding a
        // production test API or scanning unrelated process descriptors. A real
        // dup retains the same open-file description; reopening the path would
        // create an independent description and would not exercise this defect.
        let field = try #require(Mirror(reflecting: first).children.first { $0.label == "descriptor" })
        let stored: Int32? = try #require(field.value as? Optional<Int32>)
        let originalFD = try #require(stored)
        let retained = fcntl(originalFD, F_DUPFD_CLOEXEC, 0)
        try #require(retained >= 0)
        defer { close(retained) }
        #expect(second.claim(.reconciliation) == nil)
        first.release(original)
        // No retry: a retained reference must not prolong a released lease.
        let successor = try #require(second.claim(.reconciliation))
        defer { second.release(successor) }
        first.release(original)
        #expect(first.claim(.outageRecovery) == nil)
    }

    @Test func descriptorExcludesAnotherProcessAndReleasesWithoutUnlinking() throws {
        let root = try root()
        defer { try? FileManager.default.removeItem(at: root) }
        let owner = LocalRuntimeLifecycleOwner(serviceRoot: root)
        let lease = try #require(owner.claim(.reconciliation))
        let leaf = root.appendingPathComponent("lifecycle.lock")
        let before = try FileManager.default.attributesOfItem(atPath: leaf.path)[.systemFileNumber] as? NSNumber
        // A tiny offline helper performs exactly one nonblocking flock and exits.
        // It launches no daemon and reads no runtime/config/auth material.
        #expect(try helperLockStatus(leaf) == 2)
        owner.release(lease)
        #expect(try helperLockStatus(leaf) == 0)
        let after = try FileManager.default.attributesOfItem(atPath: leaf.path)[.systemFileNumber] as? NSNumber
        #expect(before == after)
        let next = try #require(owner.claim(.installation))
        owner.release(next)
    }

    private func helperLockStatus(_ leaf: URL) throws -> Int32 {
        let helper = Process()
        helper.executableURL = URL(fileURLWithPath: "/usr/bin/perl")
        helper.environment = ["PATH": "/usr/bin:/bin"]
        helper.arguments = ["-MFcntl=:flock", "-e",
            "open my $lock, '+<', $ARGV[0] or exit 3; exit(flock($lock, LOCK_EX | LOCK_NB) ? 0 : 2);", leaf.path]
        helper.standardOutput = FileHandle.nullDevice
        helper.standardError = FileHandle.nullDevice
        try helper.run()
        helper.waitUntilExit()
        return helper.terminationStatus
    }

    @Test func reconciliationUsesFreshIdentityAfterAnotherAppReleasesOwnership() async throws {
        let root = try root()
        defer { try? FileManager.default.removeItem(at: root) }
        let otherCopy = LocalRuntimeLifecycleOwner(serviceRoot: root)
        let owner = LocalRuntimeLifecycleOwner(serviceRoot: root)
        let lease = try #require(otherCopy.claim(.installation))
        let old = RuntimeClosureIdentity(version: "3.1.0", buildSha: String(repeating: "a", count: 40))
        let selected = RuntimeClosureIdentity(version: "3.2.0", buildSha: String(repeating: "b", count: 40))
        let newer = RuntimeClosureIdentity(version: "3.3.0", buildSha: String(repeating: "c", count: 40))
        let daemon = ReconciliationDaemonStub()
        daemon.targetIdentity = selected
        daemon.servingIdentity = old
        let sut = LocalDaemonReconciler(
            daemon: daemon, lifecycleOwner: owner,
            targetClosure: { LocalRuntimeClosureSelection(
                scriptURL: URL(fileURLWithPath: "/fixtures/daemon"), authority: .installed(selected)) })
        #expect(await sut.reconcile(serving: old) == .deferredForLifecycle)
        daemon.servingIdentity = newer
        otherCopy.release(lease)
        #expect(await sut.reconcile(serving: old) == .deferred(.targetNotNewer, serving: newer, target: selected))
        #expect(daemon.stops == 0)
        #expect(daemon.starts == 0)
    }
}
