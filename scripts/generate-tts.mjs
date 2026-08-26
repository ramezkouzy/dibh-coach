#!/usr/bin/env node
// Generate the coaching MP3s once via ElevenLabs.
// Usage:
//   ELEVENLABS_API_KEY=sk_xxx node scripts/generate-tts.mjs
//   ELEVENLABS_API_KEY=sk_xxx ELEVEN_VOICE=Rachel node scripts/generate-tts.mjs
//
// Drops files into public/audio/<key>.mp3. Re-running overwrites.

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const OUT_DIR = path.join(ROOT, "public", "audio");

// Mirror src/audio.ts. Kept inline so the script has no TS toolchain dep.
const PHRASES = {
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
  baseline_intro: "Breathe normally for twenty seconds.",
  placement_countdown: "Place the phone on your belly. The session begins in five seconds.",
  baseline_intro_12: "Breathe normally and relax while I learn your resting movement.",
  prepare_anchor: "Take a normal breath in, breathe out, and relax.",
  baseline_low_data: "Not enough data. Let's try again.",
  baseline_no_breath: "I could not see your breathing. Place the phone on your belly and try again.",
  baseline_too_much: "There was too much movement. Let's try again.",
  baseline_odd_rate: "Your breathing looked unusual. Let's try once more.",
  baseline_done: "Baseline captured.",
  inhale_cue: "Take a deep breath in.",
  locked_in: "Locked in. Hold steady.",
  drifting: "Drifting. Hold steady.",
  regained: "There you go. Keep holding.",
  target_reached: "Target reached. Great hold.",
  release_breath: "Release. Breathe normally.",
  session_done: "Session complete. Great work.",
  learn_intro: "Three comfortable holds. Find a depth you can hold steady.",
  learn_got_one: "Good. Two more like that.",
  learn_got_two: "One more comfortable hold.",
  learn_target_locked: "Target locked. Let's match it.",
  calibration_incomplete: "I could not learn a reliable target from those holds. Session complete.",
  go_deeper: "A little deeper.",
  ease_back: "Ease back a touch.",
  right_there: "Right there. Hold steady.",
};

// Default voice IDs from ElevenLabs catalogue (calm female narrators).
const VOICES = {
  Rachel: "21m00Tcm4TlvDq8ikWAM",
  Bella: "EXAVITQu4vr4xnSDxMaL",
  Nicole: "piTKgcLEGmPE4e6mEKli",
  Charlotte: "XB0fDUnXU5powFXDhCwa",
  Sarah: "EXAVITQu4vr4xnSDxMaL",
};

async function main() {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    console.error("ELEVENLABS_API_KEY env var is required.");
    process.exit(1);
  }
  const voiceName = process.env.ELEVEN_VOICE || "Rachel";
  const voiceId = VOICES[voiceName] || voiceName; // allow raw voice ID
  const modelId = process.env.ELEVEN_MODEL || "eleven_multilingual_v2";

  await fs.mkdir(OUT_DIR, { recursive: true });

  const entries = Object.entries(PHRASES);
  console.log(`Generating ${entries.length} clips with ${voiceName} (${modelId})…`);
  for (const [key, text] of entries) {
    const outPath = path.join(OUT_DIR, `${key}.mp3`);
    process.stdout.write(`  ${key}.mp3 … `);
    const res = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
      {
        method: "POST",
        headers: {
          "xi-api-key": apiKey,
          "Content-Type": "application/json",
          Accept: "audio/mpeg",
        },
        body: JSON.stringify({
          text,
          model_id: modelId,
          voice_settings: {
            stability: 0.65,
            similarity_boost: 0.75,
            style: 0.15,
            use_speaker_boost: true,
          },
        }),
      },
    );
    if (!res.ok) {
      const err = await res.text();
      console.error(`failed (${res.status}): ${err.slice(0, 200)}`);
      process.exit(1);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    await fs.writeFile(outPath, buf);
    console.log(`${(buf.length / 1024).toFixed(1)} KB`);
  }
  console.log(`Done → ${OUT_DIR}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
