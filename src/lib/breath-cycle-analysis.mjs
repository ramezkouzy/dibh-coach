const DEFAULTS = Object.freeze({
  requiredCycles: 3,
  smoothingRadius: 2,
  extremaRadius: 5,
  minimumPeakDistanceMs: 1400,
  minimumCycleMs: 1600,
  maximumCycleMs: 8000,
  minimumProminenceDeg: 0.3,
  maximumPeriodCv: 0.45,
  maximumAmplitudeCv: 0.6,
});

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function standardDeviation(values) {
  const center = mean(values);
  if (center == null || values.length < 2) return null;
  return Math.sqrt(values.reduce((sum, value) => sum + (value - center) ** 2, 0) / values.length);
}

function coefficientOfVariation(values) {
  const center = mean(values);
  const sd = standardDeviation(values);
  return center == null || sd == null || Math.abs(center) < 1e-6 ? null : sd / Math.abs(center);
}

function round(value, digits = 3) {
  return Number.isFinite(value) ? +value.toFixed(digits) : null;
}

function bucketAndSmooth(points, direction, startMs, smoothingRadius) {
  const buckets = new Map();
  for (const point of points) {
    if (!Number.isFinite(point?.t) || !Number.isFinite(point?.p) || point.t < startMs) continue;
    const bucket = Math.floor(point.t / 100) * 100;
    const current = buckets.get(bucket) ?? { sum: 0, count: 0 };
    current.sum += point.p;
    current.count += 1;
    buckets.set(bucket, current);
  }
  const binned = [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([t, value]) => ({ t, p: value.sum / value.count }));
  return binned.map((point, index) => {
    const neighbors = binned.slice(
      Math.max(0, index - smoothingRadius),
      Math.min(binned.length, index + smoothingRadius + 1),
    );
    const pitch = mean(neighbors.map((item) => item.p));
    return { t: point.t, p: pitch, x: direction * pitch };
  });
}

function localExtrema(points, radius, kind) {
  const candidates = [];
  for (let index = radius; index < points.length - radius; index++) {
    const point = points[index];
    const neighborhood = points.slice(index - radius, index + radius + 1);
    const isExtreme = neighborhood.every((other) =>
      kind === "max" ? point.x >= other.x : point.x <= other.x,
    );
    if (isExtreme) candidates.push(point);
  }
  return candidates;
}

function separatedPeaks(candidates, minimumDistanceMs) {
  const peaks = [];
  for (const candidate of candidates) {
    const previous = peaks.at(-1);
    if (!previous || candidate.t - previous.t >= minimumDistanceMs) {
      peaks.push(candidate);
    } else if (candidate.x > previous.x) {
      peaks[peaks.length - 1] = candidate;
    }
  }
  return peaks;
}

function minimumBetween(points, startMs, endMs) {
  let result = null;
  for (const point of points) {
    if (point.t < startMs || point.t > endMs) continue;
    if (!result || point.x < result.x) result = point;
  }
  return result;
}

