package com.attest.app

import java.io.InputStream
import java.io.OutputStream

// The upload form Attest's POST /api/recordings takes (the same fields the iPhone app sends).
// Plain Kotlin so the unit tests can check it byte for byte.

data class UploadItem(
    val title: String,
    val fileName: String,
    val mimeType: String,
    val durationMs: Long,
    val createdAtMs: Long,
    /**
     * Names the upload job on the phone only. Deliberately NOT sent as the server's `ingest_id`: Attest
     * treats ingest_id uploads as pendant pieces of one call and merges any that are minutes apart, which
     * would glue separate shared recordings together. Shared files upload exactly like the web app's
     * "Upload audio" button.
     */
    val workId: String,
)

enum class Outcome { OK, AUTH, REJECTED, RETRY }

object Multipart {
    fun head(item: UploadItem, boundary: String): ByteArray = buildString {
        fun field(name: String, value: String) =
            append("--$boundary\r\nContent-Disposition: form-data; name=\"$name\"\r\n\r\n$value\r\n")
        field("title", item.title)
        if (item.durationMs > 0) field("duration_ms", item.durationMs.toString())
        field("created_at", item.createdAtMs.toString())
        append("--$boundary\r\nContent-Disposition: form-data; name=\"file\"; filename=\"${quoteSafe(item.fileName)}\"\r\n")
        append("Content-Type: ${item.mimeType}\r\n\r\n")
    }.toByteArray(Charsets.UTF_8)

    fun tail(boundary: String): ByteArray = "\r\n--$boundary--\r\n".toByteArray(Charsets.UTF_8)

    fun write(out: OutputStream, item: UploadItem, audio: InputStream, boundary: String) {
        out.write(head(item, boundary))
        audio.copyTo(out, 64 * 1024)
        out.write(tail(boundary))
    }

    fun length(item: UploadItem, audioBytes: Long, boundary: String): Long =
        head(item, boundary).size + audioBytes + tail(boundary).size

    /** Access service-token headers, only when there is a token (a local Attest has none). */
    fun headers(config: ServerConfig): Map<String, String> =
        if (config.clientId.isEmpty()) emptyMap()
        else mapOf("CF-Access-Client-Id" to config.clientId, "CF-Access-Client-Secret" to config.clientSecret)

    fun outcome(code: Int): Outcome = when (code) {
        in 200..299 -> Outcome.OK
        401, 403 -> Outcome.AUTH
        408, 429 -> Outcome.RETRY
        in 400..499 -> Outcome.REJECTED
        else -> Outcome.RETRY // 5xx, or 0 for no response at all
    }

    /** A title from a shared file's name: "Meeting_2026-11-12.m4a" -> "Meeting 2026-11-12". */
    fun titleFrom(fileName: String): String {
        val base = fileName.substringBeforeLast('.', fileName).replace('_', ' ').trim()
        return base.ifEmpty { "Shared recording" }
    }

    private fun quoteSafe(s: String) = s.replace("\"", "'").replace("\r", " ").replace("\n", " ")
}
