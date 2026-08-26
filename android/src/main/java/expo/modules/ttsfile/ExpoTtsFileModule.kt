package expo.modules.ttsfile

import android.content.Context
import android.media.MediaMetadataRetriever
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record
import java.io.File
import java.util.Locale
import java.util.UUID

class SynthesizeOptions : Record {
  @Field var language: String = "en-US"
  @Field var rate: Double? = null
  @Field var pitch: Double? = null
  @Field var voice: String? = null
  @Field var timeoutMs: Double? = null
}

class ExpoTtsFileModule : Module() {
  private var tts: TextToSpeech? = null
  private var ready = false
  private var initStarted = false
  private val initLock = Any()
  private val initWaiters = mutableListOf<(TextToSpeech?) -> Unit>()

  // The engine's language/rate/pitch/voice are global, so requests are run one at
  // a time: each request applies its own params, then renders, before the next starts.
  private val queueLock = Any()
  private val queue = ArrayDeque<Request>()
  private var processing = false
  private var current: Request? = null

  // The watchdogs run on the main looper; all they ever do is reject a promise.
  private val watchdogHandler = Handler(Looper.getMainLooper())

  private class Request(
    val text: String,
    val options: SynthesizeOptions,
    val promise: Promise,
    val utteranceId: String,
    val file: File
  ) {
    /** Recovery timer, disarmed by whichever settles the request first. */
    var watchdog: Runnable? = null
  }

  private val context: Context
    get() = appContext.reactContext?.applicationContext
      ?: throw CodedException("React context is not available")

  override fun definition() = ModuleDefinition {
    Name("ExpoTtsFile")

    AsyncFunction("synthesizeToFile") { text: String, options: SynthesizeOptions, promise: Promise ->
      withEngine { engine ->
        if (engine == null) {
          promise.reject(CodedException("TTS engine failed to initialize"))
          return@withEngine
        }
        val dir = File(context.cacheDir, "expo-tts-file").apply { mkdirs() }
        val utteranceId = UUID.randomUUID().toString()
        val file = File(dir, "tts-$utteranceId.wav")
        enqueue(Request(text, options, promise, utteranceId, file))
      }
    }

    AsyncFunction("getVoices") { language: String?, promise: Promise ->
      withEngine { engine ->
        if (engine == null) {
          promise.reject(CodedException("TTS engine failed to initialize"))
          return@withEngine
        }
        val voices = engine.voices ?: emptySet()
        val result = voices
          .filter { language == null || it.locale.toLanguageTag().startsWith(language) }
          .map { voice ->
            mapOf(
              "identifier" to voice.name,
              "name" to voice.name,
              "language" to voice.locale.toLanguageTag(),
              "quality" to qualityString(voice.quality)
            )
          }
        promise.resolve(result)
      }
    }

    OnDestroy {
      watchdogHandler.removeCallbacksAndMessages(null)
      tts?.shutdown()
      tts = null
    }
  }

  /** Run [block] once the TTS engine is initialized (passing null if init failed). */
  private fun withEngine(block: (TextToSpeech?) -> Unit) {
    synchronized(initLock) {
      if (ready) {
        block(tts)
        return
      }
      initWaiters.add(block)
      if (!initStarted) {
        initStarted = true
        tts = TextToSpeech(context) { status ->
          synchronized(initLock) {
            ready = status == TextToSpeech.SUCCESS
            if (ready) {
              tts?.setOnUtteranceProgressListener(progressListener)
            }
            val engine = if (ready) tts else null
            val waiters = initWaiters.toList()
            initWaiters.clear()
            waiters.forEach { it(engine) }
          }
        }
      }
    }
  }

  private fun enqueue(req: Request) {
    synchronized(queueLock) {
      queue.addLast(req)
      pumpLocked()
    }
  }

  /** Start the next request if idle. Must hold [queueLock]. */
  private fun pumpLocked() {
    if (processing) return
    val req = queue.removeFirstOrNull() ?: return
    processing = true
    current = req
    start(req)
  }

  private fun advance() {
    synchronized(queueLock) {
      clearCurrentLocked()
      processing = false
      pumpLocked()
    }
  }

  /** Forget the in-flight request and disarm its watchdog. Must hold [queueLock]. */
  private fun clearCurrentLocked() {
    current?.let { req ->
      req.watchdog?.let { watchdogHandler.removeCallbacks(it) }
      req.watchdog = null
    }
    current = null
  }

