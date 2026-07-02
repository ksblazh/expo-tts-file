import ExpoModulesCore
import AVFoundation

struct SynthesizeOptions: Record {
  @Field var language: String = "en-US"
  @Field var rate: Double?
  @Field var pitch: Double?
  @Field var voice: String?
  @Field var ipa: String?
}

struct SpeechSegment: Record {
  @Field var text: String = ""
  @Field var ipa: String?
}

// Completion relay for the live synthesizer: resolves speakIpa/speakSsml promises on
// natural finish (true) or cancellation (false) so JS can chain playback correctly.
private class LiveSpeechDelegate: NSObject, AVSpeechSynthesizerDelegate {
  var completion: ((Bool) -> Void)?

  private func settle(_ finished: Bool) {
    let cb = completion
    completion = nil
    cb?(finished)
  }

  func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
    settle(true)
  }

  func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
    settle(false)
  }
}

public class ExpoTtsFileModule: Module {
  // Synthesizers are retained for the duration of a write() so they are not
  // deallocated mid-synthesis (the buffer callback would then never complete).
  private var active = Set<AVSpeechSynthesizer>()
  // Live-path synthesizer for speakIpa/speakSsml. CRITICAL (verified on device):
  // the IPA attribute IS honored by speak() but DROPPED by write() — so правильное
  // ударение exists only on this live path, never in synthesized files.
  private let liveSynth = AVSpeechSynthesizer()
  private let liveDelegate = LiveSpeechDelegate()

  // Replace any pending completion (cancelled) and speak on the main queue
  // (AVSpeechSynthesizer playback is main-thread-sensitive).
  private func liveSpeak(_ utterance: AVSpeechUtterance, promise: Promise) {
    DispatchQueue.main.async {
      if self.liveSynth.delegate == nil { self.liveSynth.delegate = self.liveDelegate }
      self.liveDelegate.completion?(false)
      self.liveDelegate.completion = { finished in promise.resolve(finished) }
      self.liveSynth.stopSpeaking(at: .immediate)
      self.liveSynth.speak(utterance)
    }
  }

  public func definition() -> ModuleDefinition {
    Name("ExpoTtsFile")

    AsyncFunction("synthesizeToFile") { (text: String, options: SynthesizeOptions, promise: Promise) in
      self.synthesize(text: text, options: options, promise: promise)
    }

    // Live speech with the IPA attribute (same options as synthesizeToFile). The
    // file path (write()) has reports of dropping the attributed pronunciation —
    // this speaks through the ordinary speak() pipeline instead. Speak runs on the
    // MAIN queue (AVSpeechSynthesizer playback is main-thread-sensitive).
    AsyncFunction("speakIpa") { (text: String, options: SynthesizeOptions, promise: Promise) in
      let utterance: AVSpeechUtterance
      if let ipa = options.ipa, !ipa.isEmpty {
        let key = NSAttributedString.Key(rawValue: AVSpeechSynthesisIPANotationAttribute)
        utterance = AVSpeechUtterance(attributedString: NSAttributedString(string: text, attributes: [key: ipa]))
      } else {
        utterance = AVSpeechUtterance(string: text)
      }
      utterance.voice = Self.resolveVoice(identifier: options.voice, language: options.language)
      if let rate = options.rate {
        utterance.rate = max(
          AVSpeechUtteranceMinimumSpeechRate,
          min(AVSpeechUtteranceMaximumSpeechRate, AVSpeechUtteranceDefaultSpeechRate * Float(rate))
        )
      }
      self.liveSpeak(utterance, promise: promise)
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
        promise.resolve(false)
        return
      }
      let utterance = AVSpeechUtterance(attributedString: attributed)
      utterance.voice = Self.resolveVoice(identifier: options.voice, language: options.language)
      if let rate = options.rate {
        utterance.rate = max(
          AVSpeechUtteranceMinimumSpeechRate,
          min(AVSpeechUtteranceMaximumSpeechRate, AVSpeechUtteranceDefaultSpeechRate * Float(rate))
        )
      }
      self.liveSpeak(utterance, promise: promise)
    }

    // Stop the live path (speakIpa/speakSsml/speakMixed); a pending completion resolves false.
    AsyncFunction("stopLiveSpeech") { (promise: Promise) in
      DispatchQueue.main.async {
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

  private func synthesize(text: String, options: SynthesizeOptions, promise: Promise) {
    // IPA pronunciation override: the WHOLE `text` range is pronounced per the given
    // IPA string via Apple's attributed-utterance mechanism — the only public way to
    // steer pronunciation (e.g. Russian ударение: the bundled voices ignore combining
    // acute marks in plain text). Honored by the classic Vocalizer voices; some newer
    // Siri voices ignore the attribute — callers verify by ear (speech lab).
    let utterance: AVSpeechUtterance
    if let ipa = options.ipa, !ipa.isEmpty {
      let key = NSAttributedString.Key(rawValue: AVSpeechSynthesisIPANotationAttribute)
      utterance = AVSpeechUtterance(attributedString: NSAttributedString(string: text, attributes: [key: ipa]))
    } else {
      utterance = AVSpeechUtterance(string: text)
    }
    if let voiceId = options.voice, let voice = AVSpeechSynthesisVoice(identifier: voiceId) {
      utterance.voice = voice
    } else {
      utterance.voice = AVSpeechSynthesisVoice(language: options.language)
    }
    if let rate = options.rate {
      utterance.rate = max(
        AVSpeechUtteranceMinimumSpeechRate,
        min(AVSpeechUtteranceMaximumSpeechRate, AVSpeechUtteranceDefaultSpeechRate * Float(rate))
      )
    }
    if let pitch = options.pitch {
      utterance.pitchMultiplier = max(0.5, min(2.0, Float(pitch)))
    }

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
    var settled = false

    let finish: (Result<Void, Error>) -> Void = { [weak self] result in
      if settled { return }
      settled = true
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
