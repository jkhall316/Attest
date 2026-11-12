import Foundation

public struct SyncSummary: Equatable {
    public var drain: DrainResult?
    public var recordingsQueued = 0
    public var uploaded = 0
    public var failed = 0
    public var lastError: String?
    public init() {}
}

/// The whole pipeline in one call: drain the pendant to disk, cut the audio into recordings, upload
/// whatever is waiting. Each stage leaves its result on disk first, so being killed halfway, going
/// offline, or the server being down loses nothing: the next sync carries on.
/// A pendant whose clock was never set reports a bogus date. Stamp such pages with a real time ONCE, as they
/// are saved (the previous page's time, else now), so the time sticks; re-deciding it on every look would
/// keep making the audio look brand new and it would never be cut into a recording.
final class ClockFixSink: PageSink {
    private let inner: PageSink
    private let now: () -> Int64
    private var last: Int64 = 0
    init(_ inner: PageSink, now: @escaping () -> Int64) { self.inner = inner; self.now = now }
    func append(_ page: PendantPage) throws {
        var p = page
        if p.timestampMs < Segmenter.minValidMs { p.timestampMs = last > 0 ? last : now() }
        last = p.timestampMs
        try inner.append(p)
    }
    func sync() throws { try inner.sync() }
}

public final class Syncer {
    public let journal: Journal
    public let outbox: Outbox
    private let engine = DrainEngine()
    private let deviceId: String
    private let titleFor: (Int64) -> String

    public init(directory: URL, deviceId: String, titleFor: ((Int64) -> String)? = nil) {
        self.journal = Journal(url: directory.appendingPathComponent("journal.bin"))
        self.outbox = Outbox(directory: directory.appendingPathComponent("outbox"))
        self.deviceId = deviceId
        self.titleFor = titleFor ?? { ms in
            let f = DateFormatter(); f.dateStyle = .medium; f.timeStyle = .short
            return "Pendant, " + f.string(from: Date(timeIntervalSince1970: Double(ms) / 1000))
        }
    }

    /// Pull audio off the pendant (if connected) and turn it into queued recordings.
    public func collect(from link: PendantLink?, now: Int64 = Int64(Date().timeIntervalSince1970 * 1000),
                        progress: ((DrainProgress) -> Void)? = nil) async throws -> SyncSummary {
        var summary = SyncSummary()
        if let link {
            engine.resetCounters()
            summary.drain = try await engine.drain(link: link, sink: ClockFixSink(journal, now: { now }), progress: progress)
        }
        summary.recordingsQueued = try cut(now: now)
        return summary
    }

    /// Cut finished recordings out of the journal into the outbox. Outbox first, journal second: a crash
    /// between the two repeats the cut next time, and the same ingest id makes that harmless.
    @discardableResult
    public func cut(now: Int64) throws -> Int {
        let (closed, open) = Segmenter.plan(pages: try journal.readAll(), now: now)
        for seg in closed { try outbox.add(seg, deviceId: deviceId, title: titleFor(seg.startMs)) }
        try journal.rewrite(open)
        return closed.count
    }

    /// Upload everything waiting. Stops early on a sign-in problem (every item would fail the same way).
    public func upload(with uploader: Uploader, into summary: inout SyncSummary) async {
        for item in outbox.pending() {
            do {
                let audio = try Data(contentsOf: outbox.audioURL(item))
                try await uploader.upload(item, audio: audio)
                outbox.remove(item)
                summary.uploaded += 1
            } catch let e as UploadError {
                summary.failed += 1
                summary.lastError = e.errorDescription
                if case .auth = e { return }
            } catch {
                summary.failed += 1
                summary.lastError = error.localizedDescription
            }
        }
    }
}
