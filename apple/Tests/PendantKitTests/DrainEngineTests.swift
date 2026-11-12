import XCTest
@testable import PendantKit

final class DrainEngineTests: XCTestCase {
    func engine(ackEvery: Int = 25, stall: TimeInterval = 0.4) -> DrainEngine {
        var c = DrainEngine.Config()
        c.statusTimeout = 0.5; c.stallTimeout = stall; c.pollInterval = 0.1; c.ackEveryPages = ackEvery
        return DrainEngine(config: c)
    }

    func testDrainsEverythingAndAcksOnlyDurablePages() async throws {
        let pendant = FakePendant(), sink = MemorySink()
        let r = try await engine().drain(link: pendant, sink: sink)
        XCTAssertEqual(r.reason, "caught_up")
        XCTAssertEqual(r.pages, 30)
        XCTAssertEqual(r.frames, 90)
        XCTAssertEqual(sink.pages.count, 30)
        XCTAssertEqual(pendant.acks, [124, 129], "an ACK after each 25 durable pages, then the rest")
        XCTAssertEqual(sink.durableCount, 30)
        // order of commands: clock, status, download, ACKs..., back to record-to-flash
        XCTAssertEqual(pendant.kinds.first, .setTime)
        XCTAssertEqual(pendant.kinds[1], .status)
        XCTAssertEqual(pendant.kinds[2], .download(batch: true))
        XCTAssertEqual(pendant.kinds.last, .download(batch: false), "left recording to flash, not stuck in download mode")
    }

    func testNeverAcksWhenTheDiskBarrierFails() async throws {
        let pendant = FakePendant(), sink = MemorySink()
        sink.failSync = true
        let r = try await engine().drain(link: pendant, sink: sink)
        XCTAssertEqual(r.reason, "append_failed")
        XCTAssertEqual(pendant.acks, [], "pages that are not durably saved must not be ACKed: an ACK deletes the pendant's copy")
    }

    func testAppendFailureAcksOnlyWhatWasSaved() async throws {
        let pendant = FakePendant(), sink = MemorySink()
        sink.failAppendAfter = 10
        let r = try await engine().drain(link: pendant, sink: sink)
        XCTAssertEqual(r.reason, "append_failed")
        XCTAssertEqual(sink.pages.count, 10)
        XCTAssertEqual(pendant.acks, [109], "pages 100...109 were saved; nothing past that is ACKed")
    }

    func testStallKeepsAndAcksWhatArrived() async throws {
        let pendant = FakePendant(), sink = MemorySink()
        pendant.stopAfterPage = 105
        let r = try await engine().drain(link: pendant, sink: sink)
        XCTAssertEqual(r.reason, "stall")
        XCTAssertEqual(r.pages, 6)
        XCTAssertEqual(pendant.acks, [105])
        XCTAssertEqual(pendant.kinds.last, .download(batch: false))
    }

    func testNothingStored() async throws {
        let pendant = FakePendant(), sink = MemorySink()
        pendant.oldest = 200; pendant.newest = 199
        let r = try await engine().drain(link: pendant, sink: sink)
        XCTAssertEqual(r.reason, "nothing_stored")
        XCTAssertFalse(pendant.kinds.contains(.download(batch: true)))
    }

    func testStatusTimeout() async throws {
        let pendant = FakePendant(), sink = MemorySink()
        pendant.answerStatus = false
        let r = try await engine().drain(link: pendant, sink: sink)
        XCTAssertEqual(r.reason, "status_timeout")
        XCTAssertEqual(pendant.acks, [])
    }

    func testClockIsSetBeforeAnythingElse() async throws {
        let pendant = FakePendant(), sink = MemorySink()
        let e = DrainEngine(config: DrainEngine.Config(), clock: { 1_750_000_000_000 })
        pendant.oldest = 1; pendant.newest = 0
        _ = try await e.drain(link: pendant, sink: sink)
        XCTAssertEqual(hexString(pendant.writes[0]), "080010001801221032070880b883a1f732f2010408011000", "msg6 at that time, same bytes as Omi's golden vector")
    }
}
