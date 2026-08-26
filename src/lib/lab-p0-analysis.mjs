export const LAB_P0_ALGORITHM = Object.freeze({
  id: "dibh-lab-p0",
  version: "0.3.0",
  params: Object.freeze({
    emaAlpha: 0.3,
    stabilityWindowMs: 2000,
    stableSdFractionOfBaseline: 0.7,
    stableSdFloorDeg: 0.08,
    stableSdCeilingDeg: 1.2,
    stableSlopeCeilingDegPerSec: 0.25,
    stableDebounceMs: 1000,
    driftDebounceMs: 1500,
    plateauTrimMs: 300,
    trainingToleranceFloorDeg: 0.5,
    trainingToleranceCeilingDeg: 2,
    trainingToleranceNoiseMultiplier: 2,
    calibrationExcursionSdCeilingDeg: 0.75,
    minimumTargetExcursionDeg: 1.5,
    restingWindowMs: 2000,
    restingSdCeilingDeg: 0.35,
    restingSlopeCeilingDegPerSec: 0.25,
    recoveryDwellMs: 1500,
    targetAcquireDwellMs: 750,
    targetCueCooldownMs: 2500,
    longGapMs: 50,
  }),
});

const ANALYSIS_SCHEMA = "dibh-lab-analysis/v1";

