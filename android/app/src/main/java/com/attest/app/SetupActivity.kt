package com.attest.app

import android.app.Activity
import android.content.Intent
import android.graphics.Color
import android.os.Bundle
import android.text.InputType
import android.util.TypedValue
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView

/** First run, and "Server and sign-in" (long-press the app icon): where your Attest is. */
class SetupActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val current = Store.load(this)
        val pad = dp(24)

        fun text(s: String, size: Float = 14f, color: Int = Color.rgb(161, 161, 170)) = TextView(this).apply {
            text = s; textSize = size; setTextColor(color); setPadding(0, dp(6), 0, dp(6))
        }
        fun field(hint: String, value: String, type: Int) = EditText(this).apply {
            this.hint = hint; setText(value); inputType = type; isSingleLine = true
            setTextColor(Color.WHITE); setHintTextColor(Color.rgb(113, 113, 122))
        }

        val server = field("https://attest.example.com", current?.server.orEmpty(),
            InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI)
        val clientId = field("Client ID", current?.clientId.orEmpty(), InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS)
        val secret = field("Client secret", current?.clientSecret.orEmpty(),
            InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD)
        val error = text("", 14f, Color.rgb(248, 113, 113)).apply { visibility = View.GONE }

        val col = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(pad, pad, pad, pad)
            addView(text("Connect to your Attest", 22f, Color.WHITE))
            addView(text("This app is a window onto your own Attest. Set that up first on a computer " +
                "(npm run setup in the Attest folder, or npm run local). Setup prints your address and an " +
                "attest://connect link: open that link on this phone to fill in everything here."))
            addView(server)
            addView(text("Only needed for \"Share > Upload to Attest\" on a Cloudflare deploy. Leave empty for a local Attest " +
                "or if you only use the app itself.", 12f))
            addView(clientId)
            addView(secret)
            addView(error)
            addView(Button(this@SetupActivity).apply {
                text = "Connect"
                setOnClickListener {
                    val url = ServerAddress.normalize(server.text.toString())
                    if (url == null) {
                        error.text = "Use an https:// address (plain http only for localhost)."
                        error.visibility = View.VISIBLE
                        return@setOnClickListener
                    }
                    Store.save(this@SetupActivity, ServerConfig(url, clientId.text.toString().trim(), secret.text.toString().trim()))
                    startActivity(Intent(this@SetupActivity, MainActivity::class.java)
                        .putExtra(MainActivity.EXTRA_RELOAD, true)
                        .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP))
                    finish()
                }
            })
        }
        val scroll = ScrollView(this).apply { addView(col); setBackgroundColor(Color.rgb(9, 9, 11)) }
        setContentView(scroll)
        Insets.pad(scroll)
    }

    private fun dp(v: Int) = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v.toFloat(), resources.displayMetrics).toInt()
}
