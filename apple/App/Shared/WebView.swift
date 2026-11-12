import SwiftUI
import WebKit

#if os(iOS)
typealias PlatformViewRepresentable = UIViewRepresentable
#else
typealias PlatformViewRepresentable = NSViewRepresentable
#endif

/// Attest itself: the same web app, with its phone layout and bottom tab bar. Sign-in (Cloudflare Access)
/// happens inside it and the session persists.
struct WebView: PlatformViewRepresentable {
    let url: URL
    /// The page can ask the app to open its native pendant panel (Settings > Open pendant sync).
    var onOpenPendant: () -> Void = {}

    func makeCoordinator() -> Coordinator { Coordinator(onOpenPendant) }

    final class Coordinator: NSObject, WKUIDelegate, WKScriptMessageHandler {
        let onOpenPendant: () -> Void
        init(_ f: @escaping () -> Void) { onOpenPendant = f }
        func userContentController(_ c: WKUserContentController, didReceive m: WKScriptMessage) {
            if (m.body as? [String: Any])?["action"] as? String == "pendant" { DispatchQueue.main.async { self.onOpenPendant() } }
        }
        // <input type=file> and microphone prompts work through the system sheets.
        #if os(iOS)
        func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin, initiatedByFrame frame: WKFrameInfo,
                     type: WKMediaCaptureType, decisionHandler: @escaping (WKPermissionDecision) -> Void) { decisionHandler(.prompt) }
        #endif
    }

    private func make(_ c: Coordinator) -> WKWebView {
        let cfg = WKWebViewConfiguration()
        #if os(iOS)
        cfg.allowsInlineMediaPlayback = true
        #endif
        cfg.mediaTypesRequiringUserActionForPlayback = []
        cfg.userContentController.add(c, name: "attest")
        let v = WKWebView(frame: .zero, configuration: cfg)
        #if os(iOS)
        v.isOpaque = false
        v.backgroundColor = .clear
        #endif
        v.uiDelegate = c
        v.allowsBackForwardNavigationGestures = true
        v.load(URLRequest(url: url))
        return v
    }
    #if os(iOS)
    func makeUIView(context: Context) -> WKWebView { make(context.coordinator) }
    func updateUIView(_ v: WKWebView, context: Context) {}
    #else
    func makeNSView(context: Context) -> WKWebView { make(context.coordinator) }
    func updateNSView(_ v: WKWebView, context: Context) {}
    #endif
}
