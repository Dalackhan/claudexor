import Foundation
import Network
import Testing
import ClaudexorKit
@testable import ClaudexorApp

// Regression coverage promoted from the isolated discovery consumer. Exercises the PRODUCTION default
// AppModel.makeDaemonControl() closure end to end: ControlApiDiscovery.load()
// from the synthetic CLAUDEXOR_CONFIG_DIR -> makeClient() (URLSession.shared)
// -> real loopback HTTP -> AppRuntimeDaemonControl reduction. The endpoint is
// an in-process NWListener bound to 127.0.0.1 with a private fixture token.

private let recordedNewRecoveryOnly = #"{"protocolMajor":3,"compatible":true,"operationsPath":"/v2/operations","engine":{"version":"4.2.0","sha":"fe3d4d244d11924ea96d4588084109d5fcedcfe7","entry":"/runtime/versions/4.2.0/claudexord.bundle.cjs"},"servingMode":"recovery_only"}"#
private let normalNew = #"{"protocolMajor":3,"compatible":true,"operationsPath":"/v2/operations","engine":{"version":"4.2.0","sha":"fe3d4d244d11924ea96d4588084109d5fcedcfe7","entry":"/runtime/versions/4.2.0/claudexord.bundle.cjs"},"servingMode":"normal"}"#
private let recordedProductRefusal = #"{"code":"daemon_recovery_only","message":"daemon is serving recovery only; product routes are closed until journal recovery completes","retryable":true,"fieldErrors":{},"requiredActions":["retry after recovery completes"],"evidenceRefs":[],"context":{}}"#

private final class DiscoveryOnce: @unchecked Sendable {
    private let lock = NSLock()
    private var done = false
    func claim() -> Bool { lock.withLock { defer { done = true }; return !done } }
}

private final class DiscoveryLoopbackServer: @unchecked Sendable {
    private let listener: NWListener
    private let queue = DispatchQueue(label: "test.runtime-discovery")
    private let lock = NSLock()
    private let handshakeBody: String
    private let token: String
    private let recovery: Bool
    private var log: [String] = []

