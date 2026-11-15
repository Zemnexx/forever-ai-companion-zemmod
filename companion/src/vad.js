// When a spoken question is over, from the microphone's 16-bit samples.
//
// Loudness is measured per chunk (RMS). The threshold for "speech" follows the
// room's background noise (a low percentile of what was heard so far), within
// fixed limits, so a player who starts talking right after the beep is still
// heard and a noisy room doesn't count as talking.
export const SAMPLE_RATE = 16000;

// RMS of 16-bit little-endian mono samples.
export function rms(pcm) {
  const n = Math.floor(pcm.length / 2);
  if (!n) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const v = pcm.readInt16LE(i * 2);
    sum += v * v;
  }
  return Math.sqrt(sum / n);
}

const allZero = (pcm) => {
  for (let i = 0; i < pcm.length; i++) if (pcm[i] !== 0) return false;
  return true;
};

// push(chunk) -> null while listening, or why it ended:
//   "silence"  the player spoke and then was quiet for silenceMs
//   "nospeech" nothing loud enough within noSpeechMs
//   "max"      the recording reached maxMs
//   "muted"    only exact zeros for mutedMs: Windows is blocking the microphone
// speechMs(): how much of it sounded like speech.
export function createSilenceDetector({
  sampleRate = SAMPLE_RATE, silenceMs = 1500, noSpeechMs = 6000, maxMs = 30000, minSpeechMs = 200, mutedMs = 1000,
  floorMin = 250, floorMax = 1200,
} = {}) {
  const levels = [];
  let elapsed = 0;
  let loudRun = 0;
  let quiet = 0;
  let speech = 0;
  let speaking = false;
  let zerosOnly = true;

  const threshold = () => {
    if (levels.length < 3) return floorMin;
    const sorted = [...levels].sort((a, b) => a - b);
    const floor = sorted[Math.floor(sorted.length * 0.1)];
    return Math.min(floorMax, Math.max(floorMin, floor * 3));
  };

  return {
    push(chunk) {
      const ms = (chunk.length / 2 / sampleRate) * 1000;
      if (!ms) return null;
      elapsed += ms;
      if (zerosOnly && !allZero(chunk)) zerosOnly = false;
      const level = rms(chunk);
      const limit = threshold();
      levels.push(level);
      if (levels.length > 300) levels.shift();
      if (level >= limit) {
        loudRun += ms;
        speech += ms;
        quiet = 0;
        if (loudRun >= minSpeechMs) speaking = true;
      } else {
        loudRun = 0;
        quiet += ms;
      }
      if (zerosOnly && elapsed >= mutedMs) return 'muted';
      if (elapsed >= maxMs) return 'max';
      if (speaking && quiet >= silenceMs) return 'silence';
      if (!speaking && elapsed >= noSpeechMs) return 'nospeech';
      return null;
    },
    speaking: () => speaking,
    speechMs: () => speech,
    elapsedMs: () => elapsed,
  };
}

// A WAV file around 16-bit mono samples.
export function wavFromPcm(pcm, sampleRate = SAMPLE_RATE) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0, 'latin1');
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write('WAVEfmt ', 8, 'latin1');
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(1, 22); // mono
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(sampleRate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36, 'latin1');
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}