function round(value, digits = 3) {
  return Number.isFinite(value) ? +value.toFixed(digits) : null;
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function standardDeviation(values) {
  if (values.length < 2) return null;
  const center = mean(values);
  if (center == null) return null;
  return Math.sqrt(values.reduce((sum, value) => sum + (value - center) ** 2, 0) / values.length);
}

function tightestCalibrationTrio(holds, direction) {
  const candidates = holds.filter(
    (hold) => hold.direction === direction && Number.isFinite(hold.relativeExcursionDeg),
  );
  let best = null;
  for (let first = 0; first < candidates.length - 2; first++) {
    for (let second = first + 1; second < candidates.length - 1; second++) {
      for (let third = second + 1; third < candidates.length; third++) {
        const trio = [candidates[first], candidates[second], candidates[third]];
        const sd = standardDeviation(trio.map((hold) => hold.relativeExcursionDeg));
        if (sd != null && (!best || sd < best.sd)) best = { holds: trio, sd };
      }
    }
  }
  return best;
}

function medianAbsoluteDeviation(values) {
  const center = median(values);
  if (center == null) return null;
  return median(values.map((value) => Math.abs(value - center)));
}

function linearSlope(points) {
  if (points.length < 4) return null;
  const t0 = points[0].t;
  const xs = points.map((point) => (point.t - t0) / 1000);
  const xMean = mean(xs);
  const yMean = mean(points.map((point) => point.p));
  if (xMean == null || yMean == null) return null;
  let numerator = 0;
  let denominator = 0;
  for (let index = 0; index < points.length; index++) {
    numerator += (xs[index] - xMean) * (points[index].p - yMean);
    denominator += (xs[index] - xMean) ** 2;
  }
  return denominator > 0 ? numerator / denominator : 0;
}

function sequenceSlope(values) {
  const points = values
    .map((value, index) => ({ t: index * 1000, p: value }))
    .filter((point) => Number.isFinite(point.p));
  return round(linearSlope(points));
}

function summarizePoints(points) {
  const values = points.map((point) => point.p);
  if (!values.length) return null;
  const center = mean(values);
  const med = median(values);
  const sd = standardDeviation(values);
  const mad = medianAbsoluteDeviation(values);
  const minimum = Math.min(...values);
  const maximum = Math.max(...values);
  return {
    sampleCount: values.length,
    meanPitchDeg: round(center),
    medianPitchDeg: round(med),
    sdDeg: round(sd),
    madDeg: round(mad),
    robustSdDeg: round(mad == null ? null : mad * 1.4826),
    minPitchDeg: round(minimum),
    maxPitchDeg: round(maximum),
    amplitudeDeg: round(maximum - minimum),
    slopeDegPerSec: round(linearSlope(points)),
  };
}

function eventIndex(event, fallback) {
  const value = Number(event?.meta?.holdIndex);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function eventRole(event, holdIndex, totalHolds) {
  if (event?.meta?.role === "learn" || event?.meta?.role === "practice") {
    return event.meta.role;
  }
  return totalHolds >= 4 && holdIndex > 3 ? "practice" : "learn";
}

function findEvent(events, type, holdIndex) {
  const indexed = events.find(
    (event) => event.type === type && Number(event?.meta?.holdIndex) === holdIndex,
  );
  if (indexed) return indexed;
  return events.filter(
    (event) => event.type === type && !Number.isFinite(Number(event?.meta?.holdIndex)),
  )[holdIndex - 1];
}

function signalPoints(recording) {
  const channels = Array.isArray(recording.channels) ? recording.channels : [];
  const timeIndex = channels.indexOf("t");
  const emaIndex = channels.indexOf("betaEma");
  const betaIndex = channels.indexOf("beta");
  const signalIndex = emaIndex >= 0 ? emaIndex : betaIndex;
  if (timeIndex < 0 || signalIndex < 0 || !Array.isArray(recording.samples)) return [];
  return recording.samples
    .map((row) => ({ t: row?.[timeIndex], p: row?.[signalIndex] }))
    .filter(
      (point) =>
        typeof point.t === "number" &&
        Number.isFinite(point.t) &&
        typeof point.p === "number" &&
        Number.isFinite(point.p),
    )
    .sort((a, b) => a.t - b.t);
}

function pointsBetween(points, startMs, endMs) {
  return points.filter((point) => point.t >= startMs && point.t <= endMs);
}

function sampleQuality(recording, points) {
  const channels = Array.isArray(recording.channels) ? recording.channels : [];
  const betaIndex = channels.indexOf("beta");
  const durationMs = Math.max(0, Number(recording.durationSec ?? 0) * 1000);
  let betaPresent = 0;
  let longestGapMs = 0;
  let longGapCount = 0;
  for (const row of recording.samples ?? []) {
    const beta = row?.[betaIndex];
    if (betaIndex >= 0 && typeof beta === "number" && Number.isFinite(beta)) betaPresent += 1;
  }
  for (let index = 1; index < points.length; index++) {
    const gap = points[index].t - points[index - 1].t;
    longestGapMs = Math.max(longestGapMs, gap);
    if (gap > LAB_P0_ALGORITHM.params.longGapMs) longGapCount += 1;
  }
  return {
    sampleCount: Array.isArray(recording.samples) ? recording.samples.length : 0,
    signalSampleCount: points.length,
    effectiveSampleRateHz: round(durationMs > 0 ? (points.length * 1000) / durationMs : null, 1),
    betaCoveragePct: round(
      recording.samples?.length ? (betaPresent / recording.samples.length) * 100 : null,
      1,
    ),
    longestGapMs: round(longestGapMs, 1),
    gapsOver50Ms: longGapCount,
  };
}

function rollingStats(points, startIndex, endIndex) {
  return summarizePoints(points.slice(startIndex, endIndex + 1));
}

function stableSegments(points, holdStartMs, releaseMs, thresholdDeg) {
  const params = LAB_P0_ALGORITHM.params;
  const holdPoints = pointsBetween(points, holdStartMs, releaseMs);
  const segments = [];
  const transitions = [];
  let left = 0;
  let stableCandidateSince = null;
  let unstableCandidateSince = null;
  let lockedAt = null;
  let firstLockAt = null;

  for (let right = 0; right < holdPoints.length; right++) {
    const now = holdPoints[right].t;
    while (left < right && holdPoints[left].t < now - params.stabilityWindowMs) left += 1;
    const windowDuration = now - holdPoints[left].t;
    const summary = rollingStats(holdPoints, left, right);
    const hasFullWindow = windowDuration >= params.stabilityWindowMs * 0.9;
    const wantStable =
      hasFullWindow &&
      summary != null &&
      summary.sdDeg != null &&
      summary.slopeDegPerSec != null &&
      summary.sdDeg < thresholdDeg &&
      Math.abs(summary.slopeDegPerSec) < params.stableSlopeCeilingDegPerSec;

    if (lockedAt == null) {
      unstableCandidateSince = null;
      if (!wantStable) {
        stableCandidateSince = null;
      } else if (stableCandidateSince == null) {
        stableCandidateSince = now;
      } else if (now - stableCandidateSince >= params.stableDebounceMs) {
        lockedAt = now;
        firstLockAt ??= now;
        stableCandidateSince = null;
        transitions.push({
          t: round(now, 1),
          type: "stable_lock",
          meta: {
            sdDeg: summary.sdDeg,
            slopeDegPerSec: summary.slopeDegPerSec,
            thresholdDeg: round(thresholdDeg),
          },
        });
      }
      continue;
    }

    if (wantStable) {
      unstableCandidateSince = null;
    } else if (unstableCandidateSince == null) {
      unstableCandidateSince = now;
    } else if (now - unstableCandidateSince >= params.driftDebounceMs) {
      const endMs = unstableCandidateSince;
      segments.push(summarizeSegment(points, lockedAt, endMs));
      transitions.push({
        t: round(now, 1),
        type: "drift_confirmed",
        meta: { segmentEndMs: round(endMs, 1) },
      });
      lockedAt = null;
      unstableCandidateSince = null;
      stableCandidateSince = null;
    }
  }

  if (lockedAt != null) segments.push(summarizeSegment(points, lockedAt, releaseMs));
  return {
    firstLockAtMs: round(firstLockAt, 1),
    segments: segments.filter(Boolean),
    transitions,
  };
}

function summarizeSegment(points, startMs, endMs) {
  if (!(endMs > startMs)) return null;
  const trim = LAB_P0_ALGORITHM.params.plateauTrimMs;
  const canTrim = endMs - startMs > trim * 2 + 500;
  const coreStartMs = canTrim ? startMs + trim : startMs;
  const coreEndMs = canTrim ? endMs - trim : endMs;
  const summary = summarizePoints(pointsBetween(points, coreStartMs, coreEndMs));
  if (!summary) return null;
  return {
    startMs: round(startMs, 1),
    endMs: round(endMs, 1),
    durationSec: round((endMs - startMs) / 1000),
    coreStartMs: round(coreStartMs, 1),
    coreEndMs: round(coreEndMs, 1),
    ...summary,
  };
}

function recoveryToPreholdMs(points, releaseMs, sessionEndMs, preholdPitch, thresholdDeg) {
  if (!Number.isFinite(preholdPitch)) return null;
  const tolerance = Math.max(0.5, thresholdDeg);
  const recovery = pointsBetween(points, releaseMs, sessionEndMs);
  let candidateStart = null;
  let previousT = null;
  for (const point of recovery) {
    const sensorGap = previousT != null && point.t - previousT > LAB_P0_ALGORITHM.params.longGapMs;
    const inside = Math.abs(point.p - preholdPitch) <= tolerance;
    if (!inside || sensorGap) {
      candidateStart = inside ? point.t : null;
    } else {
      candidateStart ??= point.t;
      if (point.t - candidateStart >= LAB_P0_ALGORITHM.params.recoveryDwellMs) {
        return round(candidateStart - releaseMs, 1);
      }
    }
    previousT = point.t;
  }
  return null;
}

function analyzeHold(points, events, holdStartEvent, fallbackIndex, totalHolds, baseline) {
  const holdIndex = eventIndex(holdStartEvent, fallbackIndex);
  const role = eventRole(holdStartEvent, holdIndex, totalHolds);
  const preholdStart = findEvent(events, "prehold_start", holdIndex);
  const preholdEnd = findEvent(events, "prehold_end", holdIndex);
  const inhaleStart = findEvent(events, "inhale_start", holdIndex);
  const release = findEvent(events, "release", holdIndex);
  const recoveryEnd = findEvent(events, "recovery_end", holdIndex);
  if (!release) {
    return {
      index: holdIndex,
      role,
      valid: false,
      issues: ["missing_release_event"],
    };
  }

  const preholdPoints =
    preholdStart && preholdEnd
      ? pointsBetween(points, preholdStart.t, preholdEnd.t)
      : inhaleStart
        ? pointsBetween(points, Math.max(0, inhaleStart.t - 2000), inhaleStart.t)
        : [];
  const prehold = summarizePoints(preholdPoints);
  const thresholdDeg = Math.min(
    LAB_P0_ALGORITHM.params.stableSdCeilingDeg,
    Math.max(
      LAB_P0_ALGORITHM.params.stableSdFloorDeg,
      Number(baseline?.sdDeg ?? 0) * LAB_P0_ALGORITHM.params.stableSdFractionOfBaseline,
    ),
  );
  const stability = stableSegments(points, holdStartEvent.t, release.t, thresholdDeg);
  const bestSegment = [...stability.segments].sort((a, b) => b.durationSec - a.durationSec)[0] ?? null;
  const plateauPitch = bestSegment?.medianPitchDeg ?? null;
  const preholdPitch = prehold?.medianPitchDeg ?? null;
  const rawExcursion =
    plateauPitch != null && preholdPitch != null ? plateauPitch - preholdPitch : null;
  const direction = rawExcursion == null || Math.abs(rawExcursion) < 0.001 ? null : Math.sign(rawExcursion);
  const holdStartPoint = pointsBetween(
    points,
    holdStartEvent.t,
    holdStartEvent.t + 250,
  )[0];
  const freshInhaleExcursion =
    direction != null && preholdPitch != null && holdStartPoint
      ? direction * (holdStartPoint.p - preholdPitch)
      : null;
  const freshInhaleEvidence =
    freshInhaleExcursion != null &&
    freshInhaleExcursion >= LAB_P0_ALGORITHM.params.minimumTargetExcursionDeg;
  const inhaleWindowStart = inhaleStart?.t ?? holdStartEvent.t;
  const excursionPoints = pointsBetween(points, inhaleWindowStart, release.t);
  let peak = null;
  if (direction != null && preholdPitch != null) {
    for (const point of excursionPoints) {
      const excursion = direction * (point.p - preholdPitch);
      if (!peak || excursion > peak.excursionDeg) peak = { t: point.t, excursionDeg: excursion };
    }
  }
  const issues = [];
  if (!prehold || prehold.sampleCount < 10) issues.push("insufficient_prehold_samples");
  if (!bestSegment) issues.push("no_stable_segment");
  if (rawExcursion == null || Math.abs(rawExcursion) < LAB_P0_ALGORITHM.params.minimumTargetExcursionDeg) {
    issues.push("excursion_too_small");
  }
  if (!freshInhaleEvidence) issues.push("insufficient_fresh_inhale");
  if (
    events.some(
      (event) =>
        event.type === "practice_hold_aborted" &&
        Number(event?.meta?.holdIndex) === holdIndex,
    )
  ) {
    issues.push("practice_hold_aborted");
  }

  return {
    index: holdIndex,
    role,
    valid: issues.length === 0,
    windows: {
      preholdStartMs: round(preholdStart?.t, 1),
      preholdEndMs: round(preholdEnd?.t, 1),
      inhaleStartMs: round(inhaleStart?.t, 1),
      holdStartMs: round(holdStartEvent.t, 1),
      releaseMs: round(release.t, 1),
      recoveryEndMs: round(recoveryEnd?.t, 1),
    },
    prehold,
    direction,
    rawExcursionDeg: round(rawExcursion),
    relativeExcursionDeg: round(rawExcursion == null ? null : Math.abs(rawExcursion)),
    freshInhaleExcursionAtHoldStartDeg: round(freshInhaleExcursion),
    freshInhaleEvidence,
    inhalePeakExcursionDeg: round(peak?.excursionDeg),
    timeFromInhaleToPeakSec: round(
      peak && inhaleStart ? (peak.t - inhaleStart.t) / 1000 : null,
    ),
    stabilityThresholdDeg: round(thresholdDeg),
    stabilitySlopeCeilingDegPerSec: LAB_P0_ALGORITHM.params.stableSlopeCeilingDegPerSec,
    firstLockFromHoldStartSec: round(
      stability.firstLockAtMs == null
        ? null
        : (stability.firstLockAtMs - holdStartEvent.t) / 1000,
    ),
    stableSegments: stability.segments,
    stateTransitions: stability.transitions,
    bestStableSegment: bestSegment,
    recoveryToPreholdMs: recoveryToPreholdMs(
      points,
      release.t,
      recoveryEnd?.t ?? release.t + 6000,
      preholdPitch,
      thresholdDeg,
    ),
    issues,
  };
}

function longestStableOnTargetRun(
  points,
  segments,
  preholdPitch,
  direction,
  targetExcursion,
  tolerance,
) {
  if (
    !Number.isFinite(preholdPitch) ||
    !Number.isFinite(direction) ||
    !Number.isFinite(targetExcursion) ||
    !Number.isFinite(tolerance)
  ) {
    return null;
  }
  let longestMs = 0;
  for (const segment of segments) {
    const segmentPoints = pointsBetween(points, segment.startMs, segment.endMs);
    let runStart = null;
    let previousT = null;
    for (const point of segmentPoints) {
      const signedExcursion = direction * (point.p - preholdPitch);
      const onTarget = Math.abs(signedExcursion - targetExcursion) <= tolerance;
      const sensorGap = previousT != null && point.t - previousT > LAB_P0_ALGORITHM.params.longGapMs;
      if (onTarget && !sensorGap) {
        runStart ??= point.t;
      } else {
        if (runStart != null && previousT != null) {
          longestMs = Math.max(longestMs, previousT - runStart);
        }
        runStart = onTarget ? point.t : null;
      }
      previousT = point.t;
    }
    if (runStart != null && previousT != null) {
      longestMs = Math.max(longestMs, previousT - runStart);
    }
  }
  return round(longestMs / 1000);
}

function sessionSummary(holds, points, requestedHoldSeconds, events) {
  const validHolds = holds.filter(
    (hold) => hold.valid && hold.bestStableSegment && hold.prehold,
  );
  const validLearnCandidates = validHolds.filter((hold) => hold.role === "learn");
  const directions = validLearnCandidates
    .map((hold) => hold.direction)
    .filter((value) => value != null);
  const directionSum = directions.reduce((sum, value) => sum + value, 0);
  const learnedDirection = directionSum === 0 ? null : Math.sign(directionSum);
  const directionConsistencyPct = directions.length
    ? (directions.filter((value) => value === learnedDirection).length / directions.length) * 100
    : null;
  const preholdPitches = validHolds.map((hold) => hold.prehold.medianPitchDeg);
  const plateauPitches = validHolds.map((hold) => hold.bestStableSegment.medianPitchDeg);
  const signedExcursions = validHolds
    .map((hold) =>
      learnedDirection == null
        ? null
        : learnedDirection *
          (hold.bestStableSegment.medianPitchDeg - hold.prehold.medianPitchDeg),
    )
    .filter((value) => value != null);
  const calibrationSelection =
    learnedDirection == null
      ? null
      : tightestCalibrationTrio(validLearnCandidates, learnedDirection);
  const calibrationAvailable = Boolean(
    calibrationSelection &&
      calibrationSelection.sd <= LAB_P0_ALGORITHM.params.calibrationExcursionSdCeilingDeg,
  );
  const learnHolds = calibrationAvailable ? calibrationSelection.holds : [];
  const learnPlateaus = learnHolds.map((hold) => hold.bestStableSegment.medianPitchDeg);
  const learnExcursions = learnHolds
    .map((hold) =>
      learnedDirection == null
        ? null
        : learnedDirection *
          (hold.bestStableSegment.medianPitchDeg - hold.prehold.medianPitchDeg),
    )
    .filter((value) => value != null);
  const withinHoldNoise = learnHolds
    .map((hold) => hold.bestStableSegment.robustSdDeg ?? hold.bestStableSegment.sdDeg)
    .filter((value) => value != null);
  const typicalNoise = median(withinHoldNoise);
  const trainingTolerance =
    calibrationAvailable && typicalNoise != null
      ? Math.min(
          LAB_P0_ALGORITHM.params.trainingToleranceCeilingDeg,
          Math.max(
            LAB_P0_ALGORITHM.params.trainingToleranceFloorDeg,
            typicalNoise * LAB_P0_ALGORITHM.params.trainingToleranceNoiseMultiplier,
          ),
        )
      : null;
  const targetPitch = calibrationAvailable ? median(learnPlateaus) : null;
  const targetExcursion = calibrationAvailable ? median(learnExcursions) : null;
  const practice = validHolds
    .filter((hold) => hold.role === "practice")
    .map((hold) => {
      const signedExcursion =
        learnedDirection == null
          ? null
          : learnedDirection *
            (hold.bestStableSegment.medianPitchDeg - hold.prehold.medianPitchDeg);
      const longestOnTargetRunSec = longestStableOnTargetRun(
        points,
        hold.stableSegments,
        hold.prehold.medianPitchDeg,
        learnedDirection,
        targetExcursion,
        trainingTolerance,
      );
      const coachingEvents = events.filter(
        (event) =>
          event.type === "coach_cue" && Number(event?.meta?.holdIndex) === hold.index,
      );
      const correctionEvents = coachingEvents.filter((event) =>
        ["go_deeper", "ease_back", "p0_deeper", "p0_ease_back"].includes(event?.meta?.cue),
      );
      const targetAcquired = events.find(
        (event) =>
          event.type === "target_acquired" && Number(event?.meta?.holdIndex) === hold.index,
      );
      const inhaleStartMs = hold.windows?.inhaleStartMs;
      return {
        index: hold.index,
        absoluteTargetErrorDeg: round(
          targetPitch == null ? null : hold.bestStableSegment.medianPitchDeg - targetPitch,
        ),
        excursionTargetErrorDeg: round(
          targetExcursion == null || signedExcursion == null
            ? null
            : signedExcursion - targetExcursion,
        ),
        insideExperimentalTrainingBand:
          targetExcursion == null || signedExcursion == null || trainingTolerance == null
            ? null
            : Math.abs(signedExcursion - targetExcursion) <= trainingTolerance,
        longestStableOnTargetRunSec: longestOnTargetRunSec,
        reachedRequestedDuration:
          longestOnTargetRunSec == null || !Number.isFinite(requestedHoldSeconds)
            ? null
            : longestOnTargetRunSec >= requestedHoldSeconds,
        targetAcquiredFromInhaleSec:
          targetAcquired && Number.isFinite(inhaleStartMs)
            ? round((targetAcquired.t - inhaleStartMs) / 1000)
            : null,
        coachingCueCount: coachingEvents.length,
        correctionCueCount: correctionEvents.length,
        coachingCues: coachingEvents.map((event) => ({
          t: round(event.t, 1),
          cue: event?.meta?.cue ?? null,
          reason: event?.meta?.reason ?? null,
          measuredExcursionDeg: round(Number(event?.meta?.measuredExcursionDeg)),
        })),
      };
    });

  const recoveryCompletedCount = validHolds.filter(
    (hold) => hold.recoveryToPreholdMs != null,
  ).length;
  const sequenceTrend = {
    interpretation: "descriptive_only_not_a_fatigue_diagnosis",
    preholdVariabilitySlopeDegPerHold: sequenceSlope(
      validHolds.map((hold) => hold.prehold.sdDeg),
    ),
    relativeExcursionSlopeDegPerHold: sequenceSlope(signedExcursions),
    timeToStableSlopeSecPerHold: sequenceSlope(
      validHolds.map((hold) => hold.firstLockFromHoldStartSec),
    ),
    stableDurationSlopeSecPerHold: sequenceSlope(
      validHolds.map((hold) => hold.bestStableSegment.durationSec),
    ),
    recoveryCompletedCount,
    recoveryObservedHoldCount: validHolds.length,
  };

  return {
    totalHoldCount: holds.length,
    validHoldCount: validHolds.length,
    learnedDirection,
    directionConsistencyPct: round(directionConsistencyPct, 1),
    preholdPoseSdDeg: round(standardDeviation(preholdPitches)),
    absolutePlateauSdDeg: round(standardDeviation(plateauPitches)),
    signedExcursionSdDeg: round(standardDeviation(signedExcursions)),
    medianPlateauRobustSdDeg: round(
      median(
        validHolds
          .map((hold) => hold.bestStableSegment.robustSdDeg)
          .filter((value) => value != null),
      ),
    ),
    learnedTarget: {
      available: calibrationAvailable,
      learnHoldCount: validLearnCandidates.length,
      selectedHoldIndexes: learnHolds.map((hold) => hold.index),
      method: "median_relative_excursion",
      targetPitchDeg: round(targetPitch),
      targetPitchUse: "diagnostic_only",
      targetSignedExcursionDeg: round(targetExcursion),
      observedLearnPlateauSdDeg: round(standardDeviation(learnPlateaus)),
      observedLearnExcursionSdDeg: round(calibrationSelection?.sd),
      calibrationExcursionSdCeilingDeg:
        LAB_P0_ALGORITHM.params.calibrationExcursionSdCeilingDeg,
      experimentalTrainingToleranceDeg: round(trainingTolerance),
    },
    practice,
    sequenceTrend,
  };
}

export function analyzeLabRecording(recording) {
  const points = signalPoints(recording);
  const events = Array.isArray(recording.events) ? recording.events : [];
  const baselineStart = events.find((event) => event.type === "baseline_start");
  const baselineEnd = events.find((event) => event.type === "baseline_end");
  const baselinePoints =
    baselineStart && baselineEnd
      ? pointsBetween(points, baselineStart.t + 2000, baselineEnd.t)
      : [];
  const baseline = summarizePoints(baselinePoints);
  const holdStarts = events.filter((event) => event.type === "hold_start");
  const holds = holdStarts.map((event, index) =>
    analyzeHold(points, events, event, index + 1, holdStarts.length, baseline),
  );
  const requestedHoldSeconds =
    typeof recording.protocol?.holdSeconds === "number"
      ? recording.protocol.holdSeconds
      : null;
  const summary = sessionSummary(holds, points, requestedHoldSeconds, events);
  const issues = [];
  const quality = sampleQuality(recording, points);
  if ((quality.effectiveSampleRateHz ?? 0) < 20) issues.push("low_sample_rate");
  if ((quality.betaCoveragePct ?? 0) < 95) issues.push("low_beta_coverage");
  if ((quality.longestGapMs ?? 0) > 250) issues.push("long_sensor_gap");
  if (!baseline || baseline.sampleCount < 30) issues.push("invalid_baseline");
  if ((summary.directionConsistencyPct ?? 100) < 80) issues.push("inconsistent_excursion_direction");
  for (const hold of holds) {
    for (const issue of hold.issues ?? []) issues.push(`hold_${hold.index}:${issue}`);
  }

  return {
    schema: ANALYSIS_SCHEMA,
    algorithm: LAB_P0_ALGORITHM,
    quality,
    baseline,
    holds,
    summary,
    valid: issues.length === 0,
    issues,
  };
}
