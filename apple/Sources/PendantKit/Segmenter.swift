import Foundation

/// One finished recording: consecutive audio with no long silence in it.
public struct Segment: Equatable {
    public var startMs: Int64
    public var frames: [Data]
    public static let frameMs = 20 // the pendant sends 20 ms Opus frames
    public var durationMs: Int { frames.count * Segment.frameMs }
}

/// Cuts the stream of drained pages into recordings. Mirrors how the Omi app does it: a gap of more
/// than two minutes between pages means the pendant was not recording, so a new recording starts;
/// and one recording is capped at 15 minutes.
public enum Segmenter {
    public static let gapMs: Int64 = 120_000
    public static let maxFrames = 15 * 60 * 50
    /// Anything shorter than this is a blip, not a conversation.
    public static let minFrames = 50
    /// A pendant that has not been time-synced reports a bogus epoch; anything before 2020 is not a time.
    static let minValidMs: Int64 = 1_577_836_800_000

    /// `closed` are finished recordings. `open` are pages that may still be continued: the most recent
    /// recording, when it ended less than a gap ago (the person may still be talking, or the next
    /// drain will bring the rest). Both keep the original pages' order.
    public static func plan(pages: [PendantPage], now: Int64) -> (closed: [Segment], open: [PendantPage]) {
        var groups: [[PendantPage]] = []
        var lastTs: Int64 = 0
        var frameCount = 0
        for var page in pages where !page.frames.isEmpty {
            // Bogus pendant clock: take the previous page's time, else the time we drained.
            if page.timestampMs < minValidMs { page.timestampMs = lastTs > 0 ? lastTs : now }
            let split = groups.isEmpty
                || abs(page.timestampMs - lastTs) > gapMs
                || frameCount + page.frames.count > maxFrames
            if split { groups.append([]); frameCount = 0 }
            groups[groups.count - 1].append(page)
            frameCount += page.frames.count
            lastTs = page.timestampMs
        }
        var open: [PendantPage] = []
        if let last = groups.last, let tail = last.last,
           now - tail.timestampMs <= gapMs, last.reduce(0, { $0 + $1.frames.count }) < maxFrames {
            open = groups.removeLast()
        }
        let closed = groups.compactMap { g -> Segment? in
            let frames = g.flatMap { $0.frames }
            return frames.count >= minFrames ? Segment(startMs: g[0].timestampMs, frames: frames) : nil
        }
        return (closed, open)
    }
}
