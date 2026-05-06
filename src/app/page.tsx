"use client";

import { useEffect, useRef, useState, useCallback, type ReactNode } from "react";
import { playClip, preloadAll, unlockAudio, type PhraseKey } from "@/audio";

// ─── Soft Bloom palette (Tide direction B) ──────────────────────────────────
const P = {
  bg: "#f5eef0",
  bgGrad: "linear-gradient(180deg, #f5eef0 0%, #e8eef5 100%)",
  ink: "#3a3346",
  ink2: "#5b5468",
  muted: "#9892a3",
  hairline: "rgba(58,51,70,0.1)",
  accent: "#c69cb3",
  accentDeep: "#8b6c84",
  sky: "#a8c1de",
  skyDeep: "#6f8db1",
  halo: "rgba(198,156,179,0.5)",
  haloSky: "rgba(168,193,222,0.4)",
  blob1: "rgba(198,156,179,0.45)",
  blob2: "rgba(168,193,222,0.4)",
  blob3: "rgba(240,216,230,0.6)",
  good: "#7aa884",
  warn: "#d99466",
};

type Phase = "welcome" | "placement" | "calibration" | "session" | "complete";

type Baseline = { meanPitch: number; amplitudeDeg: number; breathingSD: number };
type Hold = {
  index: number;
  totalDurationSec: number;
  stableSec: number; // total accumulated time inside stability tolerance
  longestRunSec: number; // longest single contiguous stable run
  driftEvents: number;
  timeToLockSec: number | null; // seconds from "start" to first stability lock
  plateauPitch: number | null; // median pitch during the longest stable run
  plateauSD: number | null; // SD during the longest stable run
  reachedTarget: boolean;
};

// ─── Tunables ───────────────────────────────────────────────────────────────
const STABILITY_WINDOW_MS = 2000; // SD over the last N ms = stability check
// Adaptive stability threshold: baseline breathing SD × this fraction.
// Two real recordings showed: belly-mode baseline SD ≈ 0.8°, hold SD ≈ 0.07°
// (11× ratio); chest-mode baseline SD ≈ 1.0°, hold SD ≈ 0.50° (2× ratio).
// The 0.7 multiplier comfortably accommodates both:
//   belly threshold = 0.56° → hold (0.07°) sits 8× below
//   chest threshold = 0.69° → hold (0.50°) sits 1.4× below (acceptable)
// Lower multipliers (0.5) flickered for chest-mode holders.
const STABLE_SD_FRAC_OF_BASELINE = 0.7;
const STABLE_SD_FLOOR = 0.08;
const STABLE_SD_CEILING = 1.2;
const STABLE_DEBOUNCE_MS = 1000; // must hold stability for this long before "lock" event
const DRIFT_DEBOUNCE_MS = 1500; // out-of-stable for this long before "drift" event
const CALIBRATE_SEC = 12;
const CALIBRATE_SETTLE_SEC = 2;
const HOLD_TARGET_OPTIONS = [15, 20, 25, 30, 35] as const;
const HOLDS_PER_SESSION_OPTIONS = [1, 2, 3, 4, 5] as const;

// ─── Helpers ────────────────────────────────────────────────────────────────
function fmt(n: number, digits = 1) {
  return n.toFixed(digits);
}

function haptic(pattern: number | number[]) {
  if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") {
    try {
      navigator.vibrate(pattern);
    } catch {
      // ignore
    }
  }
}

// SD over a time window in a time-tagged buffer
function rollingSD(data: { t: number; p: number }[], windowMs: number): number {
  if (data.length === 0) return 0;
  const cutoff = data[data.length - 1].t - windowMs;
  let sum = 0,
    count = 0,
    sumSq = 0;
  for (let i = data.length - 1; i >= 0; i--) {
    if (data[i].t < cutoff) break;
    const v = data[i].p;
    sum += v;
    sumSq += v * v;
    count++;
  }
  if (count < 4) return Infinity;
  const mean = sum / count;
  const variance = Math.max(0, sumSq / count - mean * mean);
  return Math.sqrt(variance);
}

// median + SD of all samples within a [tStart, tEnd] window
function summarizeRange(
  data: { t: number; p: number }[],
  tStart: number,
  tEnd: number,
): { median: number; sd: number; n: number } | null {
  const slice = data.filter((d) => d.t >= tStart && d.t <= tEnd).map((d) => d.p);
  if (slice.length < 4) return null;
  const sorted = [...slice].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const mean = slice.reduce((a, b) => a + b, 0) / slice.length;
  const variance = slice.reduce((a, b) => a + (b - mean) ** 2, 0) / slice.length;
  return { median, sd: Math.sqrt(variance), n: slice.length };
}

// Estimate breath rate from samples (zero-crossings of pitch − mean)
function estimateBreathRate(samples: number[], durationSec: number) {
  if (samples.length < 4 || durationSec <= 0) return 0;
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
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
  return ((crossings / 2) * 60) / durationSec;
}

// ─── Visual primitives ──────────────────────────────────────────────────────
function Blobs({ intense = false }: { intense?: boolean }) {
  return (
    <>
      <div
        style={{
          position: "absolute",
          top: "-20%",
          left: "-30%",
          width: "90%",
          height: "60%",
          background: `radial-gradient(circle, ${P.blob1}, transparent 70%)`,
          filter: "blur(20px)",
          pointerEvents: "none",
        }}
      />
      <div
        style={{
          position: "absolute",
          bottom: "-10%",
          right: "-30%",
          width: "90%",
          height: "60%",
          background: `radial-gradient(circle, ${P.blob2}, transparent 70%)`,
          filter: "blur(20px)",
          pointerEvents: "none",
        }}
      />
      {intense && (
        <div
          style={{
            position: "absolute",
            top: "20%",
            right: "-30%",
            width: "90%",
            height: "60%",
            background: `radial-gradient(circle, ${P.blob3}, transparent 70%)`,
            filter: "blur(20px)",
            pointerEvents: "none",
          }}
        />
      )}
    </>
  );
}

function Btn({
  children,
  onClick,
  variant = "primary",
  disabled,
  className = "",
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: "primary" | "ghost";
  disabled?: boolean;
  className?: string;
}) {
  const base =
    "w-full rounded-full font-semibold text-base transition-transform active:scale-[0.98] disabled:opacity-40 disabled:cursor-not-allowed";
  if (variant === "primary") {
    return (
      <button
        onClick={onClick}
        disabled={disabled}
        className={`${base} h-14 text-white ${className}`}
        style={{
          background: `linear-gradient(135deg, ${P.accentDeep}, ${P.skyDeep})`,
          boxShadow: `0 12px 28px ${P.halo}`,
          border: "none",
        }}
      >
        {children}
      </button>
    );
  }
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`${base} h-12 ${className}`}
      style={{
        background: "rgba(255,255,255,0.55)",
        backdropFilter: "blur(10px)",
        WebkitBackdropFilter: "blur(10px)",
        color: P.ink2,
        border: `1px solid ${P.hairline}`,
        fontSize: 14,
      }}
    >
      {children}
    </button>
  );
}