    init(handshakeBody: String, token: String, recovery: Bool) throws {
        self.recovery = recovery
        let parameters = NWParameters.tcp
        parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any)
        listener = try NWListener(using: parameters)
        self.handshakeBody = handshakeBody
        self.token = token
    }

    var requests: [String] { lock.withLock { log } }

    func start() async throws -> UInt16 {
        listener.newConnectionHandler = { [weak self] connection in
            connection.start(queue: self?.queue ?? .main)
            self?.receive(connection, buffer: Data())
        }
        return try await withCheckedThrowingContinuation { continuation in
            let once = DiscoveryOnce()
            listener.stateUpdateHandler = { [listener] state in
                switch state {
                case .ready:
                    if once.claim() { continuation.resume(returning: listener.port?.rawValue ?? 0) }
                case let .failed(error):
                    if once.claim() { continuation.resume(throwing: error) }
                default: break
                }
            }
            listener.start(queue: queue)
        }
    }

    func stop() { listener.cancel() }

    private func receive(_ connection: NWConnection, buffer: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 65_536) { [weak self] data, _, done, error in
            guard let self else { return }
            var buffer = buffer
            if let data { buffer.append(data) }
            let text = String(decoding: buffer, as: UTF8.self)
            guard let headerEnd = text.range(of: "\r\n\r\n") else {
                if done || error != nil { connection.cancel() } else { self.receive(connection, buffer: buffer) }
                return
            }
            let head = String(text[..<headerEnd.lowerBound])
            let length = head.split(separator: "\r\n")
                .first { $0.lowercased().hasPrefix("content-length:") }
                .flatMap { Int($0.split(separator: ":")[1].trimmingCharacters(in: .whitespaces)) } ?? 0
            let bodyBytes = buffer.count - (text[..<headerEnd.upperBound].utf8.count)
            if bodyBytes < length && !done && error == nil {
                self.receive(connection, buffer: buffer)
                return
            }
            let requestLine = head.split(separator: "\r\n").first.map(String.init) ?? ""
            let authorized = head.split(separator: "\r\n").contains { $0 == "Authorization: Bearer \(self.token)" }
            self.lock.withLock { self.log.append("\(requestLine) authorized=\(authorized)") }
            let path = requestLine.split(separator: " ").dropFirst().first.map(String.init) ?? ""
            let (status, body): (String, String)
            if !authorized {
                (status, body) = ("401 Unauthorized", #"{"code":"unauthorized"}"#)
            } else if path == "/healthz" {
                (status, body) = ("200 OK", #"{"ok":true}"#)
            } else if path == "/v2/handshake" {
                (status, body) = ("200 OK", self.handshakeBody)
            } else if self.recovery {
                (status, body) = ("503 Service Unavailable", recordedProductRefusal)
            } else if path == "/v2/runs?state=running&limit=1" || path == "/v2/runs?state=queued&limit=1" {
                (status, body) = ("200 OK", #"{"runs":[]}"#)
            } else if path == "/v2/setup/jobs?active=true&limit=1" {
                (status, body) = ("200 OK", #"{"jobs":[]}"#)
            } else {
                (status, body) = ("404 Not Found", #"{"code":"unexpected_test_route"}"#)
            }
            let response = "HTTP/1.1 \(status)\r\nContent-Type: application/json\r\nContent-Length: \(body.utf8.count)\r\nConnection: close\r\n\r\n\(body)"
            connection.send(content: Data(response.utf8), completion: .contentProcessed { _ in connection.cancel() })
        }
    }
}

@Suite struct RuntimeDefaultDiscoveryTests {
    @MainActor
    @Test func productionDefaultDiscoversNormalIdleAndRecoveryOnly() async throws {
        try await isolatedRuntimeConsumer("RuntimeDefaultDiscoveryTests/productionDefaultDiscoversNormalIdleAndRecoveryOnly") {
            let configDir = try #require(ProcessInfo.processInfo.environment["CLAUDEXOR_CONFIG_DIR"])
            #expect(ControlApiDiscovery.defaultPath().path == configDir + "/daemon/control-api.json")
            let daemonDir = URL(fileURLWithPath: configDir).appendingPathComponent("daemon", isDirectory: true)
            try FileManager.default.createDirectory(at: daemonDir, withIntermediateDirectories: true,
                attributes: [.posixPermissions: 0o700])
            let discovery = daemonDir.appendingPathComponent("control-api.json")
            let tokenFile = daemonDir.appendingPathComponent("token")
            let token = UUID().uuidString
            try Data(token.utf8).write(to: tokenFile)
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: tokenFile.path)

            let model = AppModel(requestNotificationAuthorization: false)
            let production = model.makeDaemonControl() // unchanged production default
            #expect(await production.servingHandshake() == nil) // cold: no discovery
            #expect(await production.isBusy() == nil)
            for recovery in [false, true, false] {
                let server = try DiscoveryLoopbackServer(
                    handshakeBody: recovery ? recordedNewRecoveryOnly : normalNew, token: token, recovery: recovery)
                let port = try await server.start()
                defer { server.stop() }
                try Data(#"{"host":"127.0.0.1","port":\#(port),"tokenPath":"\#(tokenFile.path)"}"#.utf8).write(to: discovery)
                try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: discovery.path)
                #expect(await production.servingHandshake() == RuntimeServingHandshake(
                    identity: RuntimeClosureIdentity(version: "4.2.0", buildSha: "fe3d4d244d11924ea96d4588084109d5fcedcfe7"),
                    recoveryOnly: recovery))
                #expect(await production.handshakeIdentity()?.version == "4.2.0")
                #expect(await production.isBusy() == (recovery ? nil : false))
                #expect(server.requests.allSatisfy { $0.hasSuffix("authorized=true") })
                #expect(server.requests.contains("GET /healthz HTTP/1.1 authorized=true"))
                #expect(server.requests.contains("POST /v2/handshake HTTP/1.1 authorized=true"))
                if !recovery {
                    for route in ["runs?state=running&limit=1", "runs?state=queued&limit=1", "setup/jobs?active=true&limit=1"] {
                        #expect(server.requests.contains("GET /v2/\(route) HTTP/1.1 authorized=true"))
                    }
                }
                print("Default discovery recovery=\(recovery): \(server.requests)")
            }
        }
    }
}
