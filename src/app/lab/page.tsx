"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { playClip, preloadAll, unlockAudio } from "@/audio";
import { analyzeLabRecording, LAB_P0_ALGORITHM } from "@/lib/lab-p0-analysis.mjs";

// Schema v3: full multi-channel sensor capture plus the exact EMA pitch used
// by the P0 analyzer. Raw beta remains available so smoothing can be replayed.
// Each sample is a row of
// [t, alpha, beta, betaEma, gamma, ax, ay, az, agx, agy, agz, rrA, rrB, rrG].
// Fields use null when a sub-event hasn't fired yet. Compact array form keeps
// repeated-hold recordings reasonably small at ~60Hz.
type Sample = [
  number, // t (ms since recording start)
  number | null, // alpha — orientation yaw  (deg)
  number | null, // beta  — raw orientation pitch (deg)
  number | null, // betaEma — browser-computed EMA pitch (deg)
  number | null, // gamma — orientation roll  (deg)
  number | null, // ax    — accel no-gravity X (m/s²)
  number | null, // ay    — accel no-gravity Y
  number | null, // az    — accel no-gravity Z
  number | null, // agx   — accel WITH gravity X
  number | null, // agy
  number | null, // agz
  number | null, // rrA   — rotation rate around Z (deg/s)  alpha
  number | null, // rrB   — rotation rate around X (deg/s)  beta
  number | null, // rrG   — rotation rate around Y (deg/s)  gamma
];

type LabEvent = { t: number; type: string; meta?: unknown };

