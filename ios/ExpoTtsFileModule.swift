import ExpoModulesCore
import AVFoundation

struct SynthesizeOptions: Record {
  @Field var language: String = "en-US"
  @Field var rate: Double?
  @Field var pitch: Double?
  @Field var voice: String?
  @Field var ipa: String?
  @Field var timeoutMs: Double?
}

struct SpeechSegment: Record {
  @Field var text: String = ""
  @Field var ipa: String?
}

// Completion relay for the live synthesizer: resolves speakIpa/speakSsml promises on
// natural finish (true) or cancellation (false) so JS can chain playback correctly.
private class LiveSpeechDelegate: NSObject, AVSpeechSynthesizerDelegate {
  // The completion is keyed by the utterance it belongs to. didCancel for a stopped
  // utterance is delivered asynchronously, so an unkeyed completion would be settled
  // by the cancellation of the utterance it just replaced — resolving the new promise
  // false while its speech is in fact playing.
  private var pending: (utterance: AVSpeechUtterance, completion: (Bool) -> Void)?

  func expect(_ utterance: AVSpeechUtterance, completion: @escaping (Bool) -> Void) {
    pending = (utterance, completion)
  }

  /// Settle whatever is pending (used when a new utterance supersedes it).
  func settleNow(_ finished: Bool) {
    guard let current = pending else { return }
    pending = nil
    current.completion(finished)
  }

  private func settle(_ utterance: AVSpeechUtterance, _ finished: Bool) {
    guard let current = pending, current.utterance === utterance else { return }
    pending = nil
    current.completion(finished)
  }

  func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
    settle(utterance, true)
  }

  func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
    settle(utterance, false)
  }
}

public class ExpoTtsFileModule: Module {
  // Synthesizers are retained for the duration of a write() so they are not
  // deallocated mid-synthesis (the buffer callback would then never complete).
  private var active = Set<AVSpeechSynthesizer>()
  // Live-path synthesizer for speakIpa/speakSsml. On the IPA attribute (device-verified,
  // iOS 26.5): it is honored on BOTH paths — speak() and write() — but only when the
  // attributed text is LATIN. Over Cyrillic the voice falls back to its own lexicon and
  // the transcription is ignored, which is what made the first write() round read as
  // "write() drops the attribute". So file synthesis carries ударение too, as long as
  // callers pass a Latin carrier (see synthesizeMixedToFile / SynthesizeOptions.ipa).
  private let liveSynth = AVSpeechSynthesizer()
  private let liveDelegate = LiveSpeechDelegate()
  // Watchdog default for the file path, in seconds. The live path has no equivalent:
  // speech has no expected duration to measure against, and stopLiveSpeech() is already
  // the way out of it.
  private static let defaultTimeout: TimeInterval = 60

  // Replace any pending completion (cancelled) and speak on the main queue
  // (AVSpeechSynthesizer playback is main-thread-sensitive). The previous promise is
  // settled and the synthesizer stopped BEFORE the new completion is registered, so the
  // late didCancel of the stopped utterance cannot settle the new one.
  private func liveSpeak(_ utterance: AVSpeechUtterance, promise: Promise) {
    DispatchQueue.main.async {
      if self.liveSynth.delegate == nil { self.liveSynth.delegate = self.liveDelegate }
      self.liveDelegate.settleNow(false)
      self.liveSynth.stopSpeaking(at: .immediate)
      self.liveDelegate.expect(utterance) { finished in promise.resolve(finished) }
      self.liveSynth.speak(utterance)
    }
  }

