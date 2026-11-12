import Foundation

/// Uploads that finish even if the app is suspended or killed. A background `URLSession` is run by the
/// system, not by us: we hand it a request body saved as a file, and iOS sends it when it can, retries
/// through network changes, and relaunches the app to say how it went. The outbox entry is removed only
/// when the server answers success; anything else leaves it for the next attempt.
public final class BackgroundUploader: NSObject, URLSessionDataDelegate {
    public static let identifier = "com.attest.upload"

    private let config: ServerConfig
    private let outbox: Outbox
    private var session: URLSession!
    /// Called when a transfer ends, with a message for the pill if something needs the person's attention.
    public var onEvent: ((String?) -> Void)?
    /// iOS hands us a completion handler when it relaunches us for finished transfers; call it when done.
    public var backgroundCompletion: (() -> Void)?

    public init(config: ServerConfig, outbox: Outbox, identifier: String = BackgroundUploader.identifier) {
        self.config = config
        self.outbox = outbox
        super.init()
        let c = URLSessionConfiguration.background(withIdentifier: identifier)
        c.sessionSendsLaunchEvents = true
        c.isDiscretionary = false
        c.waitsForConnectivity = true
        session = URLSession(configuration: c, delegate: self, delegateQueue: nil)
    }

    /// Queue every waiting recording that is not already being sent. Returns how many were handed over.
    @discardableResult
    public func enqueueAll() async -> Int {
        let running = Set(await session.allTasks.compactMap { $0.taskDescription })
        var queued = 0
        for item in outbox.pending() where !running.contains(item.ingestId) {
            guard let audio = try? Data(contentsOf: outbox.audioURL(item)) else { continue }
            let boundary = "attest-\(UUID().uuidString)"
            let file = outbox.uploadFileURL(item)
            guard (try? Multipart.body(item: item, audio: audio, boundary: boundary).write(to: file, options: .atomic)) != nil else { continue }
            let task = session.uploadTask(with: Multipart.request(config: config, boundary: boundary), fromFile: file)
            task.taskDescription = item.ingestId
            task.resume()
            queued += 1
        }
        return queued
    }

    // MARK: - URLSessionDataDelegate

    public func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard let id = task.taskDescription else { return }
        if error != nil { onEvent?(nil); return } // network trouble: the system retries, and so will the next sync
        let code = (task.response as? HTTPURLResponse)?.statusCode ?? 0
        switch Multipart.outcome(code: code) {
        case .success:
            if let item = outbox.item(ingestId: id) { outbox.remove(item) }
            onEvent?(nil)
        case .failure(let e):
            // Keep the audio. Only drop the prepared body, which a later enqueue rebuilds.
            if let item = outbox.item(ingestId: id) { try? FileManager.default.removeItem(at: outbox.uploadFileURL(item)) }
            onEvent?(e.errorDescription)
        }
    }

    public func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
        DispatchQueue.main.async { [weak self] in
            self?.backgroundCompletion?()
            self?.backgroundCompletion = nil
        }
    }
}