function Pill({ children }: { children: ReactNode }) {
  return (
    <div
      className="inline-flex items-center gap-1.5 rounded-full text-xs"
      style={{
        padding: "6px 12px",
        background: "rgba(255,255,255,0.7)",
        color: P.ink2,
        border: `1px solid ${P.hairline}`,
      }}
    >
      <span
        className="inline-flex items-center justify-center"
        style={{
          width: 14,
          height: 14,
          borderRadius: 7,
          background: P.accent,
        }}
      >
        <svg width="10" height="10" viewBox="0 0 14 14" fill="none">
          <path d="M3 7.5l3 3 5-7" stroke="#fff" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
      {children}
    </div>
  );
}

function Card({
  children,
  className = "",
  style,
}: {
  children: ReactNode;
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <div
      className={`rounded-3xl ${className}`}
      style={{
        background: "rgba(255,255,255,0.65)",
        backdropFilter: "blur(12px)",
        WebkitBackdropFilter: "blur(12px)",
        border: `1px solid ${P.hairline}`,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

function Figure() {
  return (
    <svg width="220" height="136" viewBox="0 0 220 136" fill="none">
      <line x1="6" y1="118" x2="214" y2="118" stroke={P.ink2} strokeWidth="1" strokeDasharray="2 4" opacity="0.3" />
      <circle cx="32" cy="86" r="14" stroke={P.accentDeep} strokeWidth="1.6" fill="none" />
      <path d="M46 90 Q 90 86 130 95 Q 170 104 200 110" stroke={P.accentDeep} strokeWidth="1.6" fill="none" strokeLinecap="round" />
      <path d="M46 100 Q 90 110 130 113 Q 170 116 200 116" stroke={P.accentDeep} strokeWidth="1.6" fill="none" strokeLinecap="round" opacity="0.5" />
      <path d="M60 96 Q 78 116 102 118" stroke={P.accentDeep} strokeWidth="1.6" fill="none" strokeLinecap="round" />
      <g transform="translate(98 78) rotate(-6)">
        <rect x="0" y="0" width="36" height="22" rx="3.5" fill="#fff" stroke={P.accentDeep} strokeWidth="1.4" />
        <circle cx="18" cy="11" r="3.5" fill={P.accent} />
      </g>
      <path d="M104 60 Q 116 52 128 60" stroke={P.accent} strokeWidth="1.4" fill="none" strokeLinecap="round" opacity="0.7" />
      <path d="M100 50 Q 116 38 132 50" stroke={P.accent} strokeWidth="1.4" fill="none" strokeLinecap="round" opacity="0.45" />
    </svg>
  );
}

type OrbMood = "calm" | "active" | "drifting";

function Orb({
  size = 220,
  breathScale,
  freeze = false,
  mood = "calm",
  secondsLeft,
  label,
}: {
  size?: number;
  // 0..1 — live pitch-driven breath fullness. If undefined, the orb
  // gently rests.
  breathScale?: number;
  // When true, the orb latches at the most recent breathScale and stops
  // tracking — the "apex held" feeling.
  freeze?: boolean;
  mood?: OrbMood;
  secondsLeft?: number | null;
  label?: string;
}) {
  const frozenRef = useRef(0);
  const live = breathScale ?? 0;
  if (!freeze) frozenRef.current = live;
  const breath = freeze ? frozenRef.current : live;
  // Map 0..1 → 0.55..1.08 (clamp). Below 0.05 we treat as "rest" baseline.
  const scale =
    breathScale == null ? 0.78 : 0.55 + Math.min(1, Math.max(0, breath)) * 0.53;
  // Snappier transition while actively tracking, gentler when frozen / resting.
  const dur = breathScale == null ? "0.8s" : freeze ? "0.6s" : "0.25s";
  const haloColor = mood === "drifting" ? "rgba(217,148,102,0.55)" : P.halo;
  const coreGrad =
    mood === "drifting"
      ? `radial-gradient(circle at 35% 30%, #ffffff 0%, ${P.warn} 75%)`
      : `radial-gradient(circle at 35% 30%, #ffffff 0%, ${P.accent} 75%)`;
  void mood;
  return (
    <div
      style={{
        width: size,
        height: size,
        position: "relative",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <div
        style={{
          position: "absolute",
          inset: 0,
          borderRadius: "50%",
          background: `radial-gradient(circle at 50% 50%, ${haloColor} 0%, transparent 65%)`,
          transform: `scale(${scale * 1.05})`,
          transition: `transform ${dur} cubic-bezier(.4,0,.3,1), background 0.6s ease`,
          opacity: 0.85,
        }}
      />
      <div
        style={{
          position: "absolute",
          width: "78%",
          height: "78%",
          borderRadius: "50%",
          border: `1px solid ${P.haloSky}`,
          transform: `scale(${scale * 1.02})`,
          transition: `transform ${dur} cubic-bezier(.4,0,.3,1)`,
        }}
      />
      <div
        style={{
          position: "absolute",
          width: "60%",
          height: "60%",
          borderRadius: "50%",
          background: coreGrad,
          transform: `scale(${scale})`,
          transition: `transform ${dur} cubic-bezier(.4,0,.3,1), background 0.6s ease`,
          boxShadow: `0 24px 70px ${haloColor}`,
        }}
      />
      {(secondsLeft != null || label) && (
        <div
          style={{
            position: "absolute",
            textAlign: "center",
            color: "#fff",
            textShadow: "0 1px 6px rgba(0,0,0,0.18)",
            pointerEvents: "none",
          }}
        >
          {secondsLeft != null && (
            <div
              style={{
                fontSize: 64,
                fontWeight: 200,
                letterSpacing: -2,
                fontVariantNumeric: "tabular-nums",
                lineHeight: 1,
              }}
            >
              {secondsLeft}
            </div>
          )}
          {label && (
            <div
              style={{
                fontSize: 11,
                letterSpacing: 2,
                textTransform: "uppercase",
                marginTop: 4,
                opacity: 0.9,
              }}
            >
              {label}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Header({
  back,
  step,
  totalSteps,
  right,
}: {
  back?: () => void;
  step?: number;
  totalSteps?: number;
  right?: ReactNode;
}) {
  return (
    <div
      className="flex items-center justify-between"
      style={{ paddingTop: 16, paddingLeft: 16, paddingRight: 16, position: "relative", zIndex: 2 }}
    >
      {back ? (
        <button
          onClick={back}
          className="flex items-center justify-center"
          style={{
            width: 40,
            height: 40,
            borderRadius: 20,
            background: "rgba(255,255,255,0.7)",
            backdropFilter: "blur(10px)",
            WebkitBackdropFilter: "blur(10px)",
            border: "none",
            cursor: "pointer",
          }}
          aria-label="Back"
        >
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
            <path d="M12 4l-6 6 6 6" stroke={P.ink2} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      ) : (
        <div style={{ width: 40 }} />
      )}
      {step != null && totalSteps != null ? (
        <div
          style={{
            width: 80,
            height: 4,
            borderRadius: 2,
            background: P.hairline,
            position: "relative",
            overflow: "hidden",
          }}
        >
          <div
            style={{
              position: "absolute",
              left: 0,
              top: 0,
              bottom: 0,
              width: `${(step / totalSteps) * 100}%`,
              background: `linear-gradient(90deg, ${P.accent}, ${P.sky})`,
              borderRadius: 2,
              transition: "width 0.3s ease",
            }}
          />
        </div>
      ) : (
        <div />
      )}
      <div style={{ minWidth: 40, display: "flex", justifyContent: "flex-end" }}>{right}</div>
    </div>
  );
}

// ─── Main page (sensor wiring + phase routing) ──────────────────────────────
export default function Page() {
  const [phase, setPhase] = useState<Phase>("welcome");
  const [pitch, setPitch] = useState(0);
  const [permissionError, setPermissionError] = useState<string | null>(null);

  const pitchRef = useRef(0);
  const traceRef = useRef<{ t: number; p: number }[]>([]);
  const gravityZRef = useRef(0);

  const [baseline, setBaseline] = useState<Baseline | null>(null);
  const [holdTarget, setHoldTarget] = useState<number>(20);
  const [holdsPerSession, setHoldsPerSession] = useState<number>(3);
  const [voiceOn, setVoiceOn] = useState(true);
  const [hapticsOn, setHapticsOn] = useState(true);
  const [holds, setHolds] = useState<Hold[]>([]);

  const cue = useCallback(
    (key: PhraseKey) => {
      if (voiceOn) playClip(key);
    },
    [voiceOn],
  );
  const buzz = useCallback(
    (pattern: number | number[]) => {
      if (hapticsOn) haptic(pattern);
    },
    [hapticsOn],
  );

  // Wake lock during the active session
  useEffect(() => {
    if (phase === "welcome" || phase === "complete") return;
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
  }, [phase]);

  // Sensor wiring (orientation = pitch, motion = gravity Z)
  const lastDisplayUpdateRef = useRef(0);
  useEffect(() => {
    if (phase === "welcome") return;
    const orient = (e: DeviceOrientationEvent) => {
      if (e.beta == null) return;
      const alpha = 0.3;
      const next = pitchRef.current * (1 - alpha) + e.beta * alpha;
      pitchRef.current = next;
      const now = performance.now();
      traceRef.current.push({ t: now, p: next });
      const cutoff = now - 60_000;
      while (traceRef.current.length && traceRef.current[0].t < cutoff) {
        traceRef.current.shift();
      }
      if (now - lastDisplayUpdateRef.current > 100) {
        lastDisplayUpdateRef.current = now;
        setPitch(next);
      }
    };
    const motion = (e: DeviceMotionEvent) => {
      const g = e.accelerationIncludingGravity;
      if (g && g.z != null) {
        gravityZRef.current = gravityZRef.current * 0.7 + g.z * 0.3;
      }
    };
    window.addEventListener("deviceorientation", orient);
    window.addEventListener("devicemotion", motion);
    return () => {
      window.removeEventListener("deviceorientation", orient);
      window.removeEventListener("devicemotion", motion);
    };
  }, [phase]);

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
        const r = await Doc.requestPermission();
        if (r !== "granted") {
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
        // non-fatal
      }
    }
    if (typeof window !== "undefined" && !("DeviceOrientationEvent" in window)) {
      setPermissionError("This device does not expose motion sensors.");
      return;
    }
    unlockAudio();
    preloadAll();
    traceRef.current = [];
    setPhase("placement");
  }, []);

  const restart = () => {
    setBaseline(null);
    setHolds([]);
    traceRef.current = [];
    setPhase("welcome");
  };

  return (
    <main
      className="flex-1 flex items-stretch justify-center"
      style={{
        background: P.bgGrad,
        color: P.ink,
        minHeight: "100dvh",
      }}
    >
      <div
        className="relative w-full max-w-md flex flex-col"
        style={{ minHeight: "100dvh", overflow: "hidden" }}
      >
        {phase === "welcome" && (
          <Welcome
            onStart={requestPermission}
            permissionError={permissionError}
            holdTarget={holdTarget}
            setHoldTarget={setHoldTarget}
            holdsPerSession={holdsPerSession}
            setHoldsPerSession={setHoldsPerSession}
            voiceOn={voiceOn}
            setVoiceOn={setVoiceOn}
            hapticsOn={hapticsOn}
            setHapticsOn={setHapticsOn}
          />
        )}

        {phase === "placement" && (
          <Placement
            pitch={pitch}
            pitchRef={pitchRef}
            gravityZRef={gravityZRef}
            onContinue={() => {
              traceRef.current = [];
              setPhase("calibration");
            }}
            onBack={restart}
          />
        )}

        {phase === "calibration" && (
          <Calibration
            pitch={pitch}
            traceRef={traceRef}
            onContinue={(b) => {
              setBaseline(b);
              traceRef.current = [];
              setPhase("session");
            }}
            onBack={() => setPhase("placement")}
            cue={cue}
          />
        )}

        {phase === "session" && baseline && (
          <Session
            baseline={baseline}
            holdTarget={holdTarget}
            holdsPerSession={holdsPerSession}
            pitch={pitch}
            pitchRef={pitchRef}
            traceRef={traceRef}
            cue={cue}
            buzz={buzz}
            onComplete={(h) => {
              setHolds(h);
              setPhase("complete");
            }}
            onAbort={restart}
          />
        )}

        {phase === "complete" && (
          <Complete
            holds={holds}
            holdTarget={holdTarget}
            onAgain={() => {
              setHolds([]);
              traceRef.current = [];
              setPhase("placement");
            }}
            onDone={restart}
          />
        )}
      </div>
    </main>
  );
}

// ─── Welcome ────────────────────────────────────────────────────────────────
function Welcome({
  onStart,
  permissionError,
  holdTarget,
  setHoldTarget,
  holdsPerSession,
  setHoldsPerSession,
  voiceOn,
  setVoiceOn,
  hapticsOn,
  setHapticsOn,
}: {
  onStart: () => void;
  permissionError: string | null;
  holdTarget: number;
  setHoldTarget: (n: number) => void;
  holdsPerSession: number;
  setHoldsPerSession: (n: number) => void;
  voiceOn: boolean;
  setVoiceOn: (v: boolean) => void;
  hapticsOn: boolean;
  setHapticsOn: (v: boolean) => void;
}) {
  const [showSettings, setShowSettings] = useState(false);
  return (
    <div className="relative flex-1 flex flex-col" style={{ overflow: "hidden" }}>
      <Blobs intense />
      <Header
        right={
          <button
            onClick={() => setShowSettings((s) => !s)}
            className="flex items-center justify-center"
            style={{
              width: 40,
              height: 40,
              borderRadius: 20,
              background: "rgba(255,255,255,0.7)",
              backdropFilter: "blur(10px)",
              WebkitBackdropFilter: "blur(10px)",
              border: "none",
              cursor: "pointer",
            }}
            aria-label="Settings"
          >
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
              <circle cx="10" cy="10" r="2.5" stroke={P.ink2} strokeWidth="1.6" />
              <path
                d="M10 1.5v2M10 16.5v2M3.5 3.5l1.4 1.4M15.1 15.1l1.4 1.4M1.5 10h2M16.5 10h2M3.5 16.5l1.4-1.4M15.1 4.9l1.4-1.4"
                stroke={P.ink2}
                strokeWidth="1.6"
                strokeLinecap="round"
              />
            </svg>
          </button>
        }
      />
      <div
        className="relative flex-1 flex flex-col justify-between"
        style={{ padding: "60px 32px 40px", zIndex: 1 }}
      >
        <div>
          <div className="flex items-center gap-2.5 mb-8">
            <div
              style={{
                width: 36,
                height: 36,
                borderRadius: 18,
                background: `linear-gradient(135deg, ${P.accent}, ${P.sky})`,
              }}
            />
            <div className="text-sm font-semibold" style={{ color: P.ink }}>
              Tide
            </div>
          </div>
          <h1
            style={{
              fontSize: 44,
              lineHeight: 1.05,
              fontWeight: 700,
              letterSpacing: -1.2,
              color: P.ink,
              margin: 0,
            }}
          >
            Hello.<br />
            Let&apos;s take a<br />
            <span
              style={{
                background: `linear-gradient(135deg, ${P.accentDeep}, ${P.skyDeep})`,
                WebkitBackgroundClip: "text",
                WebkitTextFillColor: "transparent",
              }}
            >
              quiet moment.
            </span>
          </h1>
          <p
            style={{
              fontSize: 15,
              lineHeight: 1.6,
              color: P.ink2,
              marginTop: 24,
              maxWidth: 320,
            }}
          >
            We&apos;ll guide you through deep breath holds for your radiation therapy. No
            pressure — just your breath, and us.
          </p>

          {showSettings && (
            <Card className="mt-8 p-5">
              <div className="text-xs font-semibold uppercase tracking-wider mb-3" style={{ color: P.muted }}>
                This session
              </div>
              <SettingRow label="Hold target">
                <SegmentedNumber
                  value={holdTarget}
                  options={HOLD_TARGET_OPTIONS}
                  unit="s"
                  onChange={setHoldTarget}
                />
              </SettingRow>
              <SettingRow label="Holds per session">
                <SegmentedNumber
                  value={holdsPerSession}
                  options={HOLDS_PER_SESSION_OPTIONS}
                  onChange={setHoldsPerSession}
                />
              </SettingRow>
              <SettingRow label="Voice coaching">
                <Toggle value={voiceOn} onChange={setVoiceOn} />
              </SettingRow>
              <SettingRow last label="Haptics (Android)">
                <Toggle value={hapticsOn} onChange={setHapticsOn} />
              </SettingRow>
            </Card>
          )}
        </div>

        <div className="flex flex-col gap-2.5 mt-6">
          <Btn onClick={onStart}>Begin</Btn>
          {permissionError && (
            <p style={{ color: "#b91c1c", fontSize: 13, textAlign: "center", margin: 0 }}>
              {permissionError}
            </p>
          )}
          <p style={{ fontSize: 11, color: P.muted, textAlign: "center", margin: "4px 0 0", lineHeight: 1.4 }}>
            A practice tool, not a medical device. Your radiation oncology team&apos;s instructions take precedence.
          </p>
        </div>
      </div>
    </div>
  );
}

function SettingRow({ label, children, last = false }: { label: string; children: ReactNode; last?: boolean }) {
  return (
    <div
      className="flex items-center justify-between py-3"
      style={{ borderBottom: last ? "none" : `1px solid ${P.hairline}` }}
    >
      <span style={{ fontSize: 14, color: P.ink, fontWeight: 500 }}>{label}</span>
      {children}
    </div>
  );
}

function SegmentedNumber<T extends number>({
  value,
  options,
  unit = "",
  onChange,
}: {
  value: T;
  options: readonly T[];
  unit?: string;
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex gap-1" style={{ background: P.hairline, padding: 3, borderRadius: 999 }}>
      {options.map((o) => (
        <button
          key={o}
          onClick={() => onChange(o)}
          className="font-semibold text-xs"
          style={{
            padding: "6px 10px",
            borderRadius: 999,
            border: "none",
            cursor: "pointer",
            background: o === value ? "#fff" : "transparent",
            color: o === value ? P.ink : P.ink2,
            boxShadow: o === value ? "0 1px 3px rgba(0,0,0,0.08)" : "none",
            transition: "all 0.15s",
          }}
        >
          {o}
          {unit}
        </button>
      ))}
    </div>
  );
}

function Toggle({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      onClick={() => onChange(!value)}
      style={{
        width: 44,
        height: 26,
        borderRadius: 13,
        background: value ? `linear-gradient(135deg, ${P.accent}, ${P.sky})` : "rgba(58,51,70,0.2)",
        position: "relative",
        cursor: "pointer",
        border: "none",
        transition: "background 0.2s",
      }}
      aria-pressed={value}
    >
      <span
        style={{
          position: "absolute",
          top: 3,
          left: value ? 21 : 3,
          width: 20,
          height: 20,
          borderRadius: 10,
          background: "#fff",
          boxShadow: "0 1px 3px rgba(0,0,0,0.15)",
          transition: "left 0.2s",
        }}
      />
    </button>
  );
}

// ─── Placement ──────────────────────────────────────────────────────────────
function Placement({
  pitch,
  pitchRef,
  gravityZRef,
  onContinue,
  onBack,
}: {
  pitch: number;
  pitchRef: React.RefObject<number>;
  gravityZRef: React.RefObject<number>;
  onContinue: () => void;
  onBack: () => void;
}) {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const id = setInterval(() => {
      const flat = Math.abs(pitchRef.current) < 30;
      const screenUp = gravityZRef.current > 4 || Math.abs(gravityZRef.current) < 0.1;
      setReady(flat && screenUp);
    }, 200);
    return () => clearInterval(id);
  }, [pitchRef, gravityZRef]);

  return (
    <div className="relative flex-1 flex flex-col" style={{ overflow: "hidden" }}>
      <Blobs />
      <Header back={onBack} step={1} totalSteps={3} />
      <div
        className="relative flex-1 flex flex-col"
        style={{ padding: "32px 28px 0", zIndex: 1 }}
      >
        <h2
          style={{
            fontSize: 30,
            lineHeight: 1.1,
            fontWeight: 700,
            letterSpacing: -0.8,
            color: P.ink,
            margin: 0,
          }}
        >
          Lay back, balance the phone on your tummy
        </h2>
        <p style={{ fontSize: 14, lineHeight: 1.55, color: P.ink2, marginTop: 12 }}>
          Phone in <strong>portrait</strong>, screen up. The <strong>top edge</strong> just
          below your sternum, the <strong>bottom edge</strong> on your lower belly. The phone
          should bridge the chest-to-belly seam — that&apos;s how we feel your breath rise.
        </p>
        <Card
          className="mt-6 flex items-center justify-center relative"
          style={{ padding: "32px 20px", overflow: "hidden" }}
        >
          <div
            style={{
              position: "absolute",
              top: -40,
              right: -40,
              width: 140,
              height: 140,
              borderRadius: "50%",
              background: `radial-gradient(circle, ${P.halo}, transparent 70%)`,
            }}
          />
          <Figure />
        </Card>
        <div className="mt-4 flex flex-wrap gap-2">
          {[
            "Portrait",
            "Top edge under sternum",
            "Bottom edge on belly",
            "Loose clothing",
          ].map((t) => (
            <Pill key={t}>{t}</Pill>
          ))}
        </div>
        <Card className="mt-4 p-4 flex items-center justify-between">
          <div>
            <div
              className="text-[10px] uppercase tracking-widest font-semibold"
              style={{ color: ready ? P.good : P.muted }}
            >
              {ready ? "Steady" : "Adjusting…"}
            </div>
            <div style={{ fontSize: 12, color: P.muted, marginTop: 2 }}>
              tilt {fmt(pitch)}°
            </div>
          </div>
          <span
            style={{
              fontSize: 18,
              color: ready ? P.good : P.muted,
              transition: "color 0.3s",
            }}
          >
            {ready ? "✓" : "…"}
          </span>
        </Card>
      </div>
      <div style={{ padding: "20px 24px 32px", zIndex: 1, position: "relative" }}>
        <Btn onClick={onContinue}>{ready ? "I'm in position" : "Continue anyway"}</Btn>
      </div>
    </div>
  );
}

// ─── Calibration ────────────────────────────────────────────────────────────
function Calibration({
  pitch,
  traceRef,
  onContinue,
  onBack,
  cue,
}: {
  pitch: number;
  traceRef: React.RefObject<{ t: number; p: number }[]>;
  onContinue: (b: Baseline) => void;
  onBack: () => void;
  cue: (k: PhraseKey) => void;
}) {
  const [running, setRunning] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState(CALIBRATE_SEC);
  const [warning, setWarning] = useState<string | null>(null);
  const startedAtRef = useRef<number | null>(null);
  const onContinueRef = useRef(onContinue);
  useEffect(() => {
    onContinueRef.current = onContinue;
  });

  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => {
      setSecondsLeft((s) => {
        if (s <= 1) {
          clearInterval(id);
          const start = startedAtRef.current ?? performance.now() - CALIBRATE_SEC * 1000;
          const settledFrom = start + CALIBRATE_SETTLE_SEC * 1000;
          const samples = traceRef.current
            .filter((d) => d.t >= settledFrom)
            .map((d) => d.p);
          if (samples.length < 30) {
            setWarning("Not enough sensor data yet — try again.");
            cue("baseline_low_data");
            setRunning(false);
            return CALIBRATE_SEC;
          }
          const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
          const min = Math.min(...samples);
          const max = Math.max(...samples);
          const amplitude = max - min;
          const variance =
            samples.reduce((a, b) => a + (b - mean) ** 2, 0) / samples.length;
          const breathingSD = Math.sqrt(variance);
          const usableSec = CALIBRATE_SEC - CALIBRATE_SETTLE_SEC;
          const bpm = estimateBreathRate(samples, usableSec);

          if (amplitude < 0.4) {
            setWarning("Almost no breathing detected. Make sure the phone is flat on your belly.");
            cue("baseline_no_breath");
            setRunning(false);
            return CALIBRATE_SEC;
          }
          if (amplitude > 30) {
            setWarning("Too much movement. Lie still and try once more.");
            cue("baseline_too_much");
            setRunning(false);
            return CALIBRATE_SEC;
          }
          if (bpm > 0 && (bpm < 4 || bpm > 30)) {
            setWarning(`Breathing rate looked off (~${bpm.toFixed(0)}/min). Breathe naturally and retry.`);
            cue("baseline_odd_rate");
            setRunning(false);
            return CALIBRATE_SEC;
          }
          setWarning(null);
          cue("baseline_done");
          onContinueRef.current({
            meanPitch: mean,
            amplitudeDeg: amplitude,
            breathingSD,
          });
          return 0;
        }
        return s - 1;
      });
    }, 1000);
    return () => clearInterval(id);
  }, [running, traceRef, cue]);

  return (
    <div className="relative flex-1 flex flex-col" style={{ overflow: "hidden" }}>
      <Blobs />
      <Header back={onBack} step={2} totalSteps={3} />
      <div
        className="relative flex-1 flex flex-col"
        style={{ padding: "32px 28px 0", zIndex: 1 }}
      >
        <h2
          style={{
            fontSize: 30,
            lineHeight: 1.1,
            fontWeight: 700,
            letterSpacing: -0.8,
            color: P.ink,
            margin: 0,
          }}
        >
          A few easy breaths
        </h2>
        <p style={{ fontSize: 14, lineHeight: 1.55, color: P.ink2, marginTop: 12 }}>
          Breathe normally. We&apos;re learning what natural feels like for you today.
        </p>
        <div className="flex-1 flex flex-col items-center justify-center">
          <Orb
            size={200}
            breathScale={
              running
                ? Math.min(1, Math.max(0, (pitch + 5) / 10)) // gentle live tracking
                : undefined
            }
            mood="calm"
          />
          <div
            style={{
              marginTop: 24,
              fontSize: 11,
              color: P.skyDeep,
              letterSpacing: 2,
              textTransform: "uppercase",
              fontWeight: 700,
            }}
          >
            {running ? "Listening" : warning ? "Let's redo" : "Ready when you are"}
          </div>
          <div style={{ marginTop: 8, fontSize: 28, color: P.ink, fontWeight: 700 }}>
            {running ? `${secondsLeft}s` : warning ? "Try again" : `${CALIBRATE_SEC}s baseline`}
          </div>
          {warning && (
            <p
              style={{
                fontSize: 13,
                color: P.warn,
                marginTop: 10,
                textAlign: "center",
                maxWidth: 280,
              }}
            >
              {warning}
            </p>
          )}
        </div>
      </div>
      <div style={{ padding: "20px 24px 32px", zIndex: 1, position: "relative" }}>
        {!running ? (
          <Btn
            onClick={() => {
              traceRef.current = [];
              startedAtRef.current = performance.now();
              setSecondsLeft(CALIBRATE_SEC);
              setWarning(null);
              setRunning(true);
              cue("baseline_intro");
            }}
          >
            {warning ? "Restart baseline" : "Start"}
          </Btn>
        ) : (
          <Btn variant="ghost" onClick={() => setRunning(false)}>
            Cancel
          </Btn>
        )}
      </div>
    </div>
  );
}

// ─── Session — the heart of the app ─────────────────────────────────────────
type SessionStage = "idle" | "active" | "exhale" | "between";

const POST_TARGET_AUTOEND_MS = 5000; // auto-end this long after target is reached
const RELEASE_SUSTAIN_MS = 1500; // movement (SD spike) sustained = release

function Session({
  baseline,
  holdTarget,
  holdsPerSession,
  pitch,
  pitchRef,
  traceRef,
  cue,
  buzz,
  onComplete,
  onAbort,
}: {
  baseline: Baseline;
  holdTarget: number;
  holdsPerSession: number;
  pitch: number;
  pitchRef: React.RefObject<number>;
  traceRef: React.RefObject<{ t: number; p: number }[]>;
  cue: (k: PhraseKey) => void;
  buzz: (p: number | number[]) => void;
  onComplete: (h: Hold[]) => void;
  onAbort: () => void;
}) {
  const [holdIdx, setHoldIdx] = useState(0);
  const [stage, setStage] = useState<SessionStage>("idle");
  const [stableSec, setStableSec] = useState(0);
  const [longestRunSec, setLongestRunSec] = useState(0);
  const [isStable, setIsStable] = useState(false);
  const [reachedTargetThisHold, setReachedTargetThisHold] = useState(false);
  // Live 0..1 mapping of pitch deviation → orb size during an active hold.
  const [breathScale, setBreathScale] = useState(0);

  const holdsRef = useRef<Hold[]>([]);
  const holdStartRef = useRef<number | null>(null);
  const cueRef = useRef(cue);
  const buzzRef = useRef(buzz);
  useEffect(() => {
    cueRef.current = cue;
  });
  useEffect(() => {
    buzzRef.current = buzz;
  });

  // Per-hold runtime accumulators.
  const algoEventsRef = useRef<{ t: number; type: string; meta?: unknown }[]>([]);
  const peakDevRef = useRef(0);
  const stableMsAccumRef = useRef(0);
  const currentRunStartRef = useRef<number | null>(null);
  const longestRunMsRef = useRef(0);
  const driftEventsRef = useRef(0);
  const firstLockAtRef = useRef<number | null>(null);
  const candidateStateRef = useRef<{ wantStable: boolean; since: number }>({ wantStable: false, since: 0 });
  const lastSampleAtRef = useRef<number>(0);
  const targetCueFiredRef = useRef(false);
  const targetReachedAtRef = useRef<number | null>(null);
  const releaseCandidateSinceRef = useRef<number | null>(null);

  const resetHoldState = useCallback(() => {
    algoEventsRef.current = [];
    peakDevRef.current = 0;
    stableMsAccumRef.current = 0;
    currentRunStartRef.current = null;
    longestRunMsRef.current = 0;
    driftEventsRef.current = 0;
    firstLockAtRef.current = null;
    candidateStateRef.current = { wantStable: false, since: 0 };
    targetCueFiredRef.current = false;
    targetReachedAtRef.current = null;
    releaseCandidateSinceRef.current = null;
    setStableSec(0);
    setLongestRunSec(0);
    setIsStable(false);
    setReachedTargetThisHold(false);
    setBreathScale(0);
  }, []);

  const logEvent = useCallback((type: string, meta?: unknown) => {
    const startedAt = holdStartRef.current ?? performance.now();
    algoEventsRef.current.push({
      t: +(performance.now() - startedAt).toFixed(1),
      type,
      meta,
    });
  }, []);

  const finishHold = useCallback(() => {
    const start = holdStartRef.current ?? performance.now();
    const totalMs = performance.now() - start;
    let plateauPitch: number | null = null;
    let plateauSD: number | null = null;
    if (longestRunMsRef.current > 1500) {
      const summary = summarizeRange(
        traceRef.current,
        start + Math.max(0, totalMs - 3000),
        start + totalMs,
      );
      if (summary) {
        plateauPitch = summary.median;
        plateauSD = summary.sd;
      }
    }
    const h: Hold = {
      index: holdIdx + 1,
      totalDurationSec: totalMs / 1000,
      stableSec: stableMsAccumRef.current / 1000,
      longestRunSec: longestRunMsRef.current / 1000,
      driftEvents: driftEventsRef.current,
      timeToLockSec:
        firstLockAtRef.current != null ? (firstLockAtRef.current - start) / 1000 : null,
      plateauPitch,
      plateauSD,
      reachedTarget: longestRunMsRef.current / 1000 >= holdTarget,
    };
    holdsRef.current.push(h);
    logEvent("finish");
    // Best-effort telemetry: capture full per-hold trace + all algorithm
    // events. Sliced from traceRef so we only ship the hold window.
    const samples = traceRef.current
      .filter((d) => d.t >= start && d.t <= start + totalMs)
      .map((d) => ({ t: +(d.t - start).toFixed(1), p: +d.p.toFixed(3) }));
    const payload = {
      kind: "session-hold",
      holdIndex: h.index,
      settings: { holdTarget, holdsPerSession },
      baseline,
      summary: h,
      events: algoEventsRef.current,
      samples,
      ua: typeof navigator !== "undefined" ? navigator.userAgent : "",
      at: new Date().toISOString(),
    };
    fetch("/api/log", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    }).catch(() => {
      // best-effort
    });
    cueRef.current("release_breath");
    buzzRef.current(40);
    setStage("exhale");
    setTimeout(() => setStage("between"), 1500);
    setTimeout(() => {
      const next = holdIdx + 1;
      if (next >= holdsPerSession) {
        cueRef.current("session_done");
        onComplete(holdsRef.current);
      } else {
        setHoldIdx(next);
        resetHoldState();
        setStage("idle");
      }
    }, 4500);
  }, [
    holdIdx,
    holdTarget,
    holdsPerSession,
    onComplete,
    resetHoldState,
    traceRef,
    baseline,
    logEvent,
  ]);

  // Stability + breath-scale loop during the hold
  useEffect(() => {
    if (stage !== "active") return;
    const id = setInterval(() => {
      const now = performance.now();
      const dt = lastSampleAtRef.current ? now - lastSampleAtRef.current : 0;
      lastSampleAtRef.current = now;

      const dev = pitchRef.current - baseline.meanPitch;
      const absDev = Math.abs(dev);
      peakDevRef.current = Math.max(peakDevRef.current, absDev);

      // Live breath scale 0..1 — relative to running peak with a tiny floor
      // (0.5°). Patients vary wildly in how much their phone tilts: real
      // recordings show some get 1°, others might get 10°. Let it self-scale.
      const ref = Math.max(0.5, peakDevRef.current);
      setBreathScale(Math.min(1, absDev / ref));

      // Stability detection. Adaptive threshold = half the breathing-baseline
      // SD measured during calibrate, clamped to a floor/ceiling.
      const sd = rollingSD(traceRef.current, STABILITY_WINDOW_MS);
      const adaptiveThreshold = Math.min(
        STABLE_SD_CEILING,
        Math.max(STABLE_SD_FLOOR, baseline.breathingSD * STABLE_SD_FRAC_OF_BASELINE),
      );
      const wantStable = sd < adaptiveThreshold;
      const cs = candidateStateRef.current;
      if (wantStable !== cs.wantStable) {
        candidateStateRef.current = { wantStable, since: now };
      }
      const heldFor = now - candidateStateRef.current.since;
      const debounceMs = wantStable ? STABLE_DEBOUNCE_MS : DRIFT_DEBOUNCE_MS;
      if (heldFor >= debounceMs) {
        if (wantStable && !isStable) {
          setIsStable(true);
          if (firstLockAtRef.current == null) firstLockAtRef.current = now;
          currentRunStartRef.current = now;
          if (driftEventsRef.current === 0) {
            logEvent("locked_in", { sd: +sd.toFixed(3), threshold: +adaptiveThreshold.toFixed(3) });
            cueRef.current("locked_in");
          } else {
            logEvent("regained", { sd: +sd.toFixed(3) });
            cueRef.current("regained");
          }
          buzzRef.current(50);
        } else if (!wantStable && isStable) {
          setIsStable(false);
          driftEventsRef.current += 1;
          if (currentRunStartRef.current != null) {
            const runMs = now - currentRunStartRef.current;
            if (runMs > longestRunMsRef.current) {
              longestRunMsRef.current = runMs;
              setLongestRunSec(runMs / 1000);
            }
            currentRunStartRef.current = null;
          }
          logEvent("drifting", { sd: +sd.toFixed(3), threshold: +adaptiveThreshold.toFixed(3) });
          cueRef.current("drifting");
          buzzRef.current([100, 100, 100]);
        }
      }

      if (isStable) {
        stableMsAccumRef.current += dt;
        setStableSec(stableMsAccumRef.current / 1000);
        if (currentRunStartRef.current != null) {
          const runMs = now - currentRunStartRef.current;
          if (runMs > longestRunMsRef.current) {
            longestRunMsRef.current = runMs;
            setLongestRunSec(runMs / 1000);
          }
        }
        if (
          !targetCueFiredRef.current &&
          longestRunMsRef.current / 1000 >= holdTarget
        ) {
          targetCueFiredRef.current = true;
          targetReachedAtRef.current = now;
          setReachedTargetThisHold(true);
          logEvent("target_reached");
          cueRef.current("target_reached");
          buzzRef.current([100, 50, 100, 50, 250]);
        }
      }

      // Auto-release path 1: rolling SD jumps WELL above the adaptive
      // threshold for >1.5s. The actual signal of release is "patient is
      // moving again" — that shows up in SD, not in pitch magnitude.
      // Only meaningful after a lock (so we know the patient was holding).
      if (firstLockAtRef.current != null && sd > adaptiveThreshold * 3) {
        if (releaseCandidateSinceRef.current == null) {
          releaseCandidateSinceRef.current = now;
        } else if (now - releaseCandidateSinceRef.current > RELEASE_SUSTAIN_MS) {
          logEvent("auto_release_sd", { sd: +sd.toFixed(3) });
          finishHold();
          return;
        }
      } else {
        releaseCandidateSinceRef.current = null;
      }

      // Auto-release path 2: target reached, then 5s additional grace —
      // celebrate the win and end. Prevents "stuck on stable forever."
      if (
        targetReachedAtRef.current != null &&
        now - targetReachedAtRef.current > POST_TARGET_AUTOEND_MS
      ) {
        logEvent("auto_release_post_target");
        finishHold();
        return;
      }
    }, 100);
    return () => clearInterval(id);
  }, [stage, baseline, holdTarget, isStable, pitchRef, traceRef, finishHold, logEvent]);

  const startHold = () => {
    resetHoldState();
    setStage("active");
    holdStartRef.current = performance.now();
    lastSampleAtRef.current = performance.now();
    logEvent("hold_start", {
      breathingSD: +baseline.breathingSD.toFixed(3),
      adaptiveThreshold: +Math.max(
        STABLE_SD_FLOOR,
        Math.min(STABLE_SD_CEILING, baseline.breathingSD * STABLE_SD_FRAC_OF_BASELINE),
      ).toFixed(3),
    });
    cueRef.current("inhale_cue");
  };

  const orbMood: OrbMood =
    stage === "active" ? (isStable ? "calm" : "active") : "calm";
  // While drifting in active mode, color = drifting (warning amber)
  const orbDrifting =
    stage === "active" && !isStable && firstLockAtRef.current != null;

  const targetPct = Math.min(100, (longestRunSec / holdTarget) * 100);
  const stablePct = Math.min(100, (stableSec / holdTarget) * 100);

  return (
    <div className="relative flex-1 flex flex-col" style={{ overflow: "hidden" }}>
      {/* Big ambient glow */}
      <div
        style={{
          position: "absolute",
          top: "20%",
          left: "50%",
          transform: "translate(-50%, 0)",
          width: 480,
          height: 480,
          borderRadius: "50%",
          background: `radial-gradient(circle, ${
            orbDrifting ? "rgba(217,148,102,0.4)" : P.halo
          } 0%, transparent 60%)`,
          filter: "blur(8px)",
          opacity: stage === "active" ? 1 : 0.6,
          transition: "opacity 1s ease, background 0.6s ease",
          pointerEvents: "none",
        }}
      />
      <div
        style={{
          position: "absolute",
          top: "50%",
          left: "50%",
          transform: "translate(-50%, -50%)",
          width: 540,
          height: 540,
          borderRadius: "50%",
          background: `radial-gradient(circle, ${P.haloSky} 0%, transparent 60%)`,
          filter: "blur(8px)",
          pointerEvents: "none",
        }}
      />

      <Header
        back={onAbort}
        right={
          <div
            style={{
              padding: "7px 14px",
              borderRadius: 999,
              background: "rgba(255,255,255,0.65)",
              backdropFilter: "blur(10px)",
              WebkitBackdropFilter: "blur(10px)",
              fontSize: 12,
              color: P.ink,
              fontWeight: 600,
              border: `1px solid ${P.hairline}`,
            }}
          >
            Hold {holdIdx + 1} of {holdsPerSession}
          </div>
        }
      />

      <div
        className="relative flex-1 flex flex-col items-center justify-center"
        style={{ padding: "0 32px", zIndex: 2 }}
      >
        <div className="relative" style={{ width: 280, height: 280, display: "flex", alignItems: "center", justifyContent: "center" }}>
          {/* Progress ring — fills with longest stable run / target */}
          <svg
            width="280"
            height="280"
            viewBox="0 0 280 280"
            style={{ position: "absolute", inset: 0, transform: "rotate(-90deg)" }}
          >
            <circle
              cx="140"
              cy="140"
              r="130"
              fill="none"
              stroke="rgba(255,255,255,0.55)"
              strokeWidth="3"
            />
            <circle
              cx="140"
              cy="140"
              r="130"
              fill="none"
              stroke={reachedTargetThisHold ? P.good : P.accentDeep}
              strokeWidth="4"
              strokeLinecap="round"
              strokeDasharray={2 * Math.PI * 130}
              strokeDashoffset={2 * Math.PI * 130 * (1 - targetPct / 100)}
              style={{ transition: "stroke-dashoffset 0.2s linear, stroke 0.5s ease" }}
            />
          </svg>
          <Orb
            size={220}
            breathScale={stage === "active" ? breathScale : undefined}
            freeze={stage === "active" && isStable}
            mood={orbDrifting ? "drifting" : orbMood}
            secondsLeft={
              stage === "active" && isStable
                ? Math.max(0, Math.ceil(holdTarget - longestRunSec))
                : null
            }
            label={stage === "active" && isStable ? "to target" : undefined}
          />
        </div>
        <div className="mt-8 text-center">
          <div
            style={{
              fontSize: 11,
              letterSpacing: 3,
              textTransform: "uppercase",
              color: P.skyDeep,
              fontWeight: 700,
            }}
          >
            {stage === "idle"
              ? "Ready"
              : stage === "active"
              ? !firstLockAtRef.current
                ? "Breathe in deeply"
                : isStable
                ? reachedTargetThisHold
                  ? "Target reached"
                  : "Locked in"
                : "Drifting"
              : stage === "exhale"
              ? "Release"
              : "Rest"}
          </div>
          <div
            style={{
              fontSize: 36,
              color: P.ink,
              fontWeight: 700,
              marginTop: 4,
              letterSpacing: -1,
            }}
          >
            {stage === "idle"
              ? "Hold " + (holdIdx + 1)
              : stage === "active"
              ? !firstLockAtRef.current
                ? "Inhale fully"
                : isStable
                ? "Hold steady"
                : "Steady…"
              : stage === "exhale"
              ? "Breathe out"
              : "Breathing"}
          </div>
        </div>
      </div>

      {/* Stable time card */}
      <div style={{ padding: "0 24px 32px", zIndex: 2, position: "relative" }}>
        <Card className="p-5">
          <div className="flex items-baseline justify-between">
            <div className="text-[10px] uppercase tracking-widest font-semibold" style={{ color: P.muted }}>
              Stable time
            </div>
            <div className="text-[10px] uppercase tracking-widest font-semibold" style={{ color: P.muted }}>
              Target {holdTarget}s
            </div>
          </div>
          <div className="flex items-baseline gap-2 mt-1">
            <div style={{ fontSize: 36, fontWeight: 700, color: P.ink, letterSpacing: -1, fontVariantNumeric: "tabular-nums" }}>
              {fmt(longestRunSec, 1)}
            </div>
            <div style={{ fontSize: 13, color: P.ink2 }}>s longest run</div>
          </div>
          <div className="mt-3 relative" style={{ height: 8, borderRadius: 4, background: P.hairline, overflow: "hidden" }}>
            <div
              style={{
                position: "absolute",
                left: 0,
                top: 0,
                bottom: 0,
                width: `${stablePct}%`,
                background: P.sky,
                opacity: 0.5,
                transition: "width 0.2s ease",
              }}
            />
            <div
              style={{
                position: "absolute",
                left: 0,
                top: 0,
                bottom: 0,
                width: `${targetPct}%`,
                background: `linear-gradient(90deg, ${P.accent}, ${P.skyDeep})`,
                transition: "width 0.2s ease",
              }}
            />
          </div>
          <div className="mt-2 flex justify-between text-xs" style={{ color: P.muted, fontVariantNumeric: "tabular-nums" }}>
            <span>{fmt(stableSec, 1)}s total stable</span>
            <span>
              tilt {fmt(pitch)}° · drift {driftEventsRef.current}
            </span>
          </div>
          <div className="mt-3">
            {stage === "idle" && <Btn onClick={startHold}>Start hold {holdIdx + 1}</Btn>}
            {stage === "active" && (
              <Btn variant="ghost" onClick={finishHold}>
                End hold
              </Btn>
            )}
            {(stage === "exhale" || stage === "between") && (
              <Btn variant="ghost" disabled>
                {stage === "exhale" ? "Releasing…" : "Resting…"}
              </Btn>
            )}
          </div>
        </Card>
      </div>
    </div>
  );
}

// ─── Complete ───────────────────────────────────────────────────────────────
function Complete({
  holds,
  holdTarget,
  onAgain,
  onDone,
}: {
  holds: Hold[];
  holdTarget: number;
  onAgain: () => void;
  onDone: () => void;
}) {
  const reached = holds.filter((h) => h.reachedTarget).length;
  const meanLongest =
    holds.length > 0 ? holds.reduce((a, h) => a + h.longestRunSec, 0) / holds.length : 0;
  const totalStable = holds.reduce((a, h) => a + h.stableSec, 0);
  const meanPlateauPitch = (() => {
    const pp = holds.map((h) => h.plateauPitch).filter((v): v is number => v != null);
    return pp.length ? pp.reduce((a, b) => a + b, 0) / pp.length : null;
  })();
  const driftTotal = holds.reduce((a, h) => a + h.driftEvents, 0);

  return (
    <div className="relative flex-1 flex flex-col" style={{ overflow: "hidden" }}>
      <div
        style={{
          position: "absolute",
          top: "5%",
          left: "50%",
          transform: "translateX(-50%)",
          width: "90%",
          height: "50%",
          background: `radial-gradient(circle, ${P.halo}, transparent 60%)`,
          filter: "blur(20px)",
          pointerEvents: "none",
        }}
      />
      <Header back={onDone} />
      <div
        className="relative flex-1 flex flex-col"
        style={{ padding: "20px 28px 0", zIndex: 1 }}
      >
        <div
          className="self-center flex items-center justify-center"
          style={{
            width: 92,
            height: 92,
            borderRadius: 46,
            background: `linear-gradient(135deg, ${P.accent}, ${P.sky})`,
            boxShadow: `0 16px 40px ${P.halo}`,
            marginTop: 8,
          }}
        >
          <svg width="36" height="36" viewBox="0 0 36 36" fill="none">
            <path
              d="M9 18l6 6 12-14"
              stroke="#fff"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </div>
        <div className="text-center mt-5">
          <div
            style={{
              fontSize: 11,
              letterSpacing: 3,
              textTransform: "uppercase",
              color: P.skyDeep,
              fontWeight: 700,
            }}
          >
            Beautiful
          </div>
          <h2
            style={{
              fontSize: 32,
              lineHeight: 1.1,
              fontWeight: 700,
              color: P.ink,
              margin: "8px 0 0",
              letterSpacing: -0.8,
            }}
          >
            You did wonderfully today.
          </h2>
          <p style={{ fontSize: 14, color: P.ink2, marginTop: 10 }}>
            {holds.length} hold{holds.length === 1 ? "" : "s"} · {reached} reached the {holdTarget}s target
          </p>
        </div>

        <Card className="mt-7 p-5">
          <div className="flex justify-around">
            {[
              [`${fmt(meanLongest, 1)}s`, "avg longest run"],
              [`${fmt(totalStable, 0)}s`, "total stable"],
              [meanPlateauPitch != null ? `${fmt(meanPlateauPitch)}°` : "—", "avg plateau"],
            ].map(([v, k]) => (
              <div key={k} className="text-center">
                <div style={{ fontSize: 22, fontWeight: 700, color: P.ink, letterSpacing: -0.5 }}>
                  {v}
                </div>
                <div
                  style={{
                    fontSize: 10,
                    color: P.muted,
                    marginTop: 4,
                    letterSpacing: 0.5,
                    textTransform: "uppercase",
                    fontWeight: 600,
                  }}
                >
                  {k}
                </div>
              </div>
            ))}
          </div>
          <div className="mt-5 pt-5" style={{ borderTop: `1px solid ${P.hairline}` }}>
            <div
              style={{
                fontSize: 11,
                letterSpacing: 1,
                textTransform: "uppercase",
                color: P.muted,
                fontWeight: 600,
              }}
            >
              Each hold (longest stable run)
            </div>
            <div className="mt-3 flex items-end gap-2.5" style={{ height: 60 }}>
              {holds.map((h, i) => {
                const pct = Math.min(100, (h.longestRunSec / holdTarget) * 100);
                return (
                  <div key={i} className="flex-1 flex flex-col items-center gap-1.5">
                    <div className="w-full flex items-end" style={{ height: 50 }}>
                      <div
                        style={{
                          width: "100%",
                          height: `${Math.max(6, pct)}%`,
                          minHeight: 4,
                          borderRadius: 6,
                          background: h.reachedTarget
                            ? `linear-gradient(180deg, ${P.good}, ${P.sky})`
                            : `linear-gradient(180deg, ${P.accent}, ${P.sky})`,
                        }}
                      />
                    </div>
                    <div
                      style={{
                        fontSize: 10,
                        color: P.muted,
                        fontVariantNumeric: "tabular-nums",
                      }}
                    >
                      {fmt(h.longestRunSec, 0)}s
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </Card>

        {driftTotal > 0 && (
          <div
            className="mt-4 flex items-start gap-2.5"
            style={{
              padding: "14px 16px",
              borderRadius: 18,
              background: "rgba(168,193,222,0.18)",
            }}
          >
            <div
              style={{
                width: 6,
                height: 6,
                borderRadius: 3,
                background: P.skyDeep,
                marginTop: 7,
                flexShrink: 0,
              }}
            />
            <div style={{ fontSize: 13, color: P.ink2, lineHeight: 1.45 }}>
              {driftTotal === 1 ? "One drift moment" : `${driftTotal} drift moments`} across the session.
              The longer the unbroken run, the closer you get to a clean clinical hold.
            </div>
          </div>
        )}
      </div>
      <div className="flex gap-2.5" style={{ padding: "20px 24px 32px", position: "relative", zIndex: 1 }}>
        <Btn variant="ghost" onClick={onDone} className="flex-1">
          Done
        </Btn>
        <Btn onClick={onAgain} className="flex-1">
          Practice again
        </Btn>
      </div>
    </div>
  );
}
