// Coaching phrases. The app plays a fixed set, so we generate them once with
// a TTS provider (ElevenLabs) and store the MP3s under public/audio/. At
// runtime we play a clip by key — zero latency, zero recurring cost. To
// re-record (e.g., swap in Belisa's voice), regenerate the same files in
// place; no app code changes.

export const PHRASES = {
  // calibrate
  baseline_intro: "Breathe normally for twenty seconds.",
  baseline_low_data: "Not enough data. Let's try again.",
  baseline_no_breath: "I could not see your breathing. Place the phone on your belly and try again.",
  baseline_too_much: "There was too much movement. Let's try again.",
  baseline_odd_rate: "Your breathing looked unusual. Let's try once more.",
  baseline_done: "Baseline captured.",

  // learn
  learn_inhale: "Take a deep breath in.",
  learn_hold: "Hold it.",
  learn_release_good: "Good hold. Release and breathe.",
  learn_release: "Release. Breathe.",
  learn_complete: "All five holds learned. Get ready to practice.",

  // practice
  practice_inhale: "Take a deep breath in, then ease down into the green zone.",
  practice_hold: "Hold it.",
  practice_in_zone: "Hold. Steady.",
  practice_below: "Breathe in a little more, then hold.",
  practice_above: "Ease down to the green zone.",
  practice_drift: "Release and try again.",
  practice_release: "Release. Breathe out.",
  practice_done: "Session complete. Great work.",
} as const;

export type PhraseKey = keyof typeof PHRASES;

let cache: Partial<Record<PhraseKey, HTMLAudioElement>> = {};
let currentlyPlaying: HTMLAudioElement | null = null;
let unlocked = false;

// iOS requires audio to be triggered inside a user gesture once before
// programmatic playback works. Call this from a click handler before the
// first non-interactive playClip().
export function unlockAudio() {
  if (unlocked || typeof window === "undefined") return;
  unlocked = true;
  // Pre-construct an audio element and play+pause it during the gesture.
  try {
    const a = new Audio();
    a.muted = true;
    a.play().catch(() => {});
    a.pause();
  } catch {
    // best-effort
  }
}

function fallbackSpeak(text: string) {
  if (typeof window === "undefined" || !window.speechSynthesis) return;
  window.speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.rate = 0.95;
  window.speechSynthesis.speak(u);
}

export function playClip(key: PhraseKey) {
  if (typeof window === "undefined") return;
  // stop any playing clip
  if (currentlyPlaying) {
    try {
      currentlyPlaying.pause();
      currentlyPlaying.currentTime = 0;
    } catch {
      // ignore
    }
  }
  let audio = cache[key];
  if (!audio) {
    audio = new Audio(`/audio/${key}.mp3`);
    audio.preload = "auto";
    cache[key] = audio;
  }
  currentlyPlaying = audio;
  audio.currentTime = 0;
  const p = audio.play();
  if (p && typeof p.catch === "function") {
    p.catch(() => {
      // File missing or autoplay blocked — fall back to Web Speech.
      fallbackSpeak(PHRASES[key]);
    });
  }
}

// Preload all clips. Call once after audio is unlocked. Best-effort.
export function preloadAll() {
  if (typeof window === "undefined") return;
  for (const key of Object.keys(PHRASES) as PhraseKey[]) {
    if (!cache[key]) {
      const a = new Audio(`/audio/${key}.mp3`);
      a.preload = "auto";
      cache[key] = a;
    }
  }
}
