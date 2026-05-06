"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { playClip, preloadAll, unlockAudio } from "@/audio";

// Schema v2: full multi-channel sensor capture.
// Each sample is a row of [t, alpha, beta, gamma, ax, ay, az, agx, agy, agz, rrA, rrB, rrG].
// Fields use null when a sub-event hasn't fired yet. Compact array form keeps
// JSON tiny so we can ship a 30s recording at 60Hz comfortably.
type Sample = [
  number, // t (ms since recording start)
  number | null, // alpha — orientation yaw  (deg)
  number | null, // beta  — orientation pitch (deg)
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
  schema: "dibh-lab/v2";
  scenario: string;
  note: string;
  startedAt: string;
  durationSec: number;
  ua: string;
  samples: Sample[];
  events: LabEvent[];
  // Channel index lookup for analysis tools
  channels: [
    "t",
    "alpha",
    "beta",
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
  ["hold-start", "Start hold"],
  ["peak", "At peak"],
  ["stable", "Steady"],
  ["drift-in", "Drift in"],
  ["drift-out", "Drift out"],
  ["target", "Target hit"],
  ["release", "Released"],
] as const;

// Guided protocol: baseline (12s) → inhale (5s) → hold (variable) → release (5s).
// Cues are exactly what the real app says. Markers go into events for boundaries.
type GuidedStep =
  | { kind: "cue"; clip: Parameters<typeof playClip>[0]; mark?: string }
  | { kind: "wait"; seconds: number; label: string };

function guidedProtocol(holdSeconds: number): GuidedStep[] {
  return [
    { kind: "cue", clip: "baseline_intro", mark: "baseline_start" },
    { kind: "wait", seconds: 12, label: "Breathe normally" },
    { kind: "cue", clip: "baseline_done", mark: "baseline_end" },
    { kind: "wait", seconds: 1.5, label: "Get ready" },
    { kind: "cue", clip: "inhale_cue", mark: "inhale_start" },
    { kind: "wait", seconds: 4, label: "Inhale fully" },
    { kind: "cue", clip: "locked_in", mark: "hold_start" },
    { kind: "wait", seconds: holdSeconds, label: "Hold steady" },
    { kind: "cue", clip: "release_breath", mark: "release" },
    { kind: "wait", seconds: 6, label: "Breathe normally" },
    { kind: "cue", clip: "session_done", mark: "session_end" },
  ];
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
  const [stepCountdown, setStepCountdown] = useState<number>(0);

  // ---- refs ---------------------------------------------------------------
  const samplesRef = useRef<Sample[]>([]);
  const eventsRef = useRef<LabEvent[]>([]);
  const startedAtRef = useRef<number>(0);
  const startedAtIsoRef = useRef<string>("");
  // Latest values from each event stream — combined on each tick.
  const oRef = useRef<{ alpha: number | null; beta: number | null; gamma: number | null }>({
    alpha: null,
    beta: null,
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
      oRef.current = { alpha: e.alpha, beta: e.beta, gamma: e.gamma };
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
        const beta = oRef.current.beta;
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
  const startRec = (sc?: string) => {
    samplesRef.current = [];
    eventsRef.current = [];
    setEvents([]);
    startedAtRef.current = performance.now();
    startedAtIsoRef.current = new Date().toISOString();
    setDuration(0);
    setCount(0);
    if (sc) setScenario(sc);
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
    setRecording(false);
    const totalDur = (performance.now() - startedAtRef.current) / 1000;
    const sc = scenario === "custom" && customScenario ? customScenario : scenario;
    const rec: Recording = {
      schema: "dibh-lab/v2",
      scenario: sc,
      note,
      startedAt: startedAtIsoRef.current,
      durationSec: +totalDur.toFixed(2),
      ua: navigator.userAgent,
      samples: samplesRef.current,
      events: eventsRef.current,
      channels: [
        "t",
        "alpha",
        "beta",
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
      ],
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
    const sc = `guided-${guidedHoldSec}s`;
    setScenario(sc);
    startRec(sc);
    setGuidedActive(true);
    guidedRunningRef.current = true;
    const steps = guidedProtocol(guidedHoldSec);
    for (const step of steps) {
      if (!guidedRunningRef.current) break;
      if (step.kind === "cue") {
        playClip(step.clip);
        if (step.mark) mark(step.mark);
        // give the cue audio a moment to land
        await sleep(800);
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
    if (recording) {
      // small grace before download
      await sleep(400);
      stopRec();
    }
  };

  const cancelGuided = () => {
    guidedRunningRef.current = false;
    setGuidedActive(false);
    setGuidedLabel("");
    if (recording) stopRec();
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
          <h1 className="text-lg font-semibold">DIBH Lab v2</h1>
          <a href="/" className="text-xs underline opacity-70">
            ← coach
          </a>
        </div>
        <p className="text-xs opacity-70 leading-relaxed">
          Captures all 13 sensor channels (orientation × 3, accel × 6, rotation rate × 3)
          + cue events. JSON downloads at the end. Guided mode plays the same
          audio cues as the real app.
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
                <div className="text-xs uppercase tracking-wider opacity-60">Guided session</div>
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
              {!guidedActive ? (
                <button
                  onClick={startGuided}
                  className="rounded-md py-3 font-semibold"
                  style={{ background: "#16a34a", color: "white" }}
                >
                  ▶ Start guided session
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
                Plays cues: baseline → inhale → hold → release. Lay back, phone in
                portrait under your sternum, follow the voice. Auto-downloads on
                finish.
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

function sleep(ms: number) {
  return new Promise<void>((res) => setTimeout(res, ms));
}

function download(rec: Recording) {
  const blob = new Blob([JSON.stringify(rec)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  const ts = rec.startedAt.replace(/[:.]/g, "-").replace(/T/, "_").slice(0, 19);
  a.download = `dibh-${rec.scenario}-${ts}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
}
