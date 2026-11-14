package expo.modules.rakazostreamasr

import android.Manifest
import android.annotation.SuppressLint
import android.content.pm.PackageManager
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import androidx.core.content.ContextCompat
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import okio.ByteString.Companion.toByteString
import org.json.JSONObject
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Streams call audio from the microphone to the server's recognition relay and
 * reports the transcripts it sends back. The microphone never crosses into JS:
 * JS starts, stops and listens to words.
 */
class StreamAsrModule : Module() {
  private var socket: WebSocket? = null
  private var recorder: AudioRecord? = null
  private var recording: Thread? = null
  private val closing = AtomicBoolean(false)
  private val client = OkHttpClient.Builder()
    .pingInterval(25, TimeUnit.SECONDS)
    .connectTimeout(10, TimeUnit.SECONDS)
    .build()

  override fun definition() = ModuleDefinition {
    Name("RakazoStreamAsr")
    Events("onResult", "onError", "onEnd")

    Function("isAvailable") {
      ContextCompat.checkSelfPermission(
        appContext.reactContext ?: return@Function false,
        Manifest.permission.RECORD_AUDIO,
      ) == PackageManager.PERMISSION_GRANTED
    }

    AsyncFunction("start") { url: String, headers: Map<String, String>, lang: String, promise: Promise ->
      val context = appContext.reactContext
      if (context == null) {
        promise.reject("E_NO_CONTEXT", "The app is not running.", null)
        return@AsyncFunction
      }
      if (ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) !=
        PackageManager.PERMISSION_GRANTED
      ) {
        promise.reject("E_PERMISSION", "Microphone permission is not granted.", null)
        return@AsyncFunction
      }
      stopNow()
      closing.set(false)
      val started = open(url, headers, lang)
      if (started == null) {
        stopNow()
        promise.resolve(false)
      } else {
        promise.resolve(true)
      }
    }

    Function("stop") {
      // Ends the utterance: the recognizer flushes its final revision, the mic keeps rolling.
      send(JSONObject().put("type", "stop"))
    }

    Function("abort") {
      stopNow()
    }

    OnDestroy {
      stopNow()
    }
  }

  /** Opens the relay socket; false when the address was refused outright. */
  private fun open(url: String, headers: Map<String, String>, lang: String): WebSocket? {
    val builder = Request.Builder().url(url)
    for ((name, value) in headers) builder.header(name, value)
    val opened = java.util.concurrent.CountDownLatch(1)
    var accepted = false
    val socket = client.newWebSocket(
      builder.build(),
      object : WebSocketListener() {
        override fun onOpen(webSocket: WebSocket, response: Response) {
          if (closing.get()) {
            webSocket.close(1000, "Stopped")
            return
          }
          send(JSONObject().put("type", "start").put("lang", lang))
          accepted = true
          opened.countDown()
          startMicrophone()
        }

        override fun onMessage(webSocket: WebSocket, text: String) {
          val frame = try {
            JSONObject(text)
          } catch (_: Exception) {
            return
          }
          when (frame.optString("type")) {
            "result" -> sendEvent(
              "onResult",
              mapOf(
                "text" to frame.optString("text"),
                "final" to frame.optBoolean("final", false),
              ),
            )
            "error" -> sendEvent("onError", mapOf("message" to frame.optString("message")))
          }
        }

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
          opened.countDown()
          if (!closing.get()) sendEvent("onError", mapOf("message" to (t.message ?: "connection failed")))
          finish()
        }

        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
          finish()
        }
      },
    )
    this.socket = socket
    opened.await(12, TimeUnit.SECONDS)
    return if (accepted) socket else null
  }

  @SuppressLint("MissingPermission") // `start` checks before any of this runs.
  private fun startMicrophone() {
    val rate = 16_000
    val frameBytes = 3_200 // 100 ms of 16 kHz mono PCM16.
    val minBuffer = AudioRecord.getMinBufferSize(
      rate,
      AudioFormat.CHANNEL_IN_MONO,
      AudioFormat.ENCODING_PCM_16BIT,
    )
    val record = try {
      AudioRecord(
        MediaRecorder.AudioSource.VOICE_COMMUNICATION,
        rate,
        AudioFormat.CHANNEL_IN_MONO,
        AudioFormat.ENCODING_PCM_16BIT,
        maxOf(minBuffer, frameBytes * 4),
      )
    } catch (_: Exception) {
      sendEvent("onError", mapOf("message" to "microphone unavailable"))
      stopNow()
      return
    }
    if (record.state != AudioRecord.STATE_INITIALIZED) {
      record.release()
      sendEvent("onError", mapOf("message" to "microphone unavailable"))
      stopNow()
      return
    }
    recorder = record
    record.startRecording()
    val loop = Thread {
      val buffer = ByteArray(frameBytes)
      while (!closing.get()) {
        val read = try {
          record.read(buffer, 0, frameBytes)
        } catch (_: Exception) {
          break
        }
        if (read <= 0) continue
        val chunk = if (read == frameBytes) buffer else buffer.copyOf(read)
        if (socket?.send(chunk.toByteString()) != true) break
      }
    }
    loop.isDaemon = true
    recording = loop
    loop.start()
  }

  private fun send(frame: JSONObject) {
    try {
      socket?.send(frame.toString())
    } catch (_: Exception) {
      // The close path reports; a dead socket's send failure needs no second word.
    }
  }

  /** Ends the session: mic first so no chunk races the closing socket. */
  private fun stopNow() {
    closing.set(true)
    try {
      recorder?.stop()
    } catch (_: Exception) {
      // Already stopped.
    }
    recording?.interrupt()
    recording = null
    recorder?.release()
    recorder = null
    try {
      socket?.close(1000, "Stopped")
    } catch (_: Exception) {
      socket?.cancel()
    }
    socket = null
  }

  private fun finish() {
    stopNow()
    sendEvent("onEnd", emptyMap<String, Any>())
  }
}
