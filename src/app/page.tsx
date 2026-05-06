"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { playClip, preloadAll, unlockAudio, type PhraseKey } from "@/audio";

type Phase = "intro" | "position" | "calibrate" | "learn" | "practice" | "report";

type Hold = {
  durationSec: number;
  peakPitch: number;
  meanPitchInHold: number;
  inZonePct: number;
};

type Baseline = {
  meanPitch: number;
  amplitudeDeg: number;
};

type Plateau = {
  targetPitch: number;
  toleranceDeg: number;
  peaks: number[];
};

const HOLD_SECONDS = 10;
const PRACTICE_HOLDS = 5;
const LEARN_HOLDS = 5;
const CALIBRATE_SECONDS = 20;

// Coaching audio is delivered via prerecorded MP3 clips through playClip().
// See src/audio.ts for the phrase catalogue and fallback behaviour.

function fmt(n: number, digits = 1) {
  return n.toFixed(digits);
}

// Count zero-crossings of (signal - mean). Each full breath cycle has 2 crossings.
// Returns estimated breaths per minute over the given duration.
function estimateBreathRate(samples: number[], durationSec: number) {
  if (samples.length < 4 || durationSec <= 0) return 0;
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
  // Hysteresis to avoid noise crossings: only count when we move past mean ± 0.2°.
  const hys = 0.2;
  let crossings = 0;
  let state: "above" | "below" | "neutral" = "neutral";
  for (const v of samples) {
    if (state !== "above" && v > mean + hys) {
      if (state === "below") crossings++;
      state = "above";
    } else if (state !== "below" && v < mean - hys) {
      if (state === "above") crossings++;
      state = "below";
    }
  }
  const breaths = crossings / 2;
  return (breaths * 60) / durationSec;
}

// Find the most stable contiguous window (by SD) of approximately `windowSec`
// seconds inside a time-tagged sample buffer. Returns the median and SD of
// that window, plus its start/end timestamps. If nothing usable, returns null.
function findStablePlateau(
  data: { t: number; p: number }[],
  windowSec = 4,
): { median: number; sd: number; tStart: number; tEnd: number } | null {
  if (data.length < 8) return null;
  const winMs = windowSec * 1000;
  let best: { median: number; sd: number; tStart: number; tEnd: number } | null = null;
  // Slide one sample at a time. Cheap: O(n*win) but our win is small (<200 samples).
  for (let i = 0; i < data.length; i++) {
    const tEnd = data[i].t + winMs;
    let j = i;
    while (j < data.length && data[j].t < tEnd) j++;
    if (j - i < 8) continue;
    const slice = data.slice(i, j).map((d) => d.p);
    const m = slice.reduce((a, b) => a + b, 0) / slice.length;
    const variance =
      slice.reduce((a, b) => a + (b - m) ** 2, 0) / slice.length;
    const sd = Math.sqrt(variance);
    if (!best || sd < best.sd) {
      const sorted = [...slice].sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)];
      best = { median, sd, tStart: data[i].t, tEnd: data[j - 1].t };
    }
  }
  return best;
}

