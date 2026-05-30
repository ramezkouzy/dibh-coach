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

  // session — stability-based coaching
  inhale_cue: "Take a deep breath in.",
  locked_in: "Locked in. Hold steady.",
  drifting: "Drifting. Hold steady.",
  regained: "There you go. Keep holding.",
  target_reached: "Target reached. Great hold.",
  release_breath: "Release. Breathe normally.",
  session_done: "Session complete. Great work.",

  // learn phase — three comfortable holds to set the session target
  learn_intro: "Three comfortable holds. Find a depth you can hold steady.",
  learn_got_one: "Good. Two more like that.",
  learn_got_two: "One more comfortable hold.",
  learn_target_locked: "Target locked. Let's match it.",

  // practice phase — position-match cues
  go_deeper: "A little deeper.",
  ease_back: "Ease back a touch.",
  right_there: "Right there. Hold steady.",

  // legacy keys retained so existing MP3s still resolve.
  // Safe to delete after re-recording, but harmless if left.
  learn_inhale: "Take a deep breath in.",
  learn_hold: "Hold it.",
  learn_release_good: "Good hold. Release and breathe.",
  learn_release: "Release. Breathe.",
  learn_complete: "All five holds learned. Get ready to practice.",
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
let playGeneration = 0;

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
  const generation = ++playGeneration;
  if (window.speechSynthesis) {
    window.speechSynthesis.cancel();
  }
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
    p.catch((error) => {
      // Pausing an in-flight clip because a newer cue arrived rejects its
      // play() promise in Safari/Chrome. That is intentional interruption,
      // not a missing file, so do not speak the old phrase over the new one.
      if (generation !== playGeneration || error?.name === "AbortError") return;
      // File missing or autoplay blocked for the current cue — fall back to Web Speech.
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
