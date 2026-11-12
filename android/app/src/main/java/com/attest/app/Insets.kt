package com.attest.app

import android.os.Build
import android.view.View
import android.view.WindowInsets

/**
 * Android 15+ draws apps edge to edge. Keep content clear of the status bar, the navigation bar and
 * the keyboard by padding the root view; the window background (Attest's near-black) shows behind the bars.
 */
object Insets {
    fun pad(view: View) {
        view.setOnApplyWindowInsetsListener { v, insets ->
            if (Build.VERSION.SDK_INT >= 30) {
                val bars = insets.getInsets(WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout() or WindowInsets.Type.ime())
                v.setPadding(bars.left, bars.top, bars.right, bars.bottom)
                WindowInsets.CONSUMED
            } else {
                // Android 10 (API 29) has no WindowInsets.Type; these cover the bars and the keyboard there.
                @Suppress("DEPRECATION")
                v.setPadding(insets.systemWindowInsetLeft, insets.systemWindowInsetTop, insets.systemWindowInsetRight, insets.systemWindowInsetBottom)
                @Suppress("DEPRECATION")
                insets.consumeSystemWindowInsets()
            }
        }
        view.requestApplyInsets()
    }
}