export default function Page() {
  const [phase, setPhase] = useState<Phase>("intro");
  const [pitch, setPitch] = useState(0);
  const [permissionError, setPermissionError] = useState<string | null>(null);

  const pitchRef = useRef(0);
  const rollRef = useRef(0);
  const gravityZRef = useRef(0);
  const traceRef = useRef<{ t: number; p: number }[]>([]);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const [baseline, setBaseline] = useState<Baseline | null>(null);
  const [plateau, setPlateau] = useState<Plateau | null>(null);
  const [holds, setHolds] = useState<Hold[]>([]);

  // Wake lock so the screen doesn't blank during a session.
  useEffect(() => {
    if (phase === "intro" || phase === "report") return;
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
        // Wake lock is best-effort; fall back silently.
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
  }, [phase]);

  // ---- sensor wiring -----------------------------------------------------
  // We throttle React display updates to ~10 fps so the parent does not re-render
  // at sensor cadence (~60 Hz). The canvas trace pulls from traceRef directly,
  // so the visual smoothness is unaffected.
  const lastDisplayUpdateRef = useRef(0);
  useEffect(() => {
    if (phase === "intro") return;
    const orientHandler = (e: DeviceOrientationEvent) => {
      // beta = rotation around X (pitch). When phone lies flat on belly screen-up
      // in portrait orientation, beta sits near 0 and changes as the belly rises
      // and falls. gamma is roll, used by the positioning gate.
      if (e.beta == null) return;
      const alpha = 0.3;
      const next = pitchRef.current * (1 - alpha) + e.beta * alpha;
      pitchRef.current = next;
      if (e.gamma != null) {
        rollRef.current = rollRef.current * (1 - alpha) + e.gamma * alpha;
      }
      const now = performance.now();
      traceRef.current.push({ t: now, p: next });
      const cutoff = now - 30_000;
      while (traceRef.current.length && traceRef.current[0].t < cutoff) {
        traceRef.current.shift();
      }
      if (now - lastDisplayUpdateRef.current > 100) {
        lastDisplayUpdateRef.current = now;
        setPitch(next);
      }
    };
    const motionHandler = (e: DeviceMotionEvent) => {
      // gravity Z tells us which side of the phone is up. Positive Z (toward
      // viewer) = screen up; negative = screen down. Used in the position gate.
      const g = e.accelerationIncludingGravity;
      if (g && g.z != null) {
        gravityZRef.current = gravityZRef.current * 0.7 + g.z * 0.3;
      }
    };
    window.addEventListener("deviceorientation", orientHandler);
    window.addEventListener("devicemotion", motionHandler);
    return () => {
      window.removeEventListener("deviceorientation", orientHandler);
      window.removeEventListener("devicemotion", motionHandler);
    };
  }, [phase]);

  // ---- live trace render -------------------------------------------------
  useEffect(() => {
    if (phase === "intro" || phase === "report") return;
    let raf = 0;
    const draw = () => {
      const canvas = canvasRef.current;
      if (canvas) {
        const dpr = window.devicePixelRatio || 1;
        const w = canvas.clientWidth;
        const h = canvas.clientHeight;
        if (canvas.width !== w * dpr) {
          canvas.width = w * dpr;
          canvas.height = h * dpr;
        }
        const ctx = canvas.getContext("2d");
        if (ctx) {
          ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
          ctx.clearRect(0, 0, w, h);
          const data = traceRef.current;
          if (data.length > 1) {
            let min = Infinity, max = -Infinity;
            for (const d of data) {
              if (d.p < min) min = d.p;
              if (d.p > max) max = d.p;
            }
            if (plateau) {
              min = Math.min(min, plateau.targetPitch - plateau.toleranceDeg * 2);
              max = Math.max(max, plateau.targetPitch + plateau.toleranceDeg * 2);
            }
            if (max - min < 4) {
              const mid = (min + max) / 2;
              min = mid - 2;
              max = mid + 2;
            }
            const range = max - min;
            const t0 = data[0].t;
            const tN = data[data.length - 1].t;
            const tRange = Math.max(1, tN - t0);
            const yOf = (p: number) => h - ((p - min) / range) * h;
            const xOf = (t: number) => ((t - t0) / tRange) * w;

            if (plateau) {
              const yTop = yOf(plateau.targetPitch + plateau.toleranceDeg);
              const yBot = yOf(plateau.targetPitch - plateau.toleranceDeg);
              ctx.fillStyle = "rgba(34,197,94,0.18)";
              ctx.fillRect(0, yTop, w, yBot - yTop);
              ctx.strokeStyle = "rgba(34,197,94,0.6)";
              ctx.lineWidth = 1;
              const yMid = yOf(plateau.targetPitch);
              ctx.setLineDash([4, 4]);
              ctx.beginPath();
              ctx.moveTo(0, yMid);
              ctx.lineTo(w, yMid);
              ctx.stroke();
              ctx.setLineDash([]);
            }

            if (baseline) {
              ctx.strokeStyle = "rgba(148,163,184,0.4)";
              ctx.beginPath();
              const yB = yOf(baseline.meanPitch);
              ctx.moveTo(0, yB);
              ctx.lineTo(w, yB);
              ctx.stroke();
            }

            ctx.strokeStyle = "#2563eb";
            ctx.lineWidth = 2;
            ctx.beginPath();
            for (let i = 0; i < data.length; i++) {
              const x = xOf(data[i].t);
              const y = yOf(data[i].p);
              if (i === 0) ctx.moveTo(x, y);
              else ctx.lineTo(x, y);
            }
            ctx.stroke();
          }
        }
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [phase, baseline, plateau]);

  // ---- permission flow ---------------------------------------------------
  const requestPermission = useCallback(async () => {
    setPermissionError(null);
    const Doc = (typeof DeviceOrientationEvent !== "undefined" ? DeviceOrientationEvent : null) as
      | (typeof DeviceOrientationEvent & { requestPermission?: () => Promise<"granted" | "denied"> })
      | null;
    const Mot = (typeof DeviceMotionEvent !== "undefined" ? DeviceMotionEvent : null) as
      | (typeof DeviceMotionEvent & { requestPermission?: () => Promise<"granted" | "denied"> })
      | null;
    if (Doc && typeof Doc.requestPermission === "function") {
      try {
        const result = await Doc.requestPermission();
        if (result !== "granted") {
          setPermissionError("Motion access denied. Reload and tap Allow when prompted.");
          return;
        }
      } catch {
        setPermissionError("Could not request motion permission. Try again on a real phone.");
        return;
      }
    }
    if (Mot && typeof Mot.requestPermission === "function") {
      try {
        await Mot.requestPermission();
      } catch {
        // Non-fatal; orientation alone is enough for the core flow.
      }
    }
    if (typeof window !== "undefined" && !("DeviceOrientationEvent" in window)) {
      setPermissionError("This device does not expose motion sensors.");
      return;
    }
    // Same gesture: unlock audio and warm the clip cache so non-interactive
    // playback works through the rest of the session.
    unlockAudio();
    preloadAll();
    traceRef.current = [];
    setPhase("position");
  }, []);

  return (
    <main className="flex-1 flex flex-col items-center px-4 py-6 max-w-md mx-auto w-full">
      <Header phase={phase} />

      {phase === "intro" && (
        <Intro onStart={requestPermission} permissionError={permissionError} />
      )}

      {phase === "position" && (
        <PositionPhase
          pitch={pitch}
          pitchRef={pitchRef}
          rollRef={rollRef}
          gravityZRef={gravityZRef}
          onReady={() => {
            traceRef.current = [];
            setPhase("calibrate");
          }}
        />
      )}

      {phase === "calibrate" && (
        <CalibratePhase
          pitch={pitch}
          canvasRef={canvasRef}
          traceRef={traceRef}
          onDone={(b) => {
            setBaseline(b);
            traceRef.current = [];
            setPhase("learn");
          }}
        />
      )}

      {phase === "learn" && baseline && (
        <LearnPhase
          pitch={pitch}
          baseline={baseline}
          canvasRef={canvasRef}
          traceRef={traceRef}
          pitchRef={pitchRef}
          onDone={(p) => {
            setPlateau(p);
            traceRef.current = [];
            setPhase("practice");
          }}
        />
      )}

      {phase === "practice" && baseline && plateau && (
        <PracticePhase
          pitch={pitch}
          baseline={baseline}
          plateau={plateau}
          canvasRef={canvasRef}
          traceRef={traceRef}
          pitchRef={pitchRef}
          onDone={(h) => {
            setHolds(h);
            setPhase("report");
          }}
        />
      )}

      {phase === "report" && (
        <Report
          baseline={baseline}
          plateau={plateau}
          holds={holds}
          onRestart={() => {
            setBaseline(null);
            setPlateau(null);
            setHolds([]);
            traceRef.current = [];
            setPhase("intro");
          }}
        />
      )}
    </main>
  );
}

function Header({ phase }: { phase: Phase }) {
  const stepNum =
    phase === "position"
      ? 1
      : phase === "calibrate"
      ? 2
      : phase === "learn"
      ? 3
      : phase === "practice"
      ? 4
      : null;
  const totalSteps = 4;
  return (
    <header className="w-full mb-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold tracking-tight">DIBH Coach</h1>
        {stepNum && <span className="text-xs text-slate-500">Step {stepNum} of {totalSteps}</span>}
      </div>
    </header>
  );
}

function Intro({
  onStart,
  permissionError,
}: {
  onStart: () => void;
  permissionError: string | null;
}) {
  return (
    <div className="flex-1 flex flex-col gap-4 w-full">
      <div className="rounded-2xl bg-blue-50 p-5">
        <h2 className="text-2xl font-semibold mb-2">Practice your breath-hold at home</h2>
        <p className="text-slate-700">
          A short, three-step session that helps you reproduce the same deep-inspiration
          breath-hold you do at the simulator. Built for left-sided breast radiation patients.
        </p>
      </div>

      <ol className="space-y-3 text-slate-700">
        <li className="flex gap-3">
          <span className="font-mono text-blue-600 font-semibold">1.</span>
          <span>
            Lie flat on your back. Place this phone <strong>screen-up on your belly</strong>,
            held in <strong>portrait</strong>, charging port toward your feet, on the dot your
            doctor drew.
          </span>
        </li>
        <li className="flex gap-3">
          <span className="font-mono text-blue-600 font-semibold">2.</span>
          <span>We&apos;ll check your phone is set right, then record a baseline.</span>
        </li>
        <li className="flex gap-3">
          <span className="font-mono text-blue-600 font-semibold">3.</span>
          <span>We&apos;ll learn your breath-hold, then practice with audio coaching.</span>
        </li>
      </ol>

      <button
        onClick={onStart}
        className="mt-2 w-full rounded-xl bg-blue-600 hover:bg-blue-700 text-white font-semibold py-4 text-lg active:scale-[0.99] transition"
      >
        Enable motion sensors & start
      </button>
      {permissionError && <p className="text-sm text-red-600">{permissionError}</p>}
      <p className="text-xs text-slate-500 leading-relaxed mt-2">
        This is a practice tool, not a medical device. It does not replace any instruction
        from your radiation oncology team.
      </p>
    </div>
  );
}

function PositionPhase({
  pitch,
  pitchRef,
  rollRef,
  gravityZRef,
  onReady,
}: {
  pitch: number;
  pitchRef: React.RefObject<number>;
  rollRef: React.RefObject<number>;
  gravityZRef: React.RefObject<number>;
  onReady: () => void;
}) {
  // "Steady & flat" check: |pitch| and |roll| both small, screen up, and the
  // values aren't moving much for 2 consecutive seconds.
  const [status, setStatus] = useState<"hunting" | "ready">("hunting");
  const [reason, setReason] = useState<string>("Place phone flat, screen-up, on your belly.");
  const stableSinceRef = useRef<number | null>(null);

  useEffect(() => {
    const id = setInterval(() => {
      const p = pitchRef.current;
      const r = rollRef.current;
      const gz = gravityZRef.current;
      const flat = Math.abs(p) < 25 && Math.abs(r) < 25;
      const screenUp = gz > 4; // gravity ≈ 9.8 m/s² toward viewer when screen-up
      if (!screenUp && Math.abs(gz) > 0.1) {
        setReason("Phone looks face-down. Screen should face up at the ceiling.");
        stableSinceRef.current = null;
        setStatus("hunting");
        return;
      }
      if (!flat) {
        setReason("Lay the phone flat on your belly.");
        stableSinceRef.current = null;
        setStatus("hunting");
        return;
      }
      // OK — start the stability timer
      if (stableSinceRef.current == null) {
        stableSinceRef.current = performance.now();
        setReason("Almost there — hold still…");
        setStatus("hunting");
        return;
      }
      if (performance.now() - stableSinceRef.current > 2000) {
        setReason("Ready.");
        setStatus("ready");
      }
    }, 200);
    return () => clearInterval(id);
  }, [pitchRef, rollRef, gravityZRef]);

  return (
    <div className="flex-1 flex flex-col gap-4 w-full">
      <h2 className="text-xl font-semibold">Position your phone</h2>
      <p className="text-slate-700 text-sm">
        Lie flat on your back. Phone <strong>screen-up</strong>, in <strong>portrait</strong>,
        charging port toward your feet, resting on the dot your doctor drew.
      </p>

      <div
        className={`rounded-2xl p-6 text-center transition-colors ${
          status === "ready" ? "bg-green-100 text-green-900" : "bg-slate-100 text-slate-700"
        }`}
      >
        <div className="text-5xl mb-2">{status === "ready" ? "✓" : "…"}</div>
        <div className="font-semibold">{reason}</div>
        <div className="mt-3 text-xs font-mono text-slate-500">
          pitch {fmt(pitch)}° · roll {fmt(rollRef.current ?? 0)}°
        </div>
      </div>

      <button
        onClick={onReady}
        className="w-full rounded-xl font-semibold py-4 text-lg bg-blue-600 hover:bg-blue-700 text-white transition"
      >
        {status === "ready" ? "Continue to baseline" : "Continue anyway"}
      </button>
      <p className="text-xs text-slate-500 text-center">
        The check above is a hint — tap Continue when you&apos;re lying flat with the phone on
        your belly, even if it hasn&apos;t turned green.
      </p>
    </div>
  );
}

const SETTLE_SECONDS = 3; // discard first N seconds of baseline samples

function CalibratePhase({
  pitch,
  canvasRef,
  traceRef,
  onDone,
}: {
  pitch: number;
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  traceRef: React.RefObject<{ t: number; p: number }[]>;
  onDone: (b: Baseline) => void;
}) {
  const [running, setRunning] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState(CALIBRATE_SECONDS);
  const [warning, setWarning] = useState<string | null>(null);
  const startedAtRef = useRef<number | null>(null);
  const onDoneRef = useRef(onDone);
  useEffect(() => {
    onDoneRef.current = onDone;
  });

  const stop = useCallback(() => {
    setRunning(false);
    setSecondsLeft(CALIBRATE_SECONDS);
  }, []);

  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => {
      setSecondsLeft((s) => {
        if (s <= 1) {
          clearInterval(id);
          const start = startedAtRef.current ?? performance.now() - CALIBRATE_SECONDS * 1000;
          // Discard the settling window — the patient is often still positioning
          // the phone in the first few seconds.
          const settledFrom = start + SETTLE_SECONDS * 1000;
          const samples = traceRef.current
            .filter((d) => d.t >= settledFrom)
            .map((d) => d.p);
          if (samples.length < 30) {
            setWarning("Not enough sensor data — make sure motion is enabled and try again.");
            playClip("baseline_low_data");
            setRunning(false);
            return CALIBRATE_SECONDS;
          }
          const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
          const min = Math.min(...samples);
          const max = Math.max(...samples);
          const amplitude = max - min;
          const usableSec = CALIBRATE_SECONDS - SETTLE_SECONDS;
          const bpm = estimateBreathRate(samples, usableSec);

          // Sanity gates
          if (amplitude < 0.5) {
            setWarning(
              "Almost no chest movement detected. Make sure the phone is flat on your belly and breathe normally.",
            );
            playClip("baseline_no_breath");
            setRunning(false);
            return CALIBRATE_SECONDS;
          }
          if (amplitude > 25) {
            setWarning(
              "Too much movement — try lying still and breathing normally without talking.",
            );
            playClip("baseline_too_much");
            setRunning(false);
            return CALIBRATE_SECONDS;
          }
          if (bpm > 0 && (bpm < 5 || bpm > 30)) {
            setWarning(
              `Breath rate looked off (~${bpm.toFixed(0)} per minute). Breathe naturally and try again.`,
            );
            playClip("baseline_odd_rate");
            setRunning(false);
            return CALIBRATE_SECONDS;
          }

          setWarning(null);
          playClip("baseline_done");
          onDoneRef.current({ meanPitch: mean, amplitudeDeg: amplitude });
          return 0;
        }
        return s - 1;
      });
    }, 1000);
    return () => clearInterval(id);
  }, [running, traceRef]);

  return (
    <div className="flex-1 flex flex-col gap-4 w-full">
      <h2 className="text-xl font-semibold">Baseline</h2>
      <p className="text-slate-700">
        Lie flat. Phone screen-up on your belly at the dot. Breathe normally — no holds —
        for {CALIBRATE_SECONDS} seconds. The first {SETTLE_SECONDS}s are ignored while you settle.
      </p>

      <Trace canvasRef={canvasRef} pitch={pitch} />

      {warning && (
        <div className="rounded-xl bg-amber-50 border border-amber-200 p-3 text-sm text-amber-900">
          {warning}
        </div>
      )}

      {!running ? (
        <button
          onClick={() => {
            traceRef.current = [];
            startedAtRef.current = performance.now();
            setSecondsLeft(CALIBRATE_SECONDS);
            setRunning(true);
            playClip("baseline_intro");
          }}
          className="rounded-xl bg-blue-600 hover:bg-blue-700 text-white font-semibold py-4 text-lg"
        >
          {warning ? `Restart baseline (${CALIBRATE_SECONDS}s)` : `Start baseline (${CALIBRATE_SECONDS}s)`}
        </button>
      ) : (
        <div className="rounded-xl bg-slate-100 py-4 text-center">
          <div className="text-4xl font-mono font-semibold text-slate-800">{secondsLeft}s</div>
          <div className="text-sm text-slate-500 mt-1">
            {CALIBRATE_SECONDS - secondsLeft < SETTLE_SECONDS
              ? "Settling… keep still"
              : "Keep breathing normally…"}
          </div>
          <button
            onClick={stop}
            className="mt-3 text-xs text-slate-500 underline"
          >
            Cancel and restart
          </button>
        </div>
      )}
    </div>
  );
}

