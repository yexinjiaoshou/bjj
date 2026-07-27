package com.rollmap.app

import android.app.Activity
import androidx.activity.result.ActivityResult
import app.tauri.annotation.ActivityCallback
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import com.journeyapps.barcodescanner.CaptureActivity
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions

class PairingCaptureActivity : CaptureActivity()

@TauriPlugin
class PairingScannerPlugin(private val activity: Activity) : Plugin(activity) {
  @Command
  fun scan(invoke: Invoke) {
    try {
      val options = ScanOptions()
        .setDesiredBarcodeFormats(ScanOptions.QR_CODE)
        .setPrompt("")
        .setBeepEnabled(false)
        .setBarcodeImageEnabled(false)
        .setOrientationLocked(true)
        .setCaptureActivity(PairingCaptureActivity::class.java)
      startActivityForResult(invoke, options.createScanIntent(activity), "scanResult")
    } catch (exception: Exception) {
      invoke.reject(exception.message ?: "Could not open the QR scanner")
    }
  }

  @ActivityCallback
  fun scanResult(invoke: Invoke, result: ActivityResult) {
    try {
      val scanResult = ScanContract().parseResult(result.resultCode, result.data)
      val response = JSObject()
      response.put("value", scanResult.contents)
      invoke.resolve(response)
    } catch (exception: Exception) {
      invoke.reject(exception.message ?: "Could not read the pairing QR code")
    }
  }
}