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
  // True from start() until the socket opens: mic frames captured meanwhile wait
  // here, so the handshake does not swallow the first words.
  private val connecting = AtomicBoolean(false)
  private val pending = ArrayDeque<ByteArray>()
  // 0 while the speaker plays; the moment it may fall silent, else. Millis.
  private val speakerUntil = java.util.concurrent.atomic.AtomicLong(-1L)
  // A call's socket waits this long for the next utterance before it closes itself.
  private val idleCloser = java.util.concurrent.Executors.newSingleThreadScheduledExecutor { runnable ->
    Thread(runnable).apply { isDaemon = true }
  }
  private var idleClose: java.util.concurrent.ScheduledFuture<*>? = null

  private fun armIdleClose() {
    cancelIdleClose()
    idleClose = idleCloser.schedule({ stopNow("idle between utterances") }, 20, TimeUnit.SECONDS)
  }

  private fun cancelIdleClose() {
    idleClose?.cancel(false)
    idleClose = null
  }

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
        cancelIdleClose()
        send(JSONObject().put("type", "start").put("lang", lang))
        forwarding.set(true)
        promise.resolve(true)
        return@AsyncFunction
      }
      note("start: opening $url lang=$lang")
      stopNow("superseded by start")
      closing.set(false)
      connecting.set(true)
      val gen = generation.incrementAndGet()
      // The microphone opens now, not when the socket does: the first words of
      // a call are spoken the moment the caller hears the ring end, and the
      // handshake takes over a second.
      startMicrophone(gen)
      val started = open(url, headers, lang, gen)
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
      armIdleClose()
    }

    Function("notePlayback") { active: Boolean ->
      // The speaker's own playback, told by the app that plays it. While it runs,
      // the raw microphone hears the bot as loudly as the caller; the gate below
      // learns that echo and only forwards speech that talks over it.
      if (active) {
        speakerUntil.set(0L)
      } else {
        // Clips of one reply follow each other closely; stay gated through the gaps.
        speakerUntil.set(android.os.SystemClock.elapsedRealtime() + 2_000)
      }
      note("speaker ${if (active) "on" else "off"}")
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
  private fun open(url: String, headers: Map<String, String>, lang: String, gen: Int): WebSocket? {
    val builder = Request.Builder().url(url)
    for ((name, value) in headers) builder.header(name, value)
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
          cancelIdleClose()
          send(JSONObject().put("type", "start").put("lang", lang))
          // The mic thread flushes what it captured during the handshake itself,
          // under the same lock it sends with, so nothing reorders or doubles.
          synchronized(pending) {
            forwarding.set(true)
            connecting.set(false)
          }
          accepted = true
          opened.countDown()
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
    // The unprocessed source first: the communication source's echo cancelling
    // eats the caller's own words whenever the speaker is playing — the head of
    // a reply spoken over the greeting, or a cut-in spoken over the bot — and
    // the bot's echo in what remains is filtered by the app's own logic.
    val sources = listOf(
      MediaRecorder.AudioSource.UNPROCESSED,
      MediaRecorder.AudioSource.VOICE_COMMUNICATION,
    )
    var record: AudioRecord? = null
    var source = 0
    for (candidate in sources) {
      val opened = try {
        AudioRecord(
          candidate,
          rate,
          AudioFormat.CHANNEL_IN_MONO,
          AudioFormat.ENCODING_PCM_16BIT,
          maxOf(minBuffer, frameBytes * 4),
        )
      } catch (e: Exception) {
        note("microphone constructor failed for source $candidate: ${e.message}")
        null
      }
      if (opened != null && opened.state == AudioRecord.STATE_INITIALIZED) {
        record = opened
        source = candidate
        break
      }
      opened?.release()
    }
    if (record == null) {
      note("microphone not initialized on any source")
      sendEvent("onError", mapOf("message" to "microphone unavailable"))
      stopNow("mic not initialized")
      return
    }
    note("microphone recording from source $source")
    recorder = record
    record.startRecording()
    val loop = Thread {
      var sent = 0L
      var quietFrames = 0
      var windowPeak = 0
      // The echo gate: learned while the speaker plays, in the mic's own thread.
      var echoPeak = 0.0
      var learnFrames = 0
      var gated = 0L
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
        // The loudest sample of this frame: a capture that eats the caller's
        // words shows up here as silence they break through.
        var peak = 0
        for (index in 0 until read - 1 step 160) {
          val low = chunk[index].toInt() and 0xFF
          val high = chunk[index + 1].toInt()
          val sample = kotlin.math.abs(((high shl 8) or low).toShort().toInt())
          if (sample > peak) peak = sample
        }
        if (peak > windowPeak) windowPeak = peak
        if (peak < 128) quietFrames += 1 else quietFrames = 0
        val speakerOn = speakerUntil.get() == 0L ||
          (speakerUntil.get() > 0 && android.os.SystemClock.elapsedRealtime() < speakerUntil.get())
        var echo = false
        if (speakerOn) {
          if (learnFrames < 15) {
            // The reply's opening: the caller rarely talks into it, so what the
            // mic hears here is the speaker's own echo.
            learnFrames += 1
            if (peak > echoPeak) echoPeak = peak.toDouble()
            echo = true
          } else {
            val gate = maxOf(echoPeak * 2.5, 400.0)
            if (peak < gate) {
              echo = true
              if (peak > echoPeak) echoPeak = peak.toDouble()
            }
          }
        } else {
          learnFrames = 0
          echoPeak = 0.0
        }
        if (sent % 50 == 0L) {
          note("mic level: frame=$sent peak=$windowPeak quiet=$quietFrames gated=$gated")
          windowPeak = 0
          quietFrames = 0
          gated = 0
        }
        if (echo) {
          gated += 1
          continue
        }
        var dead = false
        synchronized(pending) {
          val target = socket
          if (target != null && forwarding.get()) {
            // In order: whatever the handshake buffered, then this frame.
            while (pending.isNotEmpty()) {
              val buffered = pending.removeFirst()
              if (!target.send(buffered.toByteString())) {
                dead = true
                break
              }
              sent += 1
            }
            if (!dead && !target.send(chunk.toByteString())) dead = true
            if (!dead) sent += 1
          } else if (connecting.get() && pending.size < 100) {
            // The handshake is still running: these words must not be lost to it.
            pending.addLast(chunk)
          }
          // Between utterances the gap is no one's speech: dropped.
        }
        if (dead) {
          note("mic send failed after $sent frames (socket gone)")
          break
        }
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
    connecting.set(false)
    cancelIdleClose()
    synchronized(pending) { pending.clear() }
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
