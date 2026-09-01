#!/usr/bin/env node
// Generate the DIBH Lab coaching MP3s with OpenAI text-to-speech.
//
// 1. Put OPENAI_API_KEY in .env.local.
// 2. Run: pnpm tts:generate
//
// New clips are staged in public/audio/openai-coral-preview/ so the working
// production clips are not overwritten before they are reviewed.

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const ENV_FILE = path.join(ROOT, ".env.local");
const AUDIO_DIR = path.join(ROOT, "public", "audio");
const DEFAULT_OUT_DIR = path.join(AUDIO_DIR, "openai-coral-preview");
const execFileAsync = promisify(execFile);

const LAB_PHRASES = {
  p0_session_intro:
    "This is a hands-free breathing run. Listen for rest, deep breath in and hold, five seconds left, and release.",
  p0_rehearsal_intro: "First, one short rehearsal so you can learn the sequence.",
  p0_calibration_intro:
    "Calibration begins. Breathe normally. After three regular breaths, take a deep breath in and hold for ten seconds. We will repeat this three times.",
  p0_practice_intro:
    "Calibration complete. Coaching begins. Breathe normally for three breaths, then take a deep breath in and hold for ten seconds. I will coach you toward the target range.",
  p0_rest: "Rest and breathe normally.",
  p0_three_regular_breaths: "Breathe normally for three regular breaths.",
  p0_ready: "Get ready. Your deep breath is next.",
  p0_inhale: "Take a deep breath in and hold it for ten seconds.",
  p0_guided_hold_10: "Take a deep breath in, and hold for ten seconds.",
  p0_guided_hold_20: "Take a deep breath in, and hold for twenty seconds.",
  p0_hold: "Hold now.",
  p0_hold_8: "Eight-second hold starts now.",
  p0_hold_10: "Ten-second hold starts now.",
  p0_hold_12: "Twelve-second hold starts now.",
  p0_hold_15: "Fifteen-second hold starts now.",
  p0_hold_20: "Twenty-second hold starts now.",
  p0_five_seconds_left: "Five seconds left.",
  p0_release: "Release and breathe normally.",
  p0_abort:
    "Outside the target range. Release and breathe normally. After three regular breaths, we will try again.",
  p0_deeper: "Breathe in a little more.",
  p0_ease_back: "Ease back slightly.",
  p0_target: "Right there.",
  p0_calibration_retry:
    "Release and breathe normally. I could not detect a held breath. After three regular breaths, we will try again.",
  p0_calibration_mismatch:
    "That hold did not match the others closely enough. We will collect another.",
  p0_calibration_failed:
    "Calibration needs another run. Keep the phone still and follow inhale, hold, and release.",
  p0_practice_incomplete:
    "Practice stopped after repeated attempts. Review the trace before trying again.",
  p0_session_complete: "Practice complete. Great work.",
};

const DEFAULT_INSTRUCTIONS = [
  "Speak as a calm, reassuring clinical breathing coach.",
  "Use a warm, clear, neutral American English delivery.",
  "Speak deliberately and slightly slower than normal conversation.",
  "Keep commands unambiguous, with a brief natural pause between clauses.",
  "Do not add, remove, or paraphrase words.",
  "Do not sound excited, theatrical, rushed, or conversational.",
].join(" ");

async function loadLocalEnv() {
  let contents;
  try {
    contents = await fs.readFile(ENV_FILE, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }

  for (const sourceLine of contents.split(/\r?\n/)) {
    const line = sourceLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (process.env[key]) continue;
    let value = rawValue.trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

function selectedEntries() {
  const onlyIndex = process.argv.indexOf("--only");
  if (onlyIndex === -1) return Object.entries(LAB_PHRASES);
  const key = process.argv[onlyIndex + 1];
  if (!key || !(key in LAB_PHRASES)) {
    throw new Error(`Unknown --only key: ${key || "(missing)"}`);
  }
  return [[key, LAB_PHRASES[key]]];
}

async function generateClip({ apiKey, model, voice, instructions, speed, key, text, outDir }) {
  const response = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      voice,
      input: text,
      instructions,
      response_format: "mp3",
      speed,
    }),
  });

  if (!response.ok) {
    const detail = (await response.text()).slice(0, 800);
    throw new Error(`${key} failed (${response.status}): ${detail}`);
  }

  const sourceBytes = Buffer.from(await response.arrayBuffer());
  if (sourceBytes.length < 1_000) {
    throw new Error(`${key} returned an unexpectedly small audio file (${sourceBytes.length} bytes).`);
  }

  const outPath = path.join(outDir, `${key}.mp3`);
  const sourcePath = `${outPath}.source.mp3`;
  await fs.writeFile(sourcePath, sourceBytes);
  await normalizeMp3(sourcePath, outPath);
  await fs.rm(sourcePath, { force: true });

  return fs.stat(outPath);
}

