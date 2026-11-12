import Foundation
import XCTest
@testable import PendantKit

func hex(_ s: String) -> Data {
    var d = Data(); var i = s.startIndex
    while i < s.endIndex { let j = s.index(i, offsetBy: 2); d.append(UInt8(s[i ..< j], radix: 16)!); i = j }
    return d
}
func hexString(_ d: Data) -> String { d.map { String(format: "%02x", $0) }.joined() }

func fixture(_ name: String) throws -> [String: Any] {
    let url = Bundle.module.url(forResource: name, withExtension: "json", subdirectory: "Fixtures")!
    return try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as! [String: Any]
}

/// Opus-looking frames: the right table-of-contents byte and a plausible size, so the parser accepts them.
func fakeFrames(_ n: Int, seed: UInt8 = 1) -> [Data] {
    (0 ..< n).map { i in Data([0xb8] + (0 ..< 39).map { UInt8(truncatingIfNeeded: Int(seed) &* 31 &+ i &* 7 &+ $0) }) }
}

/// Builds the bytes a pendant would send, using the same wire format the parser reads.
enum Wire {
    static func varint(_ v: Int64) -> Data { LimitlessProtocol.encodeVarint(v) }
    static func field(_ num: Int, bytes: Data) -> Data { varint(Int64(num << 3 | 2)) + varint(Int64(bytes.count)) + bytes }
    static func field(_ num: Int, int: Int64) -> Data { varint(Int64(num << 3)) + varint(int) }

    static func flashPageData(timestampMs: Int64, frames: [Data]) -> Data {
        let audio = frames.reduce(Data()) { $0 + field(1, bytes: $1) }      // 0x0a <len> frame
        return field(1, int: timestampMs) + field(3, bytes: field(2, bytes: audio)) // 0x08 ts, 0x1a { 0x12 { ... } }
    }
    /// One BLE notification carrying one flash page.
    static func pagePacket(messageIndex: Int, index: Int, session: Int = 7, timestampMs: Int64, frames: [Data]) -> Data {
        let storage = field(2, int: Int64(session)) + field(5, int: Int64(index))
            + field(6, bytes: flashPageData(timestampMs: timestampMs, frames: frames))
        return LimitlessProtocol.encodeBleWrapper(messageIndex: messageIndex, payload: field(2, bytes: storage))
    }
    static func statusPacket(oldest: Int, newest: Int) -> Data {
        let storage = field(1, int: Int64(oldest)) + field(2, int: Int64(newest)) + field(3, int: 3) + field(4, int: 1000) + field(5, int: 5000)
        let inner = field(1, int: 0x55) + field(5, bytes: field(1, int: 0x55) + field(5, bytes: storage))
        return LimitlessProtocol.encodeBleWrapper(messageIndex: 15, payload: field(4, bytes: inner))
    }
}

/// A scripted pendant: answers the engine's commands the way the real one does.
final class FakePendant: PendantLink {
    let queue = PacketQueue()
    var writes: [Data] = []
    var oldest = 100, newest = 129
    var framesPerPage = 3
    var stopAfterPage: Int?            // goes silent after this page index
    var answerStatus = true
    var baseTimestamp: Int64 = 1_750_000_000_000
    private var pushed = 0

    enum Kind: Equatable { case setTime, status, download(batch: Bool), ack(Int), other }

    func kind(of data: Data) -> Kind {
        guard let p = LimitlessProtocol.parseBlePacket(data), let first = p.payload.first else { return .other }
        switch first {
        case 0x32: return .setTime
        case 0xaa: return .status
        case 0x42: return .download(batch: p.payload.count > 3 && p.payload[3] == 1)
        case 0x3a: return .ack(Int(LimitlessProtocol.decodeVarint(p.payload, 3).0))
        default: return .other
        }
    }
    var kinds: [Kind] { writes.map(kind(of:)) }
    var acks: [Int] { kinds.compactMap { if case .ack(let i) = $0 { return i } else { return nil } } }

    func send(_ data: Data) async throws {
        writes.append(data)
        switch kind(of: data) {
        case .status:
            if answerStatus { queue.push(Wire.statusPacket(oldest: oldest, newest: newest)) }
        case .download(let batch):
            guard batch, newest >= oldest else { return }
            for i in oldest ... newest {
                if let stop = stopAfterPage, i > stop { break }
                pushed += 1
                queue.push(Wire.pagePacket(messageIndex: 100 + i, index: i,
                    timestampMs: baseTimestamp + Int64(i - oldest) * 60,
                    frames: fakeFrames(framesPerPage, seed: UInt8(i & 0xFF))))
            }
        default: break
        }
    }
    func nextPacket(timeout: TimeInterval) async -> Data? { await queue.next(timeout: timeout) }
}

/// An in-memory sink that tracks what is durable, so tests can prove nothing is ACKed ahead of it.
final class MemorySink: PageSink {
    var pages: [PendantPage] = []
    var durableCount = 0
    var failSync = false
    var failAppendAfter: Int?
    func append(_ page: PendantPage) throws {
        if let n = failAppendAfter, pages.count >= n { throw JournalError.frameTooLarge }
        pages.append(page)
    }
    func sync() throws {
        if failSync { throw JournalError.frameTooLarge }
        durableCount = pages.count
    }
}

func tempDir() -> URL {
    let u = FileManager.default.temporaryDirectory.appendingPathComponent("pendant-test-\(UUID().uuidString)")
    try? FileManager.default.createDirectory(at: u, withIntermediateDirectories: true)
    return u
}
