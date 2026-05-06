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
  baseline_intro: "Breathe normally for twenty seconds.",
  baseline_low_data: "Not enough data. Let's try again.",
  baseline_no_breath: "I could not see your breathing. Place the phone on your belly and try again.",
  baseline_too_much: "There was too much movement. Let's try again.",
  baseline_odd_rate: "Your breathing looked unusual. Let's try once more.",
  baseline_done: "Baseline captured.",
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
