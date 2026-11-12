package com.attest.app

import java.net.URI
import java.net.URLDecoder

// Plain Kotlin (no Android classes) so the unit tests run on any JVM.

/** Where Attest lives, and the Cloudflare Access service token for uploads (empty for a local Attest). */
data class ServerConfig(val server: String, val clientId: String = "", val clientSecret: String = "")

object ServerAddress {
    /**
     * A normalized `https://host[:port][/path]` (no trailing slash), or null. Plain http is accepted
     * only for this phone itself (localhost / 127.0.0.1, e.g. through `adb reverse`), the same rule
     * as the iPhone app: anything else would send your recordings and sign-in in the clear.
     * A bare host ("attest.example.com") is read as https.
     */
    fun normalize(text: String): String? {
        val t = text.trim() // trailing slashes come off the path below; trimming here would turn "https://" into a host
        if (t.isEmpty() || t.any { it.isWhitespace() }) return null
        val withScheme = if ("://" in t) t else "https://$t"
        val uri = try { URI(withScheme) } catch (e: Exception) { return null }
        val scheme = uri.scheme?.lowercase() ?: return null
        val host = uri.host?.lowercase() ?: return null
        if (host.isEmpty() || uri.rawQuery != null || uri.rawFragment != null || uri.rawUserInfo != null) return null
        val local = host == "localhost" || host == "127.0.0.1"
        if (!(scheme == "https" || (scheme == "http" && local))) return null
        val port = if (uri.port == -1) "" else ":${uri.port}"
        val path = (uri.rawPath ?: "").trimEnd('/')
        return "$scheme://$host$port$path"
    }

    fun host(server: String): String = try { URI(server).host ?: server } catch (e: Exception) { server }

    /** Is [url] a page of this Attest (same scheme, host and port)? */
    fun sameOrigin(server: String, url: String): Boolean = try {
        val a = URI(server); val b = URI(url)
        a.scheme.equals(b.scheme, true) && a.host.equals(b.host, true) && effectivePort(a) == effectivePort(b)
    } catch (e: Exception) { false }

    private fun effectivePort(u: URI) = if (u.port != -1) u.port else if (u.scheme.equals("https", true)) 443 else 80
}

/**
 * `attest://connect?server=...&id=...&secret=...`, what `npm run setup` / `npm run device-token` print,
 * so the phone is configured by tapping a link instead of typing a secret. Anyone can send a link,
 * so the app confirms the host with the person before saving it.
 */
object ConnectLink {
    fun parse(link: String): ServerConfig? {
        val uri = try { URI(link) } catch (e: Exception) { return null }
        if (!uri.scheme.equals("attest", true) || !uri.host.equals("connect", true)) return null
        val q = (uri.rawQuery ?: return null).split('&').mapNotNull {
            val i = it.indexOf('=')
            if (i <= 0) null else decode(it.substring(0, i)) to decode(it.substring(i + 1))
        }.toMap()
        val server = ServerAddress.normalize(q["server"] ?: return null) ?: return null
        return ServerConfig(server, q["id"].orEmpty(), q["secret"].orEmpty())
    }

    private fun decode(s: String) = URLDecoder.decode(s, "UTF-8")
}