function linearSlopePerMinute(points) {
  if (points.length < 2) return null;
  const timeOrigin = points[0].t;
  const xs = points.map((point) => (point.t - timeOrigin) / 60000);
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

/**
 * Summarize a normal-breathing placement recording without applying any
 * calibration or coaching thresholds. The first few seconds are intentionally
 * excluded so moving the hand away from the phone does not inflate amplitude.
 */
export function analyzePositionSignal(inputPoints, options = {}) {
  const direction = options.direction === 1 ? 1 : -1;
  const requestedStartMs = Number.isFinite(options.startMs) ? options.startMs : 0;
  const settlingMs = Number.isFinite(options.settlingMs) ? options.settlingMs : 3000;
  const startMs = requestedStartMs + Math.max(0, settlingMs);
  const endMs = Number.isFinite(options.endMs) ? options.endMs : Infinity;
  const smoothingRadius = Number.isFinite(options.smoothingRadius)
    ? Math.max(1, options.smoothingRadius)
    : 3;

  const buckets = new Map();
  for (const point of inputPoints) {
    if (
      !Number.isFinite(point?.t) ||
      !Number.isFinite(point?.p) ||
      point.t < startMs ||
      point.t > endMs
    ) {
      continue;
    }
    const bucket = Math.floor(point.t / 100) * 100;
    const current = buckets.get(bucket) ?? { sum: 0, count: 0 };
    current.sum += point.p;
    current.count += 1;
    buckets.set(bucket, current);
  }
  const binned = [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([t, value]) => ({ t, p: value.sum / value.count }));
  const durationSec = binned.length > 1 ? (binned.at(-1).t - binned[0].t) / 1000 : 0;

  if (binned.length < 40) {
    return {
      enoughData: false,
      analyzedDurationSec: round(durationSec, 1),
      settlingSecondsExcluded: round(settlingMs / 1000, 1),
      usableCycleCount: 0,
      medianPeakToTroughAmplitudeDeg: null,
      amplitudeCv: null,
      medianCyclePeriodSec: null,
      cyclePeriodCv: null,
      estimatedBreathsPerMinute: null,
      noiseRobustSdDeg: null,
      noiseFloorDeg: 0.02,
      amplitudeToNoiseRatio: null,
      driftDegPerMinute: null,
      direction,
    };
  }

  const smoothed = binned.map((point, index) => {
    const neighbors = binned.slice(
      Math.max(0, index - smoothingRadius),
      Math.min(binned.length, index + smoothingRadius + 1),
    );
    const p = mean(neighbors.map((item) => item.p));
    return { t: point.t, p, x: direction * p };
  });
  const peaks = separatedPeaks(localExtrema(smoothed, 4, "max"), 1400);
  const amplitudes = [];
  const periods = [];

  for (let index = 0; index < peaks.length - 1; index++) {
    const first = peaks[index];
    const second = peaks[index + 1];
    const period = second.t - first.t;
    if (period < 1500 || period > 8000) continue;
    const trough = minimumBetween(smoothed, first.t, second.t);
    if (!trough) continue;
    const amplitude = (first.x + second.x) / 2 - trough.x;
    if (amplitude < 0.05) continue;
    amplitudes.push(amplitude);
    periods.push(period);
  }

  const residuals = binned.map((point, index) => point.p - smoothed[index].p);
  const residualCenter = median(residuals) ?? 0;
  const noiseRobustSd = (median(residuals.map((value) => Math.abs(value - residualCenter))) ?? 0) * 1.4826;
  const medianAmplitude = median(amplitudes);
  const medianPeriod = median(periods);
  const amplitudeToNoise =
    medianAmplitude == null ? null : medianAmplitude / Math.max(noiseRobustSd, 0.02);

  return {
    enoughData: durationSec >= 15 && amplitudes.length >= 3,
    analyzedDurationSec: round(durationSec, 1),
    settlingSecondsExcluded: round(settlingMs / 1000, 1),
    usableCycleCount: amplitudes.length,
    medianPeakToTroughAmplitudeDeg: round(medianAmplitude),
    amplitudeCv: round(coefficientOfVariation(amplitudes)),
    medianCyclePeriodSec: medianPeriod == null ? null : round(medianPeriod / 1000),
    cyclePeriodCv: round(coefficientOfVariation(periods)),
    estimatedBreathsPerMinute:
      medianPeriod == null || medianPeriod <= 0 ? null : round(60000 / medianPeriod, 1),
    noiseRobustSdDeg: round(noiseRobustSd),
    noiseFloorDeg: 0.02,
    amplitudeToNoiseRatio: round(amplitudeToNoise, 1),
    driftDegPerMinute: round(linearSlopePerMinute(smoothed)),
    direction,
  };
}

export function detectRegularBreathingCycles(inputPoints, options = {}) {
  const params = { ...DEFAULTS, ...options };
  const direction = options.direction === 1 ? 1 : -1;
  const startMs = Number.isFinite(options.startMs) ? options.startMs : 0;
  const points = bucketAndSmooth(inputPoints, direction, startMs, params.smoothingRadius);
  if (points.length < 40) return { ready: false, qualifiedPeakCount: 0 };

  const peakCandidates = separatedPeaks(
    localExtrema(points, params.extremaRadius, "max"),
    params.minimumPeakDistanceMs,
  );
  const needed = params.requiredCycles;
  let bestQualifiedPeakCount = 0;

  for (let first = peakCandidates.length - needed; first >= 0; first--) {
    const peaks = peakCandidates.slice(first, first + needed);
    if (peaks.length < needed) continue;
    const periods = peaks.slice(1).map((peak, index) => peak.t - peaks[index].t);
    if (periods.some((period) => period < params.minimumCycleMs || period > params.maximumCycleMs)) {
      continue;
    }

    const boundaries = [];
    const firstPeriod = periods[0] ?? 3500;
    boundaries.push(
      minimumBetween(points, Math.max(startMs, peaks[0].t - firstPeriod), peaks[0].t),
    );
    for (let index = 0; index < peaks.length - 1; index++) {
      boundaries.push(minimumBetween(points, peaks[index].t, peaks[index + 1].t));
    }
    const finalPeriod = periods.at(-1) ?? firstPeriod;
    boundaries.push(
      minimumBetween(points, peaks.at(-1).t, peaks.at(-1).t + finalPeriod),
    );
    const completeBoundaries = boundaries.filter(Boolean);
    bestQualifiedPeakCount = Math.max(bestQualifiedPeakCount, Math.min(needed, completeBoundaries.length - 1));
    if (completeBoundaries.length !== needed + 1) continue;

    const amplitudes = peaks.map(
      (peak, index) => peak.x - (boundaries[index].x + boundaries[index + 1].x) / 2,
    );
    if (amplitudes.some((amplitude) => amplitude < params.minimumProminenceDeg)) continue;
    const periodCv = coefficientOfVariation(periods);
    const amplitudeCv = coefficientOfVariation(amplitudes);
    if (periodCv != null && periodCv > params.maximumPeriodCv) continue;
    if (amplitudeCv != null && amplitudeCv > params.maximumAmplitudeCv) continue;

    return {
      ready: true,
      qualifiedPeakCount: needed,
      windowStartMs: boundaries[0].t,
      windowEndMs: boundaries.at(-1).t,
      direction,
      peaks: peaks.map((peak) => ({ t: peak.t, pitchDeg: round(peak.p) })),
      troughs: boundaries.map((trough) => ({ t: trough.t, pitchDeg: round(trough.p) })),
      meanInspiratoryPeakPitchDeg: round(mean(peaks.map((peak) => peak.p))),
      meanCyclePeriodSec: round(mean(periods) / 1000),
      cyclePeriodCv: round(periodCv),
      meanAmplitudeDeg: round(mean(amplitudes)),
      amplitudeCv: round(amplitudeCv),
    };
  }

  return {
    ready: false,
    qualifiedPeakCount: Math.min(needed - 1, bestQualifiedPeakCount),
  };
}

export const BREATH_CYCLE_DEFAULTS = DEFAULTS;
