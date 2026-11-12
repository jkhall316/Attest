import XCTest
@testable import PendantKit

/// Omi's golden vectors, run through this port: the bytes the pendant sends must parse to the same pages,
/// and the commands we send must be byte-identical to the ones Omi's app sends.
final class ProtocolTests: XCTestCase {
    func reassemble(_ packets: [Data]) -> [Data] {
        var buf: [Int: [Int: Data]] = [:]
        var done: [Data] = []
        for pkt in packets {
            guard let p = LimitlessProtocol.parseBlePacket(pkt) else { continue }
            buf[p.index, default: [:]][p.seq] = p.payload
            if let got = buf[p.index], got.count == p.numFrags {
                done.append((0 ..< p.numFrags).reduce(Data()) { $0 + (got[$1] ?? Data()) })
                buf[p.index] = nil
            }
        }
        return done
    }

    func testGoldenPages() throws {
        let names = try FileManager.default.contentsOfDirectory(atPath: Bundle.module.url(forResource: "Fixtures", withExtension: nil)!.path)
            .filter { $0.hasSuffix(".json") && $0 != "encoders.json" }.sorted()
        XCTAssertGreaterThanOrEqual(names.count, 10)
        for file in names {
            let f = try fixture(String(file.dropLast(5)))
            let packets = (f["packets"] as! [String]).map(hex)
            let pages = reassemble(packets).flatMap { LimitlessProtocol.parsePendantMessage($0) }
            let expected = f["expectedPages"] as! [[String: Any]]
            XCTAssertEqual(pages.count, expected.count, file)
            for (got, want) in zip(pages, expected) {
                XCTAssertEqual(got.index, want["index"] as? Int, file)
                XCTAssertEqual(got.session, want["session"] as? Int, file)
                XCTAssertEqual(got.timestampMs, (want["timestampMs"] as? NSNumber)?.int64Value, file)
                XCTAssertEqual(got.opusFrames.map(hexString), want["frames"] as? [String], file)
            }
            if let st = f["expectedStorageState"] as? [String: Int] {
                let got = packets.compactMap(LimitlessProtocol.parseDeviceStatus).first
                XCTAssertEqual(got?.oldestFlashPage, st["oldest_flash_page"], file)
                XCTAssertEqual(got?.newestFlashPage, st["newest_flash_page"], file)
                XCTAssertEqual(got?.currentStorageSession, st["current_storage_session"], file)
                XCTAssertEqual(got?.freeCapturePages, st["free_capture_pages"], file)
                XCTAssertEqual(got?.totalCapturePages, st["total_capture_pages"], file)
            }
        }
    }

    func testGoldenCommandsAreByteIdentical() throws {
        let vectors = try fixture("encoders")["vectors"] as! [[String: Any]]
        XCTAssertEqual(vectors.count, 7)
        for v in vectors {
            let name = v["name"] as! String
            let mi = v["messageIndex"] as! Int
            let rid = (v["requestId"] as! NSNumber).int64Value
            let got: Data
            switch name {
            case "msg6_set_current_time": got = LimitlessProtocol.encodeSetCurrentTime(messageIndex: mi, requestId: rid, timestampMs: (v["timestampMs"] as! NSNumber).int64Value)
            case "msg7_ack_12345": got = LimitlessProtocol.encodeAcknowledgeProcessedData(messageIndex: mi, requestId: rid, upToIndex: v["upToIndex"] as! Int)
            case "msg21_get_device_status": got = LimitlessProtocol.encodeGetDeviceStatus(messageIndex: mi, requestId: rid)
            default: got = LimitlessProtocol.encodeDownloadFlashPages(messageIndex: mi, requestId: rid, batchMode: v["batchMode"] as! Bool, realTime: v["realTime"] as! Bool)
            }
            XCTAssertEqual(hexString(got), v["hex"] as? String, name)
        }
    }
}
