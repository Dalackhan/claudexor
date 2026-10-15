import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// A live pre-progress refusal mark: this account's started session refused
/// this requested model before progress. Ordering evidence for that model only.
public struct AccountRefusalMark: Decodable, Sendable, Equatable {
    public let harnessId: String
    public let profileId: String
    /// nil = the harness default model.
    public let requestedModel: String?
    public let observedAt: String
    public let expiresAt: String

    enum CodingKeys: String, CodingKey {
        case harnessId = "harness_id", profileId = "profile_id", requestedModel = "requested_model"
        case observedAt = "observed_at", expiresAt = "expires_at"
    }

    /// A mark whose self-expiry has passed (or cannot be read) is not live.
    public func isLive(at now: Date = Date()) -> Bool {
        parseOffsetTimestamp(expiresAt).map { $0 > now } ?? false
    }
}

/// The latest request an account served for one requested model: a routing
/// observation, never a quota or authentication verdict.
public struct AccountLastService: Decodable, Sendable, Equatable {
    public let harnessId: String
    public let profileId: String
    /// nil = the harness default model.
    public let requestedModel: String?
    public let observedAt: String

    enum CodingKeys: String, CodingKey {
        case harnessId = "harness_id", profileId = "profile_id", requestedModel = "requested_model"
        case observedAt = "observed_at"
    }
}

/// `GET /v2/accounts/routing-evidence`: a separate additive read, negotiated
/// through the operation catalog (`AccountResourceCapabilities.routingEvidence`),
/// so the legacy Accounts payloads stay unchanged for every client.
public struct AccountRoutingEvidence: Decodable, Sendable, Equatable {
    public let refusals: [AccountRefusalMark]
    /// Most recent service first.
    public let lastService: [AccountLastService]

    public init(refusals: [AccountRefusalMark], lastService: [AccountLastService]) {
        self.refusals = refusals
        self.lastService = lastService
    }
}

public extension GatewayClient {
    /// Call only when the catalog advertises the read; a failure is the
    /// caller's to disclose and never invalidates the Accounts listing.
    func accountRoutingEvidence() async throws -> AccountRoutingEvidence {
        let data = try await accountResourceData(request("accounts/routing-evidence", method: "GET"))
        return try Self.decoder.decode(AccountRoutingEvidence.self, from: data)
    }
}
