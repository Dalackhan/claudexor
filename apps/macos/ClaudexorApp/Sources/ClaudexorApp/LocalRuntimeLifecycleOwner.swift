import Darwin
import Foundation

public enum LocalRuntimeLifecycleOperation: Sendable, Equatable {
    case reconciliation
    case installation
    case outageRecovery
}

public struct LocalRuntimeLifecycleLease: Sendable, Equatable {
    fileprivate let id: UUID
    public let operation: LocalRuntimeLifecycleOperation
}

/// A process-local completion receipt for observations suspended across another
/// action. Cross-process callers must always re-read discovery after admission.
struct LocalRuntimeLifecycleCompletionSnapshot: Sendable, Equatable {
    fileprivate let sequence: UInt64
}

/// A queued launcher must present this at the actual spawn boundary, after its
/// asynchronous probe. Releasing the exact lease cancels pending spawn work.
struct LocalRuntimeLaunchPermit: Sendable {
    fileprivate let owner: LocalRuntimeLifecycleOwner
    fileprivate let lease: LocalRuntimeLifecycleLease
    fileprivate let deadline: ContinuousClock.Instant

    func perform(_ spawn: () -> Bool) -> Bool {
        owner.performLaunch(lease, before: deadline, spawn: spawn)
    }
}

/// Serializes app lifecycle transactions, separately from the daemon's writer
/// authority and the installer's pointer lock. Production supplies the canonical
/// discovery directory; tests default to an in-memory owner with no host I/O.
public final class LocalRuntimeLifecycleOwner: @unchecked Sendable {
    private let lock = NSLock()
    private let serviceRoot: URL?
    private var current: LocalRuntimeLifecycleLease?
    private var completionSequence: UInt64 = 0
    private var descriptor: Int32?

    public init(serviceRoot: URL? = nil) {
        self.serviceRoot = serviceRoot
    }

    deinit { if let descriptor { Self.unlockAndClose(descriptor) } }

    public func claim(_ operation: LocalRuntimeLifecycleOperation) -> LocalRuntimeLifecycleLease? {
        lock.withLock { claimWhileLocked(operation) }
    }

    func completionSnapshot() -> LocalRuntimeLifecycleCompletionSnapshot {
        lock.withLock { LocalRuntimeLifecycleCompletionSnapshot(sequence: completionSequence) }
    }

    func launchPermit(
        for lease: LocalRuntimeLifecycleLease, until deadline: ContinuousClock.Instant
    ) -> LocalRuntimeLaunchPermit {
        LocalRuntimeLaunchPermit(owner: self, lease: lease, deadline: deadline)
    }

    fileprivate func performLaunch(
        _ lease: LocalRuntimeLifecycleLease, before deadline: ContinuousClock.Instant,
        spawn: () -> Bool
    ) -> Bool {
        lock.withLock {
            guard current == lease, ContinuousClock.now < deadline else { return false }
            // Exact release cannot interleave between validation and Process.run.
            return spawn()
        }
    }

    func claim(
        _ operation: LocalRuntimeLifecycleOperation,
        ifNoCompletionSince snapshot: LocalRuntimeLifecycleCompletionSnapshot
    ) -> LocalRuntimeLifecycleLease? {
        lock.withLock {
            guard completionSequence == snapshot.sequence else { return nil }
            return claimWhileLocked(operation)
        }
    }

    public func release(_ lease: LocalRuntimeLifecycleLease) {
        lock.withLock {
            guard current == lease else { return }
            if let descriptor { Self.unlockAndClose(descriptor) }
            descriptor = nil
            current = nil
            completionSequence += 1
        }
    }

    private static func unlockAndClose(_ fd: Int32) {
        // dup/fork references share a flock; close alone waits for every copy
        // to close, including a child that has not reached its CLOEXEC yet.
        flock(fd, LOCK_UN)
        close(fd)
    }

    private func claimWhileLocked(
        _ operation: LocalRuntimeLifecycleOperation
    ) -> LocalRuntimeLifecycleLease? {
        guard current == nil else { return nil }
        if let serviceRoot {
            guard let fd = Self.acquireDescriptor(in: serviceRoot) else { return nil }
            descriptor = fd
        }
        let lease = LocalRuntimeLifecycleLease(id: UUID(), operation: operation)
        current = lease
        return lease
    }

    /// Engine-style owned-directory validation/repair, then SecureLocalFile's
    /// no-follow openat and singly linked private regular-file validation. No
    /// file contents or process identity are authority; the inode is never unlinked.
    private static func acquireDescriptor(in root: URL) -> Int32? {
        let flags = O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC
        var directoryFD = open(root.path, flags)
        if directoryFD < 0 && errno == ENOENT {
            // First app launch may precede daemon directory creation. Foundation
            // supplies the existing private-directory creation pattern; no custom
            // ancestor walker or writer-lease migration is introduced here.
            do {
                try FileManager.default.createDirectory(
                    at: root, withIntermediateDirectories: true,
                    attributes: [.posixPermissions: 0o700])
            } catch { return nil }
            directoryFD = open(root.path, flags)
        }
        guard directoryFD >= 0 else { return nil }
        defer { close(directoryFD) }
        var directory = stat()
        var named = stat()
        guard fstat(directoryFD, &directory) == 0,
              directory.st_mode & mode_t(S_IFMT) == mode_t(S_IFDIR),
              directory.st_uid == geteuid(),
              lstat(root.path, &named) == 0,
              named.st_mode & mode_t(S_IFMT) == mode_t(S_IFDIR),
              directory.st_dev == named.st_dev, directory.st_ino == named.st_ino,
              root.resolvingSymlinksInPath().path == root.path
        else { return nil }
        // Match the engine's owned-directory admission: prove canonical inode
        // and uid first, then repair permissions through that same descriptor.
        if directory.st_mode & 0o777 != 0o700 {
            guard fchmod(directoryFD, 0o700) == 0 else { return nil }
        }
        guard fstat(directoryFD, &directory) == 0,
              directory.st_mode & 0o777 == 0o700
        else { return nil }
        let fd = openat(directoryFD, "lifecycle.lock",
            O_CREAT | O_RDWR | O_NONBLOCK | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard fd >= 0 else { return nil }
        var file = stat()
        guard fstat(fd, &file) == 0,
              file.st_mode & mode_t(S_IFMT) == mode_t(S_IFREG),
              file.st_uid == geteuid(), file.st_nlink == 1,
              file.st_mode & 0o777 == 0o600, flock(fd, LOCK_EX | LOCK_NB) == 0
        else { close(fd); return nil }
        return fd
    }
}
