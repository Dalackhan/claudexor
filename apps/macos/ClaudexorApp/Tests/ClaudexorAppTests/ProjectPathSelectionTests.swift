import Foundation
import Testing
@testable import ClaudexorApp

@Suite struct ProjectPathSelectionTests {
    @Test func fixturesUseCheckoutScratchWithoutLauncherConfiguration() throws {
        let fixture = try CheckoutFixture()
        defer { fixture.cleanUp() }
        var checkout = URL(fileURLWithPath: #filePath)
        for _ in 0..<6 { checkout.deleteLastPathComponent() }
        #expect(fixture.root.deletingLastPathComponent().path
            == checkout.appendingPathComponent("tmp").resolvingSymlinksInPath().path)
    }

    @Test func uniqueBasenamesStayQuiet() {
        let paths = ["/work/alpha/app", "/work/beta/tools"]
        #expect(ProjectPathSelection.recentProjectLabel(paths[0], among: paths) == "app")
        #expect(ProjectPathSelection.recentProjectLabel(paths[1], among: paths) == "tools")
    }

    @Test func duplicateBasenamesUseTheShortestContiguousParentSuffix() {
        let paths = ["/work/red/shared/app", "/work/blue/shared/app", "/work/blue/other/app"]
        // Hand-derived expectations: red/blue alone would omit the immediate parent.
        #expect(ProjectPathSelection.recentProjectLabel(paths[0], among: paths) == "app — red/shared")
        #expect(ProjectPathSelection.recentProjectLabel(paths[1], among: paths) == "app — blue/shared")
        #expect(ProjectPathSelection.recentProjectLabel(paths[2], among: paths) == "app — other")
    }

    @Test func aSingleParentIsEnoughWhenItDistinguishesTheFolders() {
        let paths = ["/work/Release One/app", "/work/Release Two/app"]
        #expect(ProjectPathSelection.recentProjectLabel(paths[0], among: paths) == "app — Release One")
        #expect(ProjectPathSelection.recentProjectLabel(paths[1], among: paths) == "app — Release Two")
    }

    @Test func equivalentRepeatedPathsDoNotCreateArtificialAmbiguity() {
        let paths = ["/work/app", "/work/app/", "/work/other/../app"]
        for path in paths {
            #expect(ProjectPathSelection.recentProjectLabel(path, among: paths) == "app")
        }
    }

    @Test func suffixesDistinguishAnAncestorFromItsDescendant() {
        let paths = ["/work/app", "/work/work/app"]
        #expect(ProjectPathSelection.recentProjectLabel(paths[0], among: paths) == "app — /work")
        #expect(ProjectPathSelection.recentProjectLabel(paths[1], among: paths) == "app — work/work")
    }

    @Test func remoteMenusCanFormatPathsWithoutFilesystemOrCrossHostCollisions() {
        let oneHost = ["/srv/red/app", "/srv/blue/app"]
        let anotherHost = ["/srv/red/app"]
        #expect(ProjectPathSelection.recentProjectLabel(oneHost[0], among: oneHost) == "app — red")
        #expect(ProjectPathSelection.recentProjectLabel(anotherHost[0], among: anotherHost) == "app")
        let homeRelative = ["~/red/app", "~/blue/app"]
        #expect(ProjectPathSelection.recentProjectLabel(homeRelative[0], among: homeRelative) == "app — red")
    }

    @Test func ordinaryDirectoriesStayOrdinaryAndTheProbeDoesNotInitializeGit() throws {
        let fixture = try CheckoutFixture()
        defer { fixture.cleanUp() }
        let folder = try fixture.directory("ordinary folder")
        #expect(fixture.status(folder) == .ordinaryFolder)
        #expect(!FileManager.default.fileExists(atPath: folder.appendingPathComponent(".git").path))
        #expect(fixture.status(fixture.root) == .ordinaryFolder)
    }

