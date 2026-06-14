package expo.modules.ttsfile

import android.content.Context
import android.media.MediaMetadataRetriever
import android.net.Uri
import android.os.Bundle
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

  private class Request(
    val text: String,
    val options: SynthesizeOptions,
    val promise: Promise,
    val utteranceId: String,
    val file: File
  )

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
      processing = false
      current = null
      pumpLocked()
    }
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
    req.options.rate?.let { engine.setSpeechRate(it.toFloat()) }
    req.options.pitch?.let { engine.setPitch(it.toFloat()) }

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

  private fun takeCurrent(utteranceId: String?): Request? {
    synchronized(queueLock) {
      val req = current
      return if (req != null && req.utteranceId == utteranceId) req else null
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
}
