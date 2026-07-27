package com.rollmap.app

import android.app.Activity
import android.net.Uri
import android.util.Log
import androidx.media3.common.MediaItem
import androidx.media3.common.MimeTypes
import androidx.media3.common.audio.ChannelMixingAudioProcessor
import androidx.media3.common.audio.ChannelMixingMatrix
import androidx.media3.effect.Presentation
import androidx.media3.transformer.Composition
import androidx.media3.transformer.EditedMediaItem
import androidx.media3.transformer.Effects
import androidx.media3.transformer.ExportException
import androidx.media3.transformer.ExportResult
import androidx.media3.transformer.Transformer
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.Plugin
import java.io.File
import java.util.concurrent.ConcurrentHashMap

private fun createReencodeAudioProcessor() = ChannelMixingAudioProcessor().apply {
  for (channelCount in 1..8) {
    putChannelMixingMatrix(
      ChannelMixingMatrix.create(channelCount, channelCount).scaleBy(0.999f),
    )
  }
}

@InvokeArg
class ProcessVideoArgs {
  lateinit var operationId: String
  lateinit var inputPath: String
  lateinit var outputPath: String
  lateinit var quality: String
  var startSeconds: Double? = null
  var durationSeconds: Double? = null
}

@InvokeArg
class CancelVideoArgs {
  lateinit var operationId: String
}

private data class ActiveExport(
  val transformer: Transformer,
  val invoke: Invoke,
  val outputFile: File,
)

@TauriPlugin
class VideoProcessorPlugin(private val activity: Activity) : Plugin(activity) {
  private val activeExports = ConcurrentHashMap<String, ActiveExport>()

  @Command
  fun processVideo(invoke: Invoke) {
    val args = try {
      invoke.parseArgs(ProcessVideoArgs::class.java)
    } catch (exception: Exception) {
      invoke.reject(exception.message ?: "Invalid video processing request")
      return
    }

    activity.runOnUiThread {
      val outputFile = File(args.outputPath)
      try {
        require(!activeExports.containsKey(args.operationId)) {
          "This video is already being processed"
        }
        val inputFile = File(args.inputPath)
        require(inputFile.isFile) { "The staged video file no longer exists" }
        outputFile.parentFile?.mkdirs()
        outputFile.delete()

        val mediaItemBuilder = MediaItem.Builder().setUri(Uri.fromFile(inputFile))
        val startSeconds = args.startSeconds
        val durationSeconds = args.durationSeconds
        if (startSeconds != null && durationSeconds != null) {
          val startMs = (startSeconds * 1000).toLong()
          val endMs = ((startSeconds + durationSeconds) * 1000).toLong()
          mediaItemBuilder.setClippingConfiguration(
            MediaItem.ClippingConfiguration.Builder()
              .setStartPositionMs(startMs)
              .setEndPositionMs(endMs)
              .build(),
          )
        }

        val targetHeight = when (args.quality) {
          "compact" -> 540
          "balanced" -> 720
          "high" -> 1080
          "original" -> null
          else -> throw IllegalArgumentException("Unknown video quality")
        }
        val editedMediaItemBuilder = EditedMediaItem.Builder(mediaItemBuilder.build())
        val videoEffects = targetHeight?.let {
          listOf(Presentation.createForHeight(it))
        } ?: emptyList()
        editedMediaItemBuilder.setEffects(
          Effects(listOf(createReencodeAudioProcessor()), videoEffects),
        )

        val transformer = Transformer.Builder(activity.applicationContext)
          .setAudioMimeType(MimeTypes.AUDIO_AAC)
          .setVideoMimeType(MimeTypes.VIDEO_H264)
          .addListener(
            object : Transformer.Listener {
              override fun onCompleted(
                composition: Composition,
                exportResult: ExportResult,
              ) {
                Log.i("RollmapVideo", "Video processing completed: ${args.operationId}")
                activeExports.remove(args.operationId)?.invoke?.resolve()
              }

              override fun onError(
                composition: Composition,
                exportResult: ExportResult,
                exportException: ExportException,
              ) {
                val activeExport = activeExports.remove(args.operationId) ?: return
                activeExport.outputFile.delete()
                val detail = buildString {
                  append(exportException.errorCodeName)
                  exportException.message?.let { append(": ").append(it) }
                  exportException.cause?.message?.let { append(": ").append(it) }
                }
                Log.e("RollmapVideo", detail, exportException)
                activeExport.invoke.reject("Android could not process this video ($detail)")
              }
            },
          )
          .build()
        activeExports[args.operationId] = ActiveExport(transformer, invoke, outputFile)
        transformer.start(editedMediaItemBuilder.build(), outputFile.absolutePath)
      } catch (exception: Exception) {
        activeExports.remove(args.operationId)
        outputFile.delete()
        invoke.reject(exception.message ?: "Android could not process this video format")
      }
    }
  }

  @Command
  fun cancelVideo(invoke: Invoke) {
    val args = try {
      invoke.parseArgs(CancelVideoArgs::class.java)
    } catch (exception: Exception) {
      invoke.reject(exception.message ?: "Invalid video cancellation request")
      return
    }

    activity.runOnUiThread {
      val activeExport = activeExports.remove(args.operationId)
      if (activeExport != null) {
        activeExport.transformer.cancel()
        activeExport.outputFile.delete()
        activeExport.invoke.reject("Video processing cancelled")
      }
      val response = app.tauri.plugin.JSObject()
      response.put("cancelled", activeExport != null)
      invoke.resolve(response)
    }
  }
}