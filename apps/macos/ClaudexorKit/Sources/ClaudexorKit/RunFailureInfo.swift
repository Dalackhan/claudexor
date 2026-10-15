import Foundation

public struct WorkspaceCaptureFailureInfo: Codable, Sendable, Equatable {
    public let code: String
    public let message: String
    public let causeCode: String?
    public let bufferBudgetBytes: Int?
    public let stream: String?
    public let drain: String?
    public let cleanup: Cleanup?
    public struct Cleanup: Codable, Sendable, Equatable {
        public let code: String?
        public let message: String
    }
}

public struct RunFailureInfo: Codable, Sendable, Equatable {
    public let captureFailure: WorkspaceCaptureFailureInfo?
    public let phase: String
    public let category: String
    /// Machine-readable sub-code used for exact remediation. Optional keeps
    /// pre-code runtimes decodable without parsing safeMessage.
    public let code: String?
    public let harnessId: String?
    public let attemptId: String?
    public let safeMessage: String
    public let rawDetailRef: String?
    public let logRefs: [String]
    public let eventRefs: [String]
    public let runDir: String?
    public let nextActions: [String]
    /// STRUCTURAL reopen time of the window this run was refused against (e.g.
    /// `subscription_window_exhausted`); nil when the refusal has none. The
    /// wire always carries the key, so dropping it forced every surface to
    /// parse "resets …" out of `safeMessage` — which is what it exists to end.
    public let resetsAt: String?

    enum CodingKeys: String, CodingKey {
        case captureFailure, phase, category, code, harnessId, attemptId, safeMessage, rawDetailRef, logRefs, eventRefs, runDir, nextActions, resetsAt
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        captureFailure = try c.decodeIfPresent(WorkspaceCaptureFailureInfo.self, forKey: .captureFailure)
        phase = try c.decodeIfPresent(String.self, forKey: .phase) ?? "unknown"
        category = try c.decodeIfPresent(String.self, forKey: .category) ?? "unknown"
        code = try c.decodeIfPresent(String.self, forKey: .code)
        harnessId = try c.decodeIfPresent(String.self, forKey: .harnessId)
        attemptId = try c.decodeIfPresent(String.self, forKey: .attemptId)
        safeMessage = try c.decode(String.self, forKey: .safeMessage)
        rawDetailRef = try c.decodeIfPresent(String.self, forKey: .rawDetailRef)
        logRefs = try c.decodeIfPresent([String].self, forKey: .logRefs) ?? []
        eventRefs = try c.decodeIfPresent([String].self, forKey: .eventRefs) ?? []
        runDir = try c.decodeIfPresent(String.self, forKey: .runDir)
        nextActions = try c.decodeIfPresent([String].self, forKey: .nextActions) ?? []
        resetsAt = try c.decodeIfPresent(String.self, forKey: .resetsAt)
    }
}
