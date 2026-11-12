import Foundation

/// BLE notifications arrive on a delegate callback; the drain engine wants to await "the next one,
/// but give up after N seconds". This is the bridge: `push` from the callback, `next(timeout:)` from async code.
public final class PacketQueue: @unchecked Sendable {
    private let lock = NSLock()
    private var buffer: [Data] = []
    private var waiter: CheckedContinuation<Data?, Never>?
    private var waiterToken = 0

    public init() {}

    public func push(_ data: Data) {
        lock.lock()
        if let w = waiter {
            waiter = nil
            lock.unlock()
            w.resume(returning: data)
        } else {
            buffer.append(data)
            lock.unlock()
        }
    }

    public func clear() { lock.lock(); buffer.removeAll(); lock.unlock() }

    /// The next packet, or nil if none arrived within `timeout` seconds.
    public func next(timeout: TimeInterval) async -> Data? {
        await withCheckedContinuation { (cont: CheckedContinuation<Data?, Never>) in
            lock.lock()
            if !buffer.isEmpty {
                let d = buffer.removeFirst()
                lock.unlock()
                cont.resume(returning: d)
                return
            }
            waiterToken += 1
            let token = waiterToken
            waiter = cont
            lock.unlock()
            DispatchQueue.global().asyncAfter(deadline: .now() + timeout) { [weak self] in
                guard let self else { return }
                self.lock.lock()
                if self.waiterToken == token, let w = self.waiter {
                    self.waiter = nil
                    self.lock.unlock()
                    w.resume(returning: nil)
                } else {
                    self.lock.unlock()
                }
            }
        }
    }
}
