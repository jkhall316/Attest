package com.attest.app

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.media.MediaMetadataRetriever
import android.net.Uri
import android.os.Bundle
import android.provider.OpenableColumns
import android.widget.Toast
import java.io.File
import java.util.UUID

/**
 * "Share > Upload to Attest" from a voice recorder, Files, WhatsApp... Each file is copied into the
 * app's own storage right away (the sharing app's permission to read it does not last), then handed
 * to UploadWorker, which uploads it in the background and retries until the server has it.
 */
class ShareActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // Recreated (rotation) while the copy or the notification prompt is running: the first instance's
        // thread already queued the files, so doing it again would upload them twice.
        if (savedInstanceState != null) return
        val config = Store.load(this)
        if (config == null) {
            Toast.makeText(this, "Connect the Attest app to your server first.", Toast.LENGTH_LONG).show()
            startActivity(Intent(this, SetupActivity::class.java))
            finish(); return
        }
        val uris = sharedUris(intent)
        // Copying a long recording can take seconds: off the main thread, then report.
        Thread {
            var queued = 0
            for (uri in uris) {
                val item = try { copyIn(uri, intent.type) } catch (e: Exception) {
                    android.util.Log.w("Attest", "could not read shared file", e); null
                } ?: continue
                UploadWorker.enqueue(this, item.first, item.second)
                queued++
            }
            runOnUiThread { done(config, queued) }
        }.start()
    }

    private fun done(config: ServerConfig, queued: Int) {
        val host = ServerAddress.host(config.server)
        Toast.makeText(
            this,
            when {
                queued == 0 -> "Nothing to upload: Attest could not read that file."
                queued == 1 -> "Uploading to $host"
                else -> "Uploading $queued recordings to $host"
            },
            Toast.LENGTH_SHORT
        ).show()
        // Only used to say when an upload fails for good; asked once, the share goes ahead either way.
        if (queued > 0 && android.os.Build.VERSION.SDK_INT >= 33 &&
            checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED &&
            !getSharedPreferences("attest", MODE_PRIVATE).getBoolean("asked_notify", false)) {
            getSharedPreferences("attest", MODE_PRIVATE).edit().putBoolean("asked_notify", true).apply()
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1)
            return // finish once answered
        }
        finish()
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        finish()
    }

    @Suppress("DEPRECATION")
    private fun sharedUris(intent: Intent): List<Uri> = when (intent.action) {
        Intent.ACTION_SEND -> listOfNotNull(intent.getParcelableExtra<Uri>(Intent.EXTRA_STREAM))
        Intent.ACTION_SEND_MULTIPLE -> intent.getParcelableArrayListExtra<Uri>(Intent.EXTRA_STREAM).orEmpty()
        else -> emptyList()
    }

    /** Copy into filesDir/outbox and describe it. */
    private fun copyIn(uri: Uri, sharedType: String?): Pair<File, UploadItem>? {
        // content:// only: a file:// URI would be opened with this app's own rights, so another app could
        // "share" Attest's private files (its cookies, its settings) and have them uploaded.
        if (uri.scheme != "content") return null
        var name = "recording"
        contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
            if (c.moveToFirst() && !c.isNull(0)) name = c.getString(0)
        }
        val mime = contentResolver.getType(uri) ?: sharedType?.takeUnless { it.endsWith("/*") } ?: "application/octet-stream"
        if (!mime.startsWith("audio/") && !mime.startsWith("video/")) return null
        val id = UUID.randomUUID().toString()
        val dir = File(filesDir, "outbox").apply { mkdirs() }
        val file = File(dir, id)
        try {
            contentResolver.openInputStream(uri)?.use { input -> file.outputStream().use { input.copyTo(it) } } ?: return null
        } catch (e: Exception) {
            file.delete(); throw e // no half-written leftovers
        }
        if (file.length() == 0L) { file.delete(); return null }

        val duration = try {
            MediaMetadataRetriever().run {
                setDataSource(file.path)
                val d = extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLongOrNull() ?: 0L
                release(); d
            }
        } catch (e: Exception) { 0L }

        return file to UploadItem(
            title = Multipart.titleFrom(name),
            fileName = name,
            mimeType = mime,
            durationMs = duration,
            createdAtMs = System.currentTimeMillis(),
            workId = "android-$id",
        )
    }
}