    @Test func missingEmptyAndFileSelectionsAreUnavailable() throws {
        let fixture = try CheckoutFixture()
        defer { fixture.cleanUp() }
        #expect(fixture.status(fixture.root.appendingPathComponent("missing")) == .unavailable)
        #expect(ProjectPathSelection.checkoutStatus(
            for: "", isLocal: true, searchBoundary: fixture.root.path) == .unavailable)
        let file = try fixture.write("ordinary file", at: "file")
        #expect(fixture.status(file) == .unavailable)
    }

    @Test func primaryCheckoutAndItsSubdirectoryAreDetectedWithoutMutation() throws {
        let fixture = try CheckoutFixture()
        defer { fixture.cleanUp() }
        let main = try fixture.repository("primary checkout")
        let nested = try fixture.directory("primary checkout/source/nested")
        let head = main.appendingPathComponent(".git/HEAD")
        let config = main.appendingPathComponent(".git/config")
        let before = try [Data(contentsOf: head), Data(contentsOf: config)]
        #expect(fixture.status(main) == .mainCheckout)
        #expect(fixture.status(nested) == .mainCheckout)
        #expect(try [Data(contentsOf: head), Data(contentsOf: config)] == before)
    }

    @Test(arguments: ["garbage\n", "ref: \n", "ref: HEAD\n", "ref: refs/heads/main\ntrailing garbage\n",
                      String(repeating: "g", count: 40) + "\n", "\n" + String(repeating: "a", count: 40) + "\n"])
    func forgedRepositoryWithMalformedHeadIsUnavailable(head: String) throws {
        let fixture = try CheckoutFixture()
        defer { fixture.cleanUp() }
        let folder = try fixture.directory("forged checkout")
        _ = try fixture.directory("forged checkout/.git/objects")
        _ = try fixture.directory("forged checkout/.git/refs")
        try Data(head.utf8).write(to: folder.appendingPathComponent(".git/HEAD"))
        #expect(fixture.status(folder) == .unavailable)
    }

    @Test func registeredWorktreeWithMalformedAdministrativeHeadIsUnavailable() throws {
        let fixture = try CheckoutFixture()
        defer { fixture.cleanUp() }
        let linked = try fixture.linkedWorktree()
        let admin = try fixture.adminDirectory(for: linked)
        try Data("garbage\n".utf8).write(to: admin.appendingPathComponent("HEAD"))
        #expect(fixture.status(linked) == .unavailable)
        #expect(fixture.status(fixture.root.appendingPathComponent("primary checkout")) == .mainCheckout)
    }

    @Test func registeredWorktreeWithMalformedCommonRepositoryHeadIsUnavailable() throws {
        let fixture = try CheckoutFixture()
        defer { fixture.cleanUp() }
        let linked = try fixture.linkedWorktree()
        let main = fixture.root.appendingPathComponent("primary checkout")
        try Data("garbage\n".utf8).write(to: main.appendingPathComponent(".git/HEAD"))
        #expect(fixture.status(main) == .unavailable)
        #expect(fixture.status(linked) == .unavailable)
    }

    @Test(arguments: ["ref: refs/heads/unborn\n", "ref:\trefs/heads/feature/topic\n",
                      String(repeating: "a", count: 40) + "\n", String(repeating: "B", count: 64) + "\n"])
    func validSymbolicAndDetachedHeadsRemainSupported(head: String) throws {
        let fixture = try CheckoutFixture()
        defer { fixture.cleanUp() }
        let linked = try fixture.linkedWorktree()
        let main = fixture.root.appendingPathComponent("primary checkout")
        let admin = try fixture.adminDirectory(for: linked)
        try Data(head.utf8).write(to: main.appendingPathComponent(".git/HEAD"))
        try Data(head.utf8).write(to: admin.appendingPathComponent("HEAD"))
        #expect(fixture.status(main) == .mainCheckout)
        #expect(fixture.status(linked) == .worktree("linked checkout"))
    }

    @Test func linkedDetachedWorktreeWithSpacesAndItsSubdirectoryAreDetected() throws {
        let fixture = try CheckoutFixture()
        defer { fixture.cleanUp() }
        let linked = try fixture.linkedWorktree()
        let nested = try fixture.directory("linked checkout/source/nested")
        let marker = linked.appendingPathComponent(".git")
        let before = try Data(contentsOf: marker)
        #expect(fixture.status(linked) == .worktree("linked checkout"))
        #expect(fixture.status(nested) == .worktree("linked checkout"))
        #expect(try Data(contentsOf: marker) == before)
    }

    @Test func canonicalSymlinkSpellingKeepsWorktreeMembership() throws {
        let fixture = try CheckoutFixture()
        defer { fixture.cleanUp() }
        let linked = try fixture.linkedWorktree()
        let alias = fixture.root.appendingPathComponent("checkout alias")
        try FileManager.default.createSymbolicLink(at: alias, withDestinationURL: linked)
        #expect(fixture.status(alias) == .worktree("linked checkout"))
    }

    @Test func relativeGitdirAndCommonDirPointersAreSupported() throws {
        let fixture = try CheckoutFixture()
        defer { fixture.cleanUp() }
        let linked = try fixture.linkedWorktree()
        let admin = try fixture.adminDirectory(for: linked)
        let relativeAdmin = "../primary checkout/.git/worktrees/" + admin.lastPathComponent
        try Data("gitdir: \(relativeAdmin)\n".utf8).write(to: linked.appendingPathComponent(".git"))
        // Git's native fixture already uses ../.. for commondir.
        #expect(try String(contentsOf: admin.appendingPathComponent("commondir"), encoding: .utf8) == "../..\n")
        #expect(fixture.status(linked) == .worktree("linked checkout"))
    }

    @Test func separateGitDirectoryIsAPrimaryCheckoutNotALinkedWorktree() throws {
        let fixture = try CheckoutFixture()
        defer { fixture.cleanUp() }
        let main = try fixture.directory("separate checkout")
        let metadata = fixture.root.appendingPathComponent("separate metadata")
        try fixture.git(["init", "--template=", "--initial-branch=main",
                         "--separate-git-dir", metadata.path, main.path])
        #expect(fixture.status(main) == .mainCheckout)
    }

    @Test(arguments: ["not a gitdir pointer\n", "gitdir: missing metadata\n", "gitdir: .\n"])
    func aGitNamedFileDoesNotProveAWorktree(marker: String) throws {
        let fixture = try CheckoutFixture()
        defer { fixture.cleanUp() }
        let folder = try fixture.directory("fake checkout")
        try Data(marker.utf8).write(to: folder.appendingPathComponent(".git"))
        #expect(fixture.status(folder) == .unavailable)
    }

    @Test func aGitNamedDirectoryWithoutRepositoryMetadataIsUnavailable() throws {
        let fixture = try CheckoutFixture()
        defer { fixture.cleanUp() }
        let folder = try fixture.directory("fake checkout")
        _ = try fixture.directory("fake checkout/.git")
        #expect(fixture.status(folder) == .unavailable)
    }

    @Test func oversizedGitdirMetadataIsUnavailable() throws {
        let fixture = try CheckoutFixture()
        defer { fixture.cleanUp() }
        let folder = try fixture.directory("oversized marker")
        try Data(("gitdir: " + String(repeating: "x", count: 131_072)).utf8)
            .write(to: folder.appendingPathComponent(".git"))
        #expect(fixture.status(folder) == .unavailable)
    }

    @Test func aSelfReferentialCommonDirectoryIsUnavailable() throws {
        let fixture = try CheckoutFixture()
        defer { fixture.cleanUp() }
        let linked = try fixture.linkedWorktree()
        let admin = try fixture.adminDirectory(for: linked)
        try Data(".\n".utf8).write(to: admin.appendingPathComponent("commondir"))
        #expect(fixture.status(linked) == .unavailable)
    }

    @Test func anotherFoldersGitdirPointerDoesNotEstablishMembership() throws {
        let fixture = try CheckoutFixture()
        defer { fixture.cleanUp() }
        let linked = try fixture.linkedWorktree()
        let fake = try fixture.directory("unregistered checkout")
        try Data(contentsOf: linked.appendingPathComponent(".git"))
            .write(to: fake.appendingPathComponent(".git"))
        #expect(fixture.status(fake) == .unavailable)
        #expect(fixture.status(linked) == .worktree("linked checkout"))
    }

    @Test func unrelatedCommonDirectoryAndBrokenBacklinkAreUnavailable() throws {
        let fixture = try CheckoutFixture()
        defer { fixture.cleanUp() }
        let linked = try fixture.linkedWorktree()
        let admin = try fixture.adminDirectory(for: linked)
        let other = try fixture.repository("unrelated repository")
        let common = admin.appendingPathComponent("commondir")
        let original = try Data(contentsOf: common)
        try Data((other.appendingPathComponent(".git").path + "\n").utf8).write(to: common)
        #expect(fixture.status(linked) == .unavailable)
        try original.write(to: common)
        try Data((fixture.root.appendingPathComponent("missing/.git").path + "\n").utf8)
            .write(to: admin.appendingPathComponent("gitdir"))
        #expect(fixture.status(linked) == .unavailable)
    }

    @Test func remoteSelectionNeverGetsLocalRepositoryEvidence() throws {
        let fixture = try CheckoutFixture()
        defer { fixture.cleanUp() }
        let linked = try fixture.linkedWorktree()
        #expect(fixture.status(linked, isLocal: false) == .unavailable)
        #expect(fixture.status(fixture.root.appendingPathComponent("missing"), isLocal: false) == .unavailable)
    }
}