  /**
   * Arm the recovery timer for [req]. Must hold [queueLock].
   *
   * Without it a request the engine never reports on holds [processing] forever, and
   * every later one waits behind it with no way out but an app restart.
   */
  private fun armWatchdogLocked(req: Request) {
    val timeoutMs = req.options.timeoutMs?.toLong() ?: DEFAULT_TIMEOUT_MS
    val watchdog = Runnable {
      val timedOut = takeCurrent(req.utteranceId) ?: return@Runnable
      timedOut.promise.reject(
        CodedException("ERR_TTS_TIMEOUT", "TTS synthesis did not finish within $timeoutMs ms", null)
      )
      advance()
    }
    req.watchdog = watchdog
    watchdogHandler.postDelayed(watchdog, timeoutMs)
  }

  private fun start(req: Request) {
    val engine = tts
    if (engine == null) {
      req.promise.reject(CodedException("TTS engine is not available"))
      advance()
      return
    }
    val langResult = engine.setLanguage(Locale.forLanguageTag(req.options.language))
    if (langResult == TextToSpeech.LANG_MISSING_DATA || langResult == TextToSpeech.LANG_NOT_SUPPORTED) {
      req.promise.reject(CodedException("Language not supported or missing data: ${req.options.language}"))
      advance()
      return
    }
    req.options.voice?.let { voiceId ->
      engine.voices?.firstOrNull { it.name == voiceId }?.let { engine.voice = it }
    }
    // Rate and pitch are engine-global and survive between requests (unlike the voice,
    // which setLanguage above resets), so they are always set: an omitted option means
    // "platform default", not "whatever the previous request happened to use".
    engine.setSpeechRate(req.options.rate?.toFloat() ?: 1.0f)
    engine.setPitch(req.options.pitch?.toFloat() ?: 1.0f)

    // Armed before the engine is handed the text rather than after it accepts it: this
    // runs while [queueLock] is held, so no callback can settle the request in between,
    // and an engine that accepts the text and then says nothing is covered from the
    // start.
    armWatchdogLocked(req)

    val result = engine.synthesizeToFile(req.text, Bundle(), req.file, req.utteranceId)
    if (result != TextToSpeech.SUCCESS) {
      req.promise.reject(CodedException("Failed to start synthesizeToFile"))
      advance()
    }
  }

  private val progressListener = object : UtteranceProgressListener() {
    override fun onStart(utteranceId: String?) {}

    override fun onDone(utteranceId: String?) {
      val req = takeCurrent(utteranceId) ?: return
      req.promise.resolve(
        mapOf(
          "uri" to Uri.fromFile(req.file).toString(),
          "durationMs" to durationOf(req.file)
        )
      )
      advance()
    }

    @Deprecated("Deprecated in Java", ReplaceWith(""))
    override fun onError(utteranceId: String?) {
      val req = takeCurrent(utteranceId) ?: return
      req.promise.reject(CodedException("TTS synthesis error"))
      advance()
    }

    override fun onError(utteranceId: String?, errorCode: Int) {
      val req = takeCurrent(utteranceId) ?: return
      req.promise.reject(CodedException("TTS synthesis error (code $errorCode)"))
      advance()
    }
  }

  /**
   * Claim the in-flight request if [utteranceId] identifies it, so exactly one of the
   * engine callback and the watchdog settles it — the other gets null and stops there.
   *
   * Null is also what an unrecognized id gets: a callback arriving for a request that
   * already timed out, or a second callback for one already done, refers to something
   * the queue has moved past and must not disturb whatever is running now. The watchdog,
   * not this check, is what keeps an unrecognized id from stalling the queue.
   */
  private fun takeCurrent(utteranceId: String?): Request? {
    synchronized(queueLock) {
      val req = current
      if (req == null || req.utteranceId != utteranceId) {
        return null
      }
      clearCurrentLocked()
      return req
    }
  }

  private fun durationOf(file: File): Int {
    val retriever = MediaMetadataRetriever()
    return try {
      retriever.setDataSource(file.absolutePath)
      retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toIntOrNull() ?: 0
    } catch (e: Exception) {
      0
    } finally {
      retriever.release()
    }
  }

  private fun qualityString(quality: Int): String = when {
    quality >= android.speech.tts.Voice.QUALITY_VERY_HIGH -> "premium"
    quality >= android.speech.tts.Voice.QUALITY_HIGH -> "enhanced"
    else -> "default"
  }

  companion object {
    // Far above what any synthesis the engine would have completed takes — it caps its
    // own input at getMaxSpeechInputLength() characters — and short enough that an app
    // recovers within the session instead of at the next launch.
    private const val DEFAULT_TIMEOUT_MS = 60_000L
  }
}