type Recording = {
  schema: "dibh-lab/v3";
  sessionId: string;
  appBuild: string;
  algorithm: typeof LAB_P0_ALGORITHM;
  scenario: string;
  note: string;
  startedAt: string;
  durationSec: number;
  ua: string;
  protocol: {
    mode: "guided" | "free";
    holdSeconds: number | null;
    holdCount: number | null;
    learnHoldCount: number | null;
  };
  samples: Sample[];
  events: LabEvent[];
  analysis: ReturnType<typeof analyzeLabRecording>;
  // Channel index lookup for analysis tools
  channels: [
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
};

const SCENARIOS = [
  "guided-25s",
  "guided-20s",
  "guided-15s",
  "calm-hold",
  "hold-with-drift",
  "natural-breathing",
  "custom",
];

const FREE_EVENTS = [
  ["prehold_start", "Prehold start"],
  ["prehold_end", "Prehold end"],
  ["inhale_start", "Inhale start"],
  ["hold_start", "Start hold"],
  ["peak", "At peak"],
  ["stable", "Steady"],
  ["drift-in", "Drift in"],
  ["drift-out", "Drift out"],
  ["target", "Target hit"],
  ["release", "Released"],
] as const;

// Guided protocol: baseline → repeated prehold / inhale / hold / recovery cycles.
// One hold tunes detection, three measure repeatability, and five provide three
// Learn-style references plus two Practice-style checks against that target.
type GuidedStep =
  | { kind: "cue"; clip: Parameters<typeof playClip>[0]; mark?: string; meta?: unknown }
  | { kind: "mark"; type: string; meta?: unknown }
  | { kind: "wait"; seconds: number; label: string };

function guidedProtocol(holdSeconds: number, holdCount: number): GuidedStep[] {
  const steps: GuidedStep[] = [
    { kind: "mark", type: "baseline_start" },
    { kind: "wait", seconds: 12, label: "Breathe normally" },
    { kind: "cue", clip: "baseline_done", mark: "baseline_end" },
  ];
  for (let index = 1; index <= holdCount; index++) {
    const role = holdCount >= 4 && index > 3 ? "practice" : "learn";
    const meta = { holdIndex: index, role };
    steps.push(
      { kind: "mark", type: "prehold_start", meta },
      { kind: "wait", seconds: 2, label: `Hold ${index}: stay relaxed` },
      { kind: "mark", type: "prehold_end", meta },
      { kind: "cue", clip: "inhale_cue", mark: "inhale_start", meta },
      { kind: "wait", seconds: 4, label: `Hold ${index}: inhale fully` },
      { kind: "cue", clip: "practice_hold", mark: "hold_start", meta },
      { kind: "wait", seconds: holdSeconds, label: `Hold ${index}: hold steady` },
      { kind: "cue", clip: "release_breath", mark: "release", meta },
      { kind: "wait", seconds: 6, label: `Hold ${index}: breathe normally` },
      { kind: "mark", type: "recovery_end", meta },
    );
  }
  steps.push({ kind: "cue", clip: "session_done", mark: "session_end" });
  return steps;
}

export default function LabPage() {
  // ---- sensor state -------------------------------------------------------
  const [granted, setGranted] = useState(false);
  const [permissionError, setPermissionError] = useState<string | null>(null);

  // ---- recording state ----------------------------------------------------
  const [recording, setRecording] = useState(false);
  const [scenario, setScenario] = useState<string>(SCENARIOS[0]);
  const [customScenario, setCustomScenario] = useState("");
  const [note, setNote] = useState("");
  const [duration, setDuration] = useState(0);
  const [count, setCount] = useState(0);
  const [pitch, setPitch] = useState(0);
  const [events, setEvents] = useState<LabEvent[]>([]);
  const [last, setLast] = useState<Recording | null>(null);

  // ---- guided runner state -----------------------------------------------
  const [guidedActive, setGuidedActive] = useState(false);
  const [guidedLabel, setGuidedLabel] = useState<string>("");
  const [guidedHoldSec, setGuidedHoldSec] = useState<number>(20);
  const [guidedHoldCount, setGuidedHoldCount] = useState<number>(3);
  const [stepCountdown, setStepCountdown] = useState<number>(0);

  // ---- refs ---------------------------------------------------------------
  const samplesRef = useRef<Sample[]>([]);
  const eventsRef = useRef<LabEvent[]>([]);
  const startedAtRef = useRef<number>(0);
  const startedAtIsoRef = useRef<string>("");
  const sessionIdRef = useRef<string>("");
  const activeScenarioRef = useRef<string>(SCENARIOS[0]);
  const recordingRef = useRef(false);
  const guidedConfigRef = useRef<{ holdSeconds: number; holdCount: number } | null>(null);
  const betaEmaRef = useRef<number | null>(null);
  // Latest values from each event stream — combined on each tick.
  const oRef = useRef<{
    alpha: number | null;
    beta: number | null;
    betaEma: number | null;
    gamma: number | null;
  }>({
    alpha: null,
    beta: null,
    betaEma: null,
    gamma: null,
  });
  const mRef = useRef<{
    ax: number | null;
    ay: number | null;
    az: number | null;
    agx: number | null;
    agy: number | null;
    agz: number | null;
    rrA: number | null;
    rrB: number | null;
    rrG: number | null;
  }>({
    ax: null,
    ay: null,
    az: null,
    agx: null,
    agy: null,
    agz: null,
    rrA: null,
    rrB: null,
    rrG: null,
  });
  const lastDispRef = useRef(0);
  const lastSampleAtRef = useRef(0);

  // ---- wake lock so the phone doesn't sleep during a recording ----------
  useEffect(() => {
    if (!granted) return;
    let lock: WakeLockSentinel | null = null;
    let cancelled = false;
    const acquire = async () => {
      try {
        const nav = navigator as Navigator & {
          wakeLock?: { request: (type: "screen") => Promise<WakeLockSentinel> };
        };
        if (nav.wakeLock) {
          lock = await nav.wakeLock.request("screen");
          if (cancelled && lock) lock.release();
        }
      } catch {
        // best-effort
      }
    };
    acquire();
    const onVisible = () => {
      if (document.visibilityState === "visible") acquire();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisible);
      lock?.release();
    };
  }, [granted]);

  // ---- sensor wiring ------------------------------------------------------
  useEffect(() => {
    if (!granted) return;
    const onOrient = (e: DeviceOrientationEvent) => {
      if (e.beta != null) {
        betaEmaRef.current =
          betaEmaRef.current == null
            ? e.beta
            : betaEmaRef.current * (1 - LAB_P0_ALGORITHM.params.emaAlpha) +
              e.beta * LAB_P0_ALGORITHM.params.emaAlpha;
      }
      oRef.current = {
        alpha: e.alpha,
        beta: e.beta,
        betaEma: betaEmaRef.current,
        gamma: e.gamma,
      };
      pushSample();
    };
    const onMotion = (e: DeviceMotionEvent) => {
      const a = e.acceleration;
      const ag = e.accelerationIncludingGravity;
      const r = e.rotationRate;
      mRef.current = {
        ax: a?.x ?? null,
        ay: a?.y ?? null,
        az: a?.z ?? null,
        agx: ag?.x ?? null,
        agy: ag?.y ?? null,
        agz: ag?.z ?? null,
        rrA: r?.alpha ?? null,
        rrB: r?.beta ?? null,
        rrG: r?.gamma ?? null,
      };
      pushSample();
    };
    function pushSample() {
      const now = performance.now();
      if (recording) {
        const t = +(now - startedAtRef.current).toFixed(1);
        // Throttle to ~60Hz max — both event streams fire and we'd otherwise
        // double-up. Skip if a sample landed within 12ms.
        if (now - lastSampleAtRef.current < 12) return;
        lastSampleAtRef.current = now;
        const o = oRef.current;
        const m = mRef.current;
        samplesRef.current.push([
          t,
          o.alpha != null ? +o.alpha.toFixed(3) : null,
          o.beta != null ? +o.beta.toFixed(3) : null,
          o.betaEma != null ? +o.betaEma.toFixed(3) : null,
          o.gamma != null ? +o.gamma.toFixed(3) : null,
          m.ax != null ? +m.ax.toFixed(4) : null,
          m.ay != null ? +m.ay.toFixed(4) : null,
          m.az != null ? +m.az.toFixed(4) : null,
          m.agx != null ? +m.agx.toFixed(4) : null,
          m.agy != null ? +m.agy.toFixed(4) : null,
          m.agz != null ? +m.agz.toFixed(4) : null,
          m.rrA != null ? +m.rrA.toFixed(3) : null,
          m.rrB != null ? +m.rrB.toFixed(3) : null,
          m.rrG != null ? +m.rrG.toFixed(3) : null,
        ]);
      }
      if (now - lastDispRef.current > 100) {
        lastDispRef.current = now;
        const beta = oRef.current.betaEma ?? oRef.current.beta;
        if (beta != null) setPitch(beta);
        if (recording) {
          setDuration((now - startedAtRef.current) / 1000);
          setCount(samplesRef.current.length);
        }
      }
    }
    window.addEventListener("deviceorientation", onOrient);
    window.addEventListener("devicemotion", onMotion);
    return () => {
      window.removeEventListener("deviceorientation", onOrient);
      window.removeEventListener("devicemotion", onMotion);
    };
  }, [granted, recording]);

  // ---- permission ---------------------------------------------------------
  const requestPerm = useCallback(async () => {
    setPermissionError(null);
    const Doc = (typeof DeviceOrientationEvent !== "undefined" ? DeviceOrientationEvent : null) as
      | (typeof DeviceOrientationEvent & { requestPermission?: () => Promise<"granted" | "denied"> })
      | null;
    const Mot = (typeof DeviceMotionEvent !== "undefined" ? DeviceMotionEvent : null) as
      | (typeof DeviceMotionEvent & { requestPermission?: () => Promise<"granted" | "denied"> })
      | null;
    if (Doc && typeof Doc.requestPermission === "function") {
      try {
        const r = await Doc.requestPermission();
        if (r !== "granted") {
          setPermissionError("Motion access denied.");
          return;
        }
      } catch {
        setPermissionError("Couldn't request orientation permission.");
        return;
      }
    }
    if (Mot && typeof Mot.requestPermission === "function") {
      try {
        await Mot.requestPermission();
      } catch {
        // non-fatal
      }
    }
    unlockAudio();
    preloadAll();
    setGranted(true);
  }, []);

  // ---- recording control --------------------------------------------------
  const startRec = (
    sc?: string,
    guidedConfig?: { holdSeconds: number; holdCount: number } | null,
  ) => {
    samplesRef.current = [];
    eventsRef.current = [];
    setEvents([]);
    startedAtRef.current = performance.now();
    startedAtIsoRef.current = new Date().toISOString();
    sessionIdRef.current = newSessionId();
    activeScenarioRef.current =
      sc ?? (scenario === "custom" && customScenario ? customScenario : scenario);
    guidedConfigRef.current = guidedConfig ?? null;
    recordingRef.current = true;
    lastSampleAtRef.current = 0;
    setDuration(0);
    setCount(0);
    setRecording(true);
  };

  const mark = (type: string, meta?: unknown) => {
    const e: LabEvent = {
      t: +(performance.now() - startedAtRef.current).toFixed(1),
      type,
      ...(meta !== undefined ? { meta } : {}),
    };
    eventsRef.current.push(e);
    setEvents([...eventsRef.current]);
  };

  const stopRec = () => {
    if (!recordingRef.current) return;
    recordingRef.current = false;
    setRecording(false);
    const totalDur = (performance.now() - startedAtRef.current) / 1000;
    const guidedConfig = guidedConfigRef.current;
    const recordingBase = {
      schema: "dibh-lab/v3" as const,
      sessionId: sessionIdRef.current,
      appBuild: "lab-p0.1",
      algorithm: LAB_P0_ALGORITHM,
      scenario: activeScenarioRef.current,
      note,
      startedAt: startedAtIsoRef.current,
      durationSec: +totalDur.toFixed(2),
      ua: navigator.userAgent,
      protocol: {
        mode: guidedConfig ? ("guided" as const) : ("free" as const),
        holdSeconds: guidedConfig?.holdSeconds ?? null,
        holdCount: guidedConfig?.holdCount ?? null,
        learnHoldCount: guidedConfig ? Math.min(3, guidedConfig.holdCount) : null,
      },
      samples: samplesRef.current,
      events: eventsRef.current,
      channels: [
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
      ] as Recording["channels"],
    };
    const rec: Recording = {
      ...recordingBase,
      analysis: analyzeLabRecording(recordingBase),
    };
    setLast(rec);
    download(rec);
  };

  // ---- guided runner ------------------------------------------------------
  const guidedRunningRef = useRef(false);
  const startGuided = async () => {
    if (!granted) {
      await requestPerm();
      return;
    }
    if (recording) return;
    const sc = `p0-${guidedHoldCount}x${guidedHoldSec}s`;
    startRec(sc, { holdSeconds: guidedHoldSec, holdCount: guidedHoldCount });
    setGuidedActive(true);
    guidedRunningRef.current = true;
    const steps = guidedProtocol(guidedHoldSec, guidedHoldCount);
    for (const step of steps) {
      if (!guidedRunningRef.current) break;
      if (step.kind === "cue") {
        playClip(step.clip);
        if (step.mark) mark(step.mark, step.meta);
      } else if (step.kind === "mark") {
        mark(step.type, step.meta);
      } else {
        setGuidedLabel(step.label);
        for (let s = step.seconds; s > 0 && guidedRunningRef.current; s--) {
          setStepCountdown(s);
          await sleep(1000);
        }
        setStepCountdown(0);
      }
    }
    setGuidedActive(false);
    setGuidedLabel("");
    guidedRunningRef.current = false;
    if (recordingRef.current) {
      // small grace before download
      await sleep(400);
      stopRec();
    }
  };

  const cancelGuided = () => {
    guidedRunningRef.current = false;
    setGuidedActive(false);
    setGuidedLabel("");
    if (recordingRef.current) stopRec();
  };

  // ---- render -------------------------------------------------------------
  return (
    <main
      className="flex-1 flex flex-col items-stretch"
      style={{
        background: "#0f1115",
        color: "#e7e5e4",
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        minHeight: "100dvh",
        padding: "16px 14px 32px",
      }}
    >
      <div className="max-w-md w-full mx-auto flex flex-col gap-3">
        <div className="flex items-baseline justify-between">
          <h1 className="text-lg font-semibold">DIBH Lab P0</h1>
          <a href="/" className="text-xs underline opacity-70">
            ← coach
          </a>
        </div>
        <p className="text-xs opacity-70 leading-relaxed">
          Measurement harness for repeatable RT breath-hold coaching. Captures raw
          sensors, EMA pitch, exact phase markers, stability segments, placement drift,
          breath excursion, and plateau reproducibility in one replayable JSON.
        </p>

        {!granted ? (
          <button
            onClick={requestPerm}
            className="rounded-lg py-3 font-semibold"
            style={{ background: "#3b82f6", color: "white" }}
          >
            Enable motion sensors
          </button>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-2">
              <Stat label="pitch (β)" value={`${pitch.toFixed(2)}°`} />
              <Stat label="time / count" value={`${duration.toFixed(1)}s · ${count}`} />
            </div>

            {/* Guided session card */}
            <div
              className="rounded-lg p-3 flex flex-col gap-2"
              style={{ background: "#1c1f26", border: "1px solid #303441" }}
            >
              <div className="flex items-center justify-between">
                <div className="text-xs uppercase tracking-wider opacity-60">P0 guided run</div>
                <select
                  value={guidedHoldSec}
                  onChange={(e) => setGuidedHoldSec(parseInt(e.target.value))}
                  disabled={recording}
                  className="rounded p-1 text-xs"
                  style={{ background: "#0a0c10", color: "#e7e5e4", border: "1px solid #303441" }}
                >
                  {[15, 20, 25, 30].map((n) => (
                    <option key={n} value={n}>
                      {n}s hold
                    </option>
                  ))}
                </select>
              </div>
              <select
                value={guidedHoldCount}
                onChange={(e) => setGuidedHoldCount(parseInt(e.target.value))}
                disabled={recording}
                className="rounded p-2 text-xs"
                style={{ background: "#0a0c10", color: "#e7e5e4", border: "1px solid #303441" }}
              >
                <option value={1}>1 hold · detector check</option>
                <option value={3}>3 holds · repeatability</option>
                <option value={5}>5 holds · 3 learn + 2 practice</option>
              </select>
              {!guidedActive ? (
                <button
                  onClick={startGuided}
                  className="rounded-md py-3 font-semibold"
                  style={{ background: "#16a34a", color: "white" }}
                >
                  ▶ Start P0 run
                </button>
              ) : (
                <>
                  <div className="text-center py-2">
                    <div className="text-xs opacity-70 mb-1">{guidedLabel}</div>
                    <div className="text-3xl font-mono">
                      {stepCountdown > 0 ? `${stepCountdown}s` : "…"}
                    </div>
                  </div>
                  <button
                    onClick={cancelGuided}
                    className="rounded-md py-2 text-sm"
                    style={{ background: "#3a0f0f", color: "#fca5a5", border: "1px solid #5a1f1f" }}
                  >
                    Cancel
                  </button>
                </>
              )}
              <div className="text-[11px] opacity-60 leading-relaxed">
                Each hold records a quiet prehold anchor, inhale, hold, and recovery.
                Keep the charging-port edge anchored on the sternum for the entire run.
                The download is automatic when all holds finish.
              </div>
            </div>

            {/* Free record */}
            <div
              className="rounded-lg p-3 flex flex-col gap-2"
              style={{ background: "#1c1f26", border: "1px solid #303441" }}
            >
              <div className="text-xs uppercase tracking-wider opacity-60">Free record</div>
              <select
                value={scenario}
                onChange={(e) => setScenario(e.target.value)}
                disabled={recording}
                className="rounded p-2 text-sm"
                style={{ background: "#0a0c10", color: "#e7e5e4", border: "1px solid #303441" }}
              >
                {SCENARIOS.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
              {scenario === "custom" && (
                <input
                  placeholder="custom scenario name"
                  value={customScenario}
                  onChange={(e) => setCustomScenario(e.target.value)}
                  disabled={recording}
                  className="rounded p-2 text-sm"
                  style={{ background: "#0a0c10", color: "#e7e5e4", border: "1px solid #303441" }}
                />
              )}
              <input
                placeholder="note (optional)"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                disabled={recording}
                className="rounded p-2 text-sm"
                style={{ background: "#0a0c10", color: "#e7e5e4", border: "1px solid #303441" }}
              />
              {!recording ? (
                <button
                  onClick={() => startRec()}
                  className="rounded-md py-2.5 font-semibold"
                  style={{ background: "#dc2626", color: "white" }}
                >
                  ● Start free record
                </button>
              ) : (
                <button
                  onClick={stopRec}
                  className="rounded-md py-2.5 font-semibold"
                  style={{ background: "#0ea5e9", color: "white" }}
                >
                  ■ Stop & download
                </button>
              )}
              {recording && !guidedActive && (
                <div className="grid grid-cols-2 gap-2 mt-1">
                  {FREE_EVENTS.map(([type, label]) => (
                    <button
                      key={type}
                      onClick={() => mark(type)}
                      className="rounded py-2 text-sm"
                      style={{ background: "#0a0c10", color: "#e7e5e4", border: "1px solid #303441" }}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Events list */}
            {events.length > 0 && (
              <div
                className="text-xs leading-relaxed max-h-40 overflow-auto rounded-md p-2 opacity-80"
                style={{ background: "#0a0c10", border: "1px solid #1c1f26" }}
              >
                {events.map((e, i) => (
                  <div key={i} className="flex justify-between font-mono">
                    <span>{(e.t / 1000).toFixed(2)}s</span>
                    <span>{e.type}</span>
                  </div>
                ))}
              </div>
            )}

            {last && !recording && !guidedActive && (
              <div
                className="rounded-md p-3 text-xs"
                style={{ background: "#1c1f26", border: "1px solid #303441" }}
              >
                <div className="font-semibold mb-1">Last download</div>
                <div className="opacity-80">scenario: {last.scenario}</div>
                <div className="opacity-80">
                  {last.durationSec}s · {last.samples.length} samples · {last.events.length} events
                </div>
                <div className="mt-2 grid grid-cols-2 gap-1.5">
                  <MiniStat
                    label="sample rate"
                    value={`${last.analysis.quality.effectiveSampleRateHz ?? "—"} Hz`}
                  />
                  <MiniStat
                    label="longest gap"
                    value={`${last.analysis.quality.longestGapMs ?? "—"} ms`}
                  />
                  <MiniStat
                    label="baseline SD"
                    value={`${last.analysis.baseline?.sdDeg ?? "—"}°`}
                  />
                  <MiniStat
                    label="valid holds"
                    value={`${last.analysis.summary.validHoldCount}/${last.analysis.summary.totalHoldCount}`}
                  />
                  <MiniStat
                    label="pose SD"
                    value={`${last.analysis.summary.preholdPoseSdDeg ?? "—"}°`}
                  />
                  <MiniStat
                    label="excursion SD"
                    value={`${last.analysis.summary.signedExcursionSdDeg ?? "—"}°`}
                  />
                  <MiniStat
                    label="plateau SD"
                    value={`${last.analysis.summary.absolutePlateauSdDeg ?? "—"}°`}
                  />
                  <MiniStat
                    label="direction"
                    value={`${last.analysis.summary.directionConsistencyPct ?? "—"}%`}
                  />
                </div>
                {last.analysis.issues.length > 0 && (
                  <div
                    className="mt-2 rounded p-2 leading-relaxed"
                    style={{ background: "#3a260f", color: "#fdba74" }}
                  >
                    QC: {last.analysis.issues.join(", ")}
                  </div>
                )}
                <button
                  onClick={() => download(last)}
                  className="mt-2 rounded px-3 py-1.5 text-xs"
                  style={{ background: "#0ea5e9", color: "white", border: "none" }}
                >
                  Re-download
                </button>
              </div>
            )}
          </>
        )}

        {permissionError && (
          <p className="text-xs" style={{ color: "#fca5a5" }}>
            {permissionError}
          </p>
        )}
      </div>
    </main>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div
      className="rounded-md p-2"
      style={{ background: "#1c1f26", border: "1px solid #303441" }}
    >
      <div className="text-[10px] uppercase tracking-wider opacity-60">{label}</div>
      <div className="font-mono text-sm tabular-nums mt-0.5">{value}</div>
    </div>
  );
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded p-1.5" style={{ background: "#0a0c10" }}>
      <div className="text-[9px] uppercase tracking-wider opacity-50">{label}</div>
      <div className="mt-0.5 font-mono tabular-nums">{value}</div>
    </div>
  );
}

function sleep(ms: number) {
  return new Promise<void>((res) => setTimeout(res, ms));
}

function newSessionId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `lab-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function download(rec: Recording) {
  const blob = new Blob([JSON.stringify(rec)], { type: "application/json" });
  const a = document.createElement("a");
  const url = URL.createObjectURL(blob);
  a.href = url;
  const ts = rec.startedAt.replace(/[:.]/g, "-").replace(/T/, "_").slice(0, 19);
  a.download = `dibh-${rec.scenario}-${ts}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
