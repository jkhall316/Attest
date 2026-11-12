import Foundation

/// One flash page's worth of audio: the pendant-clock time it was captured, and its Opus frames.
public struct PendantPage: Equatable {
    public var timestampMs: Int64
    public var frames: [Data]
    public init(timestampMs: Int64, frames: [Data]) { self.timestampMs = timestampMs; self.frames = frames }
}

/// Where the drain engine puts pages. `sync()` must not return until everything appended so far is
/// durable, because the engine tells the pendant to delete its copy right after.
public protocol PageSink: AnyObject {
    func append(_ page: PendantPage) throws
    func sync() throws
}

/// An append-only log of pages on disk. Records are `[u32 length][u64 timestamp][u32 count]` then
/// `count x ([u16 length][bytes])`, so a write cut short by a crash or a full disk leaves a torn tail
/// that `readAll` ignores and the next append overwrites, never a corrupt middle.
public final class Journal: PageSink {
    public let url: URL
    private var handle: FileHandle?
    private let lock = NSLock()

    public init(url: URL) { self.url = url }

    private func open() throws -> FileHandle {
        if let h = handle { return h }
        let fm = FileManager.default
        try fm.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        if !fm.fileExists(atPath: url.path) { fm.createFile(atPath: url.path, contents: nil) }
        let h = try FileHandle(forUpdating: url)
        // Cut off a torn tail so new records follow the last complete one.
        let good = try Journal.validLength(of: Data(contentsOf: url, options: .mappedIfSafe))
        try h.truncate(atOffset: UInt64(good))
        try h.seek(toOffset: UInt64(good))
        handle = h
        return h
    }

    public func append(_ page: PendantPage) throws {
        lock.lock(); defer { lock.unlock() }
        var body = Data()
        body.append(contentsOf: Journal.be64(UInt64(bitPattern: page.timestampMs)))
        body.append(contentsOf: Journal.be32(UInt32(page.frames.count)))
        for f in page.frames {
            guard f.count <= Int(UInt16.max) else { throw JournalError.frameTooLarge }
            body.append(contentsOf: [UInt8(f.count >> 8), UInt8(f.count & 0xFF)])
            body.append(f)
        }
        var record = Data(Journal.be32(UInt32(body.count)))
        record.append(body)
        let h = try open()
        try h.write(contentsOf: record)
    }

    /// fsync. The ACK to the pendant goes out only after this returns.
    public func sync() throws {
        lock.lock(); defer { lock.unlock() }
        try handle?.synchronize()
    }

    public func readAll() throws -> [PendantPage] {
        lock.lock(); defer { lock.unlock() }
        guard FileManager.default.fileExists(atPath: url.path) else { return [] }
        return Journal.parse(try Data(contentsOf: url))
    }

    /// Replace the log with just these pages (atomically), e.g. what is left after finished recordings were cut out.
    public func rewrite(_ pages: [PendantPage]) throws {
        lock.lock(); defer { lock.unlock() }
        try handle?.close(); handle = nil
        var all = Data()
        for page in pages {
            var body = Data(Journal.be64(UInt64(bitPattern: page.timestampMs)))
            body.append(contentsOf: Journal.be32(UInt32(page.frames.count)))
            for f in page.frames { body.append(contentsOf: [UInt8(f.count >> 8), UInt8(f.count & 0xFF)]); body.append(f) }
            all.append(contentsOf: Journal.be32(UInt32(body.count)))
            all.append(body)
        }
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try all.write(to: url, options: .atomic)
    }

    // MARK: - parsing

    static func parse(_ data: Data) -> [PendantPage] {
        var pages: [PendantPage] = []
        var pos = 0
        while let (page, next) = record(in: data, at: pos) { pages.append(page); pos = next }
        return pages
    }

    static func validLength(of data: Data) -> Int {
        var pos = 0
        while let (_, next) = record(in: data, at: pos) { pos = next }
        return pos
    }

    private static func record(in data: Data, at start: Int) -> (PendantPage, Int)? {
        let d = Data(data) // zero-based copy
        guard start + 4 <= d.count else { return nil }
        let len = Int(rd32(d, start))
        let end = start + 4 + len
        guard len >= 12, end <= d.count else { return nil }
        var p = start + 4
        let ts = Int64(bitPattern: rd64(d, p)); p += 8
        let n = Int(rd32(d, p)); p += 4
        var frames: [Data] = []
        for _ in 0 ..< n {
            guard p + 2 <= end else { return nil }
            let l = Int(d[p]) << 8 | Int(d[p + 1]); p += 2
            guard p + l <= end else { return nil }
            frames.append(d.subdata(in: p ..< p + l)); p += l
        }
        return p == end ? (PendantPage(timestampMs: ts, frames: frames), end) : nil
    }

    static func be32(_ v: UInt32) -> [UInt8] { [UInt8(v >> 24), UInt8((v >> 16) & 0xFF), UInt8((v >> 8) & 0xFF), UInt8(v & 0xFF)] }
    static func be64(_ v: UInt64) -> [UInt8] { be32(UInt32(v >> 32)) + be32(UInt32(v & 0xFFFF_FFFF)) }
    static func rd32(_ d: Data, _ p: Int) -> UInt32 { (0 ..< 4).reduce(0) { $0 << 8 | UInt32(d[p + $1]) } }
    static func rd64(_ d: Data, _ p: Int) -> UInt64 { (0 ..< 8).reduce(0) { $0 << 8 | UInt64(d[p + $1]) } }
}

public enum JournalError: Error { case frameTooLarge }
