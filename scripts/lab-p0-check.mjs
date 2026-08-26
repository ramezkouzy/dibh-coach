#!/usr/bin/env node
import assert from "node:assert/strict";

import { analyzeLabRecording } from "../src/lib/lab-p0-analysis.mjs";
import {
  analyzePositionSignal,
  detectRegularBreathingCycles,
} from "../src/lib/breath-cycle-analysis.mjs";

const CHANNELS = [
  "t",
  "alpha",
  "beta",
  "betaEma",
  "gamma",
  "ax",
  "ay",
  "az",
  "agx",
  "agy",
  "agz",
  "rrAlpha",
  "rrBeta",
  "rrGamma",
];

function synthRecording(direction, holdCount = 5) {
  const stepMs = 20;
  const samples = [];
  const events = [];
  let cursor = 0;
  let previousPitch = 0;

  const append = (durationMs, pitchAt) => {
    const start = cursor;
    for (let t = start; t < start + durationMs; t += stepMs) {
      const pitch = pitchAt(t - start, durationMs, t);
      const rrBeta = ((pitch - previousPitch) / stepMs) * 1000;
      previousPitch = pitch;
      samples.push([t, 0, pitch, pitch, 0, 0, 0, 0, 0, 0, 9.81, 0, rrBeta, 0]);
    }
    cursor += durationMs;
  };

  events.push({ t: cursor, type: "baseline_start" });
  append(12_000, (_local, _duration, t) => Math.sin((t / 2500) * Math.PI * 2));
  events.push({ t: cursor, type: "baseline_end" });

  for (let holdIndex = 1; holdIndex <= holdCount; holdIndex++) {
    const meta = { holdIndex, role: holdIndex <= 3 ? "learn" : "practice" };
    const offset = (holdIndex - 2) * 0.08;
    // Deliberately move the absolute phone pose between attempts. The target
    // must still be learned and scored from excursion relative to each hold's
    // own relaxed anchor, not from absolute pitch.
    const restPitch = (holdIndex - 1) * 1.25;
    events.push({ t: cursor, type: "prehold_start", meta });
    append(2_000, (_local, _duration, t) => restPitch + 0.03 * Math.sin(t / 90));
    events.push({ t: cursor, type: "prehold_end", meta });
    events.push({ t: cursor, type: "inhale_start", meta });
    append(4_000, (local, duration) => restPitch + direction * 8 * (local / duration));
    if (meta.role === "practice") {
      events.push({
        t: cursor,
        type: "target_acquired",
        meta: { ...meta, measuredExcursionDeg: 8 + offset },
      });
      events.push({
        t: cursor,
        type: "coach_cue",
        meta: { ...meta, cue: "right_there", reason: "target_acquired" },
      });
    }
    events.push({ t: cursor, type: "hold_start", meta });
    append(
      10_000,
      (_local, _duration, t) =>
        restPitch + direction * (8 + offset) + 0.04 * Math.sin(t / 75),
    );
    events.push({ t: cursor, type: "release", meta });
    append(
      4_000,
      (local, duration) => restPitch + direction * 8 * (1 - local / duration),
    );
    events.push({ t: cursor, type: "recovery_end", meta });
  }
  events.push({ t: cursor, type: "session_end" });

  return {
    schema: "dibh-lab/v3",
    durationSec: cursor / 1000,
    protocol: { holdSeconds: 10 },
    channels: CHANNELS,
    samples,
    events,
  };
}

for (const direction of [-1, 1]) {
  const recording = synthRecording(direction);
  const first = analyzeLabRecording(recording);
  const second = analyzeLabRecording(recording);
  assert.deepEqual(first, second, "analysis must be deterministic");
  assert.equal(first.valid, true);
  assert.equal(first.summary.validHoldCount, 5);
  assert.equal(first.summary.learnedDirection, direction);
  assert.equal(first.summary.directionConsistencyPct, 100);
  assert.ok(first.summary.preholdPoseSdDeg > 1);
  assert.ok(first.summary.absolutePlateauSdDeg > 1);
  assert.ok(first.summary.signedExcursionSdDeg < 0.2);
  assert.equal(first.summary.learnedTarget.available, true);
  assert.ok(Math.abs(first.summary.learnedTarget.targetSignedExcursionDeg - 8) < 0.1);
  assert.equal(
    first.summary.learnedTarget.experimentalTrainingToleranceDeg,
    1,
    "the replay analyzer should preserve the one-degree legacy target half-window",
  );
  assert.equal(first.summary.practice.length, 2);
  for (const practice of first.summary.practice) {
    assert.ok(practice.longestStableOnTargetRunSec > 6);
    assert.equal(practice.reachedRequestedDuration, false);
    assert.equal(practice.targetAcquiredFromInhaleSec, 4);
    assert.equal(practice.coachingCueCount, 1);
    assert.equal(practice.correctionCueCount, 0);
  }
  for (const hold of first.holds) {
    assert.equal(hold.valid, true);
    assert.ok(hold.firstLockFromHoldStartSec >= 2.7);
    assert.ok(hold.firstLockFromHoldStartSec <= 3.2);
    assert.ok(hold.bestStableSegment.durationSec > 6);
    assert.ok(hold.bestStableSegment.sdDeg < 0.1);
    assert.ok(Math.abs(hold.bestStableSegment.slopeDegPerSec) < 0.02);
  }
}

