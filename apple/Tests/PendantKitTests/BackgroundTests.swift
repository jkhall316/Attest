import XCTest
@testable import PendantKit

final class BackgroundTests: XCTestCase {
    let item = OutboxItem(ingestId: "pendant:dev:1750000000000", createdAtMs: 1_750_000_000_000, durationMs: 2400, title: "Pendant", fileName: "p.webm")

    // MARK: connect links

    func testConnectLinkRoundTrip() {
        let cfg = ServerConfig(server: URL(string: "https://attest.example.com")!, clientId: "abc.access", clientSecret: "s&c=ret/+ x")
        let link = ConnectLink.make(server: cfg.server, clientId: cfg.clientId, clientSecret: cfg.clientSecret)
        XCTAssertEqual(link.scheme, "attest")
        XCTAssertEqual(ConnectLink.parse(link), cfg, "special characters in the secret survive")
    }

    func testConnectLinkRefusesAnythingOddOrInsecure() {
        func parse(_ s: String) -> ServerConfig? { ConnectLink.parse(URL(string: s)!) }
        XCTAssertNil(parse("https://attest.example.com/connect?server=https://x.com"), "wrong scheme")
        XCTAssertNil(parse("attest://other?server=https://x.com"), "wrong action")
        XCTAssertNil(parse("attest://connect?server=http://attest.example.com"), "plain http to a real host would send the token in the clear")
        XCTAssertNil(parse("attest://connect?server=javascript:alert(1)"))
        XCTAssertNil(parse("attest://connect"))
        XCTAssertNotNil(parse("attest://connect?server=http://localhost:8787"), "local development is fine")
        XCTAssertEqual(parse("attest://connect?server=https://a.com")?.clientId, "", "no token is allowed (a local server without Access)")
    }

    // MARK: upload form and outcomes

    func testMultipartHasEveryFieldAndTheAudio() {
        let audio = Data([0x1A, 0x45, 0xDF, 0xA3, 1, 2, 3])
        let body = Multipart.body(item: item, audio: audio, boundary: "BB")
        let text = String(decoding: body, as: UTF8.self)
        for (k, v) in [("ingest_id", item.ingestId), ("created_at", "1750000000000"), ("duration_ms", "2400"), ("title", "Pendant")] {
            XCTAssertTrue(text.contains("name=\"\(k)\"\r\n\r\n\(v)\r\n"), k)
        }
        XCTAssertNotNil(body.range(of: audio))
        XCTAssertTrue(text.hasSuffix("--BB--\r\n"))
        let req = Multipart.request(config: ServerConfig(server: URL(string: "https://a.com")!, clientId: "i", clientSecret: "s"), boundary: "BB")
        XCTAssertEqual(req.url?.absoluteString, "https://a.com/api/recordings")
        XCTAssertEqual(req.value(forHTTPHeaderField: "CF-Access-Client-Id"), "i")
        XCTAssertEqual(req.value(forHTTPHeaderField: "Content-Type"), "multipart/form-data; boundary=BB")
    }

    func testOutcomes() {
        func failure(_ code: Int) -> UploadError? { if case .failure(let e) = Multipart.outcome(code: code) { return e } else { return nil } }
        XCTAssertNoThrow(try Multipart.outcome(code: 200).get())
        XCTAssertEqual(failure(403), .auth(403))
        XCTAssertEqual(failure(401), .auth(401))
        XCTAssertEqual(failure(413), .rejected(413))
        XCTAssertEqual(failure(503), .server(503))
        XCTAssertEqual(failure(0), .server(0))
    }

    // MARK: background session

    /// A real background session: it must take the body from a file, tag the task, and not queue the same recording twice.
    func testEnqueueWritesTheBodyFileTagsTheTaskAndNeverDoublesUp() async throws {
        let dir = tempDir()
        let outbox = Outbox(directory: dir.appendingPathComponent("outbox"))
        let seg = Segment(startMs: 1_750_000_000_000, frames: fakeFrames(60))
        let queued = try outbox.add(seg, deviceId: "dev", title: "T")
        // 127.0.0.1:9 refuses connections, so nothing is actually sent
        let up = BackgroundUploader(config: ServerConfig(server: URL(string: "http://127.0.0.1:9")!, clientId: "i", clientSecret: "s"),
                                    outbox: outbox, identifier: "com.attest.test.\(UUID().uuidString)")
        let n = await up.enqueueAll()
        XCTAssertEqual(n, 1)
        let file = outbox.uploadFileURL(queued)
        let body = try Data(contentsOf: file)
        XCTAssertNotNil(body.range(of: Data(queued.ingestId.utf8)))
        XCTAssertNotNil(body.range(of: Data([0x1A, 0x45, 0xDF, 0xA3])), "the WebM is inside the prepared body")
        let again = await up.enqueueAll()
        XCTAssertEqual(again, 0, "already handed to the system: not queued a second time")
        XCTAssertEqual(outbox.pending().count, 1, "the recording stays in the outbox until the server says yes")
    }

    // MARK: cancellation (iOS says time is up)

    func testCancelledDrainStopsAndAcksOnlyWhatIsSaved() async throws {
        let pendant = FakePendant(), sink = MemorySink()
        pendant.stopAfterPage = 112 // 13 pages arrive, then silence
        var c = DrainEngine.Config(); c.pollInterval = 0.1; c.stallTimeout = 30; c.ackEveryPages = 25
        let engine = DrainEngine(config: c)
        let task = Task { try await engine.drain(link: pendant, sink: sink) }
        try await Task.sleep(nanoseconds: 400_000_000)
        task.cancel()
        let r = try await task.value
        XCTAssertEqual(r.reason, "cancelled")
        XCTAssertEqual(pendant.acks, [112], "ACK exactly the pages that were written, so the pendant resends none of them and loses none")
        XCTAssertEqual(pendant.kinds.last, .download(batch: false), "and the pendant is put back to recording")
    }
}
