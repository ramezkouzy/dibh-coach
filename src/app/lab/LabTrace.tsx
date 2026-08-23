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
  role: "learn" | "practice";
  valid: boolean;
  direction?: number | null;
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
        targetSignedExcursionDeg?: number | null;
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
const FULL_HEIGHT = 360;
const ALIGNED_HEIGHT = 300;
const MARGIN = { left: 58, right: 18, top: 24, bottom: 42 };

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
          label="valid holds"
          value={`${summary.validHoldCount ?? 0}/${summary.totalHoldCount ?? 0}`}
        />
        <TraceStat
          label="learned excursion"
          value={formatDeg(target?.targetSignedExcursionDeg)}
        />
        <TraceStat label="excursion variation" value={formatDeg(summary.signedExcursionSdDeg)} />
        <TraceStat
          label="sample rate"
          value={`${recording.analysis.quality?.effectiveSampleRateHz ?? "—"} Hz`}
        />
      </div>

      <div>
        <div className="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-[10px] uppercase tracking-wider opacity-70">
          <Legend color="#64748b" label="relax / recovery" />
          <Legend color="#38bdf8" label="inhale" />
          <Legend color="#a78bfa" label="hold" />
          <Legend color="#22c55e" label="stable" />
          <Legend color="#f59e0b" label="target band" />
          <Legend color="#fb7185" label="audio coaching" />
        </div>
        <svg
          viewBox={`0 0 ${FULL_WIDTH} ${FULL_HEIGHT}`}
          className="block w-full rounded-md"
          style={{ background: "#0a0c10", border: "1px solid #303441" }}
          role="img"
          aria-labelledby="full-trace-title full-trace-desc"
        >
          <title id="full-trace-title">Full session phone pitch trace</title>
          <desc id="full-trace-desc">
            Phone pitch over the full recording with breathing phases, stable segments, practice
            target bands, and audio coaching events.
          </desc>
          <ChartGrid model={model.fullChart} xUnit="s" yUnit="°" />
          {model.phases.map((phase, index) => (
            <rect
              key={`${phase.kind}-${index}`}
              x={model.fullChart.x(phase.startMs)}
              y={MARGIN.top}
              width={Math.max(1, model.fullChart.x(phase.endMs) - model.fullChart.x(phase.startMs))}
              height={FULL_HEIGHT - MARGIN.top - MARGIN.bottom}
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
          {model.coachingEvents.map((event) => (
            <g key={`${event.t}-${String(event.meta?.cue ?? "cue")}`}>
              <line
                x1={model.fullChart.x(event.t)}
                x2={model.fullChart.x(event.t)}
                y1={MARGIN.top}
                y2={FULL_HEIGHT - MARGIN.bottom}
                stroke="#fb7185"
                strokeWidth="1.5"
                strokeDasharray="5 4"
              />
              <circle
                cx={model.fullChart.x(event.t)}
                cy={MARGIN.top + 8}
                r="4"
                fill="#fb7185"
              >
                <title>{coachLabel(event)}</title>
              </circle>
            </g>
          ))}
          {recording.analysis.holds.map((hold) => {
            const start = hold.windows?.holdStartMs;
            if (!Number.isFinite(start)) return null;
            return (
              <text
                key={`hold-label-${hold.index}`}
                x={model.fullChart.x(start as number) + 5}
                y={FULL_HEIGHT - MARGIN.bottom - 8}
                fill="#e7e5e4"
                fontSize="12"
              >
                {hold.role === "learn" ? "L" : "P"}{hold.index}
              </text>
            );
          })}
        </svg>
      </div>

      <div>
        <div className="mb-2 text-xs font-semibold">Holds aligned to each inhale</div>
        <svg
          viewBox={`0 0 ${FULL_WIDTH} ${ALIGNED_HEIGHT}`}
          className="block w-full rounded-md"
          style={{ background: "#0a0c10", border: "1px solid #303441" }}
          role="img"
          aria-labelledby="aligned-title aligned-desc"
        >
          <title id="aligned-title">Relative excursion comparison across holds</title>
          <desc id="aligned-desc">
            Every hold is normalized to its own relaxed starting position so inhale depth and
            maintenance can be compared despite changes in absolute phone angle.
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
                  x={MARGIN.left}
                  y={top}
                  width={FULL_WIDTH - MARGIN.left - MARGIN.right}
                  height={Math.max(2, bottom - top)}
                  fill="#f59e0b"
                  opacity="0.16"
                >
                  <title>{`Learned excursion ${targetValue.toFixed(2)}° ±${tolerance.toFixed(2)}°`}</title>
                </rect>
              );
            })()}
          {model.alignedLines.map((line) => (
            <g key={`aligned-${line.index}`}>
              <path
                d={line.path}
                fill="none"
                stroke={line.role === "learn" ? "#38bdf8" : "#a78bfa"}
                strokeWidth={line.role === "learn" ? "1.7" : "2.4"}
                strokeDasharray={line.role === "learn" ? undefined : "7 4"}
                opacity={line.valid ? 0.9 : 0.45}
              >
                <title>{`${line.role === "learn" ? "Learn" : "Practice"} hold ${line.index}`}</title>
              </path>
              <text
                x={Math.min(FULL_WIDTH - MARGIN.right - 18, line.endX + 4)}
                y={line.endY}
                fill={line.role === "learn" ? "#38bdf8" : "#a78bfa"}
                fontSize="12"
              >
                {line.role === "learn" ? "L" : "P"}{line.index}
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
                  {hold.role === "learn" ? "Learn" : "Practice"} {hold.index}
                </span>
                <span className="opacity-60">{hold.valid ? "valid" : "review"}</span>
              </div>
              <MetricRow label="relative excursion" value={formatDeg(hold.relativeExcursionDeg)} />
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
                value={formatDeg(hold.bestStableSegment?.robustSdDeg ?? hold.bestStableSegment?.sdDeg)}
              />
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
                    label="stable + on target"
                    value={formatSeconds(practice.longestStableOnTargetRunSec)}
                  />
                  <MetricRow label="audio cues" value={`${practice.coachingCueCount ?? 0}`} />
                  <MetricRow label="direction corrections" value={`${practice.correctionCueCount ?? 0}`} />
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
  const sampled = downsample(points, 1100);
  const durationMs = Math.max(recording.durationSec * 1000, points.at(-1)?.t ?? 0, 1);
  const pitchValues = points.map((point) => point.p);
  const pitchMin = Math.min(...pitchValues);
  const pitchMax = Math.max(...pitchValues);
  const pitchPad = Math.max(0.5, (pitchMax - pitchMin) * 0.08);
  const fullChart = chartScale(
    0,
    durationMs,
    pitchMin - pitchPad,
    pitchMax + pitchPad,
    FULL_HEIGHT,
  );
  const phases = recording.analysis.holds.flatMap((hold) => {
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
        hold.prehold?.medianPitchDeg != null &&
        Number.isFinite(learnedDirection) &&
        Number.isFinite(learned?.targetSignedExcursionDeg) &&
        Number.isFinite(learned?.experimentalTrainingToleranceDeg),
    )
    .map((hold) => {
      const anchor = hold.prehold?.medianPitchDeg as number;
      const direction = learnedDirection as number;
      const target = learned?.targetSignedExcursionDeg as number;
      const tolerance = learned?.experimentalTrainingToleranceDeg as number;
      return {
        index: hold.index,
        startMs: hold.windows?.inhaleStartMs ?? 0,
        endMs: hold.windows?.releaseMs ?? 0,
        lowPitch: anchor + direction * (target - tolerance),
        highPitch: anchor + direction * (target + tolerance),
        tolerance,
      };
    });
  const stablePaths = recording.analysis.holds.flatMap((hold) =>
    (hold.stableSegments ?? []).map((segment, index) => {
      const segmentPoints = downsample(
        points.filter((point) => point.t >= segment.startMs && point.t <= segment.endMs),
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
      const end = hold.windows?.releaseMs;
      const anchor = hold.prehold?.medianPitchDeg;
      const direction = learnedDirection ?? hold.direction;
      if (![start, end, anchor, direction].every(Number.isFinite)) return null;
      const series = points
        .filter((point) => point.t >= (start as number) && point.t <= (end as number))
        .map((point) => ({
          t: (point.t - (start as number)) / 1000,
          p: (direction as number) * (point.p - (anchor as number)),
        }));
      return { hold, points: downsample(series, 450) };
    })
    .filter(
      (item): item is { hold: TraceHold; points: Point[] } => item != null && item.points.length > 0,
    );
  const alignedValues = alignedSeries.flatMap((item) => item.points.map((point) => point.p));
  if (Number.isFinite(learned?.targetSignedExcursionDeg)) {
    alignedValues.push(learned?.targetSignedExcursionDeg as number);
  }
  const alignedMaxT = Math.max(1, ...alignedSeries.flatMap((item) => item.points.map((point) => point.t)));
  const alignedMin = Math.min(0, ...alignedValues);
  const alignedMax = Math.max(1, ...alignedValues);
  const alignedPad = Math.max(0.5, (alignedMax - alignedMin) * 0.1);
  const alignedChart = chartScale(
    0,
    alignedMaxT,
    alignedMin - alignedPad,
    alignedMax + alignedPad,
    ALIGNED_HEIGHT,
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
  return {
    points,
    fullChart,
    fullPath: linePath(sampled, fullChart.x, fullChart.y),
    phases,
    targetBands,
    stablePaths,
    alignedChart,
    alignedLines,
    coachingEvents: recording.events.filter((event) => event.type === "coach_cue"),
  };
}

function chartScale(xMin: number, xMax: number, yMin: number, yMax: number, height: number) {
  const plotWidth = FULL_WIDTH - MARGIN.left - MARGIN.right;
  const plotHeight = height - MARGIN.top - MARGIN.bottom;
  return {
    xMin,
    xMax,
    yMin,
    yMax,
    height,
    x: (value: number) => MARGIN.left + ((value - xMin) / Math.max(0.001, xMax - xMin)) * plotWidth,
    y: (value: number) => MARGIN.top + ((yMax - value) / Math.max(0.001, yMax - yMin)) * plotHeight,
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
  return (
    <g aria-hidden="true">
      {yTicks.map((tick) => (
        <g key={`y-${tick}`}>
          <line
            x1={MARGIN.left}
            x2={FULL_WIDTH - MARGIN.right}
            y1={model.y(tick)}
            y2={model.y(tick)}
            stroke="#303441"
            strokeWidth="1"
          />
          <text x={MARGIN.left - 8} y={model.y(tick) + 4} textAnchor="end" fill="#a8a29e" fontSize="11">
            {tick.toFixed(1)}{yUnit}
          </text>
        </g>
      ))}
      {xTicks.map((tick) => (
        <g key={`x-${tick}`}>
          <line
            x1={model.x(tick)}
            x2={model.x(tick)}
            y1={MARGIN.top}
            y2={height - MARGIN.bottom}
            stroke="#242833"
            strokeWidth="1"
          />
          <text
            x={model.x(tick)}
            y={height - MARGIN.bottom + 20}
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

function phaseColor(kind: string) {
  if (kind === "inhale") return "#38bdf8";
  if (kind === "hold") return "#a78bfa";
  return "#64748b";
}

function coachLabel(event: TraceEvent) {
  const cue = String(event.meta?.cue ?? "audio coaching").replaceAll("_", " ");
  const hold = Number(event.meta?.holdIndex);
  return Number.isFinite(hold) ? `Hold ${hold}: ${cue}` : cue;
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

function formatDeg(value?: number | null) {
  return Number.isFinite(value) ? `${(value as number).toFixed(2)}°` : "—";
}

function formatSignedDeg(value?: number | null) {
  return Number.isFinite(value) ? `${(value as number) > 0 ? "+" : ""}${(value as number).toFixed(2)}°` : "—";
}

function formatSeconds(value?: number | null) {
  return Number.isFinite(value) ? `${(value as number).toFixed(1)}s` : "—";
}