  public func definition() -> ModuleDefinition {
    Name("ExpoTtsFile")

    AsyncFunction("synthesizeToFile") { (text: String, options: SynthesizeOptions, promise: Promise) in
      self.synthesize(
        utterance: Self.utterance(text: text, ipa: options.ipa, options: options),
        options: options,
        promise: promise
      )
    }

    // Attributed synthesis to a FILE: the same per-word IPA ranges as speakMixed, but
    // through write(). This is what lets a background/offline player (a podcast built
    // from clips) carry ударение inside sentences — marked words ride as Latin-carrier
    // runs with their own transcription, the rest of the sentence reads naturally.
    AsyncFunction("synthesizeMixedToFile") { (segments: [SpeechSegment], options: SynthesizeOptions, promise: Promise) in
      guard let utterance = Self.mixedUtterance(segments: segments, options: options) else {
        promise.reject("ERR_TTS", "No speakable segments.")
        return
      }
      self.synthesize(utterance: utterance, options: options, promise: promise)
    }

    // Live speech with the IPA attribute (same options as synthesizeToFile) — for
    // interactive playback, where waiting on a file write is pointless. Speak runs on
    // the MAIN queue (AVSpeechSynthesizer playback is main-thread-sensitive).
    AsyncFunction("speakIpa") { (text: String, options: SynthesizeOptions, promise: Promise) in
      self.liveSpeak(Self.utterance(text: text, ipa: options.ipa, options: options), promise: promise)
    }

    // Live speech from an SSML document (iOS 16+): a SEPARATE parser from the IPA
    // attribute — <phoneme alphabet="ipa" ph="..."> may work where the attribute
    // does not. Resolves false when SSML is unsupported/unparseable.
    AsyncFunction("speakSsml") { (ssml: String, options: SynthesizeOptions, promise: Promise) in
      if #available(iOS 16.0, *) {
        guard let utterance = AVSpeechUtterance(ssmlRepresentation: ssml) else {
          promise.resolve(false)
          return
        }
        if utterance.voice == nil {
          utterance.voice = Self.resolveVoice(identifier: options.voice, language: options.language)
        } else if let voiceId = options.voice, let voice = AVSpeechSynthesisVoice(identifier: voiceId) {
          utterance.voice = voice
        }
        self.liveSpeak(utterance, promise: promise)
      } else {
        promise.resolve(false)
      }
    }

    // Live speech from SEGMENTS — Apple honors the IPA attribute per WORD range,
    // so a sentence rides as [plain Cyrillic runs] + [marked words as Latin-carrier
    // text with their own IPA attribute]. Unmarked words keep the voice's natural
    // reading; only the corrected words are steered.
    AsyncFunction("speakMixed") { (segments: [SpeechSegment], options: SynthesizeOptions, promise: Promise) in
      guard let utterance = Self.mixedUtterance(segments: segments, options: options) else {
        promise.resolve(false)
        return
      }
      self.liveSpeak(utterance, promise: promise)
    }

    // Stop the live path (speakIpa/speakSsml/speakMixed); a pending completion resolves false.
    AsyncFunction("stopLiveSpeech") { (promise: Promise) in
      DispatchQueue.main.async {
        // Settle the pending promise here instead of waiting for didCancel: an
        // immediate stop does not reliably deliver it (device-observed on iOS 26:
        // didFinish arrives instead), which resolved `true` for speech the caller had
        // just stopped — indistinguishable from a natural finish.
        self.liveDelegate.settleNow(false)
        self.liveSynth.stopSpeaking(at: .immediate)
        promise.resolve(nil)
      }
    }

