import ClaudexorKit
import Testing
@testable import ClaudexorApp

@Suite struct ProjectCheckoutPresentationTests {
    private func context(_ path: String, thread: String? = nil, remote: Bool = false) -> ComposerSelectionContext {
        .init(locationID: remote ? "ssh:11111111-1111-4111-8111-111111111111" : ExecutionLocationID.local.rawValue,
              threadID: thread, repoRoot: path)
    }

    @Test func verifiedGitCheckoutHelpNamesTheSelectedPathAndUsesTheExistingBranchSymbol() {
        let selected = context("/work/main checkout/source")
        let main = ProjectCheckoutPresentation(context: selected, observedContext: selected, status: .mainCheckout)
        #expect(main.symbolName == "arrow.triangle.branch")
        #expect(!main.isWorktree)
        #expect(main.help == "Main checkout: /work/main checkout/source")

        let linked = context("/work/review checkout/source")
        let worktree = ProjectCheckoutPresentation(
            context: linked, observedContext: linked, status: .worktree("review checkout"))
        #expect(worktree.symbolName == "arrow.triangle.branch")
        #expect(worktree.isWorktree)
        #expect(worktree.help == "Worktree: review checkout\n/work/review checkout/source")
    }

    @Test func initialLocalObservationShowsLoadingForOnlyTheSelectedPath() {
        let selected = context("/work/new folder")
        let presentation = ProjectCheckoutPresentation(context: selected, observedContext: nil, status: nil)
        #expect(presentation.symbolName == nil)
        #expect(!presentation.isWorktree)
        #expect(presentation.help == "Checking checkout…\n/work/new folder")
    }

    @Test func ordinaryFolderHasPathHelpWithoutAGitOrUnknownBadge() {
        let selected = context("/work/design notes")
        let presentation = ProjectCheckoutPresentation(
            context: selected, observedContext: selected, status: .ordinaryFolder)
        #expect(presentation.symbolName == nil)
        #expect(presentation.help == "Folder: /work/design notes")
    }

    @Test func aNewSelectionCannotShowThePreviousFoldersStatusEvenBeforeItsTaskStarts() {
        let previous = context("/work/old checkout", thread: "old")
        let selected = context("/work/new folder", thread: "new")
        let presentation = ProjectCheckoutPresentation(
            context: selected, observedContext: previous, status: .worktree("old checkout"))
        #expect(presentation.symbolName == nil)
        #expect(presentation.help == "Checkout status unavailable\n/work/new folder")
    }

    @Test func selectedThreadIdentityFencesEvidenceEvenWhenThePathIsTheSame() {
        let previous = context("/work/app", thread: "old")
        let selected = context("/work/app", thread: "new")
        let presentation = ProjectCheckoutPresentation(
            context: selected, observedContext: previous, status: .mainCheckout)
        #expect(presentation.symbolName == nil)
        #expect(presentation.help == "Checkout status unavailable\n/work/app")
    }

    @Test func unavailableSelectedThreadNeverShowsDraftOrPreviouslySelectedWorkspaceHelp() {
        let previous = context("/work/previous workspace", thread: "old")
        let unavailable = context("", thread: "missing")
        let presentation = ProjectCheckoutPresentation(
            context: unavailable, observedContext: previous, status: .worktree("previous workspace"), metadataKnown: false)
        #expect(presentation.symbolName == nil)
        #expect(presentation.name == "Project unavailable")
        #expect(presentation.help == "Project metadata unavailable")
        #expect(presentation.chipHelp == "Project metadata unavailable\n\nProject for this thread (bound). Pick another to start a new thread there.")
        #expect(presentation.accessibilityValue == "Project unavailable\nProject metadata unavailable")
    }

    @Test func confirmedScopelessThreadKeepsNoProjectCopyInsteadOfUnavailable() {
        let selected = context("", thread: "known-scopeless")
        let presentation = ProjectCheckoutPresentation(
            context: selected, observedContext: nil, status: nil, metadataKnown: true)
        #expect(presentation.name == "No project")
        #expect(presentation.chipHelp == "Project for this thread (bound). Pick another to start a new thread there.")
        #expect(presentation.accessibilityValue == "No project")
        #expect(presentation.symbolName == nil)
    }

    @Test func knownSelectedProjectStillUsesDisambiguatedNameAndPathHelpInTheChip() {
        let selected = context("/work/red/app", thread: "known-project")
        let presentation = ProjectCheckoutPresentation(
            context: selected, observedContext: selected, status: .mainCheckout,
            metadataKnown: true, recent: ["/work/red/app", "/work/blue/app"])
        #expect(presentation.name == "app — red")
        #expect(presentation.chipHelp == "Main checkout: /work/red/app\n\nProject for this thread (bound). Pick another to start a new thread there.")
        #expect(presentation.accessibilityValue == "app — red\nMain checkout: /work/red/app")
    }

    @Test func unavailableProbeReplacesEarlierSuccessForTheSamePath() {
        let selected = context("/work/removed checkout")
        let presentation = ProjectCheckoutPresentation(
            context: selected, observedContext: selected, status: .unavailable)
        #expect(presentation.symbolName == nil)
        #expect(presentation.help == "Checkout status unavailable\n/work/removed checkout")
    }

    @Test func remoteContextNeverPresentsLocalEvidenceEvenForAnIdenticalPath() {
        let local = context("/work/app")
        let remote = context("/work/app", remote: true)
        for observed in [local, remote] {
            let presentation = ProjectCheckoutPresentation(
                context: remote, observedContext: observed, status: .mainCheckout)
            #expect(presentation.symbolName == nil)
            #expect(presentation.help == "Checkout status unavailable on remote host\n/work/app")
        }
    }

    @Test func aDraftWithoutAProjectCannotInheritPreviousEvidence() {
        let presentation = ProjectCheckoutPresentation(
            context: context(""), observedContext: context("/work/app"), status: .mainCheckout)
        #expect(presentation.symbolName == nil)
        #expect(presentation.help == "Checkout status unavailable")
        #expect(presentation.name == "Choose project")
        #expect(presentation.chipHelp == "Working directory for the new thread — pick a recent project or Browse…")
        #expect(presentation.accessibilityValue == "Choose project")
    }
}
