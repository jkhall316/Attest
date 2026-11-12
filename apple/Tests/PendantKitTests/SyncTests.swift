import XCTest
@testable import PendantKit

/// URLProtocol stub standing in for the Attest server.
final class StubServer: URLProtocol {
    nonisolated(unsafe) static var handler: ((URLRequest, Data) -> (Int, Data))?
    nonisolated(unsafe) static var seen: [(request: URLRequest, body: Data)] = []
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        var body = Data()
        if let s = request.httpBodyStream {
            s.open(); let buf = UnsafeMutablePointer<UInt8>.allocate(capacity: 65536); defer { buf.deallocate() }
            while s.hasBytesAvailable { let n = s.read(buf, maxLength: 65536); if n <= 0 { break }; body.append(buf, count: n) }
            s.close()
        } else { body = request.httpBody ?? Data() }
        StubServer.seen.append((request, body))
        let (code, data) = StubServer.handler?(request, body) ?? (500, Data())
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: code, httpVersion: nil, headerFields: nil)!, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data)
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
    static func session() -> URLSession {
        let c = URLSessionConfiguration.ephemeral; c.protocolClasses = [StubServer.self]; return URLSession(configuration: c)
    }
}

final class SyncTests: XCTestCase {
    let cfg = ServerConfig(server: URL(string: "https://attest.test")!, clientId: "cid.access", clientSecret: "sec")
    let t0: Int64 = 1_750_000_000_000
    override func setUp() { StubServer.seen = []; StubServer.handler = nil }

    func queued(_ dir: URL) throws -> Syncer {
        let s = Syncer(directory: dir, deviceId: "dev1", titleFor: { "Pendant \($0)" })
        try s.journal.append(PendantPage(timestampMs: t0, frames: fakeFrames(120)))
        try s.journal.append(PendantPage(timestampMs: t0 + 300_000, frames: fakeFrames(80)))
        return s
    }

    func testCutThenUploadSendsWhatTheServerNeeds() async throws {
        let s = try queued(tempDir())
        XCTAssertEqual(try s.cut(now: t0 + 3_600_000), 2)
        XCTAssertEqual(s.outbox.pending().count, 2)
        StubServer.handler = { _, _ in (200, Data(#"{"id":"abc"}"#.utf8)) }
        var summary = SyncSummary()
        await s.upload(with: Uploader(config: cfg, session: StubServer.session()), into: &summary)
        XCTAssertEqual(summary.uploaded, 2)
        XCTAssertEqual(s.outbox.pending().count, 0, "removed only after the server said yes")
        XCTAssertEqual(try s.journal.readAll().count, 0)

        let (req, body) = StubServer.seen[0]
        XCTAssertEqual(req.url?.path, "/api/recordings")
        XCTAssertEqual(req.value(forHTTPHeaderField: "CF-Access-Client-Id"), "cid.access")
        XCTAssertEqual(req.value(forHTTPHeaderField: "CF-Access-Client-Secret"), "sec")
        let text = String(decoding: body, as: UTF8.self)
        XCTAssertTrue(text.contains("name=\"ingest_id\"\r\n\r\npendant:dev1:\(t0)"), "stable id, so a retry does not duplicate")
        XCTAssertTrue(text.contains("name=\"created_at\"\r\n\r\n\(t0)"), "the real capture time")
        XCTAssertTrue(text.contains("name=\"duration_ms\"\r\n\r\n2400"))
        XCTAssertNotNil(body.range(of: Data([0x1A, 0x45, 0xDF, 0xA3])), "the WebM itself is in the body")
    }

    func testServerDownKeepsEverythingAndRetries() async throws {
        let s = try queued(tempDir())
        _ = try s.cut(now: t0 + 3_600_000)
        StubServer.handler = { _, _ in (503, Data()) }
        var a = SyncSummary()
        await s.upload(with: Uploader(config: cfg, session: StubServer.session()), into: &a)
        XCTAssertEqual(a.uploaded, 0); XCTAssertEqual(a.failed, 2)
        XCTAssertEqual(s.outbox.pending().count, 2, "nothing lost")
        StubServer.handler = { _, _ in (200, Data(#"{"id":"x"}"#.utf8)) }
        var b = SyncSummary()
        await s.upload(with: Uploader(config: cfg, session: StubServer.session()), into: &b)
        XCTAssertEqual(b.uploaded, 2)
    }

    func testBadTokenStopsAtOnceAndKeepsTheAudio() async throws {
        let s = try queued(tempDir())
        _ = try s.cut(now: t0 + 3_600_000)
        StubServer.handler = { _, _ in (403, Data()) }
        var a = SyncSummary()
        await s.upload(with: Uploader(config: cfg, session: StubServer.session()), into: &a)
        XCTAssertEqual(StubServer.seen.count, 1, "no point trying the second one")
        XCTAssertEqual(s.outbox.pending().count, 2)
        XCTAssertTrue(a.lastError?.contains("Client ID") == true)
    }

    func testEndToEndFromPendantToServer() async throws {
        let pendant = FakePendant()
        pendant.baseTimestamp = t0
        let s = Syncer(directory: tempDir(), deviceId: "dev1")
        let summary = try await s.collect(from: pendant, now: t0 + 3_600_000)
        XCTAssertEqual(summary.drain?.reason, "caught_up")
        XCTAssertEqual(summary.recordingsQueued, 1, "30 pages x 3 frames a minute apart is one recording")
        XCTAssertEqual(pendant.acks.last, 129)
        XCTAssertEqual(s.outbox.pending().first?.durationMs, 90 * 20)
    }

    func testUnsetPendantClockIsStampedOnceSoItStillGetsCut() async throws {
        let pendant = FakePendant()
        pendant.baseTimestamp = 5 // clock never set: 1970
        let s = Syncer(directory: tempDir(), deviceId: "dev1")
        let drainedAt = t0
        let first = try await s.collect(from: pendant, now: drainedAt)
        XCTAssertEqual(first.recordingsQueued, 0, "just drained, so it may still be going")
        XCTAssertEqual(try s.journal.readAll().first?.timestampMs, drainedAt, "stamped with the drain time, and saved that way")
        // ten minutes later, with nothing new, it is old enough to cut
        XCTAssertEqual(try s.cut(now: drainedAt + 10 * 60_000), 1)
        XCTAssertEqual(s.outbox.pending().first?.createdAtMs, drainedAt)
    }

    func testCutIsSafeToRepeatAfterACrash() throws {
        let s = try queued(tempDir())
        XCTAssertEqual(try s.cut(now: t0 + 3_600_000), 2)
        // the journal was rewritten, so a second cut finds nothing; but if the crash came before the rewrite
        // the same ingest ids are produced again and the server stores one copy
        XCTAssertEqual(Outbox.ingestId(deviceId: "dev1", startMs: t0), s.outbox.pending()[0].ingestId)
        XCTAssertEqual(try s.cut(now: t0 + 3_600_000), 0)
    }
}
