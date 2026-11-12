package com.attest.app

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.app.AlertDialog
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.view.Gravity
import android.view.View
import android.webkit.CookieManager
import android.webkit.PermissionRequest
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView

/**
 * Attest itself: the same web app, with its phone layout and bottom tab bar (Home, Ask, Record,
 * Recordings, Settings). Sign-in (Cloudflare Access) happens inside it and the session persists.
 */
class MainActivity : Activity() {
    companion object {
        const val EXTRA_RELOAD = "reload"
        private const val REQ_FILE = 1
        private const val REQ_MIC = 2
    }

    private lateinit var web: WebView
    private lateinit var offline: View
    private lateinit var offlineText: TextView
    private var config: ServerConfig? = null
    private var fileCallback: ValueCallback<Array<Uri>>? = null
    private var pendingMic: PermissionRequest? = null

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        config = Store.load(this)
        if (config == null && intent?.data == null) {
            startActivity(Intent(this, SetupActivity::class.java)); finish(); return
        }

        web = WebView(this).apply {
            setBackgroundColor(Color.rgb(9, 9, 11))
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.mediaPlaybackRequiresUserGesture = false
            settings.allowFileAccess = false
            settings.allowContentAccess = false
            webViewClient = Client()
            webChromeClient = Chrome()
            setDownloadListener { url, userAgent, disposition, mime, _ -> download(url, userAgent, disposition, mime) }
            addJavascriptInterface(PrintBridge(), "AttestAndroid")
        }
        CookieManager.getInstance().setAcceptCookie(true)
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, true) // the Access login hops domains

        offlineText = TextView(this).apply { setTextColor(Color.rgb(212, 212, 216)); textSize = 15f; gravity = Gravity.CENTER }
        offline = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL; gravity = Gravity.CENTER; visibility = View.GONE
            setBackgroundColor(Color.rgb(9, 9, 11)); setPadding(48, 48, 48, 48)
            addView(offlineText)
            addView(Button(this@MainActivity).apply { text = "Try again"; setOnClickListener { offline.visibility = View.GONE; web.reload() } })
            addView(Button(this@MainActivity).apply { text = "Server and sign-in"; setOnClickListener { openSetup() } })
        }
        val root = FrameLayout(this).apply { addView(web); addView(offline) }
        setContentView(root)
        Insets.pad(root)
        registerBack()

        if (savedInstanceState != null) web.restoreState(savedInstanceState)
        else config?.let { web.loadUrl(it.server) }
        // A connect link is handled once: not again when Android recreates the activity or it is reopened
        // from Recents with the original intent (that would offer to switch back to an old server).
        val fromHistory = (intent?.flags ?: 0) and Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY != 0
        if (savedInstanceState == null && !fromHistory) handleLink(intent)
        else if (config == null) openSetup()
        sweepOutbox()
    }

    // Shared files that never got uploaded (the worker gives up after about two days): don't keep them forever.
    private fun sweepOutbox() = Thread {
        val cutoff = System.currentTimeMillis() - 7L * 24 * 3600 * 1000
        java.io.File(filesDir, "outbox").listFiles()?.filter { it.lastModified() < cutoff }?.forEach { it.delete() }
    }.start()

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        if (intent.getBooleanExtra(EXTRA_RELOAD, false)) {
            config = Store.load(this)
            config?.let { offline.visibility = View.GONE; web.loadUrl(it.server) }
        }
        handleLink(intent)
    }

    // attest://connect?server=...&id=...&secret=... from setup. Anyone can send you a link, so confirm the host.
    private fun handleLink(intent: Intent?) {
        val data = intent?.data ?: return
        intent.data = null
        val c = ConnectLink.parse(data.toString())
        if (c == null) {
            AlertDialog.Builder(this).setMessage("That Attest link is not valid.").setPositiveButton("OK") { _, _ ->
                if (config == null) openSetup()
            }.show()
            return
        }
        AlertDialog.Builder(this)
            .setTitle("Connect to ${ServerAddress.host(c.server)}?")
            .setMessage("Attest will open this server and upload recordings you share to it. Only continue if this is your own Attest.")
            .setPositiveButton("Connect") { _, _ ->
                Store.save(this, c); config = c
                offline.visibility = View.GONE; web.loadUrl(c.server)
            }
            .setNegativeButton("Cancel") { _, _ -> if (config == null) openSetup() }
            .setCancelable(false)
            .show()
    }

    private fun openSetup() = startActivity(Intent(this, SetupActivity::class.java))

    // Export .md / .docx / .zip are server links that answer with a file: save them to Downloads with the
    // app's sign-in (the Access cookie), only from your own Attest. (blob: downloads, like the mind-map
    // image, are not supported.)
    private fun download(url: String, userAgent: String, disposition: String?, mime: String?) {
        val server = config?.server
        if (server == null || !ServerAddress.sameOrigin(server, url)) return
        val name = android.webkit.URLUtil.guessFileName(url, disposition, mime)
        val req = android.app.DownloadManager.Request(Uri.parse(url))
            .setTitle(name)
            .setMimeType(mime)
            .addRequestHeader("User-Agent", userAgent)
            .setNotificationVisibility(android.app.DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
            .setDestinationInExternalPublicDir(android.os.Environment.DIRECTORY_DOWNLOADS, name)
        CookieManager.getInstance().getCookie(url)?.let { req.addRequestHeader("Cookie", it) }
        try {
            getSystemService(android.app.DownloadManager::class.java).enqueue(req)
            android.widget.Toast.makeText(this, "Saving $name to Downloads", android.widget.Toast.LENGTH_SHORT).show()
        } catch (e: Exception) {
            android.widget.Toast.makeText(this, "Could not save $name", android.widget.Toast.LENGTH_LONG).show()
        }
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        if (::web.isInitialized) web.saveState(outState)
    }

    override fun onPause() {
        super.onPause()
        CookieManager.getInstance().flush() // keep the sign-in if Android kills the app
    }

    // Back goes back a page in Attest before it leaves the app. Android 13+ delivers the back gesture
    // through OnBackInvokedDispatcher (and from Android 16 onBackPressed is no longer called for it).
    private fun goBackOrLeave() {
        if (::web.isInitialized && web.canGoBack()) web.goBack() else finish()
    }

    private fun registerBack() {
        if (android.os.Build.VERSION.SDK_INT >= 33) {
            onBackInvokedDispatcher.registerOnBackInvokedCallback(
                android.window.OnBackInvokedDispatcher.PRIORITY_DEFAULT
            ) { goBackOrLeave() }
        }
    }

    @SuppressLint("GestureBackNavigation") // only reached on Android 10-12; 13+ is handled by registerBack()
    @Deprecated("Android 10-12 only; 13+ uses registerBack()")
    override fun onBackPressed() = goBackOrLeave()

    private inner class Client : WebViewClient() {
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            val url = request.url
            return when (url.scheme?.lowercase()) {
                // Attest, the Access login and its identity provider all stay in the app, so the session cookie lands here.
                "http", "https" -> false
                // Only your own Attest's pages may offer a connect link; from anywhere else it is ignored.
                "attest" -> {
                    val page = view.url
                    val server = config?.server
                    if (page != null && server != null && ServerAddress.sameOrigin(server, page)) handleLink(Intent(Intent.ACTION_VIEW, url))
                    true
                }
                else -> { // mailto:, tel:, intent: ... go to the app that handles them
                    try { startActivity(Intent(Intent.ACTION_VIEW, url)) } catch (e: ActivityNotFoundException) {}
                    true
                }
            }
        }

        override fun onPageFinished(view: WebView, url: String) {
            // Near-black only until the first page paints (no white flash at launch). After that white, so
            // pages without a background of their own, like Export > Print / PDF, are dark-on-white.
            view.setBackgroundColor(Color.WHITE)
            // A web view ignores window.print(): route it to Android's print dialog (Save as PDF lives there).
            val server = config?.server
            if (server != null && ServerAddress.sameOrigin(server, url)) {
                view.evaluateJavascript("window.print = function () { AttestAndroid.print(); };", null)
            }
        }

        override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
            if (!request.isForMainFrame) return
            val host = config?.let { ServerAddress.host(it.server) } ?: "your Attest"
            offlineText.text = "Could not reach $host.\n\n${error.description}"
            offline.visibility = View.VISIBLE
        }
    }

    /** `AttestAndroid.print()`: the page's print button. Only does anything on your own Attest's pages. */
    private inner class PrintBridge {
        @android.webkit.JavascriptInterface
        fun print() = runOnUiThread {
            val server = config?.server ?: return@runOnUiThread
            val page = web.url ?: return@runOnUiThread
            if (!ServerAddress.sameOrigin(server, page)) return@runOnUiThread
            val name = (web.title?.takeIf { it.isNotBlank() } ?: "Attest").take(60)
            getSystemService(android.print.PrintManager::class.java)
                .print(name, web.createPrintDocumentAdapter(name), null)
        }
    }

    private inner class Chrome : WebChromeClient() {
        // The Record tab asks for the microphone: grant it to your Attest only, after Android's own prompt.
        override fun onPermissionRequest(request: PermissionRequest) {
            val server = config?.server
            val wantsMic = PermissionRequest.RESOURCE_AUDIO_CAPTURE in request.resources
            if (!wantsMic || server == null || !ServerAddress.sameOrigin(server, request.origin.toString())) {
                request.deny(); return
            }
            if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
                request.grant(arrayOf(PermissionRequest.RESOURCE_AUDIO_CAPTURE))
            } else {
                pendingMic?.deny()
                pendingMic = request
                requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), REQ_MIC)
            }
        }

        override fun onPermissionRequestCanceled(request: PermissionRequest) {
            if (pendingMic == request) pendingMic = null
        }

        // <input type=file>: Upload on the Record tab.
        override fun onShowFileChooser(view: WebView, callback: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean {
            fileCallback?.onReceiveValue(null)
            fileCallback = callback
            return try {
                startActivityForResult(params.createIntent(), REQ_FILE); true
            } catch (e: ActivityNotFoundException) {
                fileCallback = null; false
            }
        }
    }

    @Deprecated("Framework Activity result API")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode != REQ_FILE) return
        val picked = if (resultCode != RESULT_OK || data == null) null
            else data.clipData?.let { c -> Array(c.itemCount) { c.getItemAt(it).uri } }
                ?: WebChromeClient.FileChooserParams.parseResult(resultCode, data)
        fileCallback?.onReceiveValue(picked)
        fileCallback = null
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode != REQ_MIC) return
        val req = pendingMic ?: return
        pendingMic = null
        if (grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED) req.grant(arrayOf(PermissionRequest.RESOURCE_AUDIO_CAPTURE))
        else req.deny()
    }

    override fun onDestroy() {
        if (::web.isInitialized) web.destroy()
        super.onDestroy()
    }
}
