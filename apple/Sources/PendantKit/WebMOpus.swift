import Foundation

/// Wraps raw Opus packets in a WebM (Matroska) file. The pendant hands over 20 ms Opus frames at
/// 16 kHz mono and nothing else, so there is no re-encoding: the packets go in as they are. WebM
/// is the container Attest already records and plays (`audio/webm`), it is what browsers
/// including Safari play, and ffmpeg/Whisper servers read it.
///
/// Layout: EBML header, Segment { Info, Tracks, Cluster..., Cues }. Cues come last so the
/// cluster offsets are known; they make the file seekable.
public enum WebMOpus {
    /// Pre-skip in samples at 48 kHz (what libopus reports for its encoder delay).
    static let preSkip: UInt16 = 312

    public static func mux(
        frames: [Data], sampleRate: Int = 16_000, channels: Int = 1, frameMs: Int = 20
    ) -> Data {
        let clusterMs = 5_000
        let perCluster = max(1, clusterMs / frameMs)
        let durationMs = Double(frames.count * frameMs)

        let header = element(0x1A45DFA3, [
            uint(0x4286, 1), uint(0x42F7, 1), uint(0x42F2, 4), uint(0x42F3, 8),
            string(0x4282, "webm"), uint(0x4287, 4), uint(0x4285, 2),
        ])

        let info = element(0x1549A966, [
            uint(0x2AD7B1, 1_000_000), // TimecodeScale: 1 ms
            float64(0x4489, durationMs),
            string(0x4D80, "Attest"), string(0x5741, "Attest pendant"),
        ])

        let tracks = element(0x1654AE6B, [
            element(0xAE, [
                uint(0xD7, 1), uint(0x73C5, 1), uint(0x83, 2), string(0x86, "A_OPUS"),
                bytes(0x63A2, opusHead(sampleRate: sampleRate, channels: channels)),
                uint(0x56AA, UInt64(Double(preSkip) / 48_000 * 1e9)), // CodecDelay, ns
                uint(0x56BB, 80_000_000),                              // SeekPreRoll, ns
                element(0xE1, [float64(0xB5, 48_000), uint(0x9F, UInt64(channels))]),
            ]),
        ])

        var clusters = Data()
        var cues: [(timeMs: Int, offset: Int)] = []
        let segmentHeadLength = info.count + tracks.count
        var i = 0
        while i < frames.count {
            let startMs = i * frameMs
            cues.append((startMs, segmentHeadLength + clusters.count))
            var body = [uint(0xE7, UInt64(startMs))]
            for j in i ..< min(i + perCluster, frames.count) {
                body.append(simpleBlock(relativeMs: (j - i) * frameMs, packet: frames[j]))
            }
            clusters.append(element(0x1F43B675, body))
            i += perCluster
        }

        let cuesElement = element(0x1C53BB6B, cues.map { cue in
            element(0xBB, [
                uint(0xB3, UInt64(cue.timeMs)),
                element(0xB7, [uint(0xF7, 1), uint(0xF1, UInt64(cue.offset))]),
            ])
        })

        var out = header
        out.append(element(0x18538067, [info, tracks, clusters, cuesElement]))
        return out
    }

    /// RFC 7845 identification header, as WebM carries it in CodecPrivate.
    static func opusHead(sampleRate: Int, channels: Int) -> Data {
        var d = Data("OpusHead".utf8)
        d.append(1)
        d.append(UInt8(channels))
        d.append(contentsOf: le16(preSkip))
        d.append(contentsOf: le32(UInt32(sampleRate)))
        d.append(contentsOf: le16(0)) // output gain
        d.append(0)                   // channel mapping family 0
        return d
    }

    // MARK: - EBML

    /// An element id is written as its own bytes; sizes use the shortest EBML variable-length integer.
    static func vint(_ n: Int) -> Data {
        var length = 1
        while length < 8, n >= (1 << (7 * length)) - 1 { length += 1 }
        var out = [UInt8](repeating: 0, count: length)
        var v = n
        for k in stride(from: length - 1, through: 0, by: -1) { out[k] = UInt8(v & 0xFF); v >>= 8 }
        out[0] |= UInt8(0x80 >> (length - 1))
        return Data(out)
    }

    static func idBytes(_ id: UInt32) -> Data {
        var out = [UInt8]()
        var v = id
        while v > 0 { out.insert(UInt8(v & 0xFF), at: 0); v >>= 8 }
        return Data(out)
    }

    static func element(_ id: UInt32, _ payload: Data) -> Data {
        var d = idBytes(id)
        d.append(vint(payload.count))
        d.append(payload)
        return d
    }
    static func element(_ id: UInt32, _ children: [Data]) -> Data {
        element(id, children.reduce(into: Data()) { $0.append($1) })
    }
    static func bytes(_ id: UInt32, _ d: Data) -> Data { element(id, d) }
    static func string(_ id: UInt32, _ s: String) -> Data { element(id, Data(s.utf8)) }
    static func uint(_ id: UInt32, _ v: UInt64) -> Data {
        var out = [UInt8]()
        var x = v
        repeat { out.insert(UInt8(x & 0xFF), at: 0); x >>= 8 } while x > 0
        return element(id, Data(out))
    }
    static func float64(_ id: UInt32, _ v: Double) -> Data {
        element(id, Data(withUnsafeBytes(of: v.bitPattern.bigEndian) { Array($0) }))
    }

    /// SimpleBlock: track number 1 (vint 0x81), signed 16-bit timecode relative to the cluster, flags (keyframe).
    static func simpleBlock(relativeMs: Int, packet: Data) -> Data {
        var payload = Data([0x81])
        let t = UInt16(bitPattern: Int16(clamping: relativeMs))
        payload.append(contentsOf: [UInt8(t >> 8), UInt8(t & 0xFF), 0x80])
        payload.append(packet)
        return element(0xA3, payload)
    }

    static func le16(_ v: UInt16) -> [UInt8] { [UInt8(v & 0xFF), UInt8(v >> 8)] }
    static func le32(_ v: UInt32) -> [UInt8] { (0 ..< 4).map { UInt8((v >> (8 * UInt32($0))) & 0xFF) } }
}