    AsyncFunction("getVoices") { (language: String?) -> [[String: Any]] in
      return AVSpeechSynthesisVoice.speechVoices()
        .filter { language == nil || $0.language.hasPrefix(language!) }
        .map { voice in
          [
            "identifier": voice.identifier,
            "name": voice.name,
            "language": voice.language,
            "quality": ExpoTtsFileModule.qualityString(voice.quality),
          ]
        }
    }
  }

  // IPA pronunciation override: the WHOLE `text` range is pronounced per the given IPA
  // string via Apple's attributed-utterance mechanism — the only public way to steer
  // pronunciation (e.g. Russian ударение: the bundled voices ignore combining acute
  // marks in plain text). Honored by the classic Vocalizer voices ON LATIN TEXT; some
  // newer Siri voices ignore the attribute — callers verify by ear (speech lab).
  private static func utterance(text: String, ipa: String?, options: SynthesizeOptions) -> AVSpeechUtterance {
    let utterance: AVSpeechUtterance
    if let ipa, !ipa.isEmpty {
      let key = NSAttributedString.Key(rawValue: AVSpeechSynthesisIPANotationAttribute)
      utterance = AVSpeechUtterance(attributedString: NSAttributedString(string: text, attributes: [key: ipa]))
    } else {
      utterance = AVSpeechUtterance(string: text)
    }
    applyProsody(utterance, options)
    return utterance
  }

  // Apple honors the attribute per RANGE, so a sentence rides as [plain runs] +
  // [marked words as Latin-carrier text with their own IPA]. nil = nothing to say.
  private static func mixedUtterance(segments: [SpeechSegment], options: SynthesizeOptions) -> AVSpeechUtterance? {
    let attributed = NSMutableAttributedString()
    let key = NSAttributedString.Key(rawValue: AVSpeechSynthesisIPANotationAttribute)
    for seg in segments where !seg.text.isEmpty {
      if let ipa = seg.ipa, !ipa.isEmpty {
        attributed.append(NSAttributedString(string: seg.text, attributes: [key: ipa]))
      } else {
        attributed.append(NSAttributedString(string: seg.text))
      }
    }
    if attributed.length == 0 {
      return nil
    }
    let utterance = AVSpeechUtterance(attributedString: attributed)
    applyProsody(utterance, options)
    return utterance
  }

  private static func applyProsody(_ utterance: AVSpeechUtterance, _ options: SynthesizeOptions) {
    utterance.voice = resolveVoice(identifier: options.voice, language: options.language)
    if let rate = options.rate {
      utterance.rate = max(
        AVSpeechUtteranceMinimumSpeechRate,
        min(AVSpeechUtteranceMaximumSpeechRate, AVSpeechUtteranceDefaultSpeechRate * Float(rate))
      )
    }
    if let pitch = options.pitch {
      utterance.pitchMultiplier = max(0.5, min(2.0, Float(pitch)))
    }
  }

  private func synthesize(utterance: AVSpeechUtterance, options: SynthesizeOptions, promise: Promise) {
    let fileURL: URL
    do {
      fileURL = try Self.outputFileURL()
    } catch {
      promise.reject("ERR_TTS_FILE", "Could not create output file: \(error.localizedDescription)")
      return
    }

    let synthesizer = AVSpeechSynthesizer()
    DispatchQueue.main.async { self.active.insert(synthesizer) }

    var audioFile: AVAudioFile?
    var totalFrames: AVAudioFramePosition = 0
    var sampleRate: Double = 0

    // The buffer callback and the watchdog below race to settle the promise, from
    // different queues, so the flag they race on is read and set under a lock rather
    // than in two steps. Exactly one caller is told it may proceed.
    let settleLock = NSLock()
    var settled = false
    let claim: () -> Bool = {
      settleLock.lock()
      defer { settleLock.unlock() }
      if settled { return false }
      settled = true
      return true
    }

    // write() signals completion with a zero-length buffer. An engine that never sends
    // one leaves the promise pending for the life of the app and the synthesizer
    // retained in `active`, so a timer settles it instead — recovery for a stuck engine,
    // not a deadline for slow synthesis (see SynthesizeOptions.timeoutMs).
    let timeout = options.timeoutMs.map { $0 / 1000.0 } ?? Self.defaultTimeout
    // The synthesizer is captured weakly: cancelling a work item does not dequeue it, so
    // a cancelled watchdog still holds whatever it captured until its deadline passes —
    // which, for a caller synthesizing clip after clip, would pile up a minute's worth of
    // finished synthesizers. Whenever this body has real work to do, `active` is still
    // holding the object anyway.
    let watchdog = DispatchWorkItem { [weak self, weak synthesizer] in
      // Claiming commits this body to settling the promise: anything it can bail out of
      // has to be checked before the claim, or the promise it took ownership of would
      // hang exactly the way this timer exists to prevent.
      guard claim() else { return }
      // `audioFile` is deliberately left alone here: the buffer callback may be writing
      // to it on its own queue at this moment, and closing it from a second thread is
      // the one thing worse than the leak. Dropping the synthesizer ends the callbacks;
      // the partial file stays in the cache like every other file this module writes.
      if let synthesizer {
        synthesizer.stopSpeaking(at: .immediate)
        self?.active.remove(synthesizer)
      }
      promise.reject(
        "ERR_TTS_TIMEOUT",
        "Speech synthesis did not finish within \(Int(timeout * 1000)) ms"
      )
    }
    DispatchQueue.main.asyncAfter(deadline: .now() + timeout, execute: watchdog)

    let finish: (Result<Void, Error>) -> Void = { [weak self] result in
      guard claim() else { return }
      watchdog.cancel()
      // Close the file BEFORE resolving: AVAudioFile finalizes the header when it is
      // deallocated, and the caller may open the URI the instant the promise resolves.
      audioFile = nil
      DispatchQueue.main.async { self?.active.remove(synthesizer) }
      switch result {
      case .success:
        let durationMs = sampleRate > 0 ? Int(Double(totalFrames) / sampleRate * 1000.0) : 0
        promise.resolve([
          "uri": fileURL.absoluteString,
          "durationMs": durationMs,
        ])
      case .failure(let error):
        promise.reject("ERR_TTS", error.localizedDescription)
      }
    }

    synthesizer.write(utterance) { (buffer: AVAudioBuffer) in
      guard let pcmBuffer = buffer as? AVAudioPCMBuffer else {
        finish(.failure(TtsError.unexpectedBuffer))
        return
      }

      // A zero-length buffer signals that synthesis is complete.
      if pcmBuffer.frameLength == 0 {
        if audioFile == nil {
          finish(.failure(TtsError.noAudioProduced))
        } else {
          finish(.success(()))
        }
        return
      }

      do {
        if audioFile == nil {
          sampleRate = pcmBuffer.format.sampleRate
          audioFile = try AVAudioFile(
            forWriting: fileURL,
            settings: pcmBuffer.format.settings,
            commonFormat: pcmBuffer.format.commonFormat,
            interleaved: pcmBuffer.format.isInterleaved
          )
        }
        try audioFile?.write(from: pcmBuffer)
        totalFrames += AVAudioFramePosition(pcmBuffer.frameLength)
      } catch {
        finish(.failure(error))
      }
    }
  }

  // Voice by identifier → exact BCP-47 language → language-prefix match ("ru" finds
  // "ru-RU"): AVSpeechSynthesisVoice(language:) is strict about full tags and would
  // otherwise return nil for a bare "ru".
  private static func resolveVoice(identifier: String?, language: String) -> AVSpeechSynthesisVoice? {
    if let id = identifier, let voice = AVSpeechSynthesisVoice(identifier: id) {
      return voice
    }
    if let voice = AVSpeechSynthesisVoice(language: language) {
      return voice
    }
    let prefix = language.lowercased().split(separator: "-")[0]
    return AVSpeechSynthesisVoice.speechVoices().first {
      $0.language.lowercased().hasPrefix(prefix)
    }
  }

  private static func outputFileURL() throws -> URL {
    let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
    let dir = caches.appendingPathComponent("expo-tts-file", isDirectory: true)
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    return dir.appendingPathComponent("tts-\(UUID().uuidString).caf")
  }

  private static func qualityString(_ quality: AVSpeechSynthesisVoiceQuality) -> String {
    switch quality {
    case .enhanced: return "enhanced"
    case .premium: return "premium"
    default: return "default"
    }
  }

  private enum TtsError: LocalizedError {
    case unexpectedBuffer
    case noAudioProduced

    var errorDescription: String? {
      switch self {
      case .unexpectedBuffer: return "Speech synthesizer returned an unexpected buffer type."
      case .noAudioProduced: return "Speech synthesizer produced no audio (empty or invalid text?)."
      }
    }
  }
}