const PLATEAU_WINDOW_SEC = 4; // look for a stable 4s region inside the hold
const PLATEAU_SD_LIMIT = 1.5; // if no 4s window has SD < this, the hold is unstable

function LearnPhase({
  pitch,
  baseline,
  canvasRef,
  traceRef,
  pitchRef,
  onDone,
}: {
  pitch: number;
  baseline: Baseline;
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  traceRef: React.RefObject<{ t: number; p: number }[]>;
  pitchRef: React.RefObject<number>;
  onDone: (p: Plateau) => void;
}) {
  const [holdIdx, setHoldIdx] = useState(0);
  const [stage, setStage] = useState<"idle" | "inhale" | "hold" | "rest">("idle");
  const [holdSecondsLeft, setHoldSecondsLeft] = useState(HOLD_SECONDS);
  const [lastHoldNote, setLastHoldNote] = useState<string | null>(null);
  const peaksRef = useRef<number[]>([]); // signed deviation from baseline
  const holdStartRef = useRef<number | null>(null);
  const onDoneRef = useRef(onDone);
  useEffect(() => {
    onDoneRef.current = onDone;
  });

  const finalize = useCallback(() => {
    const peaks = peaksRef.current;
    if (peaks.length === 0) return;
    const mean = peaks.reduce((a, b) => a + b, 0) / peaks.length;
    const variance =
      peaks.reduce((a, b) => a + (b - mean) ** 2, 0) / peaks.length;
    const sd = Math.sqrt(variance);
    const tolerance = Math.max(1, sd * 1.5);
    playClip("learn_complete");
    onDoneRef.current({
      targetPitch: baseline.meanPitch + mean,
      toleranceDeg: tolerance,
      peaks: peaks.map((p) => baseline.meanPitch + p),
    });
  }, [baseline]);

  const runHold = useCallback(() => {
    setLastHoldNote(null);
    setStage("inhale");
    playClip("learn_inhale");
    setTimeout(() => {
      setStage("hold");
      playClip("learn_hold");
      holdStartRef.current = performance.now();
      let s = HOLD_SECONDS;
      setHoldSecondsLeft(s);
      const tick = setInterval(() => {
        s -= 1;
        setHoldSecondsLeft(s);
        if (s <= 0) {
          clearInterval(tick);
          const start = holdStartRef.current ?? performance.now();
          const data = traceRef.current.filter((d) => d.t >= start);

          let plateauPitch: number;
          let isStable = false;
          let note = "";
          const stable = findStablePlateau(data, PLATEAU_WINDOW_SEC);
          if (stable && stable.sd <= PLATEAU_SD_LIMIT) {
            plateauPitch = stable.median;
            isStable = true;
            note = `Plateau locked (SD ${stable.sd.toFixed(2)}°)`;
          } else if (stable) {
            // Found a window but it was wobbly — still record but flag
            plateauPitch = stable.median;
            note = `Hold was a bit wobbly (SD ${stable.sd.toFixed(2)}°). Tap Redo if it didn't feel right.`;
          } else if (data.length > 0) {
            plateauPitch =
              data.reduce((a, b) => a + b.p, 0) / data.length;
            note = "Short hold — used overall mean. Tap Redo if you want.";
          } else {
            plateauPitch = pitchRef.current;
            note = "No samples captured. Please redo.";
          }

          const deviation = plateauPitch - baseline.meanPitch;
          // Stash provisionally — if the user taps Redo we replace it.
          peaksRef.current.push(deviation);
          setLastHoldNote(note);
          playClip(isStable ? "learn_release_good" : "learn_release");
          setStage("rest");
        }
      }, 1000);
    }, 4000);
  }, [baseline, traceRef, pitchRef]);

  const acceptAndContinue = () => {
    const next = holdIdx + 1;
    if (next >= LEARN_HOLDS) {
      finalize();
    } else {
      setHoldIdx(next);
      setStage("idle");
      setLastHoldNote(null);
    }
  };

  const redoHold = () => {
    // Drop the last recorded peak and rerun the same hold index.
    peaksRef.current.pop();
    setStage("idle");
    setLastHoldNote(null);
  };

  return (
    <div className="flex-1 flex flex-col gap-4 w-full">
      <h2 className="text-xl font-semibold">Learn your breath-hold</h2>
      <p className="text-slate-700">
        Five holds. We&apos;ll cue you. Take a deep breath in, hold it for {HOLD_SECONDS} seconds,
        then release. Phone stays flat on your belly.
      </p>

      <Trace canvasRef={canvasRef} pitch={pitch} />

      <div className="rounded-xl bg-slate-100 p-4 text-center">
        <div className="text-sm text-slate-500">
          Hold {Math.min(holdIdx + 1, LEARN_HOLDS)} of {LEARN_HOLDS}
          {peaksRef.current.length > 0 &&
            ` · captured ${peaksRef.current.length}`}
        </div>
        {stage === "idle" && (
          <button
            onClick={runHold}
            className="mt-3 w-full rounded-xl bg-blue-600 hover:bg-blue-700 text-white font-semibold py-3"
          >
            Start hold {holdIdx + 1}
          </button>
        )}
        {stage === "inhale" && (
          <div className="mt-3 text-2xl font-semibold text-blue-700">Breathe in…</div>
        )}
        {stage === "hold" && (
          <div className="mt-3">
            <div className="text-3xl font-mono font-semibold text-blue-700">{holdSecondsLeft}s</div>
            <div className="text-sm text-slate-500">Hold it</div>
          </div>
        )}
        {stage === "rest" && (
          <div className="mt-3 flex flex-col gap-2">
            <div className="text-lg text-slate-700">Release. Breathe.</div>
            {lastHoldNote && (
              <div className="text-xs text-slate-500">{lastHoldNote}</div>
            )}
            <div className="grid grid-cols-2 gap-2 mt-2">
              <button
                onClick={redoHold}
                className="rounded-xl bg-slate-200 hover:bg-slate-300 text-slate-800 font-semibold py-2"
              >
                Redo
              </button>
              <button
                onClick={acceptAndContinue}
                className="rounded-xl bg-blue-600 hover:bg-blue-700 text-white font-semibold py-2"
              >
                {holdIdx + 1 >= LEARN_HOLDS ? "Finish" : "Next hold"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

type ZoneState = "below" | "inZone" | "above" | "wayOff";

const DRIFT_LIMIT_MS = 3000; // sustained out-of-zone before "release" cue
const REASSURE_INTERVAL_MS = 2500; // how often to re-speak "hold steady"

function PracticePhase({
  pitch,
  baseline,
  plateau,
  canvasRef,
  traceRef,
  pitchRef,
  onDone,
}: {
  pitch: number;
  baseline: Baseline;
  plateau: Plateau;
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  traceRef: React.RefObject<{ t: number; p: number }[]>;
  pitchRef: React.RefObject<number>;
  onDone: (h: Hold[]) => void;
}) {
  const [holdIdx, setHoldIdx] = useState(0);
  const [stage, setStage] = useState<"idle" | "inhale" | "hold" | "rest">("idle");
  const [holdSecondsLeft, setHoldSecondsLeft] = useState(HOLD_SECONDS);
  const [zone, setZone] = useState<ZoneState>("inZone");
  const holdsRef = useRef<Hold[]>([]);
  const holdStartRef = useRef<number | null>(null);
  const outOfZoneSinceRef = useRef<number | null>(null);
  const lastCueRef = useRef<{ t: number; cue: string }>({ t: 0, cue: "" });
  const onDoneRef = useRef(onDone);
  useEffect(() => {
    onDoneRef.current = onDone;
  });

  // ---- live coaching during hold ---------------------------------------
  useEffect(() => {
    if (stage !== "hold") return;
    const id = setInterval(() => {
      const dev = pitchRef.current - plateau.targetPitch;
      const absDev = Math.abs(dev);
      const inZone = absDev <= plateau.toleranceDeg;

      // track sustained out-of-zone
      const now = performance.now();
      if (inZone) {
        outOfZoneSinceRef.current = null;
      } else if (outOfZoneSinceRef.current == null) {
        outOfZoneSinceRef.current = now;
      }
      const sustainedMs = outOfZoneSinceRef.current
        ? now - outOfZoneSinceRef.current
        : 0;

      let next: ZoneState;
      if (inZone) next = "inZone";
      else if (sustainedMs > DRIFT_LIMIT_MS || absDev > plateau.toleranceDeg * 3)
        next = "wayOff";
      else if (dev > 0) next = "above";
      else next = "below";
      setZone(next);

      // speak cues — debounce so we don't jabber
      const cue = next;
      const last = lastCueRef.current;
      const elapsed = now - last.t;
      const shouldSpeak =
        (cue !== last.cue && elapsed > 1500) ||
        (cue === "inZone" && elapsed > REASSURE_INTERVAL_MS) ||
        (cue === "wayOff" && elapsed > REASSURE_INTERVAL_MS);
      if (shouldSpeak) {
        lastCueRef.current = { t: now, cue };
        const clipKey: PhraseKey =
          cue === "inZone"
            ? "practice_in_zone"
            : cue === "below"
            ? "practice_below"
            : cue === "above"
            ? "practice_above"
            : "practice_drift";
        playClip(clipKey);
      }
    }, 400);
    return () => clearInterval(id);
  }, [stage, plateau, pitchRef]);

  const runHold = useCallback(() => {
    setStage("inhale");
    setZone("inZone");
    outOfZoneSinceRef.current = null;
    lastCueRef.current = { t: 0, cue: "" };
    playClip("practice_inhale");
    setTimeout(() => {
      setStage("hold");
      playClip("practice_hold");
      holdStartRef.current = performance.now();
      let s = HOLD_SECONDS;
      setHoldSecondsLeft(s);
      const tick = setInterval(() => {
        s -= 1;
        setHoldSecondsLeft(s);
        if (s <= 0) {
          clearInterval(tick);
          const start = holdStartRef.current ?? performance.now();
          const samples = traceRef.current.filter((d) => d.t >= start).map((d) => d.p);
          const inZoneCount = samples.filter(
            (p) => Math.abs(p - plateau.targetPitch) <= plateau.toleranceDeg,
          ).length;
          let peak = baseline.meanPitch;
          for (const v of samples) {
            if (Math.abs(v - baseline.meanPitch) > Math.abs(peak - baseline.meanPitch)) {
              peak = v;
            }
          }
          const mean = samples.length
            ? samples.reduce((a, b) => a + b, 0) / samples.length
            : baseline.meanPitch;
          const inZonePct = samples.length ? (inZoneCount / samples.length) * 100 : 0;
          holdsRef.current.push({
            durationSec: HOLD_SECONDS,
            peakPitch: peak,
            meanPitchInHold: mean,
            inZonePct,
          });
          playClip("practice_release");
          setStage("rest");
          setTimeout(() => {
            const next = holdIdx + 1;
            if (next >= PRACTICE_HOLDS) {
              playClip("practice_done");
              onDoneRef.current(holdsRef.current);
            } else {
              setHoldIdx(next);
              setStage("idle");
            }
          }, 3000);
        }
      }, 1000);
    }, 4500);
  }, [holdIdx, baseline, plateau, traceRef]);

  // ---- visual during hold: full-screen color + big glanceable cue ------
  if (stage === "hold") {
    return (
      <HoldOverlay
        zone={zone}
        secondsLeft={holdSecondsLeft}
        pitch={pitch}
        plateau={plateau}
        holdIdx={holdIdx}
      />
    );
  }

  return (
    <div className="flex-1 flex flex-col gap-4 w-full">
      <h2 className="text-xl font-semibold">Practice</h2>
      <p className="text-slate-700 text-sm">
        Inhale a bit past your target, then ease down into the green zone and hold there.
        Audio will guide you. The screen will go full color so you can glance at it.
      </p>

      <Trace canvasRef={canvasRef} pitch={pitch} />

      <div className="rounded-xl bg-slate-100 py-3 px-4 text-center text-sm text-slate-500">
        Target {fmt(plateau.targetPitch)}° ± {fmt(plateau.toleranceDeg)}°
      </div>

      <div className="rounded-xl bg-slate-100 p-4 text-center">
        <div className="text-sm text-slate-500">
          Hold {Math.min(holdIdx + 1, PRACTICE_HOLDS)} of {PRACTICE_HOLDS}
        </div>
        {stage === "idle" && (
          <button
            onClick={runHold}
            className="mt-3 w-full rounded-xl bg-blue-600 hover:bg-blue-700 text-white font-semibold py-3"
          >
            Start hold {holdIdx + 1}
          </button>
        )}
        {stage === "inhale" && (
          <div className="mt-3 text-2xl font-semibold text-blue-700">
            Breathe in… ease down into the zone
          </div>
        )}
        {stage === "rest" && (
          <div className="mt-3 text-lg text-slate-700">Release. Breathe.</div>
        )}
      </div>
    </div>
  );
}

function HoldOverlay({
  zone,
  secondsLeft,
  pitch,
  plateau,
  holdIdx,
}: {
  zone: ZoneState;
  secondsLeft: number;
  pitch: number;
  plateau: Plateau;
  holdIdx: number;
}) {
  const dev = pitch - plateau.targetPitch;
  const palette =
    zone === "inZone"
      ? "bg-green-500 text-white"
      : zone === "wayOff"
      ? "bg-red-600 text-white"
      : "bg-amber-500 text-white";
  const word =
    zone === "inZone"
      ? "HOLD"
      : zone === "below"
      ? "DEEPER ↑"
      : zone === "above"
      ? "EASE ↓"
      : "RELEASE";
  const sub =
    zone === "inZone"
      ? "Stay right here"
      : zone === "below"
      ? "Breathe in a little more"
      : zone === "above"
      ? "Ease down into the zone"
      : "Release and try again";
  return (
    <div className={`fixed inset-0 z-50 flex flex-col items-center justify-center ${palette} transition-colors`}>
      <div className="absolute top-4 left-4 text-xs opacity-80">
        Hold {Math.min(holdIdx + 1, PRACTICE_HOLDS)} of {PRACTICE_HOLDS}
      </div>
      <div className="absolute top-4 right-4 text-xl font-mono font-semibold">{secondsLeft}s</div>
      <div className="text-7xl font-extrabold tracking-tight">{word}</div>
      <div className="mt-2 text-lg opacity-90">{sub}</div>
      <div className="mt-8 text-sm font-mono opacity-80">
        pitch {fmt(pitch)}° · target {fmt(plateau.targetPitch)}° ({dev >= 0 ? "+" : ""}
        {fmt(dev)}°)
      </div>
    </div>
  );
}

function Report({
  baseline,
  plateau,
  holds,
  onRestart,
}: {
  baseline: Baseline | null;
  plateau: Plateau | null;
  holds: Hold[];
  onRestart: () => void;
}) {
  const meanInZone =
    holds.length > 0 ? holds.reduce((a, h) => a + h.inZonePct, 0) / holds.length : 0;
  const meanPeak =
    holds.length > 0 ? holds.reduce((a, h) => a + h.peakPitch, 0) / holds.length : 0;
  const peakSd =
    holds.length > 1
      ? Math.sqrt(
          holds.reduce((a, h) => a + (h.peakPitch - meanPeak) ** 2, 0) / holds.length,
        )
      : 0;

  return (
    <div className="flex-1 flex flex-col gap-4 w-full">
      <h2 className="text-xl font-semibold">Session report</h2>

      <div className="grid grid-cols-2 gap-3">
        <Stat label="Holds completed" value={String(holds.length)} />
        <Stat label="Avg time in zone" value={`${fmt(meanInZone, 0)}%`} />
        <Stat label="Avg peak pitch" value={`${fmt(meanPeak)}°`} />
        <Stat label="Reproducibility (SD)" value={`±${fmt(peakSd)}°`} />
      </div>

      {plateau && (
        <div className="rounded-xl bg-slate-50 p-4 text-sm text-slate-700">
          <div>
            Learned target: {fmt(plateau.targetPitch)}° ± {fmt(plateau.toleranceDeg)}°
          </div>
          {baseline && (
            <div>
              Baseline: {fmt(baseline.meanPitch)}° (amplitude {fmt(baseline.amplitudeDeg)}°)
            </div>
          )}
        </div>
      )}

      <details className="rounded-xl bg-slate-50 p-4 text-sm">
        <summary className="font-semibold cursor-pointer">Per-hold detail</summary>
        <table className="w-full mt-3 text-left">
          <thead className="text-slate-500">
            <tr>
              <th>#</th>
              <th>Peak</th>
              <th>Mean</th>
              <th>In zone</th>
            </tr>
          </thead>
          <tbody>
            {holds.map((h, i) => (
              <tr key={i} className="border-t border-slate-200">
                <td>{i + 1}</td>
                <td>{fmt(h.peakPitch)}°</td>
                <td>{fmt(h.meanPitchInHold)}°</td>
                <td>{fmt(h.inZonePct, 0)}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>

      <button
        onClick={onRestart}
        className="mt-2 rounded-xl bg-blue-600 hover:bg-blue-700 text-white font-semibold py-3"
      >
        Practice again
      </button>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-slate-50 p-3">
      <div className="text-xs text-slate-500">{label}</div>
      <div className="text-2xl font-semibold mt-1">{value}</div>
    </div>
  );
}

function Trace({
  canvasRef,
  pitch,
}: {
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  pitch: number;
}) {
  return (
    <div className="rounded-xl bg-white border border-slate-200 overflow-hidden">
      <canvas ref={canvasRef} className="w-full h-40" />
      <div className="px-3 py-2 text-xs text-slate-500 border-t border-slate-100 flex justify-between">
        <span>Pitch (deg)</span>
        <span className="font-mono">{fmt(pitch)}°</span>
      </div>
    </div>
  );
}
