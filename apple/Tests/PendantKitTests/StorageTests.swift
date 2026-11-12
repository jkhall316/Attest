import XCTest
@testable import PendantKit

final class StorageTests: XCTestCase {
    // MARK: segmenter

    func page(_ t: Int64, _ n: Int = 50) -> PendantPage { PendantPage(timestampMs: t, frames: fakeFrames(n)) }
    let t0: Int64 = 1_750_000_000_000

    func testGapSplitsRecordingsAndRecentTailStaysOpen() {
        let pages = [page(t0), page(t0 + 1_000), page(t0 + 200_000), page(t0 + 201_000)]
        let r = Segmenter.plan(pages: pages, now: t0 + 210_000)
        XCTAssertEqual(r.closed.count, 1)
        XCTAssertEqual(r.closed[0].startMs, t0)
        XCTAssertEqual(r.closed[0].durationMs, 2_000, "two pages of 50 frames x 20 ms")
        XCTAssertEqual(r.open.count, 2, "the last recording ended 9 s ago: it may still be going")
    }

    func testOldTailClosesToo() {
        let r = Segmenter.plan(pages: [page(t0), page(t0 + 1_000)], now: t0 + 10 * 60_000)
        XCTAssertEqual(r.closed.count, 1)
        XCTAssertEqual(r.open.count, 0)
    }

    func testBlipsAreDropped() {
        let r = Segmenter.plan(pages: [page(t0, 10)], now: t0 + 10 * 60_000)
        XCTAssertEqual(r.closed.count, 0, "under a second is not a conversation")
    }

    func testFifteenMinuteCap() {
        let pages = (0 ..< 20).map { page(t0 + Int64($0) * 60_000 / 2, 3000) } // 60 s of frames every 30 s => one stream
        let r = Segmenter.plan(pages: pages, now: t0 + 3_600_000)
        XCTAssertTrue(r.closed.allSatisfy { $0.frames.count <= Segmenter.maxFrames })
        XCTAssertGreaterThan(r.closed.count, 1)
    }

    func testBogusPendantClockInheritsInsteadOfFakingAGap() {
        let r = Segmenter.plan(pages: [page(t0), page(5, 50), page(t0 + 2_000)], now: t0 + 10 * 60_000)
        XCTAssertEqual(r.closed.count, 1, "a page stamped 1970 must not split the recording")
        let now = t0 + 10 * 60_000
        let lone = Segmenter.plan(pages: [page(5, 60)], now: now)
        XCTAssertEqual(lone.open.first?.timestampMs, now, "with nothing to inherit it falls back to the time of the look")
    }

    // MARK: journal

    func testJournalRoundTripAndTornTail() throws {
        let url = tempDir().appendingPathComponent("j.bin")
        let j = Journal(url: url)
        try j.append(page(t0, 4)); try j.append(page(t0 + 1, 2)); try j.sync()
        XCTAssertEqual(try j.readAll().map { $0.frames.count }, [4, 2])
        // a crash mid-write leaves half a record
        let h = try FileHandle(forWritingTo: url); try h.seekToEnd(); try h.write(contentsOf: Data([0, 0, 1, 0, 9, 9, 9])); try h.close()
        let j2 = Journal(url: url)
        XCTAssertEqual(try j2.readAll().count, 2, "the torn tail is ignored")
        try j2.append(page(t0 + 2, 1)); try j2.sync()
        XCTAssertEqual(try Journal(url: url).readAll().map { $0.frames.count }, [4, 2, 1], "and the next append lands after the last whole record")
        try j2.rewrite([page(t0 + 9, 7)])
        XCTAssertEqual(try Journal(url: url).readAll().map { $0.frames.count }, [7])
    }

    // MARK: WebM

    func toneFrames() throws -> [Data] {
        let d = try Data(contentsOf: Bundle.module.url(forResource: "tone_frames", withExtension: "bin", subdirectory: "Fixtures")!)
        var out: [Data] = []; var p = 0
        while p + 2 <= d.count { let n = Int(d[p]) << 8 | Int(d[p + 1]); p += 2; out.append(d.subdata(in: p ..< p + n)); p += n }
        return out
    }

    func testWebMStructure() {
        XCTAssertEqual(WebMOpus.vint(0), Data([0x80]))
        XCTAssertEqual(WebMOpus.vint(126), Data([0xFE]))
        XCTAssertEqual(WebMOpus.vint(127), Data([0x40, 0x7F]), "all-ones is reserved, so 127 needs two bytes")
        XCTAssertEqual(WebMOpus.vint(300), Data([0x41, 0x2C]))
        let file = WebMOpus.mux(frames: fakeFrames(10))
        XCTAssertEqual(file.prefix(4), Data([0x1A, 0x45, 0xDF, 0xA3]), "EBML magic")
        XCTAssertNotNil(file.range(of: Data("A_OPUS".utf8)))
        XCTAssertNotNil(file.range(of: Data("OpusHead".utf8)))
    }

    /// The real check: ffmpeg must be able to decode what we wrote, to the right length.
    func testFfmpegDecodesTheMuxedFile() throws {
        guard let ffmpeg = ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/usr/bin/ffmpeg"].first(where: { FileManager.default.isExecutableFile(atPath: $0) })
        else { throw XCTSkip("ffmpeg not installed") }
        let frames = try toneFrames()
        XCTAssertEqual(frames.count, 151)
        let url = tempDir().appendingPathComponent("t.webm")
        try WebMOpus.mux(frames: frames).write(to: url)
        let p = Process(); p.executableURL = URL(fileURLWithPath: ffmpeg)
        let out = tempDir().appendingPathComponent("t.wav")
        p.arguments = ["-v", "error", "-y", "-i", url.path, "-ar", "16000", "-ac", "1", out.path]
        let err = Pipe(); p.standardError = err
        try p.run(); p.waitUntilExit()
        let msg = String(data: err.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        XCTAssertEqual(p.terminationStatus, 0, "ffmpeg said: \(msg)")
        XCTAssertEqual(msg, "", "no decode errors")
        let wav = try Data(contentsOf: out)
        let seconds = Double(wav.count - 44) / 2 / 16000
        XCTAssertEqual(seconds, 3.02, accuracy: 0.05, "151 frames x 20 ms")
        // the 440 Hz tone survived: the decoded audio is not silence
        let samples = wav.dropFirst(44).withUnsafeBytes { Array($0.bindMemory(to: Int16.self)) }
        XCTAssertGreaterThan(samples.map { abs(Int($0)) }.max() ?? 0, 1000)
    }
}
