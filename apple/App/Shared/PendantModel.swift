import Foundation
import PendantKit
import SwiftUI
#if os(iOS)
import UIKit
#endif

/// Everything the pendant panel shows and does. One sync = connect, drain, cut, upload.
/// A single shared instance: iOS can relaunch the app in the background just for the pendant, and that
/// launch must find the Bluetooth manager already there (state restoration), with no UI involved.
@MainActor
final class PendantModel: ObservableObject {
    static let shared = PendantModel()
    static let taskIdentifier = "com.attest.sync"

    enum Phase: Equatable { case idle, connecting, draining(Int, Int), uploading, done, failed }

    @Published var phase: Phase = .idle
    @Published var message = "Not synced yet"
    @Published var queued = 0
    @Published var lastSync: Date?
    @Published var server: String = UserDefaults.standard.string(forKey: "server") ?? ""
    @Published var clientId: String = UserDefaults.standard.string(forKey: "clientId") ?? ""
    @Published var clientSecret: String = Keychain.get("clientSecret")
    @Published var pendantId: String = UserDefaults.standard.string(forKey: "pendant") ?? ""
    @Published var backgroundArmed = false

    private let dir: URL = {
        let d = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("AttestPendant")
        try? FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        return d
    }()
    private var bluetooth: PendantBluetooth?
    private var uploader: BackgroundUploader?
    private var busy = false

    var serverURL: URL? { URL(string: server.trimmingCharacters(in: .whitespaces)).flatMap { $0.scheme?.hasPrefix("http") == true ? $0 : nil } }
    var configured: Bool { serverURL != nil }
    var hasToken: Bool { !clientId.isEmpty && !clientSecret.isEmpty }
    /// Worth showing the floating pill: recordings waiting, a sync running, or something wrong.
    var needsAttention: Bool {
        if queued > 0 { return true }
        switch phase { case .connecting, .draining, .uploading, .failed: return true; default: return false }
    }
    private var config: ServerConfig? { serverURL.map { ServerConfig(server: $0, clientId: clientId, clientSecret: clientSecret) } }

    func apply(_ c: ServerConfig) {
        server = c.server.absoluteString; clientId = c.clientId; clientSecret = c.clientSecret
        save()
    }

    func save() {
        UserDefaults.standard.set(server, forKey: "server")
        UserDefaults.standard.set(clientId, forKey: "clientId")
        UserDefaults.standard.set(pendantId, forKey: "pendant")
        Keychain.set(clientSecret, for: "clientSecret")
        uploader = nil // rebuilt with the new server on next use
        refreshQueue()
        startBackground()
    }

    private func syncer() -> Syncer { Syncer(directory: dir, deviceId: pendantId.isEmpty ? "pendant" : pendantId) }
    func refreshQueue() { queued = syncer().outbox.pending().count }

    // MARK: - background

    /// Call at every launch, including the silent ones iOS makes for the pendant. Re-creates the Bluetooth manager
    /// with the same restore id (so iOS can hand back the pending connection) and re-attaches to uploads the system
    /// kept running while we were not.
    func startBackground() {
        guard let cfg = config else { return }
        if uploader == nil {
            let u = BackgroundUploader(config: cfg, outbox: syncer().outbox)
            u.onEvent = { [weak self] err in Task { @MainActor in
                self?.refreshQueue()
                if let err { self?.phase = .failed; self?.message = err }
            } }
            uploader = u
        }
        #if os(iOS)
        guard let id = UUID(uuidString: pendantId) else { return } // nothing to arm until a pendant was paired once
        let bt = bluetooth ?? PendantBluetooth(restoreIdentifier: "com.attest.pendant")
        bluetooth = bt
        bt.onReady = { [weak self] in Task { @MainActor in await self?.backgroundSync(connect: false) } }
        bt.keepConnected(id: id)
        backgroundArmed = true
        #endif
    }

    /// Hand iOS's "you were relaunched for uploads" completion handler to the uploader.
    func setBackgroundCompletion(_ handler: @escaping () -> Void) { uploader?.backgroundCompletion = handler }

    /// Runs in the background: the pendant reconnected, or a scheduled task fired. Keeps the app alive for as long as
    /// iOS allows; if it says time is up, the drain stops cleanly (what is saved is ACKed, the rest is resent later).
    func backgroundSync(connect: Bool) async {
        let work = Task { await self.run(connect: connect, background: true) }
        #if os(iOS)
        var bg = UIBackgroundTaskIdentifier.invalid
        bg = UIApplication.shared.beginBackgroundTask(withName: "pendant-sync") { work.cancel() }
        await work.value
        if bg != .invalid { UIApplication.shared.endBackgroundTask(bg) }
        #else
        await work.value
        #endif
    }

    // MARK: - sync

    func sync() async { await run(connect: true, background: false) }

    private func run(connect: Bool, background: Bool) async {
        guard !busy, let cfg = config else { return }
        busy = true; defer { busy = false }
        let syncer = syncer()
        var summary = SyncSummary()
        do {
            let bt = bluetooth ?? PendantBluetooth(restoreIdentifier: "com.attest.pendant")
            bluetooth = bt
            if connect {
                phase = .connecting; message = "Looking for your pendant…"
                let id = try await bt.connect(id: UUID(uuidString: pendantId))
                if pendantId.isEmpty { pendantId = id.uuidString; save() }
            }
            message = "Copying recordings off the pendant…"
            summary = try await syncer.collect(from: bt) { [weak self] p in
                Task { @MainActor in self?.phase = .draining(p.pagesDone, p.pagesTotal) }
            }
            if !backgroundArmed { bt.disconnect() } // armed: stay connected so the next reconnect or task finds it ready
        } catch {
            // No pendant in range is normal; whatever is already queued still goes up.
            message = error.localizedDescription
            summary.recordingsQueued = (try? syncer.cut(now: Int64(Date().timeIntervalSince1970 * 1000))) ?? 0
        }
        phase = .uploading
        if background, let u = uploader {
            // The system sends these, even if we are suspended or killed straight after.
            await u.enqueueAll()
        } else {
            await syncer.upload(with: Uploader(config: cfg), into: &summary)
        }
        refreshQueue()
        lastSync = Date()
        if summary.failed > 0 { phase = .failed; message = summary.lastError ?? "Some recordings could not be uploaded yet. They are kept and will retry." }
        else {
            phase = .done
            let got = summary.drain.map { $0.pages > 0 } ?? false
            message = summary.uploaded > 0 ? "Uploaded \(summary.uploaded) recording\(summary.uploaded == 1 ? "" : "s")."
                : background && queued > 0 ? "\(queued) recording\(queued == 1 ? "" : "s") on the way."
                : got ? "Copied from the pendant. Recordings upload once a conversation has ended." : "Up to date."
        }
    }
}