/// Every read/write and Git subprocess is confined to a unique controlled fixture.
/// Fixture allocation is checkout-local regardless of the launcher's TMPDIR.
private struct CheckoutFixture {
    let root: URL

    init() throws {
        var checkout = URL(fileURLWithPath: #filePath)
        for _ in 0..<6 { checkout.deleteLastPathComponent() }
        let scratch = checkout.appendingPathComponent("tmp").resolvingSymlinksInPath()
        root = scratch.appendingPathComponent("checkout-provenance-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    }

    func cleanUp() { try? FileManager.default.removeItem(at: root) }

    func directory(_ relative: String) throws -> URL {
        let target = root.appendingPathComponent(relative)
        try FileManager.default.createDirectory(at: target, withIntermediateDirectories: true)
        return target
    }

    func write(_ value: String, at relative: String) throws -> URL {
        let target = root.appendingPathComponent(relative)
        try Data(value.utf8).write(to: target)
        return target
    }

    func status(_ folder: URL, isLocal: Bool = true) -> ProjectCheckoutStatus {
        ProjectPathSelection.checkoutStatus(
            for: folder.path, isLocal: isLocal, searchBoundary: root.path)
    }

    func repository(_ name: String) throws -> URL {
        let target = try directory(name)
        try git(["init", "--template=", "--initial-branch=main", target.path])
        return target
    }

    func linkedWorktree() throws -> URL {
        let main = try repository("primary checkout")
        try git(["-C", main.path, "commit", "--allow-empty", "--no-verify", "--no-gpg-sign", "-m", "Fixture"])
        let linked = root.appendingPathComponent("linked checkout")
        try git(["-C", main.path, "worktree", "add", "--detach", linked.path, "HEAD"])
        return linked
    }

    func adminDirectory(for linked: URL) throws -> URL {
        let marker = try String(contentsOf: linked.appendingPathComponent(".git"), encoding: .utf8)
        try #require(marker.hasPrefix("gitdir: "))
        let path = String(marker.dropFirst(8)).trimmingCharacters(in: .newlines)
        let admin = URL(fileURLWithPath: path).resolvingSymlinksInPath()
        try #require(admin.path.hasPrefix(root.resolvingSymlinksInPath().path + "/"))
        return admin
    }

    func git(_ arguments: [String]) throws {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/git")
        process.currentDirectoryURL = root
        process.arguments = ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false"] + arguments
        process.environment = [
            "PATH": "/usr/bin:/bin", "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": "/dev/null",
            "GIT_TERMINAL_PROMPT": "0", "GIT_AUTHOR_NAME": "Fixture", "GIT_COMMITTER_NAME": "Fixture",
            "GIT_AUTHOR_EMAIL": "fixture@example.invalid", "GIT_COMMITTER_EMAIL": "fixture@example.invalid",
        ]
        let output = Pipe()
        process.standardOutput = output
        process.standardError = output
        try process.run()
        try output.fileHandleForWriting.close()
        let data = output.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        try output.fileHandleForReading.close()
        try #require(process.terminationStatus == 0, "Fixture git failed: \(String(decoding: data, as: UTF8.self))")
    }
}
