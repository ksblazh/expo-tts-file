Pod::Spec.new do |s|
  s.name           = 'ExpoTtsFile'
  s.version        = '0.1.0'
  s.summary        = 'On-device text-to-speech synthesized to an audio file.'
  s.description    = 'Offline TTS-to-file for React Native / Expo: synthesize speech to a playable audio file on device.'
  s.author         = 'Kseniia Blazhkovskaia <ksblazh@gmail.com>'
  s.homepage       = 'https://github.com/ksblazh/expo-tts-file'
  s.platforms      = {
    :ios => '16.4',
    :tvos => '16.4'
  }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  # Swift/Objective-C compatibility
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }

  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
end