const inconsistent = synthRecording(1, 3);
for (const row of inconsistent.samples) {
  const t = row[0];
  let added = 0;
  if (t >= 14_000 && t < 18_000) added = 4 * ((t - 14_000) / 4_000);
  if (t >= 18_000 && t < 28_000) added = 4;
  if (t >= 28_000 && t < 32_000) added = 4 * (1 - (t - 28_000) / 4_000);
  row[2] += added;
  row[3] += added;
}
const inconsistentAnalysis = analyzeLabRecording(inconsistent);
assert.equal(
  inconsistentAnalysis.summary.learnedTarget.available,
  false,
  "three individually valid but mismatched calibration holds must not produce a target",
);
assert.ok(inconsistentAnalysis.summary.learnedTarget.observedLearnExcursionSdDeg > 0.75);

const aborted = synthRecording(1);
aborted.events.push({
  t: aborted.events.find((event) => event.type === "hold_start" && event.meta?.holdIndex === 4).t + 4000,
  type: "practice_hold_aborted",
  meta: { holdIndex: 4, role: "practice", reason: "sustained_above_target" },
});
const abortedAnalysis = analyzeLabRecording(aborted);
assert.equal(abortedAnalysis.holds.find((hold) => hold.index === 4).valid, false);
assert.ok(abortedAnalysis.issues.includes("hold_4:practice_hold_aborted"));

const observation = synthRecording(-1, 3);
for (const event of observation.events) {
  if (event.meta?.holdIndex) event.meta.role = "observation";
}
const observationAnalysis = analyzeLabRecording(observation);
assert.equal(observationAnalysis.holds.length, 3);
assert.ok(observationAnalysis.holds.every((hold) => hold.role === "observation"));
assert.equal(observationAnalysis.summary.learnedTarget.available, false);
assert.equal(observationAnalysis.summary.learnedDirection, -1);
assert.ok(observationAnalysis.summary.signedExcursionSdDeg < 0.2);

function synthLocalCycleProtocol(direction = -1) {
  const stepMs = 20;
  const samples = [];
  const events = [];
  let cursor = 0;
  let previousPitch = 0;
  const append = (durationMs, pitchAt) => {
    const start = cursor;
    for (let t = start; t < start + durationMs; t += stepMs) {
      const pitch = pitchAt(t - start, durationMs, t);
      const rrBeta = ((pitch - previousPitch) / stepMs) * 1000;
      previousPitch = pitch;
      samples.push([t, 0, pitch, pitch, 0, 0, 0, 0, 0, 0, 9.81, 0, rrBeta, 0]);
    }
    cursor += durationMs;
  };
  const appendThreeCycles = (holdIndex, role, restPitch) => {
    const meta = { holdIndex, role };
    const start = cursor;
    events.push({ t: start, type: "prehold_start", meta });
    append(12_000, (local) => restPitch + direction * 0.8 * Math.sin((local / 3000) * Math.PI * 2));
    const anchor = restPitch + direction * 0.8;
    events.push({ t: cursor, type: "prehold_end", meta });
    events.push({
      t: cursor,
      type: "breathing_cycles_qualified",
      meta: {
        ...meta,
        meanInspiratoryPeakPitchDeg: anchor,
        peakPitchesDeg: [anchor - 0.02, anchor, anchor + 0.02],
      },
    });
    return anchor;
  };

  events.push({ t: cursor, type: "baseline_start" });
  append(12_000, (local) => direction * 0.8 * Math.sin((local / 3000) * Math.PI * 2));
  events.push({ t: cursor, type: "baseline_end" });

  const calibrationDeltas = [3, 3.3, 2.7];
  for (let index = 0; index < calibrationDeltas.length; index++) {
    const holdIndex = index + 1;
    const role = "calibration";
    const restPitch = index * 1.1;
    const anchor = appendThreeCycles(holdIndex, role, restPitch);
    const meta = { holdIndex, role };
    events.push({ t: cursor, type: "inhale_start", meta });
    append(1800, (local, duration) => restPitch + direction * (0.8 + calibrationDeltas[index] * local / duration));
    events.push({
      t: cursor,
      type: "hold_start",
      meta: {
        ...meta,
        direction,
        localAnchorPitchDeg: anchor,
        normalPeakPitchesDeg: [anchor - 0.02, anchor, anchor + 0.02],
      },
    });
    append(10_000, (_local, _duration, t) => anchor + direction * calibrationDeltas[index] + 0.06 * Math.sin(t / 140));
    events.push({ t: cursor, type: "release", meta });
    append(1200, (local, duration) => anchor + direction * calibrationDeltas[index] * (1 - local / duration));
  }

  const practiceHoldIndex = 4;
  const practiceMeta = { holdIndex: practiceHoldIndex, role: "practice" };
  const practiceAnchor = appendThreeCycles(practiceHoldIndex, "practice", 0.4);
  events.push({ t: cursor, type: "inhale_start", meta: practiceMeta });
  append(1800, (local, duration) => 0.4 + direction * (0.8 + 3 * local / duration));
  events.push({
    t: cursor,
    type: "hold_start",
    meta: {
      ...practiceMeta,
      direction,
      localAnchorPitchDeg: practiceAnchor,
      normalPeakPitchesDeg: [practiceAnchor - 0.02, practiceAnchor, practiceAnchor + 0.02],
      targetExcursionDeg: 3,
      toleranceDeg: 0.5,
    },
  });
  events.push({ t: cursor, type: "target_acquired", meta: practiceMeta });
  append(10_000, (_local, _duration, t) => practiceAnchor + direction * 3.05 + 0.05 * Math.sin(t / 110));
  events.push({ t: cursor, type: "release", meta: practiceMeta });
  events.push({ t: cursor, type: "session_end" });

  return {
    schema: "dibh-lab/v3",
    durationSec: cursor / 1000,
    protocol: { holdSeconds: 10, requiredNormalCycles: 3 },
    channels: CHANNELS,
    samples,
    events,
  };
}

