import Foundation
import Testing
@testable import ClaudexorKit

/// One request path → (status, body) table for this suite's client.
private final class EvidenceProtocol: URLProtocol {
    nonisolated(unsafe) static var routes: [String: (Int, String)] = [:]
    nonisolated(unsafe) static var requested: [String] = []
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let path = request.url!.path
        Self.requested.append(path)
        let (status, body) = Self.routes[path] ?? (404, #"{"code":"not_found","message":"no route"}"#)
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: status,
            httpVersion: nil, headerFields: nil)!, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
    static func client() -> GatewayClient {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [Self.self]
        return GatewayClient(baseURL: URL(string: "http://127.0.0.1:1")!, token: "fixture",
                             session: URLSession(configuration: configuration))
    }
}

@Suite(.serialized)
struct AccountRoutingEvidenceTests {
    static let evidence = """
    {"refusals":[{"harness_id":"claude","profile_id":"work","requested_model":null,
      "observed_at":"2026-10-13T08:00:00.000Z","expires_at":"2026-10-13T09:00:00.000Z"}],
     "lastService":[{"harness_id":"claude","profile_id":"work","requested_model":"claude-opus-5-5",
      "observed_at":"2026-10-13T07:00:00.000Z"}]}
    """

    @Test func theCatalogNegotiatesTheAdditiveRead() throws {
        let current = #"{"operations":[{"id":"get:credential-profiles"},{"id":"get:accounts.routing-evidence"}]}"#
        let older = #"{"operations":[{"id":"get:credential-profiles"},{"id":"get:quota"}]}"#
        let decode = { (json: String) in
            try JSONDecoder().decode(AccountResourceOperationCatalog.self, from: Data(json.utf8)).capabilities
        }
        #expect(try decode(current).routingEvidence == true)
        #expect(try decode(older).routingEvidence == false)
    }

    @Test func decodesModelScopedEvidenceAndJudgesExpiry() throws {
        let value = try JSONDecoder().decode(AccountRoutingEvidence.self, from: Data(Self.evidence.utf8))
        let mark = try #require(value.refusals.first)
        #expect(mark.requestedModel == nil)
        #expect(value.lastService.first?.requestedModel == "claude-opus-5-5")
        let before = try #require(ISO8601DateFormatter().date(from: "2026-10-13T08:30:00Z"))
        let after = try #require(ISO8601DateFormatter().date(from: "2026-10-13T09:00:01Z"))
        #expect(mark.isLive(at: before))
        #expect(!mark.isLive(at: after))
        let unreadable = AccountRefusalMark(
            harnessId: "claude", profileId: "work", requestedModel: nil,
            observedAt: "now", expiresAt: "later")
        #expect(!unreadable.isLive(at: before))
    }

    @Test func readsTheAdditivePathAndReportsItsOwnFailure() async throws {
        defer { EvidenceProtocol.routes = [:]; EvidenceProtocol.requested = [] }
        EvidenceProtocol.routes = ["/v2/accounts/routing-evidence": (200, Self.evidence)]
        let client = EvidenceProtocol.client()
        let value = try await client.accountRoutingEvidence()
        #expect(value.lastService.count == 1)
        #expect(EvidenceProtocol.requested == ["/v2/accounts/routing-evidence"])
        EvidenceProtocol.routes = ["/v2/accounts/routing-evidence": (500, #"{"code":"internal"}"#)]
        await #expect(throws: GatewayError.self) { try await client.accountRoutingEvidence() }
    }
}
