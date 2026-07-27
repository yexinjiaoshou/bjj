package com.rollmap.app

import android.content.Context
import android.net.wifi.WifiManager
import android.os.Bundle
import android.webkit.WebView
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import androidx.appcompat.app.AlertDialog

class MainActivity : TauriActivity() {
  private var multicastLock: WifiManager.MulticastLock? = null
  private var webView: WebView? = null
  private var exitDialog: AlertDialog? = null
  private var backRequestPending = false

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    onBackPressedDispatcher.addCallback(
      this,
      object : OnBackPressedCallback(true) {
        override fun handleOnBackPressed() {
          handleSystemBack()
        }
      },
    )
  }

  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    this.webView = webView
  }

  private fun handleSystemBack() {
    if (backRequestPending || exitDialog?.isShowing == true) return
    val currentWebView = webView
    if (currentWebView == null) {
      showExitConfirmation()
      return
    }

    backRequestPending = true
    currentWebView.evaluateJavascript(
      """
      (() => {
        try {
          const handler = window.__ROLLMAP_HANDLE_ANDROID_BACK__;
          return typeof handler === "function" ? handler() : "exit";
        } catch (_) {
          return "exit";
        }
      })()
      """.trimIndent(),
    ) { result ->
      backRequestPending = false
      if (result != "\"handled\"") {
        showExitConfirmation()
      }
    }
  }

  private fun showExitConfirmation() {
    if (isFinishing || isDestroyed || exitDialog?.isShowing == true) return
    exitDialog =
      AlertDialog.Builder(this)
        .setTitle(R.string.exit_confirmation_title)
        .setMessage(R.string.exit_confirmation_message)
        .setNegativeButton(android.R.string.cancel, null)
        .setPositiveButton(R.string.exit_action) { _, _ -> finish() }
        .create()
        .also { dialog ->
          dialog.setOnDismissListener { exitDialog = null }
          dialog.show()
        }
  }

  override fun onResume() {
    super.onResume()
    if (multicastLock?.isHeld == true) return
    val wifiManager =
      applicationContext.getSystemService(Context.WIFI_SERVICE) as? WifiManager ?: return
    multicastLock = runCatching {
      wifiManager.createMulticastLock("rollmap-mdns").apply {
        setReferenceCounted(false)
        acquire()
      }
    }.getOrNull()
  }

  override fun onPause() {
    multicastLock?.let { lock ->
      if (lock.isHeld) lock.release()
    }
    multicastLock = null
    super.onPause()
  }

  override fun onDestroy() {
    exitDialog?.dismiss()
    exitDialog = null
    webView = null
    super.onDestroy()
  }
}