const cyclePoints = Array.from({ length: 701 }, (_, index) => {
  const t = index * 20;
  return { t, p: -0.8 * Math.sin((t / 3000) * Math.PI * 2) };
});
const detectedCycles = detectRegularBreathingCycles(cyclePoints, {
  direction: -1,
  requiredCycles: 3,
  startMs: 0,
});
assert.equal(detectedCycles.ready, true, "three complete sinusoidal cycles should qualify");
assert.equal(detectedCycles.peaks.length, 3);
assert.ok(Math.abs(detectedCycles.meanInspiratoryPeakPitchDeg + 0.8) < 0.08);

const positionSignal = (amplitude, noiseAmplitude = 0.02) =>
  Array.from({ length: 2251 }, (_, index) => {
    const t = index * 20;
    return {
      t,
      p:
        -amplitude * Math.sin((t / 4000) * Math.PI * 2) +
        noiseAmplitude * Math.sin((t / 180) * Math.PI * 2) +
        (t / 60000) * 0.08,
    };
  });
const strongPosition = analyzePositionSignal(positionSignal(1.2), { direction: -1 });
const weakPosition = analyzePositionSignal(positionSignal(0.22, 0.08), { direction: -1 });
assert.equal(strongPosition.enoughData, true, "position study should qualify a 45-second trace");
assert.ok(strongPosition.usableCycleCount >= 8);
assert.ok(Math.abs(strongPosition.medianPeakToTroughAmplitudeDeg - 2.4) < 0.2);
assert.ok(Math.abs(strongPosition.estimatedBreathsPerMinute - 15) < 0.5);
assert.ok(strongPosition.amplitudeToNoiseRatio > weakPosition.amplitudeToNoiseRatio);

const localProtocol = synthLocalCycleProtocol(-1);
const localAnalysis = analyzeLabRecording(localProtocol);
assert.equal(localAnalysis.summary.learnedTarget.available, true);
assert.equal(localAnalysis.summary.learnedTarget.method, "local_three_peak_delta_mean_combined_sd");
assert.deepEqual(localAnalysis.summary.learnedTarget.selectedHoldIndexes, [1, 2, 3]);
assert.ok(Math.abs(localAnalysis.summary.learnedTarget.targetSignedExcursionDeg - 3) < 0.05);
assert.ok(Math.abs(localAnalysis.summary.learnedTarget.betweenHoldDeltaSdDeg - 0.3) < 0.05);
assert.equal(localAnalysis.summary.learnedTarget.experimentalTrainingToleranceDeg, 0.5);
assert.equal(localAnalysis.summary.practice.length, 1);
assert.ok(localAnalysis.summary.practice[0].percentInTargetRange > 95);
assert.equal(localAnalysis.summary.practice[0].holdCompleted, true);

console.log("Lab P0 synthetic replay checks passed for legacy directions, observation replay, three-cycle detection, position-signal comparison, local-delta calibration, and coached target timing.");
