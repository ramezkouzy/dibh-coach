// Coaching phrases. The app plays a fixed set, so we generate them once with
// a TTS provider (ElevenLabs) and store the MP3s under public/audio/. At
// runtime we play a clip by key — zero latency, zero recurring cost. To
// re-record (e.g., swap in Belisa's voice), regenerate the same files in
// place; no app code changes.

export const PHRASES = {
  // Lab P0 protocol — one self-contained, prerecorded prompt set.
  p0_session_intro:
    "We will do one rehearsal, three calibration holds, and two coached practice holds. Follow rest, inhale, hold, and release.",
  p0_rehearsal_intro: "First, one short rehearsal so you can learn the sequence.",
  p0_calibration_intro:
    "Calibration begins. Complete three comfortable deep breaths and hold each one steady.",
  p0_practice_intro: "Calibration complete. Now match that breath depth for two practice holds.",
  p0_rest: "Rest. Breathe normally.",
  p0_ready: "Get ready. Your next deep breath starts in five seconds.",
  p0_inhale: "Inhale now.",
  p0_hold: "Hold now.",
  p0_hold_8: "Hold for eight seconds. Watch the countdown.",
  p0_hold_10: "Hold for ten seconds. Watch the countdown.",
  p0_hold_12: "Hold for twelve seconds. Watch the countdown.",
  p0_hold_15: "Hold for fifteen seconds. Watch the countdown.",
  p0_hold_20: "Hold for twenty seconds. Watch the countdown.",
  p0_release: "Release. Breathe normally.",
  p0_abort: "Outside the target range. Release and breathe normally. We will try again.",
  p0_deeper: "Breathe in a little more.",
  p0_ease_back: "Ease back slightly.",
  p0_target: "Right there.",
  p0_calibration_retry: "That breath was not clear enough to measure. We will repeat it.",
  p0_calibration_mismatch:
    "That hold did not match the others closely enough. We will collect another.",
  p0_calibration_failed:
    "Calibration needs another run. Keep the phone still and follow inhale, hold, and release.",
  p0_practice_incomplete:
    "Practice stopped after repeated attempts. Review the trace before trying again.",
  p0_session_complete: "Practice complete. Great work.",

  // calibrate
  baseline_intro: "Breathe normally for twenty seconds.",
  placement_countdown: "Place the phone on your belly. The session begins in five seconds.",
  baseline_intro_12: "Breathe normally and relax while I learn your resting movement.",
  prepare_anchor: "Take a normal breath in, breathe out, and relax.",
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
  calibration_incomplete: "I could not learn a reliable target from those holds. Session complete.",

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
export type AudioPlaybackResult = "ended" | "interrupted" | "failed" | "timed_out";

let cache: Partial<Record<PhraseKey, HTMLAudioElement>> = {};
let unlocked = false;
let playGeneration = 0;
let activePlayback:
  | {
      audio: HTMLAudioElement;
      finish: (result: AudioPlaybackResult) => void;
    }
  | null = null;

// iOS requires audio to be triggered inside a user gesture once before
// programmatic playback works. Call this from a click handler before the
// first non-interactive playClip().
export function unlockAudio() {
  if (unlocked || typeof window === "undefined") return;
  // Resume Web Audio while we are still inside the user's tap. Do not mark
  // audio as unlocked until the browser confirms it: iOS can reject an unlock
  // that happens after an awaited motion-permission prompt.
  try {
    const AudioContextClass = window.AudioContext ??
      (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextClass) return;
    const context = new AudioContextClass();
    void context.resume().then(() => {
      const source = context.createBufferSource();
      source.buffer = context.createBuffer(1, 1, 22050);
      source.connect(context.destination);
      source.start(0);
      unlocked = context.state === "running";
      window.setTimeout(() => void context.close(), 50);
    }).catch(() => {
      unlocked = false;
      void context.close();
    });
  } catch {
    // best-effort
  }
}

export function stopAudio() {
  if (!activePlayback) return;
  const { audio, finish } = activePlayback;
  try {
    audio.pause();
    audio.currentTime = 0;
  } catch {
    // best-effort
  }
  finish("interrupted");
}

export function playClip(key: PhraseKey): Promise<AudioPlaybackResult> {
  if (typeof window === "undefined") return Promise.resolve("failed");
  const generation = ++playGeneration;
  stopAudio();
  let audio = cache[key];
  if (!audio) {
    audio = new Audio(`/audio/${key}.mp3`);
    audio.preload = "auto";
    audio.setAttribute("playsinline", "");
    cache[key] = audio;
  }
  audio.muted = false;
  audio.volume = 1;
  audio.currentTime = 0;
  return new Promise((resolve) => {
    let settled = false;
    const timeoutMs = Number.isFinite(audio.duration)
      ? Math.max(5000, audio.duration * 1000 + 2500)
      : 15000;
    const timeoutId = window.setTimeout(() => {
      try {
        audio.pause();
        audio.currentTime = 0;
      } catch {
        // best-effort
      }
      if (cache[key] === audio) delete cache[key];
      finish("timed_out");
    }, timeoutMs);
    const finish = (result: AudioPlaybackResult) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeoutId);
      audio.removeEventListener("ended", onEnded);
      audio.removeEventListener("error", onError);
      if (activePlayback?.audio === audio) activePlayback = null;
      resolve(result);
    };
    const onEnded = () => finish("ended");
    const onError = () => {
      if (cache[key] === audio) delete cache[key];
      finish("failed");
    };
    audio.addEventListener("ended", onEnded, { once: true });
    audio.addEventListener("error", onError, { once: true });
    activePlayback = { audio, finish };
    audio.play().catch((error) => {
      if (generation !== playGeneration || error?.name === "AbortError") {
        finish("interrupted");
        return;
      }
      if (cache[key] === audio) delete cache[key];
      finish("failed");
    });
  });
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
