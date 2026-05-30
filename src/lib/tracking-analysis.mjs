const ANALYSIS_SCHEMA = "dibh-tracking-analysis/v1";
const SESSION_SCHEMA = "dibh-session/v1";

const LEARN_HOLD_SD_MULT = 3;
const LEARN_HOLD_SD_FLOOR_DEG = 1.5;
const SAMPLE_CLOCK_OFFSET_WARN_MS = 1500;
const START_AT_TARGET_FRACTION = 0.6;
const MIN_BREATH_PROGRESS_FRACTION = 0.25;
const MIN_BREATH_PROGRESS_DEG = 1.5;
const SELF_TEST_CAP_SEC = 10;

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function round(value, digits = 3) {
  return isFiniteNumber(value) ? +value.toFixed(digits) : null;
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function mean(values) {
  if (!values.length) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function standardDeviation(values) {
  if (!values.length) return null;
  const m = mean(values);
  return Math.sqrt(values.reduce((a, b) => a + (b - m) ** 2, 0) / values.length);
}

function signOrNull(value) {
  if (!isFiniteNumber(value) || Math.abs(value) < 0.001) return null;
  return value > 0 ? 1 : -1;
}

function issue(code, severity, message, details = undefined) {
  return { code, severity, message, ...(details ? { details } : {}) };
}

function cueCounts(events) {
  return events.reduce((acc, event) => {
    if (event && typeof event.type === "string") {
      acc[event.type] = (acc[event.type] ?? 0) + 1;
    }
    return acc;
  }, {});
}

function normalizeSamples(samples) {
  const clean = (Array.isArray(samples) ? samples : [])
    .map((sample) => ({ t: Number(sample?.t), p: Number(sample?.p) }))
    .filter((sample) => isFiniteNumber(sample.t) && isFiniteNumber(sample.p))
    .sort((a, b) => a.t - b.t);

  if (!clean.length) {
    return { samples: [], sampleClockOffsetMs: 0 };
  }

  const firstT = clean[0].t;
  const hasEarlySamples = clean.some((sample) => sample.t >= 0 && sample.t <= 1000);
  const shouldRebase = firstT > SAMPLE_CLOCK_OFFSET_WARN_MS || !hasEarlySamples;
  const offset = shouldRebase ? firstT : 0;

  return {
    samples: clean.map((sample) => ({ t: sample.t - offset, p: sample.p })),
    sampleClockOffsetMs: offset,
  };
}

function samplesInWindow(samples, startMs, endMs) {
  return samples.filter((sample) => sample.t >= startMs && sample.t <= endMs);
}

function maxProgressTowardTarget(samples, startPitch, direction, endMs) {
  if (!samples.length || direction == null || !isFiniteNumber(startPitch)) return null;
  let best = 0;
  for (const sample of samples) {
    if (sample.t > endMs) break;
    best = Math.max(best, (sample.p - startPitch) * direction);
  }
  return best;
}

function firstEventSec(events, type) {
  const event = events.find((candidate) => candidate?.type === type);
  return isFiniteNumber(event?.t) ? event.t / 1000 : null;
}

function parseSessionExport(value) {
  if (!value || typeof value !== "object") {
    throw new Error("Expected a JSON object.");
  }
  if (value.schema !== SESSION_SCHEMA) {
    throw new Error(`Expected schema ${SESSION_SCHEMA}.`);
  }
  if (!value.baseline || !isFiniteNumber(value.baseline.meanPitch)) {
    throw new Error("Missing baseline.meanPitch.");
  }
  if (!value.plateau || !isFiniteNumber(value.plateau.targetPitch)) {
    throw new Error("Missing plateau.targetPitch.");
  }
  if (!Array.isArray(value.holds)) {
    throw new Error("Missing holds array.");
  }
  return value;
}

function analyzeCalibration(session, targetExcursionDeg) {
  const baselineSD = Math.max(0, Number(session.baseline?.breathingSD ?? 0));
  const maxAllowedPlateauSD = Math.max(LEARN_HOLD_SD_FLOOR_DEG, baselineSD * LEARN_HOLD_SD_MULT);
  const calibrationHolds = Array.isArray(session.plateau?.calibrationHolds)
    ? session.plateau.calibrationHolds
    : [];
  const unstable = calibrationHolds
    .map((hold, index) => ({ hold, index: index + 1 }))
    .filter(({ hold }) => Number(hold?.plateauSD ?? 0) > maxAllowedPlateauSD);
  const tolerance = Number(session.plateau?.toleranceDeg ?? 0);
  const issues = [];

  if (unstable.length > 0) {
    issues.push(
      issue(
        "learn_hold_unstable",
        "warn",
        "At least one Learn hold was too noisy and should not set the target.",
        {
          holdIndexes: unstable.map(({ index }) => index),
          maxAllowedPlateauSDDeg: round(maxAllowedPlateauSD),
        },
      ),
    );
  }

  if (Math.abs(targetExcursionDeg) < 2) {
    issues.push(
      issue(
        "target_too_close_to_baseline",
        "warn",
        "The learned target is close to the breathing baseline, so the app may confuse stillness with a breath hold.",
        { targetExcursionDeg: round(targetExcursionDeg) },
      ),
    );
  }

  if (tolerance > Math.max(2, Math.abs(targetExcursionDeg) * 0.35)) {
    issues.push(
      issue(
        "target_band_wide",
        "info",
        "The learned target band is wide, which usually means the Learn holds were inconsistent.",
        { toleranceDeg: round(tolerance), targetExcursionDeg: round(targetExcursionDeg) },
      ),
    );
  }

  return {
    learnHoldCount: calibrationHolds.length,
    maxAllowedPlateauSDDeg: round(maxAllowedPlateauSD),
    unstableLearnHoldCount: unstable.length,
    maxPlateauSDDeg: round(
      Math.max(0, ...calibrationHolds.map((hold) => Number(hold?.plateauSD ?? 0))),
    ),
    issues,
  };
}

function analyzeHold(session, hold) {
  const { samples, sampleClockOffsetMs } = normalizeSamples(hold.samples);
  const baselinePitch = Number(session.baseline.meanPitch);
  const targetPitch = Number(session.plateau.targetPitch);
  const toleranceDeg = Number(session.plateau.toleranceDeg ?? 0);
  const targetExcursionDeg = targetPitch - baselinePitch;
  const targetDirection = signOrNull(targetExcursionDeg);
  const targetExcursionAbs = Math.abs(targetExcursionDeg);
  const events = Array.isArray(hold.events) ? hold.events : [];
  const firstLockSec = firstEventSec(events, "locked_in");
  const firstWindow = samplesInWindow(samples, 0, 1000);
  const firstThreeSec = samplesInWindow(samples, 0, 3000);
  const startPitchDeg = median(firstWindow.map((sample) => sample.p));
  const firstThreeSDDeg = standardDeviation(firstThreeSec.map((sample) => sample.p));
  const startExcursionDeg =
    startPitchDeg == null ? null : startPitchDeg - baselinePitch;
  const startDirection = signOrNull(startExcursionDeg);
  const startExcursionFraction =
    startExcursionDeg == null || targetExcursionAbs < 0.001
      ? null
      : Math.abs(startExcursionDeg) / targetExcursionAbs;
  const startNearTarget =
    startPitchDeg != null &&
    (Math.abs(startPitchDeg - targetPitch) <= toleranceDeg ||
      (startDirection === targetDirection &&
        startExcursionFraction != null &&
        startExcursionFraction >= START_AT_TARGET_FRACTION));
  const progressWindowMs =
    firstLockSec == null
      ? Math.min(10_000, Number(hold.totalDurationSec ?? 0) * 1000)
      : firstLockSec * 1000;
  const progressBeforeLockDeg = maxProgressTowardTarget(
    samples,
    startPitchDeg,
    targetDirection,
    progressWindowMs,
  );
  const minBreathProgressDeg = Math.max(
    MIN_BREATH_PROGRESS_DEG,
    targetExcursionAbs * MIN_BREATH_PROGRESS_FRACTION,
  );
  const insufficientBreathAfterStart =
    firstLockSec != null &&
    (progressBeforeLockDeg == null || progressBeforeLockDeg < minBreathProgressDeg);
  const plateauExcursionDeg =
    isFiniteNumber(hold.plateauPitch) ? hold.plateauPitch - baselinePitch : null;
  const plateauDirection = signOrNull(plateauExcursionDeg);
  const wrongDirection =
    plateauDirection != null &&
    targetDirection != null &&
    plateauDirection !== targetDirection &&
    Math.abs(plateauExcursionDeg) > Math.max(2, targetExcursionAbs * 0.4);
  const suggestedCapSec = Math.min(
    SELF_TEST_CAP_SEC,
    Number(session.settings?.holdTarget ?? SELF_TEST_CAP_SEC) || SELF_TEST_CAP_SEC,
  );
  const overranSafetyCap =
    Number(hold.totalDurationSec ?? 0) > suggestedCapSec + 5 &&
    hold.reachedTarget !== true;

  const issues = [];
  if (sampleClockOffsetMs > SAMPLE_CLOCK_OFFSET_WARN_MS) {
    issues.push(
      issue(
        "sample_clock_offset",
        "warn",
        "Hold samples did not start near t=0; backend rebased them before analysis.",
        { sampleClockOffsetMs: round(sampleClockOffsetMs, 1) },
      ),
    );
  }
  if (startNearTarget) {
    issues.push(
      issue(
        "hold_started_near_target",
        "warn",
        "The hold began already near or beyond the learned target, so lock can occur without a fresh inhale.",
        {
          startPitchDeg: round(startPitchDeg),
          targetPitchDeg: round(targetPitch),
          startExcursionFraction: round(startExcursionFraction),
        },
      ),
    );
  }
  if (insufficientBreathAfterStart) {
    issues.push(
      issue(
        "insufficient_breath_after_start",
        "warn",
        "The trace did not show enough new target-direction motion after Start before lock.",
        {
          progressBeforeLockDeg: round(progressBeforeLockDeg),
          minBreathProgressDeg: round(minBreathProgressDeg),
          firstLockSec: round(firstLockSec),
        },
      ),
    );
  }
  if (wrongDirection) {
    issues.push(
      issue(
        "plateau_wrong_direction",
        "warn",
        "The saved plateau moved opposite the learned target direction.",
        {
          plateauPitchDeg: round(hold.plateauPitch),
          baselinePitchDeg: round(baselinePitch),
          targetPitchDeg: round(targetPitch),
        },
      ),
    );
  }
  if (Number(hold.driftEvents ?? 0) >= 5) {
    issues.push(
      issue("high_drift_count", "info", "The hold had repeated drift/regain cycles.", {
        driftEvents: Number(hold.driftEvents),
      }),
    );
  }
  if (overranSafetyCap) {
    issues.push(
      issue(
        "hold_over_safety_cap",
        "warn",
        "The hold ran past the suggested self-test safety cap without reaching the target.",
        {
          durationSec: round(hold.totalDurationSec),
          suggestedCapSec,
          reachedTarget: hold.reachedTarget === true,
        },
      ),
    );
  }

  return {
    index: Number(hold.index ?? 0),
    durationSec: round(hold.totalDurationSec),
    firstLockSec: round(firstLockSec),
    startPitchDeg: round(startPitchDeg),
    startExcursionDeg: round(startExcursionDeg),
    startExcursionFraction: round(startExcursionFraction),
    firstThreeSecondSDDeg: round(firstThreeSDDeg),
    progressBeforeLockDeg: round(progressBeforeLockDeg),
    minBreathProgressDeg: round(minBreathProgressDeg),
    plateauPitchDeg: round(hold.plateauPitch),
    plateauSDDeg: round(hold.plateauSD),
    onTargetSec: round(hold.onTargetSec),
    longestOnTargetRunSec: round(hold.longestOnTargetRunSec),
    reachedTarget: hold.reachedTarget === true,
    driftEvents: Number(hold.driftEvents ?? 0),
    sampleClockOffsetMs: round(sampleClockOffsetMs, 1),
    startNearTarget,
    insufficientBreathAfterStart,
    plateauWrongDirection: wrongDirection,
    overranSafetyCap,
    cueCounts: cueCounts(events),
    issues,
  };
}

function buildRecommendations(analysis) {
  const codes = new Set(analysis.issues.map((candidate) => candidate.code));
  const recommendations = [];

  if (codes.has("hold_started_near_target") || codes.has("insufficient_breath_after_start")) {
    recommendations.push({
      code: "require_fresh_breath_evidence",
      priority: "high",
      message:
        "Before saying locked-in or hold-steady, require a new inhale excursion after Start rather than accepting a phone that is already sitting near the target.",
    });
    recommendations.push({
      code: "capture_prehold_pose",
      priority: "high",
      message:
        "Record a short phone-pose anchor immediately before each hold so the algorithm can separate placement/tilt from actual chest excursion.",
    });
  }

  if (codes.has("learn_hold_unstable")) {
    recommendations.push({
      code: "reject_noisy_learn_holds",
      priority: "high",
      message:
        "Treat noisy Learn holds as redo-only; do not let a high-SD Learn hold shape the target band.",
    });
  }

  if (codes.has("plateau_wrong_direction")) {
    recommendations.push({
      code: "enforce_direction_consistency",
      priority: "medium",
      message:
        "Require the practice plateau to move in the same direction as the learned DIBH excursion before saving it as a good hold.",
    });
  }

  if (codes.has("hold_over_safety_cap")) {
    recommendations.push({
      code: "self_test_release_cap",
      priority: "high",
      message:
        "For self-testing, cap unreached holds at 10 seconds and explicitly cue release instead of letting the user hold into discomfort.",
    });
  }

  if (codes.has("sample_clock_offset")) {
    recommendations.push({
      code: "fix_sample_timebase",
      priority: "medium",
      message:
        "Normalize exported hold samples to hold-start t=0 in the client so replay tooling does not need to infer the offset.",
    });
  }

  return recommendations;
}

function confidenceFromIssues(issues) {
  const warnCount = issues.filter((candidate) => candidate.severity === "warn").length;
  if (warnCount >= 4) return "low";
  if (warnCount >= 2) return "guarded";
  return "usable";
}

function summarizeIssueCounts(issues) {
  return issues.reduce((acc, candidate) => {
    acc[candidate.severity] = (acc[candidate.severity] ?? 0) + 1;
    return acc;
  }, {});
}

export function analyzeSession(rawSession) {
  const session = parseSessionExport(rawSession);
  const baselinePitch = Number(session.baseline.meanPitch);
  const targetPitch = Number(session.plateau.targetPitch);
  const targetExcursionDeg = targetPitch - baselinePitch;
  const calibration = analyzeCalibration(session, targetExcursionDeg);
  const holds = session.holds.map((hold) => analyzeHold(session, hold));
  const issues = [
    ...calibration.issues,
    ...holds.flatMap((hold) =>
      hold.issues.map((holdIssue) => ({
        ...holdIssue,
        holdIndex: hold.index || undefined,
      })),
    ),
  ];
  const suggestedSelfTestCapSec = Math.min(
    SELF_TEST_CAP_SEC,
    Number(session.settings?.holdTarget ?? SELF_TEST_CAP_SEC) || SELF_TEST_CAP_SEC,
  );
  const analysis = {
    schema: ANALYSIS_SCHEMA,
    analyzedAt: new Date().toISOString(),
    sessionStartedAt: session.startedAt ?? null,
    summary: {
      holdCount: session.holds.length,
      requestedHoldTargetSec: Number(session.settings?.holdTarget ?? 0) || null,
      suggestedSelfTestCapSec,
      baselinePitchDeg: round(baselinePitch),
      baselineBreathingSDDeg: round(session.baseline.breathingSD),
      learnedTargetPitchDeg: round(targetPitch),
      targetExcursionDeg: round(targetExcursionDeg),
      targetToleranceDeg: round(session.plateau.toleranceDeg),
      reachedTargetCount: session.holds.filter((hold) => hold.reachedTarget === true).length,
    },
    calibration,
    holds,
    issues,
    issueCounts: summarizeIssueCounts(issues),
    trackingConfidence: confidenceFromIssues(issues),
    recommendations: [],
  };
  analysis.recommendations = buildRecommendations(analysis);
  return analysis;
}

export function parseSessionJson(text) {
  return parseSessionExport(JSON.parse(text));
}

export { SESSION_SCHEMA, ANALYSIS_SCHEMA };
