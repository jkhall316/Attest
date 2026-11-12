import Foundation

/// A recording waiting to be uploaded. `ingestId` is derived from when it started, so a retry after a
/// crash, or the same audio cut out twice, is recognised by the server and stored once.
public struct OutboxItem: Codable, Equatable {
    public var ingestId: String
    public var createdAtMs: Int64
    public var durationMs: Int
    public var title: String
    public var fileName: String
}

/// Finished recordings on disk until the server has them. Survives the app being killed, being offline,
/// or the server being down; nothing is removed until an upload is acknowledged.
public final class Outbox {
    public let directory: URL
    public init(directory: URL) { self.directory = directory }

    public static func ingestId(deviceId: String, startMs: Int64) -> String { "pendant:\(deviceId):\(startMs)" }

    private func stem(_ id: String) -> String { id.map { $0.isLetter || $0.isNumber || $0 == "-" ? String($0) : "_" }.joined() }

    @discardableResult
    public func add(_ segment: Segment, deviceId: String, title: String) throws -> OutboxItem {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let id = Outbox.ingestId(deviceId: deviceId, startMs: segment.startMs)
        let item = OutboxItem(ingestId: id, createdAtMs: segment.startMs, durationMs: segment.durationMs,
                              title: title, fileName: stem(id) + ".webm")
        // Audio first, then the small descriptor: an item only counts once its descriptor exists.
        try WebMOpus.mux(frames: segment.frames).write(to: directory.appendingPathComponent(item.fileName), options: .atomic)
        try JSONEncoder().encode(item).write(to: directory.appendingPathComponent(stem(id) + ".json"), options: .atomic)
        return item
    }

    public func pending() -> [OutboxItem] {
        let names = (try? FileManager.default.contentsOfDirectory(atPath: directory.path)) ?? []
        return names.filter { $0.hasSuffix(".json") }.sorted().compactMap { n in
            guard let d = try? Data(contentsOf: directory.appendingPathComponent(n)) else { return nil }
            return try? JSONDecoder().decode(OutboxItem.self, from: d)
        }
    }

    public func audioURL(_ item: OutboxItem) -> URL { directory.appendingPathComponent(item.fileName) }

    /// The ready-to-send request body for a background upload (a background session can only upload from a file).
    public func uploadFileURL(_ item: OutboxItem) -> URL { directory.appendingPathComponent(stem(item.ingestId) + ".upload") }

    public func item(ingestId: String) -> OutboxItem? { pending().first { $0.ingestId == ingestId } }

    public func remove(_ item: OutboxItem) {
        try? FileManager.default.removeItem(at: uploadFileURL(item))
        try? FileManager.default.removeItem(at: audioURL(item))
        try? FileManager.default.removeItem(at: directory.appendingPathComponent(stem(item.ingestId) + ".json"))
    }
}
