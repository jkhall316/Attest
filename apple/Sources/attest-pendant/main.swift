import Foundation
import PendantKit

// attest-pendant: pull recordings off a Limitless pendant over Bluetooth and send them to Attest.
//
//   attest-pendant configure --server https://attest.example.com [--client-id ID --client-secret SECRET]
//   attest-pendant scan
//   attest-pendant sync          connect, drain the pendant, upload
//   attest-pendant upload        upload what is already queued (no Bluetooth)
//   attest-pendant status

struct Settings: Codable {
    var server: String?
    var clientId: String?
    var clientSecret: String?
    var pendant: String?
}

let dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("AttestPendant")
let settingsURL = dir.appendingPathComponent("config.json")
func load() -> Settings { (try? JSONDecoder().decode(Settings.self, from: Data(contentsOf: settingsURL))) ?? Settings() }
func save(_ s: Settings) throws {
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    try JSONEncoder().encode(s).write(to: settingsURL, options: .atomic)
    try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: settingsURL.path) // holds the token secret
}
func die(_ m: String) -> Never { FileHandle.standardError.write(Data((m + "\n").utf8)); exit(1) }

var args = Array(CommandLine.arguments.dropFirst())
let command = args.isEmpty ? "help" : args.removeFirst()
func flag(_ name: String) -> String? { args.firstIndex(of: name).flatMap { $0 + 1 < args.count ? args[$0 + 1] : nil } }

func serverConfig(_ s: Settings) -> ServerConfig {
    guard let url = s.server.flatMap(URL.init(string:)) else { die("No server yet. Run: attest-pendant configure --server https://your-attest-host") }
    return ServerConfig(server: url, clientId: s.clientId ?? "", clientSecret: s.clientSecret ?? "")
}

func report(_ s: SyncSummary) {
    if let d = s.drain { print("Pendant: \(d.pages) pages, \(d.frames) frames (\(d.reason))") }
    print("Queued \(s.recordingsQueued) new recording(s); uploaded \(s.uploaded), failed \(s.failed)")
    if let e = s.lastError { print("Last error: \(e)") }
}

func run() async {
    var settings = load()
    switch command {
    case "configure":
        if let v = flag("--server") { settings.server = v }
        if let v = flag("--client-id") { settings.clientId = v }
        if let v = flag("--client-secret") { settings.clientSecret = v }
        do { try save(settings) } catch { die("Could not save settings: \(error.localizedDescription)") }
        print("Saved to \(settingsURL.path)")

    case "scan":
        #if canImport(CoreBluetooth)
        do {
            let bt = PendantBluetooth()
            let found = try await bt.scan(seconds: 8) { print("  found \($0.name)  \($0.id)  rssi \($0.rssi)") }
            if found.isEmpty { print(PendantBluetoothError.notFound.localizedDescription) }
            else if let first = found.first, settings.pendant == nil {
                settings.pendant = first.id.uuidString; try? save(settings)
                print("Remembered \(first.name) as your pendant.")
            }
        } catch { die(error.localizedDescription) }
        #endif

    case "sync", "upload":
        let cfg = serverConfig(settings)
        let syncer = Syncer(directory: dir, deviceId: settings.pendant ?? "pendant")
        var summary = SyncSummary()
        #if canImport(CoreBluetooth)
        if command == "sync" {
            let bt = PendantBluetooth()
            do {
                print("Connecting to the pendant…")
                let id = try await bt.connect(id: settings.pendant.flatMap(UUID.init(uuidString:)))
                if settings.pendant == nil { settings.pendant = id.uuidString; try? save(settings) }
                print("Connected. Draining…")
                summary = try await syncer.collect(from: bt) { p in
                    FileHandle.standardError.write(Data("\r  \(p.pagesDone)/\(p.pagesTotal) pages".utf8))
                }
                print("")
                bt.disconnect()
            } catch {
                // Not being able to reach the pendant must not stop queued recordings from uploading.
                print("Bluetooth: \(error.localizedDescription)")
                summary.lastError = error.localizedDescription
                summary.recordingsQueued = (try? syncer.cut(now: Int64(Date().timeIntervalSince1970 * 1000))) ?? 0
            }
        } else {
            summary.recordingsQueued = (try? syncer.cut(now: Int64(Date().timeIntervalSince1970 * 1000))) ?? 0
        }
        #endif
        await syncer.upload(with: Uploader(config: cfg), into: &summary)
        report(summary)

    case "status":
        let s = load()
        let syncer = Syncer(directory: dir, deviceId: s.pendant ?? "pendant")
        print("Server:  \(s.server ?? "(not set)")")
        print("Pendant: \(s.pendant ?? "(none yet: run scan)")")
        print("Waiting to upload: \(syncer.outbox.pending().count)")
        print("Audio not yet cut into recordings: \(((try? syncer.journal.readAll()) ?? []).reduce(0) { $0 + $1.frames.count } / 50) s")

    default:
        print("""
        attest-pendant configure --server URL [--client-id ID --client-secret SECRET]
        attest-pendant scan | sync | upload | status
        """)
    }
}

Task { await run(); exit(0) }
RunLoop.main.run()
