import Foundation

public struct ServerConfig: Codable, Equatable {
    public var server: URL
    /// Cloudflare Access service token (setup prints these once). Empty for a local server without Access.
    public var clientId: String
    public var clientSecret: String
    public init(server: URL, clientId: String = "", clientSecret: String = "") {
        self.server = server; self.clientId = clientId; self.clientSecret = clientSecret
    }
}

public enum UploadError: Error, Equatable, LocalizedError {
    case auth(Int)        // 401/403: the token is wrong, expired, or not allowed
    case rejected(Int)    // other 4xx: this recording will never be accepted as sent
    case server(Int)      // 5xx / network: try again later
    public var errorDescription: String? {
        switch self {
        case .auth(let c): return "The server refused the sign-in (\(c)). Check the Client ID and secret."
        case .rejected(let c): return "The server rejected the recording (\(c))."
        case .server(let c): return "The server had a problem (\(c)). It will retry."
        }
    }
}

/// The upload form Attest's /api/recordings takes. Shared by the foreground and background uploaders.
public enum Multipart {
    public static func body(item: OutboxItem, audio: Data, boundary: String) -> Data {
        var body = Data()
        func field(_ name: String, _ value: String) {
            body.append("--\(boundary)\r\nContent-Disposition: form-data; name=\"\(name)\"\r\n\r\n\(value)\r\n".data(using: .utf8)!)
        }
        field("title", item.title)
        field("duration_ms", String(item.durationMs))
        field("created_at", String(item.createdAtMs))
        field("ingest_id", item.ingestId)
        body.append("--\(boundary)\r\nContent-Disposition: form-data; name=\"file\"; filename=\"\(item.fileName)\"\r\nContent-Type: audio/webm\r\n\r\n".data(using: .utf8)!)
        body.append(audio)
        body.append("\r\n--\(boundary)--\r\n".data(using: .utf8)!)
        return body
    }

    public static func request(config: ServerConfig, boundary: String) -> URLRequest {
        var req = URLRequest(url: config.server.appendingPathComponent("api/recordings"))
        req.httpMethod = "POST"
        req.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        if !config.clientId.isEmpty {
            req.setValue(config.clientId, forHTTPHeaderField: "CF-Access-Client-Id")
            req.setValue(config.clientSecret, forHTTPHeaderField: "CF-Access-Client-Secret")
        }
        return req
    }

    /// What an HTTP status means for an upload.
    public static func outcome(code: Int) -> Result<Void, UploadError> {
        switch code {
        case 200 ..< 300: return .success(())
        case 401, 403: return .failure(.auth(code))
        case 400 ..< 500: return .failure(.rejected(code))
        default: return .failure(.server(code))
        }
    }
}

/// Sends one outbox item to Attest as a normal upload. The server dedupes on `ingest_id`, so
/// retrying a recording that actually got through returns the existing row instead of a copy.
public final class Uploader {
    private let config: ServerConfig
    private let session: URLSession
    public init(config: ServerConfig, session: URLSession = .shared) { self.config = config; self.session = session }

    @discardableResult
    public func upload(_ item: OutboxItem, audio: Data) async throws -> String {
        let boundary = "attest-\(UUID().uuidString)"
        let body = Multipart.body(item: item, audio: audio, boundary: boundary)
        let req = Multipart.request(config: config, boundary: boundary)
        let data: Data, resp: URLResponse
        do { (data, resp) = try await session.upload(for: req, from: body) }
        catch { throw UploadError.server(0) }
        let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
        if case .failure(let e) = Multipart.outcome(code: code) { throw e }
        return ((try? JSONSerialization.jsonObject(with: data)) as? [String: Any])?["id"] as? String ?? ""
    }
}
