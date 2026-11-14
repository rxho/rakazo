package expo.modules.rakazostreamasr

import android.Manifest
import android.annotation.SuppressLint
import android.content.pm.PackageManager
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.util.Log
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
import java.util.concurrent.atomic.AtomicInteger

/**
 * Streams call audio from the microphone to the server's recognition relay and
 * reports the transcripts it sends back. The microphone never crosses into JS:
 * JS starts, stops and listens to words.
 *
 * Utterances reuse one connection: `stop` marks the utterance end while the
 * microphone keeps rolling, and each `start` tears the previous session down
 * first. Sockets from an older session may deliver callbacks after a newer one
 * began, so every callback carries the session generation it belongs to and is
 * ignored once that generation has been replaced.
 */
class StreamAsrModule : Module() {
  private var socket: WebSocket? = null
  private var recorder: AudioRecord? = null
  private var recording: Thread? = null
  private val closing = AtomicBoolean(false)
  private val generation = AtomicInteger(0)
  // Between one utterance's stop and the next start the mic keeps rolling, but
  // its audio belongs to no utterance and is not forwarded.
  private val forwarding = AtomicBoolean(true)
  private val client = OkHttpClient.Builder()
    .pingInterval(25, TimeUnit.SECONDS)
    .connectTimeout(10, TimeUnit.SECONDS)
    .build()

  private fun note(message: String) = Log.i(TAG, message)

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
      val alive = socket != null && !closing.get() && recording?.isAlive == true
      if (alive) {
        // One connection carries a whole call's utterances: the server's pool
        // of decoder threads is small, and a fresh connection per utterance
        // exhausts it a few turns into a call.
        note("start: reusing the open recognizer socket")
        send(JSONObject().put("type", "start").put("lang", lang))
        forwarding.set(true)
        promise.resolve(true)
        return@AsyncFunction
      }
      note("start: opening $url lang=$lang")
      stopNow("superseded by start")
      closing.set(false)
      val started = open(url, headers, lang)
      if (started == null) {
        note("start: relay refused the connection")
        stopNow("open refused")
        promise.resolve(false)
      } else {
        promise.resolve(true)
      }
    }

    Function("stop") {
      // Ends the utterance: the recognizer flushes its final revision, the mic keeps rolling.
      note("utterance stop")
      send(JSONObject().put("type", "stop"))
      forwarding.set(false)
    }

    Function("abort") {
      note("abort")
      stopNow("aborted")
    }

    OnDestroy {
      note("destroyed")
      stopNow("destroyed")
    }
  }

  /** Opens the relay socket; null when the address was refused outright. */
  private fun open(url: String, headers: Map<String, String>, lang: String): WebSocket? {
    val builder = Request.Builder().url(url)
    for ((name, value) in headers) builder.header(name, value)
    val gen = generation.incrementAndGet()
    val opened = java.util.concurrent.CountDownLatch(1)
    var accepted = false
    val socket = client.newWebSocket(
      builder.build(),
      object : WebSocketListener() {
        override fun onOpen(webSocket: WebSocket, response: Response) {
          if (generation.get() != gen) {
            note("open ignored: stale generation")
            webSocket.close(1000, "Replaced")
            return
          }
          note("socket open, starting microphone")
          send(JSONObject().put("type", "start").put("lang", lang))
          forwarding.set(true)
          accepted = true
          opened.countDown()
          startMicrophone(gen)
        }

        override fun onMessage(webSocket: WebSocket, text: String) {
          if (generation.get() != gen) return
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
            "error" -> {
              note("relay error: ${frame.optString("message")}")
              sendEvent("onError", mapOf("message" to frame.optString("message")))
            }
          }
        }

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
          note("socket failure gen=$gen: ${t.message}")
          opened.countDown()
          if (generation.get() != gen) return
          sendEvent("onError", mapOf("message" to (t.message ?: "connection failed")))
          finish(gen)
        }

        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
          note("socket closed gen=$gen code=$code")
          if (generation.get() != gen) return
          finish(gen)
        }
      },
    )
    this.socket = socket
    opened.await(12, TimeUnit.SECONDS)
    return if (accepted) socket else null
  }

  @SuppressLint("MissingPermission") // `start` checks before any of this runs.
  private fun startMicrophone(gen: Int) {
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
    } catch (e: Exception) {
      note("microphone constructor failed: ${e.message}")
      sendEvent("onError", mapOf("message" to "microphone unavailable"))
      stopNow("mic constructor failed")
      return
    }
    if (record.state != AudioRecord.STATE_INITIALIZED) {
      note("microphone not initialized (state=${record.state})")
      record.release()
      sendEvent("onError", mapOf("message" to "microphone unavailable"))
      stopNow("mic not initialized")
      return
    }
    recorder = record
    record.startRecording()
    note("microphone recording")
    val loop = Thread {
      var sent = 0L
      val buffer = ByteArray(frameBytes)
      while (!closing.get()) {
        val read = try {
          record.read(buffer, 0, frameBytes)
        } catch (e: Exception) {
          note("mic read failed after $sent frames: ${e.message}")
          break
        }
        if (read <= 0) continue
        val chunk = if (read == frameBytes) buffer else buffer.copyOf(read)
        if (!forwarding.get()) continue // Between utterances: the gap is no one's speech.
        val target = socket
        if (target == null || !target.send(chunk.toByteString())) {
          note("mic send failed after $sent frames (socket gone)")
          break
        }
        sent += 1
      }
      note("mic thread exit after $sent frames, closing=${closing.get()}")
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
  private fun stopNow(reason: String) {
    generation.incrementAndGet() // Any callback still in flight belongs to a dead session.
    closing.set(true)
    forwarding.set(false)
    note("stopping: $reason")
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

  private fun finish(gen: Int) {
    if (generation.get() != gen) return
    stopNow("socket ended")
    sendEvent("onEnd", emptyMap<String, Any>())
  }

  private companion object {
    const val TAG = "RakazoStreamAsr"
  }
}
