import Foundation

/// The link to a pendant: write a command, wait for what it sends back. CoreBluetooth implements it
/// for real; tests implement it with a fake pendant.
public protocol PendantLink: AnyObject {
    func send(_ data: Data) async throws
    /// The next notification, or nil after `timeout` seconds of silence.
    func nextPacket(timeout: TimeInterval) async -> Data?
}

public struct DrainResult: Equatable {
    public var pages: Int
    public var frames: Int
    /// `nothing_stored`, `caught_up`, `stall`, `status_timeout`, `cancelled`, or `append_failed`.
    public var reason: String
}

public struct DrainProgress { public var pagesDone: Int; public var pagesTotal: Int }

/// Empties the pendant's flash into a `PageSink`: set its clock, ask what is stored, switch it to
/// download mode, collect the pages it pushes, and ACK them. Follows Omi's flash-drain sequence
/// (see NOTICE). The rule that matters: an ACK makes the pendant DELETE its copy, so pages are ACKed
/// only after `sink.sync()` has made them durable. A failed append or sync ends the drain without
/// ACKing past what was safely written; the pendant redelivers the rest next time.
public final class DrainEngine {
    public struct Config {
        public var statusTimeout: TimeInterval = 8
        public var stallTimeout: TimeInterval = 30
        public var pollInterval: TimeInterval = 5
        public var ackEveryPages = 25
        public init() {}
    }

    private var messageIndex = 0
    private var requestId: Int64 = 0
    private let config: Config
    private let clock: () -> Int64

    public init(config: Config = Config(), clock: @escaping () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) }) {
        self.config = config
        self.clock = clock
    }

    /// Call when a new connection starts: the pendant counts messages per connection.
    public func resetCounters() { messageIndex = 0; requestId = 0 }

    private func nextIndex() -> Int { defer { messageIndex += 1 }; return messageIndex }
    private func nextRequest() -> Int64 { requestId += 1; return requestId }

    public func drain(link: PendantLink, sink: PageSink, progress: ((DrainProgress) -> Void)? = nil) async throws -> DrainResult {
        try await link.send(LimitlessProtocol.encodeSetCurrentTime(
            messageIndex: nextIndex(), requestId: nextRequest(), timestampMs: clock()))
        try await link.send(LimitlessProtocol.encodeGetDeviceStatus(messageIndex: nextIndex(), requestId: nextRequest()))

        // 1. What is stored?
        var state: LimitlessProtocol.StorageState?
        let statusDeadline = Date().addingTimeInterval(config.statusTimeout)
        while state == nil, Date() < statusDeadline {
            guard let pkt = await link.nextPacket(timeout: statusDeadline.timeIntervalSinceNow) else { break }
            state = LimitlessProtocol.parseDeviceStatus(pkt)
        }
        guard let st = state else { return DrainResult(pages: 0, frames: 0, reason: "status_timeout") }
        let total = st.newestFlashPage - st.oldestFlashPage + 1
        if st.newestFlashPage < st.oldestFlashPage || total <= 0 { return DrainResult(pages: 0, frames: 0, reason: "nothing_stored") }

        // 2. Download.
        try await link.send(LimitlessProtocol.encodeDownloadFlashPages(
            messageIndex: nextIndex(), requestId: nextRequest(), batchMode: true, realTime: false))

        var fragments: [Int: [Int: Data]] = [:]
        var lastAppended = -1, lastAcked = -1, maxSeen = -1, sinceAck = 0
        var pages = 0, frames = 0
        var lastPageAt = Date()
        var reason = "stall"

        // ACK only what is durable. If the barrier fails, nothing new is ACKed.
        func ackWritten() async throws -> Bool {
            if lastAppended <= lastAcked { return true }
            do { try sink.sync() } catch { return false }
            try await link.send(LimitlessProtocol.encodeAcknowledgeProcessedData(
                messageIndex: nextIndex(), requestId: nextRequest(), upToIndex: lastAppended))
            lastAcked = lastAppended
            sinceAck = 0
            return true
        }

        loop: while true {
            // iOS is about to suspend us: stop cleanly. What is saved is ACKed below; the rest is resent next time.
            if Task.isCancelled { reason = "cancelled"; break }
            guard let pkt = await link.nextPacket(timeout: config.pollInterval) else {
                if Date().timeIntervalSince(lastPageAt) > config.stallTimeout { reason = "stall"; break }
                continue
            }
            guard let packet = LimitlessProtocol.parseBlePacket(pkt) else { continue }
            fragments[packet.index, default: [:]][packet.seq] = packet.payload
            guard let got = fragments[packet.index], got.count == packet.numFrags else { continue }
            var whole = Data()
            for i in 0 ..< packet.numFrags { if let f = got[i] { whole.append(f) } }
            fragments.removeValue(forKey: packet.index)

            for page in LimitlessProtocol.parsePendantMessage(whole) {
                lastPageAt = Date()
                guard let index = page.index else { continue }
                if !page.opusFrames.isEmpty {
                    do { try sink.append(PendantPage(timestampMs: page.timestampMs, frames: page.opusFrames)) }
                    catch { reason = "append_failed"; break loop }
                    frames += page.opusFrames.count
                }
                lastAppended = max(lastAppended, index)
                maxSeen = max(maxSeen, index)
                pages += 1
                sinceAck += 1
                progress?(DrainProgress(pagesDone: pages, pagesTotal: total))
                if sinceAck >= config.ackEveryPages, try await !ackWritten() { reason = "append_failed"; break loop }
                if maxSeen >= st.newestFlashPage { reason = "caught_up"; break loop }
            }
        }

        // 3. Final ACK of whatever is safely on disk, then back to record-to-flash.
        let ok = try await ackWritten()
        try? await link.send(LimitlessProtocol.encodeDownloadFlashPages(
            messageIndex: nextIndex(), requestId: nextRequest(), batchMode: false, realTime: false))
        return DrainResult(pages: pages, frames: frames, reason: ok ? reason : "append_failed")
    }
}