async function normalizeMp3(sourcePath, outPath) {
  const normalizedPath = `${outPath}.normalized.mp3`;
  try {
    await execFileAsync("ffmpeg", [
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      sourcePath,
      "-af",
      "loudnorm=I=-16:LRA=7:TP=-1.5",
      "-ar",
      "24000",
      "-ac",
      "1",
      "-codec:a",
      "libmp3lame",
      "-b:a",
      "128k",
      normalizedPath,
    ]);
    await fs.rename(normalizedPath, outPath);
  } catch (error) {
    await fs.rm(normalizedPath, { force: true });
    if (error?.code === "ENOENT") {
      throw new Error("ffmpeg is required to normalize the generated phone audio.");
    }
    throw error;
  }
}

async function generateTargetTone(outDir) {
  const outPath = path.join(outDir, "p0_in_range_ding.mp3");
  const temporaryPath = `${outPath}.generated.mp3`;
  await execFileAsync("ffmpeg", [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=880:duration=0.20:sample_rate=24000",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=1175:duration=0.30:sample_rate=24000",
    "-filter_complex",
    "[0:a]volume=3.25,afade=t=out:st=0.11:d=0.09[first];[1:a]adelay=160,volume=2.75,afade=t=out:st=0.34:d=0.12[second];[first][second]amix=inputs=2:duration=longest:normalize=0,alimiter=limit=0.5:attack=5:release=50:level=false",
    "-ar",
    "24000",
    "-ac",
    "1",
    "-codec:a",
    "libmp3lame",
    "-b:a",
    "128k",
    temporaryPath,
  ]);
  await fs.rename(temporaryPath, outPath);
}

async function buildManifestFiles(outDir) {
  const files = [];
  for (const [key, text] of Object.entries(LAB_PHRASES)) {
    const filename = `${key}.mp3`;
    const bytes = await fs.readFile(path.join(outDir, filename));
    files.push({
      filename,
      text,
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  }
  const tone = await fs.readFile(path.join(outDir, "p0_in_range_ding.mp3"));
  files.push({
    filename: "p0_in_range_ding.mp3",
    text: null,
    bytes: tone.length,
    sha256: createHash("sha256").update(tone).digest("hex"),
    source: "generated two-tone target-range chime",
  });
  return files;
}

async function normalizeExistingPreview(outDir) {
  for (const key of Object.keys(LAB_PHRASES)) {
    const outPath = path.join(outDir, `${key}.mp3`);
    process.stdout.write(`  normalize ${key}.mp3 … `);
    await normalizeMp3(outPath, outPath);
    console.log("done");
  }
  await generateTargetTone(outDir);
}

async function main() {
  await loadLocalEnv();

  const apiKey = process.env.OPENAI_API_KEY?.trim();
  const model = process.env.OPENAI_TTS_MODEL?.trim() || "gpt-4o-mini-tts";
  const voice = process.env.OPENAI_TTS_VOICE?.trim() || "coral";
  const speed = Number(process.env.OPENAI_TTS_SPEED || "0.92");
  const instructions = process.env.OPENAI_TTS_INSTRUCTIONS?.trim() || DEFAULT_INSTRUCTIONS;
  const outDir = process.env.OPENAI_TTS_OUT_DIR
    ? path.resolve(ROOT, process.env.OPENAI_TTS_OUT_DIR)
    : DEFAULT_OUT_DIR;

  if (!Number.isFinite(speed) || speed < 0.25 || speed > 4) {
    throw new Error("OPENAI_TTS_SPEED must be between 0.25 and 4.");
  }

  await fs.mkdir(outDir, { recursive: true });

  if (process.argv.includes("--normalize-preview")) {
    console.log(`Normalizing the existing Coral preview in ${outDir}`);
    await normalizeExistingPreview(outDir);
  } else if (process.argv.includes("--tone-only")) {
    console.log(`Generating the target-range chime in ${outDir}`);
    await generateTargetTone(outDir);
  } else {
    if (!apiKey) {
      console.error(`Add OPENAI_API_KEY to ${ENV_FILE}, then run pnpm tts:generate again.`);
      process.exit(1);
    }

    const entries = selectedEntries();
    console.log(`Generating ${entries.length} DIBH Lab clip${entries.length === 1 ? "" : "s"}.`);
    console.log(`Model: ${model} | voice: ${voice} | speed: ${speed}`);
    console.log(`Preview output: ${outDir}`);

    for (const [key, text] of entries) {
      process.stdout.write(`  ${key}.mp3 … `);
      const file = await generateClip({
        apiKey,
        model,
        voice,
        instructions,
        speed,
        key,
        text,
        outDir,
      });
      console.log(`${(file.size / 1_000).toFixed(1)} KB normalized`);
    }
    await generateTargetTone(outDir);
  }

  const files = await buildManifestFiles(outDir);
  const manifest = {
    schema: "dibh-audio-manifest/v1",
    generatedAt: new Date().toISOString(),
    provider: "OpenAI",
    model,
    voice,
    responseFormat: "mp3",
    speed,
    instructions,
    files,
  };
  await fs.writeFile(
    path.join(outDir, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );

  console.log(`Done. Review the preview files in ${outDir}`);
  console.log("The current production audio has not been overwritten.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
