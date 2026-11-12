import SwiftUI
import PendantKit

struct RootView: View {
    @ObservedObject private var pendant = PendantModel.shared
    @State private var showPendant = false
    @State private var showSetup = false
    @State private var incoming: ServerConfig?

    var body: some View {
        Group {
            if let url = pendant.serverURL {
                ZStack(alignment: .bottomTrailing) {
                    // Behind the page, so the status-bar strip is the app's own dark, not white.
                    Color(red: 9 / 255, green: 9 / 255, blue: 11 / 255).ignoresSafeArea()
                    WebView(url: url, onOpenPendant: { showPendant = true }).ignoresSafeArea(edges: .bottom)
                    // Only when there is something to say (recordings waiting, syncing, a problem), clear of the
                    // header and the tab bar. Otherwise the pendant lives in Settings > Open pendant sync.
                    if pendant.needsAttention {
                        PendantChip(pendant: pendant) { showPendant = true }
                            .padding(.trailing, 12).padding(.bottom, 74)
                    }
                }
                .preferredColorScheme(.dark)
                .sheet(isPresented: $showPendant) { PendantSheet(pendant: pendant, edit: { showPendant = false; showSetup = true }) }
            } else {
                SetupView(pendant: pendant)
            }
        }
        .sheet(isPresented: $showSetup) { SetupView(pendant: pendant) { showSetup = false } }
        .task { pendant.refreshQueue() }
        // attest://connect?... from setup. Anyone can send you a link, so the address is confirmed first.
        .onOpenURL { url in incoming = ConnectLink.parse(url) }
        .alert("Connect to \(incoming?.server.host ?? "")?", isPresented: Binding(get: { incoming != nil }, set: { if !$0 { incoming = nil } })) {
            Button("Connect") { if let c = incoming { pendant.apply(c) }; incoming = nil }
            Button("Cancel", role: .cancel) { incoming = nil }
        } message: {
            Text("Attest will sign in to this server and upload your pendant recordings to it. Only continue if this is your own Attest.")
        }
    }
}

/// A small status pill over the web app: tap for the pendant panel.
struct PendantChip: View {
    @ObservedObject var pendant: PendantModel
    var action: () -> Void
    var body: some View {
        Button(action: action) {
            HStack(spacing: 6) {
                Image(systemName: "waveform.badge.mic")
                if pendant.queued > 0 { Text("\(pendant.queued)").font(.caption.bold()) }
                if case .draining(let a, let b) = pendant.phase { Text("\(a)/\(b)").font(.caption.monospacedDigit()) }
            }
            .padding(.horizontal, 10).padding(.vertical, 6)
            .background(.ultraThinMaterial, in: Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Pendant")
    }
}

struct PendantSheet: View {
    @ObservedObject var pendant: PendantModel
    var edit: () -> Void
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack {
                Text("Limitless pendant").font(.title2.bold())
                Spacer()
                Button("Done") { dismiss() }
            }
            Text(pendant.message).foregroundStyle(pendant.phase == .failed ? .red : .secondary)
            if case .draining(let a, let b) = pendant.phase { ProgressView(value: Double(a), total: Double(max(b, 1))) }
            LabeledContent("Waiting to upload", value: "\(pendant.queued)")
            if let d = pendant.lastSync { LabeledContent("Last sync", value: d.formatted(date: .abbreviated, time: .shortened)) }
            if !pendant.hasToken {
                Label("Add the Client ID and secret that setup printed, or the server will refuse uploads.", systemImage: "exclamationmark.triangle")
                    .font(.footnote).foregroundStyle(.orange)
            }
            Button {
                Task { await pendant.sync() }
            } label: {
                Label(pendant.phase == .connecting || pendant.phase == .uploading || { if case .draining = pendant.phase { return true } else { return false } }() ? "Syncing…" : "Sync now",
                      systemImage: "arrow.triangle.2.circlepath").frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent).controlSize(.large)
            Text("A pendant talks to one phone at a time. If it is connected to another app, such as Omi, turn Bluetooth off there first.")
                .font(.footnote).foregroundStyle(.secondary)
            Button("Server and sign-in…", action: edit).font(.footnote)
            Spacer()
        }
        .padding(20)
        .presentationDetents([.medium])
    }
}

struct SetupView: View {
    @ObservedObject var pendant: PendantModel
    var done: (() -> Void)?
    @State private var invalid = false

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Connect to your Attest").font(.title2.bold())
            Text("This app is a window onto your own Attest, which runs in your Cloudflare account. If you have not set that up yet, do it first on a computer: run `npm run setup` in the Attest folder (the README walks through it). It prints your address, and a link you can tap on this phone to fill in everything below.")
                .font(.footnote).foregroundStyle(.secondary)
            TextField("https://attest.example.com", text: $pendant.server)
                .textFieldStyle(.roundedBorder).autocorrectionDisabled()
                #if os(iOS)
                .textInputAutocapitalization(.never).keyboardType(.URL)
                #endif
            Text("Only for the Bluetooth pendant. Leave empty if you only use Attest in the app.")
                .font(.footnote).foregroundStyle(.secondary)
            TextField("Client ID", text: $pendant.clientId).textFieldStyle(.roundedBorder).autocorrectionDisabled()
            SecureField("Client secret", text: $pendant.clientSecret).textFieldStyle(.roundedBorder)
            if invalid { Text("That is not a web address.").foregroundStyle(.red).font(.footnote) }
            Button("Connect") {
                invalid = pendant.serverURL == nil
                if !invalid { pendant.save(); done?() }
            }
            .buttonStyle(.borderedProminent).controlSize(.large)
        }
        .padding(24).frame(maxWidth: 480)
    }
}
