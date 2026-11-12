package com.attest.app

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.webkit.CookieManager
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import androidx.work.workDataOf
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.util.UUID
import java.util.concurrent.TimeUnit

/**
 * Uploads one shared recording. WorkManager runs it when there is a network, keeps it across app
 * closes and reboots, and retries with backoff. (A retry after the server stored the file but the
 * answer was lost would make a second copy; see workId in Multipart.kt for why there is no ingest_id.)
 */
class UploadWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    companion object {
        private const val MAX_ATTEMPTS = 20
        private const val CHANNEL = "uploads"

        fun enqueue(context: Context, file: File, item: UploadItem) {
            val req = OneTimeWorkRequestBuilder<UploadWorker>()
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
                .setInputData(workDataOf(
                    "path" to file.path, "title" to item.title, "name" to item.fileName, "mime" to item.mimeType,
                    "duration" to item.durationMs, "created" to item.createdAtMs, "work" to item.workId,
                ))
                .addTag("upload")
                .build()
            WorkManager.getInstance(context).enqueueUniqueWork(item.workId, ExistingWorkPolicy.KEEP, req)
        }
    }

    override suspend fun doWork(): Result = withContext(Dispatchers.IO) {
        val d = inputData
        val file = File(d.getString("path") ?: return@withContext Result.failure())
        if (!file.exists()) return@withContext Result.failure()
        val item = UploadItem(
            title = d.getString("title") ?: "Shared recording",
            fileName = d.getString("name") ?: "recording",
            mimeType = d.getString("mime") ?: "application/octet-stream",
            durationMs = d.getLong("duration", 0),
            createdAtMs = d.getLong("created", System.currentTimeMillis()),
            workId = d.getString("work") ?: UUID.randomUUID().toString(),
        )
        val config = Store.load(applicationContext) ?: return@withContext Result.retry()

        val code = try { send(config, file, item) } catch (e: IOException) { 0 } catch (e: Exception) {
            return@withContext giveUp(file, item, "something went wrong on the phone (${e.javaClass.simpleName})")
        }
        when (Multipart.outcome(code)) {
            Outcome.OK -> { file.delete(); Result.success() }
            Outcome.RETRY -> if (runAttemptCount + 1 >= MAX_ATTEMPTS) giveUp(file, item, "the server kept failing ($code)") else Result.retry()
            Outcome.AUTH -> giveUp(file, item, "the server refused the sign-in ($code). Open the app and sign in, or add the Client ID and secret under Server and sign-in")
            Outcome.REJECTED -> giveUp(file, item, "the server rejected it ($code)")
        }
    }

    private fun send(config: ServerConfig, file: File, item: UploadItem): Int {
        val boundary = "attest-" + UUID.randomUUID()
        val conn = URL(config.server + "/api/recordings").openConnection() as HttpURLConnection
        try {
            conn.requestMethod = "POST"
            conn.doOutput = true
            conn.connectTimeout = 30_000
            conn.readTimeout = 120_000
            conn.setFixedLengthStreamingMode(Multipart.length(item, file.length(), boundary))
            conn.setRequestProperty("Content-Type", "multipart/form-data; boundary=$boundary")
            Multipart.headers(config).forEach { (k, v) -> conn.setRequestProperty(k, v) }
            // No service token: use the app's own sign-in (the Access cookie the web view holds), if any.
            if (config.clientId.isEmpty()) CookieManager.getInstance().getCookie(config.server)?.let { conn.setRequestProperty("Cookie", it) }
            conn.instanceFollowRedirects = false // a redirect means Access wants a login: treat it as a sign-in failure
            conn.outputStream.use { out -> file.inputStream().use { Multipart.write(out, item, it, boundary) } }
            val code = conn.responseCode
            return if (code in 300..399) 401 else code
        } finally {
            conn.disconnect()
        }
    }

    private fun giveUp(file: File, item: UploadItem, why: String): Result {
        file.delete()
        notifyFailure(item.title, why)
        return Result.failure()
    }

    private fun notifyFailure(title: String, why: String) {
        val ctx = applicationContext
        // POST_NOTIFICATIONS exists from Android 13; below that it always reads as denied.
        if (android.os.Build.VERSION.SDK_INT >= 33 &&
            ctx.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return
        val nm = ctx.getSystemService(NotificationManager::class.java)
        if (!nm.areNotificationsEnabled()) return
        nm.createNotificationChannel(NotificationChannel(CHANNEL, "Uploads", NotificationManager.IMPORTANCE_DEFAULT))
        val open = PendingIntent.getActivity(ctx, 0, Intent(ctx, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
        val n = android.app.Notification.Builder(ctx, CHANNEL)
            .setSmallIcon(android.R.drawable.stat_notify_error)
            .setContentTitle("Could not upload \"$title\"")
            .setContentText(why)
            .setStyle(android.app.Notification.BigTextStyle().bigText("Could not upload \"$title\": $why. Share it again to retry."))
            .setContentIntent(open)
            .setAutoCancel(true)
            .build()
        nm.notify(title.hashCode(), n)
    }
}
