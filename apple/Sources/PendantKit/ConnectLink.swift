import Foundation

/// `attest://connect?server=...&id=...&secret=...`: what setup prints (and the Mac can AirDrop or message to
/// the phone) so the app is configured by tapping a link instead of typing a secret on a phone keyboard.
public enum ConnectLink {
    public static func make(server: URL, clientId: String, clientSecret: String) -> URL {
        var c = URLComponents()
        c.scheme = "attest"; c.host = "connect"
        c.queryItems = [URLQueryItem(name: "server", value: server.absoluteString),
                        URLQueryItem(name: "id", value: clientId), URLQueryItem(name: "secret", value: clientSecret)]
        return c.url!
    }

    /// Nil unless it is a well-formed connect link to an https server (plain http only for localhost, for
    /// development). The app still asks the person to confirm the host before saving anything: a link is
    /// something other people can send you.
    public static func parse(_ url: URL) -> ServerConfig? {
        guard url.scheme == "attest", url.host == "connect",
              let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems else { return nil }
        func q(_ n: String) -> String { items.first { $0.name == n }?.value ?? "" }
        guard let server = URL(string: q("server")), let host = server.host, !host.isEmpty else { return nil }
        let local = host == "localhost" || host == "127.0.0.1"
        guard server.scheme == "https" || (server.scheme == "http" && local) else { return nil }
        return ServerConfig(server: server, clientId: q("id"), clientSecret: q("secret"))
    }
}
