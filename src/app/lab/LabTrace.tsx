"use client";

import { useMemo } from "react";

type TraceEvent = {
  t: number;
  type: string;
  meta?: Record<string, unknown>;
};

type TraceSegment = {
  startMs: number;
  endMs: number;
  durationSec: number;
  medianPitchDeg?: number | null;
  sdDeg?: number | null;
  robustSdDeg?: number | null;
  slopeDegPerSec?: number | null;
};

type TraceHold = {
  index: number;
  role: "learn" | "calibration" | "practice" | "observation";
  valid: boolean;
  direction?: number | null;
  localAnchorPitchDeg?: number | null;
  normalPeakPitchesDeg?: number[];
  calibrationDeltaDeg?: number | null;
  withinHoldRobustSdDeg?: number | null;
  holdDurationSec?: number | null;
  relativeExcursionDeg?: number | null;
  firstLockFromHoldStartSec?: number | null;
  recoveryToPreholdMs?: number | null;
  prehold?: {
    medianPitchDeg?: number | null;
    sdDeg?: number | null;
  } | null;
  windows?: {
    preholdStartMs?: number | null;
    preholdEndMs?: number | null;
    inhaleStartMs?: number | null;
    holdStartMs?: number | null;
    releaseMs?: number | null;
    recoveryEndMs?: number | null;
  };
  stableSegments?: TraceSegment[];
  bestStableSegment?: TraceSegment | null;
};

type TracePractice = {
  index: number;
  excursionTargetErrorDeg?: number | null;
  insideExperimentalTrainingBand?: boolean | null;
  longestStableOnTargetRunSec?: number | null;
  targetAcquiredFromInhaleSec?: number | null;
  coachingCueCount?: number;
  correctionCueCount?: number;
  successfulCorrectionCount?: number;
  timeInTargetRangeSec?: number | null;
  percentInTargetRange?: number | null;
  holdCompleted?: boolean;
  abortedAfterTwoCorrections?: boolean;
};

export type TraceRecording = {
  scenario?: string;
  durationSec: number;
  channels: string[];
  samples: Array<Array<number | null>>;
  events: TraceEvent[];
  analysis: {
    quality?: {
      effectiveSampleRateHz?: number | null;
      longestGapMs?: number | null;
    };
    holds: TraceHold[];
    summary: {
      validHoldCount?: number;
      totalHoldCount?: number;
      learnedDirection?: number | null;
      signedExcursionSdDeg?: number | null;
      learnedTarget?: {
        available?: boolean;
        method?: string;
        learnHoldCount?: number;
        selectedHoldIndexes?: number[];
        targetSignedExcursionDeg?: number | null;
        observedLearnExcursionSdDeg?: number | null;
        calibrationDeltasDeg?: number[];
        betweenHoldDeltaSdDeg?: number | null;
        pooledWithinHoldSdDeg?: number | null;
        combinedSdDeg?: number | null;
        calibrationExcursionSdCeilingDeg?: number | null;
        experimentalTrainingToleranceDeg?: number | null;
      };
      practice?: TracePractice[];
      sequenceTrend?: {
        preholdVariabilitySlopeDegPerHold?: number | null;
        relativeExcursionSlopeDegPerHold?: number | null;
        timeToStableSlopeSecPerHold?: number | null;
        stableDurationSlopeSecPerHold?: number | null;
      };
    };
  };
};

type Point = { t: number; p: number };

const FULL_WIDTH = 1000;
const FULL_HEIGHT = 430;
const ALIGNED_HEIGHT = 300;
const FULL_MARGIN = { left: 58, right: 18, top: 118, bottom: 42 };
const ALIGNED_MARGIN = { left: 58, right: 18, top: 34, bottom: 42 };

