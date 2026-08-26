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
