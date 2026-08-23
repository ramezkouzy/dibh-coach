#!/usr/bin/env node
import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const STABILITY_WINDOW_MS = 2000;
const STABLE_SD_FRAC_OF_BASELINE = 0.7;
const STABLE_SD_FLOOR = 0.08;
const STABLE_SD_CEILING = 1.2;

function mean(xs) {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function sd(xs) {
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length);
}

function percentile(xs, p) {
  if (!xs.length) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.round((sorted.length - 1) * p)];
}

function rollingSd(samples, windowMs) {
  const out = [];
  const cur = [];
  let sum = 0;
  let sumSq = 0;
  for (const s of samples) {
    cur.push(s);
    sum += s.p;
    sumSq += s.p * s.p;
    const cutoff = s.t - windowMs;
    while (cur.length && cur[0].t < cutoff) {
      const old = cur.shift();
      sum -= old.p;
      sumSq -= old.p * old.p;
    }
    if (cur.length >= 4) {
      const m = sum / cur.length;
      out.push({ t: s.t, sd: Math.sqrt(Math.max(0, sumSq / cur.length - m * m)) });
    }
  }
  return out;
}

function loadSamples(rec) {
  if (rec.schema === "dibh-lab/v2" || rec.schema === "dibh-lab/v3") {
    const betaIdx = rec.channels.indexOf(rec.channels.includes("betaEma") ? "betaEma" : "beta");
    if (betaIdx < 0) throw new Error("missing beta channel");
    return rec.samples
      .map((row) => ({ t: row[0], p: row[betaIdx] }))
      .filter((s) => typeof s.t === "number" && typeof s.p === "number");
  }
  return rec.samples
    .map((s) => ({ t: s.t, p: s.p ?? s.beta }))
    .filter((s) => typeof s.t === "number" && typeof s.p === "number");
}

function phaseWindows(events, samples) {
  const byType = new Map((events ?? []).map((e) => [e.type, e.t]));
  if (byType.has("baseline_start") && byType.has("baseline_end")) {
    return {
      baseline: [byType.get("baseline_start"), byType.get("baseline_end")],
      hold:
        byType.has("hold_start") && byType.has("release")
          ? [byType.get("hold_start"), byType.get("release")]
          : null,
    };
  }
  const first = samples[0]?.t ?? 0;
  return {
    baseline: [first, first + 12000],
    hold: null,
  };
}

async function listRecordings() {
  const dirs = [join(homedir(), "Downloads"), join(process.cwd(), "..", "data")];
  const paths = [];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const name of await readdir(dir)) {
      if (/^dibh-.*\.json$/i.test(name)) paths.push(join(dir, name));
    }
  }
  return [...new Set(paths)].sort();
}

const paths = process.argv.slice(2).length ? process.argv.slice(2) : await listRecordings();
if (!paths.length) {
  console.error("No DIBH JSON recordings found.");
  process.exit(1);
}

let failures = 0;
for (const path of paths) {
  try {
    const rec = JSON.parse(await readFile(path, "utf8"));
    const samples = loadSamples(rec);
    if (samples.length < 30) throw new Error("too few pitch samples");
    const phases = phaseWindows(rec.events ?? [], samples);
    const [b0, b1] = phases.baseline;
    const baseline = samples.filter((s) => s.t >= b0 + 2000 && s.t <= b1).map((s) => s.p);
    if (baseline.length < 30) throw new Error("too few baseline samples");
    const breathingSD = sd(baseline);
    const threshold = Math.min(
      STABLE_SD_CEILING,
      Math.max(STABLE_SD_FLOOR, breathingSD * STABLE_SD_FRAC_OF_BASELINE),
    );
    const holdWindow = phases.hold;
    const holdRolling = holdWindow
      ? rollingSd(samples, STABILITY_WINDOW_MS)
          .filter((s) => s.t >= holdWindow[0] && s.t <= holdWindow[1])
          .map((s) => s.sd)
      : [];
    const holdMedian = percentile(holdRolling, 0.5);
    const verdict =
      holdMedian == null ? "parsed" : holdMedian < threshold * 1.5 ? "stable-ish" : "review";
    console.log(
      [
        path,
        `samples=${samples.length}`,
        `baselineSD=${breathingSD.toFixed(3)}`,
        `threshold=${threshold.toFixed(3)}`,
        `holdMedianSD=${holdMedian == null ? "n/a" : holdMedian.toFixed(3)}`,
        `verdict=${verdict}`,
      ].join(" | "),
    );
  } catch (err) {
    failures += 1;
    console.error(`${path} | ERROR | ${err instanceof Error ? err.message : String(err)}`);
  }
}

if (failures) process.exit(1);