export default function LabTrace({ recording }: { recording: TraceRecording }) {
  const model = useMemo(() => buildTraceModel(recording), [recording]);
  const summary = recording.analysis.summary;
  const target = summary.learnedTarget;
  const practiceByIndex = new Map((summary.practice ?? []).map((item) => [item.index, item]));

  if (!model.points.length) {
    return <p className="text-xs opacity-70">This JSON does not contain a usable pitch trace.</p>;
  }

  return (
    <section className="flex flex-col gap-4" aria-label="Breath-hold trace analysis">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <TraceStat
          label="quality-valid holds"
          value={`${summary.validHoldCount ?? 0}/${summary.totalHoldCount ?? 0}`}
        />
        <TraceStat
          label="target delta"
          value={formatDeg(target?.targetSignedExcursionDeg)}
        />
        <TraceStat label="excursion variation" value={formatDeg(summary.signedExcursionSdDeg)} />
        <TraceStat
          label="sample rate"
          value={`${recording.analysis.quality?.effectiveSampleRateHz ?? "—"} Hz`}
        />
      </div>

      {target?.method === "local_three_peak_delta_mean_combined_sd" && (
        <div
          className="rounded-md p-3 text-xs leading-relaxed"
          style={{ background: "#0d2b1a", border: "1px solid #15803d", color: "#bbf7d0" }}
        >
          <div className="font-semibold">Local three-cycle calibration</div>
          <div className="mt-1 opacity-90">
            Deltas: {(target.calibrationDeltasDeg ?? []).map((value) => `${value.toFixed(2)}°`).join(" · ") || "collecting"}.
            {" "}Mean target {formatDeg(target.targetSignedExcursionDeg)} with a ±{formatDeg(target.experimentalTrainingToleranceDeg)} band.
            {" "}Between-hold SD {formatDeg(target.betweenHoldDeltaSdDeg)}; within-hold SD {formatDeg(target.pooledWithinHoldSdDeg)}.
          </div>
        </div>
      )}

      {recording.scenario?.includes("observation") && (
        <div
          className="rounded-md p-3 text-xs leading-relaxed"
          style={{ background: "#0c2d48", border: "1px solid #0369a1", color: "#bae6fd" }}
        >
          <div className="font-semibold">All three cycles were recorded unconditionally</div>
          <div className="mt-1 opacity-90">
            “Quality-valid” is post-run description only. Visible movement may still fail
            that label when it is less than 1.5° from the preceding quiet window, never
            settles into a stable plateau, or begins from a moving baseline. The full trace
            remains available either way.
          </div>
        </div>
      )}

      {target && !target.available && (target.learnHoldCount ?? 0) >= 3 && (
        <div
          className="rounded-md p-3 text-xs leading-relaxed"
          style={{ background: "#3a2208", border: "1px solid #92400e", color: "#fde68a" }}
        >
          <div className="font-semibold">Calibration range not established</div>
          <div className="mt-1 opacity-90">
            The best calibration trio varied by {formatDeg(target.observedLearnExcursionSdDeg)};
            this Lab version requires ≤ {formatDeg(target.calibrationExcursionSdCeilingDeg)}.
            Practice attempts from this recording are shown for diagnosis but are not scored
            against a valid target.
          </div>
        </div>
      )}

      <div>
        <div className="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-[10px] uppercase tracking-wider opacity-70">
          <Legend color="#64748b" label="relax / recovery" />
          <Legend color="#38bdf8" label="inhale" />
          <Legend color="#a78bfa" label="hold" />
          <Legend color="#22c55e" label="stable" />
          <Legend color="#86efac" label="local breathing peak" />
          <Legend color="#f59e0b" label="target band" />
          <Legend color="#fb7185" label="prerecorded prompt" />
        </div>
        <svg
          viewBox={`0 0 ${FULL_WIDTH} ${FULL_HEIGHT}`}
          className="block w-full rounded-md"
          style={{ background: "#0a0c10", border: "1px solid #303441" }}
          role="img"
          aria-labelledby="full-trace-title full-trace-desc"
        >
          <title id="full-trace-title">Session prompts and breath-hold timeline</title>
          <desc id="full-trace-desc">
            Direction-normalized phone motion over the full recording, with every prerecorded
            prompt trigger, breathing phase, hold, stable segment, and practice target band.
          </desc>
          <ChartGrid model={model.fullChart} xUnit="s" yUnit="°" />
          {model.phases.map((phase, index) => (
            <rect
              key={`${phase.kind}-${index}`}
              x={model.fullChart.x(phase.startMs)}
              y={FULL_MARGIN.top}
              width={Math.max(1, model.fullChart.x(phase.endMs) - model.fullChart.x(phase.startMs))}
              height={FULL_HEIGHT - FULL_MARGIN.top - FULL_MARGIN.bottom}
              fill={phaseColor(phase.kind)}
              opacity={phase.kind === "hold" ? 0.1 : 0.07}
            />
          ))}
          {model.targetBands.map((band) => {
            const yTop = model.fullChart.y(Math.max(band.lowPitch, band.highPitch));
            const yBottom = model.fullChart.y(Math.min(band.lowPitch, band.highPitch));
            return (
              <rect
                key={`target-${band.index}`}
                x={model.fullChart.x(band.startMs)}
                y={yTop}
                width={Math.max(1, model.fullChart.x(band.endMs) - model.fullChart.x(band.startMs))}
                height={Math.max(2, yBottom - yTop)}
                fill="#f59e0b"
                opacity="0.18"
              >
                <title>{`Practice ${band.index} target ±${band.tolerance.toFixed(2)}°`}</title>
              </rect>
            );
          })}
          <path d={model.fullPath} fill="none" stroke="#e7e5e4" strokeWidth="1.5" />
          {model.localBreathingPeaks.map((peak) => (
            <circle
              key={`local-peak-${peak.holdIndex}-${peak.peakNumber}-${peak.t}`}
              cx={model.fullChart.x(peak.t)}
              cy={model.fullChart.y(peak.p)}
              r="4"
              fill="#22c55e"
              stroke="#bbf7d0"
              strokeWidth="1.2"
            >
              <title>{`Hold ${peak.holdIndex} local breathing peak ${peak.peakNumber}`}</title>
            </circle>
          ))}
          {model.stablePaths.map((segment) => (
            <path
              key={segment.key}
              d={segment.path}
              fill="none"
              stroke="#22c55e"
              strokeWidth="3"
            >
              <title>{segment.label}</title>
            </path>
          ))}
          {model.coachingEvents.map((event, index) => (
            <g key={`${event.t}-${String(event.meta?.cue ?? "cue")}`}>
              <line
                x1={model.fullChart.x(event.t)}
                x2={model.fullChart.x(event.t)}
                y1={promptLaneY(index) + 5}
                y2={FULL_HEIGHT - FULL_MARGIN.bottom}
                stroke="#fb7185"
                strokeWidth="1"
                strokeDasharray="4 4"
              />
              <circle
                cx={model.fullChart.x(event.t)}
                cy={promptLaneY(index)}
                r="3.5"
                fill="#fb7185"
              >
                <title>{coachLabel(event)}</title>
              </circle>
              <text
                x={model.fullChart.x(event.t)}
                y={promptLaneY(index) - 6}
                textAnchor="middle"
                fill="#fda4af"
                fontSize="9"
              >
                {promptLabel(event)}
              </text>
            </g>
          ))}
          {recording.analysis.holds.map((hold) => {
            const start = hold.windows?.holdStartMs;
            if (!Number.isFinite(start)) return null;
            return (
              <text
                key={`hold-label-${hold.index}`}
                x={model.fullChart.x(start as number) + 5}
                y={FULL_HEIGHT - FULL_MARGIN.bottom - 8}
                fill="#e7e5e4"
                fontSize="12"
              >
                {holdRoleCode(hold.role)}{hold.index}
              </text>
            );
          })}
        </svg>
      </div>

      <div>
        <div className="mb-2 text-xs font-semibold">
          Breath shape by hold — inhale rises, release falls toward zero
        </div>
        <svg
          viewBox={`0 0 ${FULL_WIDTH} ${ALIGNED_HEIGHT}`}
          className="block w-full rounded-md"
          style={{ background: "#0a0c10", border: "1px solid #303441" }}
          role="img"
          aria-labelledby="aligned-title aligned-desc"
        >
          <title id="aligned-title">Relative excursion comparison across holds</title>
          <desc id="aligned-desc">
            Every hold is normalized to its own relaxed position and direction. Inhalation rises,
            holding remains elevated, and exhalation after release falls toward zero.
          </desc>
          <ChartGrid model={model.alignedChart} xUnit="s" yUnit="°" height={ALIGNED_HEIGHT} />
          {target?.available && Number.isFinite(target.targetSignedExcursionDeg) &&
            Number.isFinite(target.experimentalTrainingToleranceDeg) && (() => {
              const targetValue = target.targetSignedExcursionDeg as number;
              const tolerance = target.experimentalTrainingToleranceDeg as number;
              const top = model.alignedChart.y(targetValue + tolerance);
              const bottom = model.alignedChart.y(targetValue - tolerance);
              return (
                <rect
                  x={ALIGNED_MARGIN.left}
                  y={top}
                  width={FULL_WIDTH - ALIGNED_MARGIN.left - ALIGNED_MARGIN.right}
                  height={Math.max(2, bottom - top)}
                  fill="#f59e0b"
                  opacity="0.16"
                >
                  <title>{`Learned excursion ${targetValue.toFixed(2)}° ±${tolerance.toFixed(2)}°`}</title>
                </rect>
              );
            })()}
          {model.alignedPhaseMarkers.map((marker) => (
            <g key={`phase-marker-${marker.label}`}>
              <line
                x1={model.alignedChart.x(marker.t)}
                x2={model.alignedChart.x(marker.t)}
                y1={ALIGNED_MARGIN.top}
                y2={ALIGNED_HEIGHT - ALIGNED_MARGIN.bottom}
                stroke={marker.color}
                strokeWidth="1.2"
                strokeDasharray="5 4"
              />
              <text
                x={model.alignedChart.x(marker.t) + 4}
                y={ALIGNED_MARGIN.top + 12}
                fill={marker.color}
                fontSize="10"
              >
                {marker.label}
              </text>
            </g>
          ))}
          {model.alignedLines.map((line) => (
            <g key={`aligned-${line.index}`}>
              <path
                d={line.path}
                fill="none"
                stroke={line.role === "practice" ? "#a78bfa" : "#38bdf8"}
                strokeWidth={line.role === "practice" ? "2.4" : "1.7"}
                strokeDasharray={line.role === "practice" ? "7 4" : undefined}
                opacity={line.valid ? 0.9 : 0.45}
              >
                <title>{`${holdRoleLabel(line.role)} hold ${line.index}`}</title>
              </path>
              <text
                x={Math.min(FULL_WIDTH - ALIGNED_MARGIN.right - 18, line.endX + 4)}
                y={line.endY}
                fill={line.role === "practice" ? "#a78bfa" : "#38bdf8"}
                fontSize="12"
              >
                {holdRoleCode(line.role)}{line.index}
              </text>
            </g>
          ))}
        </svg>
      </div>

      <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-2">
        {recording.analysis.holds.map((hold) => {
          const practice = practiceByIndex.get(hold.index);
          return (
            <div
              key={`hold-${hold.index}`}
              className="rounded-md p-3 text-xs"
              style={{ background: "#1c1f26", border: "1px solid #303441" }}
            >
              <div className="mb-2 flex items-center justify-between">
                <span className="font-semibold">
                  {holdRoleLabel(hold.role)} {hold.index}
                </span>
                <span className="opacity-60">{hold.valid ? "valid" : "review"}</span>
              </div>
              <MetricRow
                label={hold.role === "calibration" || hold.localAnchorPitchDeg != null ? "local delta" : "relative excursion"}
                value={formatDeg(hold.calibrationDeltaDeg ?? hold.relativeExcursionDeg)}
              />
              <MetricRow
                label="time to stable"
                value={formatSeconds(hold.firstLockFromHoldStartSec)}
              />
              <MetricRow
                label="longest stable"
                value={formatSeconds(hold.bestStableSegment?.durationSec)}
              />
              <MetricRow
                label="hold variability"
                value={formatDeg(hold.withinHoldRobustSdDeg ?? hold.bestStableSegment?.robustSdDeg ?? hold.bestStableSegment?.sdDeg)}
              />
              <MetricRow label="timed hold" value={formatSeconds(hold.holdDurationSec)} />
              <MetricRow label="rest variability" value={formatDeg(hold.prehold?.sdDeg)} />
              <MetricRow
                label="recovery"
                value={
                  hold.recoveryToPreholdMs == null
                    ? "not observed"
                    : `${(hold.recoveryToPreholdMs / 1000).toFixed(1)}s`
                }
              />
              {practice && (
                <>
                  <div className="my-2 border-t" style={{ borderColor: "#303441" }} />
                  <MetricRow label="target error" value={formatSignedDeg(practice.excursionTargetErrorDeg)} />
                  <MetricRow
                    label="target acquisition"
                    value={formatSeconds(practice.targetAcquiredFromInhaleSec)}
                  />
                  <MetricRow
                    label="longest beam-on"
                    value={formatSeconds(practice.longestStableOnTargetRunSec)}
                  />
                  <MetricRow
                    label="time in range"
                    value={
                      practice.percentInTargetRange == null
                        ? "—"
                        : `${practice.timeInTargetRangeSec?.toFixed(1) ?? "—"}s · ${practice.percentInTargetRange.toFixed(0)}%`
                    }
                  />
                  <MetricRow label="audio cues" value={`${practice.coachingCueCount ?? 0}`} />
                  <MetricRow label="direction corrections" value={`${practice.correctionCueCount ?? 0}`} />
                  <MetricRow label="successful corrections" value={`${practice.successfulCorrectionCount ?? 0}`} />
                  <MetricRow
                    label="outcome"
                    value={practice.abortedAfterTwoCorrections ? "aborted" : practice.holdCompleted ? "10s complete" : "review"}
                  />
                </>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function buildTraceModel(recording: TraceRecording) {
  const timeIndex = recording.channels.indexOf("t");
  const emaIndex = recording.channels.indexOf("betaEma");
  const betaIndex = recording.channels.indexOf("beta");
  const signalIndex = emaIndex >= 0 ? emaIndex : betaIndex;
  const points = recording.samples
    .map((row) => ({ t: row[timeIndex], p: row[signalIndex] }))
    .filter((point): point is Point => Number.isFinite(point.t) && Number.isFinite(point.p))
    .sort((a, b) => a.t - b.t);
  const directionCandidate =
    recording.analysis.summary.learnedDirection ??
    recording.analysis.holds.find((hold) => hold.valid && Number.isFinite(hold.direction))?.direction ??
    recording.analysis.holds.find((hold) => Number.isFinite(hold.direction))?.direction;
  const displayDirection = Number.isFinite(directionCandidate)
    ? Math.sign(directionCandidate as number) || 1
    : 1;
  const displayPoints = points.map((point) => ({ ...point, p: displayDirection * point.p }));
  const sampled = downsample(displayPoints, 1100);
  const durationMs = Math.max(recording.durationSec * 1000, points.at(-1)?.t ?? 0, 1);
  const pitchValues = displayPoints.map((point) => point.p);
  const pitchMin = Math.min(...pitchValues);
  const pitchMax = Math.max(...pitchValues);
  const pitchPad = Math.max(0.5, (pitchMax - pitchMin) * 0.08);
  const fullChart = chartScale(
    0,
    durationMs,
    pitchMin - pitchPad,
    pitchMax + pitchPad,
    FULL_HEIGHT,
    FULL_MARGIN,
  );
  const recordedPhases = guidedPhases(recording.events, durationMs);
  const phases = recordedPhases.length
    ? recordedPhases
    : recording.analysis.holds.flatMap((hold) => {
        const windows = hold.windows ?? {};
        return [
          phase("relax", windows.preholdStartMs, windows.preholdEndMs),
          phase("inhale", windows.inhaleStartMs, windows.holdStartMs),
          phase("hold", windows.holdStartMs, windows.releaseMs),
          phase("recovery", windows.releaseMs, windows.recoveryEndMs),
        ].filter((item): item is { kind: string; startMs: number; endMs: number } => item != null);
      });
  const learned = recording.analysis.summary.learnedTarget;
  const learnedDirection = recording.analysis.summary.learnedDirection;
  const targetBands = recording.analysis.holds
    .filter(
      (hold) =>
        hold.role === "practice" &&
        (hold.localAnchorPitchDeg != null || hold.prehold?.medianPitchDeg != null) &&
        Number.isFinite(learnedDirection) &&
        Number.isFinite(learned?.targetSignedExcursionDeg) &&
        Number.isFinite(learned?.experimentalTrainingToleranceDeg),
    )
    .map((hold) => {
      const anchor = (hold.localAnchorPitchDeg ?? hold.prehold?.medianPitchDeg) as number;
      const direction = learnedDirection as number;
      const target = learned?.targetSignedExcursionDeg as number;
      const tolerance = learned?.experimentalTrainingToleranceDeg as number;
      return {
        index: hold.index,
        startMs: hold.windows?.inhaleStartMs ?? 0,
        endMs: hold.windows?.releaseMs ?? 0,
        lowPitch: displayDirection * (anchor + direction * (target - tolerance)),
        highPitch: displayDirection * (anchor + direction * (target + tolerance)),
        tolerance,
      };
    });
  const localBreathingPeaks = recording.events.flatMap((event) => {
    if (event.type !== "breathing_cycles_qualified") return [];
    const times = Array.isArray(event.meta?.peakTimesMs) ? event.meta.peakTimesMs.map(Number) : [];
    const pitches = Array.isArray(event.meta?.peakPitchesDeg)
      ? event.meta.peakPitchesDeg.map(Number)
      : [];
    return times.flatMap((time, index) =>
      Number.isFinite(time) && Number.isFinite(pitches[index])
        ? [{
            t: time,
            p: displayDirection * pitches[index],
            holdIndex: Number(event.meta?.holdIndex),
            peakNumber: index + 1,
          }]
        : [],
    );
  });
  const stablePaths = recording.analysis.holds.flatMap((hold) =>
    (hold.stableSegments ?? []).map((segment, index) => {
      const segmentPoints = downsample(
        displayPoints.filter((point) => point.t >= segment.startMs && point.t <= segment.endMs),
        250,
      );
      return {
        key: `${hold.index}-${index}`,
        path: linePath(segmentPoints, fullChart.x, fullChart.y),
        label: `Hold ${hold.index}: ${segment.durationSec.toFixed(1)}s stable`,
      };
    }),
  );
  const alignedSeries = recording.analysis.holds
    .map((hold) => {
      const start = hold.windows?.inhaleStartMs;
      const holdStart = hold.windows?.holdStartMs;
      const release = hold.windows?.releaseMs;
      const recoveryEnd = hold.windows?.recoveryEndMs;
      const anchor = hold.localAnchorPitchDeg ?? hold.prehold?.medianPitchDeg;
      const direction = hold.direction ?? learnedDirection;
      if (![start, release, anchor, direction].every(Number.isFinite)) return null;
      const seriesStart = Math.max(
        hold.windows?.preholdStartMs ?? (start as number) - 2000,
        (start as number) - 2500,
      );
      const seriesEnd = Math.min(
        Number.isFinite(recoveryEnd) ? (recoveryEnd as number) : (release as number) + 5000,
        (release as number) + 5000,
      );
      const series = points
        .filter((point) => point.t >= seriesStart && point.t <= seriesEnd)
        .map((point) => ({
          t: (point.t - (start as number)) / 1000,
          p: (direction as number) * (point.p - (anchor as number)),
        }));
      return {
        hold,
        points: downsample(series, 520),
        holdStartT: Number.isFinite(holdStart)
          ? ((holdStart as number) - (start as number)) / 1000
          : null,
        releaseT: ((release as number) - (start as number)) / 1000,
      };
    })
    .filter(
      (item): item is {
        hold: TraceHold;
        points: Point[];
        holdStartT: number | null;
        releaseT: number;
      } => item != null && item.points.length > 0,
    );
  const alignedValues = alignedSeries.flatMap((item) => item.points.map((point) => point.p));
  if (Number.isFinite(learned?.targetSignedExcursionDeg)) {
    alignedValues.push(learned?.targetSignedExcursionDeg as number);
  }
  const alignedMinT = Math.min(0, ...alignedSeries.flatMap((item) => item.points.map((point) => point.t)));
  const alignedMaxT = Math.max(1, ...alignedSeries.flatMap((item) => item.points.map((point) => point.t)));
  const alignedMin = Math.min(0, ...alignedValues);
  const alignedMax = Math.max(1, ...alignedValues);
  const alignedPad = Math.max(0.5, (alignedMax - alignedMin) * 0.1);
  const alignedChart = chartScale(
    alignedMinT,
    alignedMaxT,
    alignedMin - alignedPad,
    alignedMax + alignedPad,
    ALIGNED_HEIGHT,
    ALIGNED_MARGIN,
  );
  const alignedLines = alignedSeries.map(({ hold, points: series }) => {
    const last = series.at(-1) as Point;
    return {
      index: hold.index,
      role: hold.role,
      valid: hold.valid,
      path: linePath(series, alignedChart.x, alignedChart.y),
      endX: alignedChart.x(last.t),
      endY: alignedChart.y(last.p),
    };
  });
  const alignedPhaseMarkers = [
    { t: 0, label: "INHALE", color: "#38bdf8" },
    {
      t: medianNumber(alignedSeries.map((item) => item.holdStartT)),
      label: "HOLD",
      color: "#a78bfa",
    },
    {
      t: medianNumber(alignedSeries.map((item) => item.releaseT)),
      label: "RELEASE",
      color: "#fb7185",
    },
  ].filter((marker): marker is { t: number; label: string; color: string } => Number.isFinite(marker.t));
  return {
    points,
    fullChart,
    fullPath: linePath(sampled, fullChart.x, fullChart.y),
    phases,
    targetBands,
    localBreathingPeaks,
    stablePaths,
    alignedChart,
    alignedLines,
    alignedPhaseMarkers,
    coachingEvents: recording.events.filter((event) => event.type === "coach_cue"),
  };
}

function chartScale(
  xMin: number,
  xMax: number,
  yMin: number,
  yMax: number,
  height: number,
  margin: { left: number; right: number; top: number; bottom: number },
) {
  const plotWidth = FULL_WIDTH - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;
  return {
    xMin,
    xMax,
    yMin,
    yMax,
    height,
    margin,
    x: (value: number) => margin.left + ((value - xMin) / Math.max(0.001, xMax - xMin)) * plotWidth,
    y: (value: number) => margin.top + ((yMax - value) / Math.max(0.001, yMax - yMin)) * plotHeight,
  };
}

function ChartGrid({
  model,
  xUnit,
  yUnit,
  height = FULL_HEIGHT,
}: {
  model: ReturnType<typeof chartScale>;
  xUnit: string;
  yUnit: string;
  height?: number;
}) {
  const xTicks = tickValues(model.xMin, model.xMax, 6);
  const yTicks = tickValues(model.yMin, model.yMax, 5);
  const { margin } = model;
  return (
    <g aria-hidden="true">
      {yTicks.map((tick) => (
        <g key={`y-${tick}`}>
          <line
            x1={margin.left}
            x2={FULL_WIDTH - margin.right}
            y1={model.y(tick)}
            y2={model.y(tick)}
            stroke="#303441"
            strokeWidth="1"
          />
          <text x={margin.left - 8} y={model.y(tick) + 4} textAnchor="end" fill="#a8a29e" fontSize="11">
            {tick.toFixed(1)}{yUnit}
          </text>
        </g>
      ))}
      {xTicks.map((tick) => (
        <g key={`x-${tick}`}>
          <line
            x1={model.x(tick)}
            x2={model.x(tick)}
            y1={margin.top}
            y2={height - margin.bottom}
            stroke="#242833"
            strokeWidth="1"
          />
          <text
            x={model.x(tick)}
            y={height - margin.bottom + 20}
            textAnchor="middle"
            fill="#a8a29e"
            fontSize="11"
          >
            {(xUnit === "s" && model.xMax > 100 ? tick / 1000 : tick).toFixed(0)}{xUnit}
          </text>
        </g>
      ))}
    </g>
  );
}

function downsample(points: Point[], maximum: number) {
  if (points.length <= maximum) return points;
  const step = Math.ceil(points.length / maximum);
  return points.filter((_point, index) => index % step === 0 || index === points.length - 1);
}

function linePath(points: Point[], x: (value: number) => number, y: (value: number) => number) {
  return points.map((point, index) => `${index ? "L" : "M"}${x(point.t).toFixed(1)},${y(point.p).toFixed(1)}`).join(" ");
}

function tickValues(minimum: number, maximum: number, count: number) {
  const step = (maximum - minimum) / Math.max(1, count - 1);
  return Array.from({ length: count }, (_item, index) => minimum + step * index);
}

function phase(kind: string, start?: number | null, end?: number | null) {
  return Number.isFinite(start) && Number.isFinite(end) && (end as number) > (start as number)
    ? { kind, startMs: start as number, endMs: end as number }
    : null;
}

function guidedPhases(events: TraceEvent[], durationMs: number) {
  const transitions = events
    .filter(
      (event) =>
        event.type === "guided_phase" &&
        typeof event.meta?.phase === "string" &&
        Number.isFinite(event.t),
    )
    .sort((a, b) => a.t - b.t);
  return transitions
    .map((event, index) => ({
      kind: String(event.meta?.phase),
      startMs: event.t,
      endMs: transitions[index + 1]?.t ?? durationMs,
    }))
    .filter((item) => item.endMs > item.startMs);
}

function phaseColor(kind: string) {
  if (kind === "inhale") return "#38bdf8";
  if (kind === "hold") return "#a78bfa";
  if (kind === "release") return "#fb7185";
  if (kind === "ready") return "#f59e0b";
  if (kind === "practice") return "#22c55e";
  return "#64748b";
}

function promptLaneY(index: number) {
  return 24 + (index % 4) * 23;
}

function promptLabel(event: TraceEvent) {
  const cue = String(event.meta?.cue ?? "audio");
  const labels: Record<string, string> = {
    p0_session_intro: "SESSION INTRO",
    p0_rehearsal_intro: "REHEARSAL",
    p0_calibration_intro: "CALIBRATION",
    p0_practice_intro: "PRACTICE",
    p0_rest: "REST",
    p0_ready: "READY",
    p0_inhale: "INHALE",
    p0_hold: "HOLD",
    p0_hold_8: "HOLD 8s",
    p0_hold_10: "HOLD 10s",
    p0_hold_12: "HOLD 12s",
    p0_hold_15: "HOLD 15s",
    p0_hold_20: "HOLD 20s",
    p0_five_seconds_left: "5 SECONDS LEFT",
    p0_in_range_ding: "IN RANGE DING",
    p0_release: "RELEASE",
    p0_abort: "ABORT / RELEASE",
    p0_deeper: "DEEPER",
    p0_ease_back: "EASE BACK",
    p0_target: "RIGHT THERE",
    p0_calibration_retry: "REPEAT",
    p0_calibration_mismatch: "COLLECT ANOTHER",
    p0_calibration_failed: "RETRY SESSION",
    p0_practice_incomplete: "PRACTICE STOPPED",
    p0_session_complete: "COMPLETE",
  };
  return labels[cue] ?? cue.replaceAll("_", " ").toUpperCase();
}

function coachLabel(event: TraceEvent) {
  const cue = String(event.meta?.cue ?? "audio coaching").replaceAll("_", " ");
  const hold = Number(event.meta?.holdIndex);
  return Number.isFinite(hold) ? `Hold ${hold}: ${cue}` : cue;
}

function medianNumber(values: Array<number | null | undefined>) {
  const finite = values.filter((value): value is number => Number.isFinite(value)).sort((a, b) => a - b);
  if (!finite.length) return Number.NaN;
  const middle = Math.floor(finite.length / 2);
  return finite.length % 2 ? finite[middle] : (finite[middle - 1] + finite[middle]) / 2;
}

function TraceStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md p-2" style={{ background: "#1c1f26", border: "1px solid #303441" }}>
      <div className="text-[9px] uppercase tracking-wider opacity-60">{label}</div>
      <div className="mt-1 font-mono text-sm tabular-nums">{value}</div>
    </div>
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="inline-block h-2 w-2 rounded-full" style={{ background: color }} />
      {label}
    </span>
  );
}

function MetricRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-0.5">
      <span className="opacity-60">{label}</span>
      <span className="font-mono tabular-nums text-right">{value}</span>
    </div>
  );
}

function holdRoleLabel(role: TraceHold["role"]) {
  if (role === "observation") return "Observation";
  if (role === "calibration" || role === "learn") return "Calibration";
  return "Coaching";
}

function holdRoleCode(role: TraceHold["role"]) {
  if (role === "observation") return "O";
  if (role === "calibration" || role === "learn") return "C";
  return "P";
}

function formatDeg(value?: number | null) {
  return Number.isFinite(value) ? `${(value as number).toFixed(2)}°` : "—";
}

function formatSignedDeg(value?: number | null) {
  return Number.isFinite(value) ? `${(value as number) > 0 ? "+" : ""}${(value as number).toFixed(2)}°` : "—";
}

function formatSeconds(value?: number | null) {
  return Number.isFinite(value) ? `${(value as number).toFixed(1)}s` : "—";
}
