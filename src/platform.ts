import { Platform } from 'react-native';

/**
 * Guard for the iOS-only surface (`speakIpa`, `speakMixed`, `speakSsml`,
 * `stopLiveSpeech`, `synthesizeMixedToFile`).
 *
 * Those methods do not exist at all in the Android Kotlin module or the web stub, so
 * calling one bottoms out in "TypeError: undefined is not a function" — a message that
 * says nothing about WHY it failed. Reject with the reason instead, naming the function
 * and the platform, before touching the native object.
 */
export function requireImplemented(method: unknown, label: string): void {
  if (typeof method !== 'function') {
    throw new Error(
      `expo-tts-file: ${label} is not implemented on ${Platform.OS} — it is iOS-only. ` +
        'See the per-function platform table in the README.'
    );
  }
}
