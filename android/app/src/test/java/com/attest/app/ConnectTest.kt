package com.attest.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream

class ConnectTest {
    @Test fun normalizesAddresses() {
        assertEquals("https://attest.example.com", ServerAddress.normalize("https://attest.example.com/"))
        assertEquals("https://attest.example.com", ServerAddress.normalize("  attest.example.com  "))
        assertEquals("https://attest.example.com", ServerAddress.normalize("HTTPS://Attest.Example.com"))
        assertEquals("https://a.b:8443/sub", ServerAddress.normalize("https://a.b:8443/sub/"))
        assertEquals("http://localhost:8787", ServerAddress.normalize("http://localhost:8787"))
        assertEquals("http://127.0.0.1:8787", ServerAddress.normalize("http://127.0.0.1:8787"))
    }

    @Test fun refusesUnsafeOrBrokenAddresses() {
        assertNull(ServerAddress.normalize(""))
        assertNull(ServerAddress.normalize("http://attest.example.com")) // plain http off-device
        assertNull(ServerAddress.normalize("http://192.168.1.20:8787"))
        assertNull(ServerAddress.normalize("ftp://attest.example.com"))
        assertNull(ServerAddress.normalize("https://"))
        assertNull(ServerAddress.normalize("https://a b.com"))
        assertNull(ServerAddress.normalize("https://user:pw@attest.example.com"))
        assertNull(ServerAddress.normalize("https://attest.example.com/?x=1"))
    }

    @Test fun sameOrigin() {
        assertTrue(ServerAddress.sameOrigin("https://a.example.com", "https://a.example.com/"))
        assertTrue(ServerAddress.sameOrigin("https://a.example.com", "https://A.example.com:443/x"))
        assertFalse(ServerAddress.sameOrigin("https://a.example.com", "https://evil.example.com/"))
        assertFalse(ServerAddress.sameOrigin("https://a.example.com", "http://a.example.com/"))
        assertFalse(ServerAddress.sameOrigin("http://localhost:8787", "http://localhost:9999/"))
    }

    @Test fun parsesConnectLinks() {
        val c = ConnectLink.parse("attest://connect?server=https%3A%2F%2Fattest.example.com&id=abc.access&secret=s%2Bcr%3Dt")
        assertEquals(ServerConfig("https://attest.example.com", "abc.access", "s+cr=t"), c)
        assertEquals(ServerConfig("https://attest.example.com"), ConnectLink.parse("attest://connect?server=https://attest.example.com"))
    }

    @Test fun refusesBadConnectLinks() {
        assertNull(ConnectLink.parse("https://connect?server=https://a.com"))
        assertNull(ConnectLink.parse("attest://other?server=https://a.com"))
        assertNull(ConnectLink.parse("attest://connect"))
        assertNull(ConnectLink.parse("attest://connect?server=http%3A%2F%2Fevil.com"))
        assertNull(ConnectLink.parse("attest://connect?id=x&secret=y"))
    }

    private val item = UploadItem("Standup", "stand\"up.m4a", "audio/mp4", 61_000, 1_700_000_000_000, "android-1")

    @Test fun multipartBody() {
        val out = ByteArrayOutputStream()
        Multipart.write(out, item, ByteArrayInputStream(byteArrayOf(1, 2, 3)), "B")
        val text = String(out.toByteArray(), Charsets.ISO_8859_1)
        assertTrue(text.startsWith("--B\r\nContent-Disposition: form-data; name=\"title\"\r\n\r\nStandup\r\n"))
        assertTrue("duration_ms" in text && "61000" in text)
        assertFalse("ingest_id" in text) // see UploadItem.workId
        assertTrue("filename=\"stand'up.m4a\"\r\nContent-Type: audio/mp4\r\n\r\n\u0001\u0002\u0003\r\n--B--\r\n" in text)
        assertEquals(out.size().toLong(), Multipart.length(item, 3, "B"))
    }

    @Test fun omitsUnknownDuration() {
        val head = String(Multipart.head(item.copy(durationMs = 0), "B"))
        assertFalse("duration_ms" in head)
    }

    @Test fun headersOnlyWithAToken() {
        assertEquals(emptyMap<String, String>(), Multipart.headers(ServerConfig("https://a.com")))
        assertEquals(mapOf("CF-Access-Client-Id" to "i", "CF-Access-Client-Secret" to "s"), Multipart.headers(ServerConfig("https://a.com", "i", "s")))
    }

    @Test fun outcomes() {
        assertEquals(Outcome.OK, Multipart.outcome(201))
        assertEquals(Outcome.AUTH, Multipart.outcome(401))
        assertEquals(Outcome.AUTH, Multipart.outcome(403))
        assertEquals(Outcome.RETRY, Multipart.outcome(429))
        assertEquals(Outcome.REJECTED, Multipart.outcome(413))
        assertEquals(Outcome.RETRY, Multipart.outcome(503))
        assertEquals(Outcome.RETRY, Multipart.outcome(0))
    }

    @Test fun titles() {
        assertEquals("Meeting 2026-11-12", Multipart.titleFrom("Meeting_2026-11-12.m4a"))
        assertEquals("notes", Multipart.titleFrom("notes"))
        assertEquals("Shared recording", Multipart.titleFrom(".m4a"))
    }
}
