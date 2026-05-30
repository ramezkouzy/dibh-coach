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

type Phase = "welcome" | "placement" | "calibration" | "learn" | "session" | "complete";

type Baseline = { meanPitch: number; amplitudeDeg: number; breathingSD: number };

type TracePoint = { t: number; p: number };
type AlgorithmEvent = { t: number; type: string; meta?: unknown };
type DebugSnapshot = {
  pitch: number;
  targetDelta: number | null;
  sd: number;
  threshold: number;
  lockAgeMs: number | null;
  onTargetDwellMs: number;
  lastCue: string;
  releaseCandidateMs: number;
};

// The target depth + tolerance learned from 3 comfortable calibration holds.
// FUTURE: persist to localStorage for an inter-session drift readout —
// "your usual hold is at X°, today's was at Y°, drift Z°" — useful for
// clinician review of patient consistency across days.
type Plateau = {
  targetPitch: number;
  toleranceDeg: number;
  calibrationHolds: { plateauPitch: number; plateauSD: number }[];
};

type Hold = {
  index: number;
  totalDurationSec: number;
  stableSec: number; // total accumulated time inside stability tolerance
  longestRunSec: number; // longest single contiguous stable run
  driftEvents: number;
  timeToLockSec: number | null; // seconds from "start" to first stability lock
  plateauPitch: number | null; // median pitch during the longest stable run
  plateauSD: number | null; // SD during the longest stable run
  // Practice phase only: how long was the patient stable AND within tolerance
  // of the session target. The clinical metric — sustained reproducible hold.
  onTargetSec: number;
  longestOnTargetRunSec: number;
  reachedTarget: boolean;
  startedAt: string;
  samples: TracePoint[];
  events: AlgorithmEvent[];
};

type SessionSettings = {
  holdTarget: number;
  holdsPerSession: number;
  voiceOn: boolean;
  hapticsOn: boolean;
  debugOn: boolean;
};

type SessionExport = {
  schema: "dibh-session/v1";
  app: "DIBH Coach";
  exportedAt: string;
  startedAt: string;
  ua: string;
  settings: SessionSettings;
  baseline: Baseline;
  plateau: Plateau;
  holds: Hold[];
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
const POSITION_CUE_LOCK_SETTLE_MS = 1000;
const ON_TARGET_DWELL_MS = 1000;
const LEARN_HOLDS = 3; // comfortable calibration holds → averaged target
const TOLERANCE_FLOOR_DEG = 0.5; // never tighter than ±0.5° of target
const TOLERANCE_SD_MULT = 2; // tolerance = max(SD_across_calib_holds × this, floor)
const CALIBRATE_SEC = 12;
const CALIBRATE_SETTLE_SEC = 2;
const HOLD_TARGET_OPTIONS = [15, 20, 25, 30, 35] as const;
const HOLDS_PER_SESSION_OPTIONS = [1, 2, 3, 4, 5] as const;
const SETTINGS_KEY = "dibh-coach:self-test-settings:v1";

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

function adaptiveThresholdFor(baseline: Baseline) {
  return Math.min(
    STABLE_SD_CEILING,
    Math.max(STABLE_SD_FLOOR, baseline.breathingSD * STABLE_SD_FRAC_OF_BASELINE),
  );
}

function round(n: number, digits = 3) {
  return +n.toFixed(digits);
}

function downloadJson(filename: string, data: unknown) {
  if (typeof window === "undefined") return;
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

async function shareOrDownloadJson(filename: string, data: unknown) {
  if (typeof window === "undefined") return;
  const text = JSON.stringify(data, null, 2);
  const blob = new Blob([text], { type: "application/json" });
  const file = new File([blob], filename, { type: "application/json" });
  const nav = navigator as Navigator & {
    canShare?: (data: ShareData & { files?: File[] }) => boolean;
    share?: (data: ShareData & { files?: File[] }) => Promise<void>;
  };
  if (nav.share && (!nav.canShare || nav.canShare({ files: [file] }))) {
    try {
      await nav.share({
        title: "DIBH Coach session",
        text: "DIBH Coach self-test session JSON",
        files: [file],
      });
      return;
    } catch {
      // Fall back to download if sharing was cancelled or unavailable.
    }
  }
  downloadJson(filename, data);
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
  targetScale,
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
  // 0..1 — where the orb should sit when on-target. Renders as a dashed
  // ring at that size. The patient inhales until their live orb fills it.
  targetScale?: number;
  secondsLeft?: number | null;
  label?: string;
}) {
  const frozenRef = useRef(0);
  const live = breathScale ?? 0;
  if (!freeze) frozenRef.current = live;
  const breath = freeze ? frozenRef.current : live;
  // Map 0..1 → 0.45..1.10 — wider dynamic range so the rest pose is visibly
  // small and full inhale is visibly full.
  const scale =
    breathScale == null ? 0.55 : 0.45 + Math.min(1, Math.max(0, breath)) * 0.65;
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
      {targetScale != null && (
        <div
          style={{
            position: "absolute",
            width: "60%",
            height: "60%",
            borderRadius: "50%",
            border: `2px dashed ${P.skyDeep}`,
            opacity: 0.45,
            transform: `scale(${0.45 + Math.min(1, Math.max(0, targetScale)) * 0.65})`,
            transition: "transform 0.4s cubic-bezier(.4,0,.3,1)",
            pointerEvents: "none",
          }}
        />
      )}
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

function PositionMeter({
  pitch,
  target,
  tolerance,
  label,
}: {
  pitch: number;
  target: number;
  tolerance: number;
  label: "deeper" | "ease" | "ontarget" | "—";
}) {
  // Map a window of ±2.5×tolerance around target onto 0..1
  const range = Math.max(2.5 * tolerance, 4);
  const clamp = (n: number) => Math.min(1, Math.max(0, n));
  const dotPos = clamp((pitch - target + range) / (2 * range));
  const bandLeft = clamp((-tolerance + range) / (2 * range));
  const bandRight = clamp((tolerance + range) / (2 * range));
  const tone =
    label === "ontarget" ? P.good : label === "deeper" || label === "ease" ? P.warn : P.muted;
  const text =
    label === "ontarget"
      ? "On target"
      : label === "deeper"
      ? "A little deeper"
      : label === "ease"
      ? "Ease back a touch"
      : "Find your spot";
  return (
    <Card className="px-4 py-3">
      <div
        className="flex items-baseline justify-between text-[10px] uppercase tracking-widest font-semibold"
        style={{ color: tone }}
      >
        <span>{text}</span>
        <span style={{ color: P.muted, fontFamily: "ui-monospace, monospace" }}>
          {fmt(pitch)}° · target {fmt(target)}°
        </span>
      </div>
      <div
        className="relative mt-2"
        style={{ height: 10, borderRadius: 5, background: P.hairline, overflow: "hidden" }}
      >
        <div
          style={{
            position: "absolute",
            left: `${bandLeft * 100}%`,
            width: `${(bandRight - bandLeft) * 100}%`,
            top: 0,
            bottom: 0,
            background: "rgba(122,168,132,0.45)",
          }}
        />
        <div
          style={{
            position: "absolute",
            left: `${dotPos * 100}%`,
            top: -3,
            width: 16,
            height: 16,
            borderRadius: 8,
            background: tone === P.muted ? P.skyDeep : tone,
            border: "2px solid #fff",
            boxShadow: "0 0 0 1px rgba(0,0,0,0.08)",
            transform: "translateX(-50%)",
            transition: "left 0.15s ease-out",
          }}
        />
      </div>
    </Card>
  );
}

function DebugPanel({ data }: { data: DebugSnapshot }) {
  const rows: [string, string][] = [
    ["pitch", `${fmt(data.pitch)}°`],
    ["target Δ", data.targetDelta == null ? "—" : `${fmt(data.targetDelta, 2)}°`],
    ["SD", Number.isFinite(data.sd) ? `${fmt(data.sd, 3)}°` : "—"],
    ["threshold", `${fmt(data.threshold, 3)}°`],
    ["lock age", data.lockAgeMs == null ? "—" : `${fmt(data.lockAgeMs / 1000, 1)}s`],
    ["target dwell", `${fmt(data.onTargetDwellMs / 1000, 1)}s`],
    ["release cand.", `${fmt(data.releaseCandidateMs / 1000, 1)}s`],
    ["last cue", data.lastCue || "—"],
  ];
  return (
    <Card className="mb-3 p-3">
      <div
        className="text-[10px] uppercase tracking-widest font-semibold"
        style={{ color: P.skyDeep }}
      >
        Debug
      </div>
      <div
        className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1"
        style={{ fontSize: 11, color: P.ink2, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }}
      >
        {rows.map(([k, v]) => (
          <div key={k} className="flex justify-between gap-2">
            <span style={{ color: P.muted }}>{k}</span>
            <span style={{ color: P.ink }}>{v}</span>
          </div>
        ))}
      </div>
    </Card>
  );
}

// Step counts across phases:
//   placement = 1, calibration = 2, learn = 3, session = 4
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
  const [plateau, setPlateau] = useState<Plateau | null>(null);
  const [holdTarget, setHoldTarget] = useState<number>(20);
  const [holdsPerSession, setHoldsPerSession] = useState<number>(3);
  const [voiceOn, setVoiceOn] = useState(true);
  const [hapticsOn, setHapticsOn] = useState(true);
  const [debugOn, setDebugOn] = useState(false);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [holds, setHolds] = useState<Hold[]>([]);
  const [sessionStartedAt, setSessionStartedAt] = useState<string | null>(null);

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

  useEffect(() => {
    const urlDebug =
      typeof window !== "undefined" &&
      new URLSearchParams(window.location.search).get("debug") === "1";
    try {
      const raw = typeof window !== "undefined" ? window.localStorage.getItem(SETTINGS_KEY) : null;
      if (raw) {
        const saved = JSON.parse(raw) as Partial<SessionSettings>;
        if (
          typeof saved.holdTarget === "number" &&
          HOLD_TARGET_OPTIONS.includes(saved.holdTarget as (typeof HOLD_TARGET_OPTIONS)[number])
        ) {
          setHoldTarget(saved.holdTarget);
        }
        if (
          typeof saved.holdsPerSession === "number" &&
          HOLDS_PER_SESSION_OPTIONS.includes(
            saved.holdsPerSession as (typeof HOLDS_PER_SESSION_OPTIONS)[number],
          )
        ) {
          setHoldsPerSession(saved.holdsPerSession);
        }
        if (typeof saved.voiceOn === "boolean") setVoiceOn(saved.voiceOn);
        if (typeof saved.hapticsOn === "boolean") setHapticsOn(saved.hapticsOn);
        if (typeof saved.debugOn === "boolean") setDebugOn(saved.debugOn);
      }
      if (urlDebug) setDebugOn(true);
    } catch {
      if (urlDebug) setDebugOn(true);
    } finally {
      setSettingsLoaded(true);
    }
  }, []);

  useEffect(() => {
    if (!settingsLoaded || typeof window === "undefined") return;
    const settings: SessionSettings = {
      holdTarget,
      holdsPerSession,
      voiceOn,
      hapticsOn,
      debugOn,
    };
    window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  }, [settingsLoaded, holdTarget, holdsPerSession, voiceOn, hapticsOn, debugOn]);

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
    setPlateau(null);
    setHolds([]);
    setSessionStartedAt(null);
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
            debugOn={debugOn}
            setDebugOn={setDebugOn}
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
              setPhase("learn");
            }}
            onBack={() => setPhase("placement")}
            cue={cue}
          />
        )}

        {phase === "learn" && baseline && (
          <Learn
            baseline={baseline}
            pitch={pitch}
            pitchRef={pitchRef}
            traceRef={traceRef}
            cue={cue}
            buzz={buzz}
            onContinue={(p) => {
              setPlateau(p);
              setSessionStartedAt(new Date().toISOString());
              traceRef.current = [];
              setPhase("session");
            }}
            onAbort={restart}
          />
        )}

        {phase === "session" && baseline && plateau && (
          <Session
            baseline={baseline}
            plateau={plateau}
            holdTarget={holdTarget}
            holdsPerSession={holdsPerSession}
            pitch={pitch}
            pitchRef={pitchRef}
            traceRef={traceRef}
            cue={cue}
            buzz={buzz}
            debugOn={debugOn}
            onComplete={(h) => {
              setHolds(h);
              setPhase("complete");
            }}
            onAbort={restart}
          />
        )}

        {phase === "complete" && baseline && plateau && (
          <Complete
            holds={holds}
            holdTarget={holdTarget}
            baseline={baseline}
            plateau={plateau}
            settings={{ holdTarget, holdsPerSession, voiceOn, hapticsOn, debugOn }}
            sessionStartedAt={sessionStartedAt}
            onAgain={() => {
              setHolds([]);
              setSessionStartedAt(null);
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
  debugOn,
  setDebugOn,
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
  debugOn: boolean;
  setDebugOn: (v: boolean) => void;
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
              <SettingRow label="Haptics (Android)">
                <Toggle value={hapticsOn} onChange={setHapticsOn} />
              </SettingRow>
              <SettingRow last label="Debug panel">
                <Toggle value={debugOn} onChange={setDebugOn} />
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
      <Header back={onBack} step={1} totalSteps={4} />
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
          Lay back, anchor the phone on your sternum
        </h2>
        <p style={{ fontSize: 14, lineHeight: 1.55, color: P.ink2, marginTop: 12 }}>
          Phone in <strong>portrait</strong>, screen up. The <strong>charging-port edge</strong>
          (bottom) resting on your sternum; let the rest of the phone extend down across
          your upper belly. Breathe with your <strong>chest</strong>, not just your belly —
          that&apos;s the hold your radiation team is teaching you.
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
            "Port edge on sternum",
            "Chest-led breath",
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
      <Header back={onBack} step={2} totalSteps={4} />
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
          <Card className="mt-5 p-3" style={{ width: "100%", maxWidth: 300 }}>
            <div className="flex items-center justify-between text-[10px] uppercase tracking-widest font-semibold">
              <span style={{ color: running ? P.good : P.muted }}>
                {running ? "Sensor live" : "Sensor ready"}
              </span>
              <span style={{ color: P.muted, fontFamily: "ui-monospace, monospace" }}>
                tilt {fmt(pitch)}°
              </span>
            </div>
            <div
              className="mt-2"
              style={{ height: 6, borderRadius: 3, background: P.hairline, overflow: "hidden" }}
            >
              <div
                style={{
                  height: "100%",
                  width: running
                    ? `${((CALIBRATE_SEC - secondsLeft) / CALIBRATE_SEC) * 100}%`
                    : "0%",
                  background: `linear-gradient(90deg, ${P.accent}, ${P.skyDeep})`,
                  transition: "width 0.4s ease",
                }}
              />
            </div>
          </Card>
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

// ─── Learn — three comfortable holds → averaged target plateau ─────────────
function Learn({
  baseline,
  pitch,
  pitchRef,
  traceRef,
  cue,
  buzz,
  onContinue,
  onAbort,
}: {
  baseline: Baseline;
  pitch: number;
  pitchRef: React.RefObject<number>;
  traceRef: React.RefObject<{ t: number; p: number }[]>;
  cue: (k: PhraseKey) => void;
  buzz: (p: number | number[]) => void;
  onContinue: (p: Plateau) => void;
  onAbort: () => void;
}) {
  type Stage = "intro" | "idle" | "active" | "review";
  type LearnHold = { plateauPitch: number; plateauSD: number; stableSec: number; longestRunSec: number };
  const [stage, setStage] = useState<Stage>("intro");
  const [holdIdx, setHoldIdx] = useState(0);
  const [isStable, setIsStable] = useState(false);
  const [breathScale, setBreathScale] = useState(0);
  const [stableSec, setStableSec] = useState(0);
  const [longestRunSec, setLongestRunSec] = useState(0);
  const [pendingHold, setPendingHold] = useState<LearnHold | null>(null);

  const peaksRef = useRef<{ plateauPitch: number; plateauSD: number }[]>([]);
  const cueRef = useRef(cue);
  const buzzRef = useRef(buzz);
  useEffect(() => {
    cueRef.current = cue;
  });
  useEffect(() => {
    buzzRef.current = buzz;
  });

  const holdStartRef = useRef<number | null>(null);
  const lastSampleAtRef = useRef(0);
  const stableMsAccumRef = useRef(0);
  const peakDevRef = useRef(0);
  const currentRunStartRef = useRef<number | null>(null);
  const longestRunMsRef = useRef(0);
  const firstLockAtRef = useRef<number | null>(null);
  const candidateStateRef = useRef<{ wantStable: boolean; since: number }>({ wantStable: false, since: 0 });
  const releaseCandidateSinceRef = useRef<number | null>(null);

  const reset = useCallback(() => {
    stableMsAccumRef.current = 0;
    peakDevRef.current = 0;
    currentRunStartRef.current = null;
    longestRunMsRef.current = 0;
    firstLockAtRef.current = null;
    candidateStateRef.current = { wantStable: false, since: 0 };
    releaseCandidateSinceRef.current = null;
    setIsStable(false);
    setBreathScale(0);
    setStableSec(0);
    setLongestRunSec(0);
    setPendingHold(null);
  }, []);

  const finalize = useCallback(() => {
    const peaks = peaksRef.current;
    if (peaks.length < 2) return;
    const target = peaks.reduce((a, b) => a + b.plateauPitch, 0) / peaks.length;
    const meanSq =
      peaks.reduce((a, b) => a + (b.plateauPitch - target) ** 2, 0) / peaks.length;
    const acrossSD = Math.sqrt(meanSq);
    const tolerance = Math.max(TOLERANCE_FLOOR_DEG, acrossSD * TOLERANCE_SD_MULT);
    cueRef.current("learn_target_locked");
    onContinue({
      targetPitch: target,
      toleranceDeg: tolerance,
      calibrationHolds: peaks,
    });
  }, [onContinue]);

  const finishHold = useCallback(() => {
    const start = holdStartRef.current ?? performance.now();
    const totalMs = performance.now() - start;
    const summary = summarizeRange(
      traceRef.current,
      start + Math.max(0, totalMs - 3000),
      start + totalMs,
    );
    cueRef.current("release_breath");
    buzzRef.current(40);
    setPendingHold(
      summary && longestRunMsRef.current > 1500
        ? {
            plateauPitch: summary.median,
            plateauSD: summary.sd,
            stableSec: stableMsAccumRef.current / 1000,
            longestRunSec: longestRunMsRef.current / 1000,
          }
        : null,
    );
    setStage("review");
  }, [traceRef]);

  const acceptHold = useCallback(() => {
    if (!pendingHold) {
      reset();
      setStage("idle");
      return;
    }
    peaksRef.current.push({
      plateauPitch: pendingHold.plateauPitch,
      plateauSD: pendingHold.plateauSD,
    });
    const next = peaksRef.current.length;
    if (next >= LEARN_HOLDS) {
      finalize();
      return;
    }
    if (next === 1) cueRef.current("learn_got_one");
    else if (next === 2) cueRef.current("learn_got_two");
    setHoldIdx(next);
    reset();
    setStage("idle");
  }, [finalize, pendingHold, reset]);

  const redoHold = useCallback(() => {
    reset();
    setStage("idle");
  }, [reset]);

  useEffect(() => {
    if (stage !== "active") return;
    const id = setInterval(() => {
      const now = performance.now();
      const dt = lastSampleAtRef.current ? now - lastSampleAtRef.current : 0;
      lastSampleAtRef.current = now;
      const dev = pitchRef.current - baseline.meanPitch;
      const absDev = Math.abs(dev);
      peakDevRef.current = Math.max(peakDevRef.current, absDev);
      setBreathScale(Math.min(1, absDev / 12));
      const sd = rollingSD(traceRef.current, STABILITY_WINDOW_MS);
      const adaptive = adaptiveThresholdFor(baseline);
      const wantStable = sd < adaptive;
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
          cueRef.current("locked_in");
          buzzRef.current(50);
        } else if (!wantStable && isStable) {
          setIsStable(false);
          if (currentRunStartRef.current != null) {
            const runMs = now - currentRunStartRef.current;
            if (runMs > longestRunMsRef.current) {
              longestRunMsRef.current = runMs;
              setLongestRunSec(runMs / 1000);
            }
            currentRunStartRef.current = null;
          }
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
      }
      const releaseDepth = Math.max(1, peakDevRef.current * 0.55);
      const returnedTowardBaseline = peakDevRef.current > 1 && absDev <= releaseDepth;
      if (firstLockAtRef.current != null && sd > adaptive * 3 && returnedTowardBaseline) {
        if (releaseCandidateSinceRef.current == null) {
          releaseCandidateSinceRef.current = now;
        } else if (now - releaseCandidateSinceRef.current > RELEASE_SUSTAIN_MS) {
          finishHold();
          return;
        }
      } else {
        releaseCandidateSinceRef.current = null;
      }
    }, 100);
    return () => clearInterval(id);
  }, [stage, baseline, isStable, pitchRef, traceRef, finishHold]);

  const startHold = () => {
    reset();
    setStage("active");
    holdStartRef.current = performance.now();
    lastSampleAtRef.current = performance.now();
    cueRef.current("inhale_cue");
  };

  const orbMood: OrbMood = stage === "active" ? (isStable ? "calm" : "active") : "calm";
  const orbDrifting = stage === "active" && !isStable && firstLockAtRef.current != null;

  return (
    <div className="relative flex-1 flex flex-col" style={{ overflow: "hidden" }}>
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
      <Header back={onAbort} step={3} totalSteps={4} />
      <div
        className="relative flex-1 flex flex-col items-center justify-center"
        style={{ padding: "0 32px", zIndex: 2 }}
      >
        {stage === "intro" ? (
          <>
            <Orb size={220} mood="calm" />
            <h2
              style={{
                fontSize: 28,
                fontWeight: 700,
                color: P.ink,
                marginTop: 24,
                textAlign: "center",
                letterSpacing: -0.6,
                lineHeight: 1.1,
              }}
            >
              Find your spot
            </h2>
            <p
              style={{
                fontSize: 14,
                color: P.ink2,
                marginTop: 12,
                textAlign: "center",
                maxWidth: 320,
              }}
            >
              Three comfortable chest holds. Reach a depth you can hold steady — we&apos;ll
              average them to set your target. No need to push.
            </p>
          </>
        ) : (
          <>
            <Orb
              size={220}
              breathScale={stage === "active" ? breathScale : undefined}
              freeze={stage === "active" && isStable}
              mood={orbDrifting ? "drifting" : orbMood}
              secondsLeft={null}
            />
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
                Hold {holdIdx + 1} of {LEARN_HOLDS}
              </div>
              <div
                style={{
                  fontSize: 32,
                  color: P.ink,
                  fontWeight: 700,
                  marginTop: 4,
                  letterSpacing: -1,
                }}
              >
                {stage === "active"
                  ? isStable
                    ? "Hold steady"
                    : firstLockAtRef.current
                    ? "Find it again"
                    : "Inhale and hold"
                  : stage === "review"
                  ? pendingHold
                    ? "Use this hold?"
                    : "Redo this one"
                  : "Comfortable hold"}
              </div>
            </div>
          </>
        )}
      </div>
      <div style={{ padding: "0 24px 32px", zIndex: 2, position: "relative" }}>
        {stage === "intro" && (
          <Btn
            onClick={() => {
              cueRef.current("learn_intro");
              setStage("idle");
            }}
          >
            I&apos;m ready
          </Btn>
        )}
        {stage === "idle" && (
          <Card className="p-5">
            <div
              className="text-[10px] uppercase tracking-widest font-semibold"
              style={{ color: P.muted }}
            >
              Comfortable hold {holdIdx + 1} of {LEARN_HOLDS}
            </div>
            <div className="text-sm mt-1" style={{ color: P.ink2 }}>
              Reach a depth you can hold steady, then keep it there.
            </div>
            <div className="mt-4">
              <Btn onClick={startHold}>Start hold {holdIdx + 1}</Btn>
            </div>
          </Card>
        )}
        {stage === "active" && (
          <Card className="p-4">
            <div className="flex justify-between text-xs" style={{ color: P.muted }}>
              <span>{isStable ? "Locked in" : "Finding…"}</span>
              <span style={{ fontVariantNumeric: "tabular-nums" }}>
                stable {fmt(stableSec, 1)}s · best {fmt(longestRunSec, 1)}s · pitch{" "}
                {fmt(pitch)}°
              </span>
            </div>
            <div className="mt-3">
              <Btn variant="ghost" onClick={finishHold}>
                End hold
              </Btn>
            </div>
          </Card>
        )}
        {stage === "review" && (
          <Card className="p-5 text-center">
            <div
              style={{
                fontSize: 11,
                letterSpacing: 2,
                textTransform: "uppercase",
                color: P.skyDeep,
                fontWeight: 700,
              }}
            >
              {pendingHold ? "Review hold" : "Hold not captured"}
            </div>
            <div style={{ fontSize: 18, color: P.ink, fontWeight: 600, marginTop: 4 }}>
              {pendingHold
                ? `${fmt(pendingHold.longestRunSec, 1)}s steady · plateau ${fmt(
                    pendingHold.plateauPitch,
                  )}°`
                : "Try this hold again before it counts."}
            </div>
            <div className="mt-4 flex gap-2.5">
              <Btn variant="ghost" onClick={redoHold} className="flex-1">
                Redo
              </Btn>
              <Btn onClick={acceptHold} disabled={!pendingHold} className="flex-1">
                Use hold
              </Btn>
            </div>
          </Card>
        )}
      </div>
    </div>
  );
}

// ─── Session — the heart of the app ─────────────────────────────────────────
type SessionStage = "idle" | "active" | "review";

const POST_TARGET_AUTOEND_MS = 5000; // auto-end this long after target is reached
const RELEASE_SUSTAIN_MS = 1500; // movement (SD spike) sustained = release

function Session({
  baseline,
  plateau,
  holdTarget,
  holdsPerSession,
  pitch,
  pitchRef,
  traceRef,
  cue,
  buzz,
  debugOn,
  onComplete,
  onAbort,
}: {
  baseline: Baseline;
  plateau: Plateau;
  holdTarget: number;
  holdsPerSession: number;
  pitch: number;
  pitchRef: React.RefObject<number>;
  traceRef: React.RefObject<{ t: number; p: number }[]>;
  cue: (k: PhraseKey) => void;
  buzz: (p: number | number[]) => void;
  debugOn: boolean;
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
  const [pendingHold, setPendingHold] = useState<Hold | null>(null);
  const [debugSnapshot, setDebugSnapshot] = useState<DebugSnapshot>({
    pitch: 0,
    targetDelta: null,
    sd: Infinity,
    threshold: adaptiveThresholdFor(baseline),
    lockAgeMs: null,
    onTargetDwellMs: 0,
    lastCue: "",
    releaseCandidateMs: 0,
  });

  const holdsRef = useRef<Hold[]>([]);
  const holdStartRef = useRef<number | null>(null);
  const holdStartedAtIsoRef = useRef<string>("");
  const cueRef = useRef(cue);
  const buzzRef = useRef(buzz);
  useEffect(() => {
    cueRef.current = cue;
  });
  useEffect(() => {
    buzzRef.current = buzz;
  });

  // Per-hold runtime accumulators.
  const algoEventsRef = useRef<AlgorithmEvent[]>([]);
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
  const lastCueRef = useRef("");
  // Position-match (stable AND within tolerance of session target)
  const onTargetMsAccumRef = useRef(0);
  const onTargetRunStartRef = useRef<number | null>(null);
  const onTargetDwellStartRef = useRef<number | null>(null);
  const longestOnTargetMsRef = useRef(0);
  const lastPositionCueRef = useRef<{ t: number; cue: string }>({ t: 0, cue: "" });
  const [onTargetSec, setOnTargetSec] = useState(0);
  const [longestOnTargetSec, setLongestOnTargetSec] = useState(0);
  const [positionLabel, setPositionLabel] = useState<"deeper" | "ease" | "ontarget" | "—">("—");

  const emitCue = useCallback((key: PhraseKey) => {
    lastCueRef.current = key;
    cueRef.current(key);
  }, []);

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
    lastCueRef.current = "";
    onTargetMsAccumRef.current = 0;
    onTargetRunStartRef.current = null;
    onTargetDwellStartRef.current = null;
    longestOnTargetMsRef.current = 0;
    lastPositionCueRef.current = { t: 0, cue: "" };
    setStableSec(0);
    setLongestRunSec(0);
    setIsStable(false);
    setReachedTargetThisHold(false);
    setBreathScale(0);
    setPendingHold(null);
    setOnTargetSec(0);
    setLongestOnTargetSec(0);
    setPositionLabel("—");
    setDebugSnapshot({
      pitch: pitchRef.current,
      targetDelta: null,
      sd: Infinity,
      threshold: adaptiveThresholdFor(baseline),
      lockAgeMs: null,
      onTargetDwellMs: 0,
      lastCue: "",
      releaseCandidateMs: 0,
    });
  }, [baseline, pitchRef]);

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
    logEvent("finish");
    const samples = traceRef.current
      .filter((d) => d.t >= start && d.t <= start + totalMs)
      .map((d) => ({ t: round(d.t - start, 1), p: round(d.p) }));
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
      onTargetSec: onTargetMsAccumRef.current / 1000,
      longestOnTargetRunSec: longestOnTargetMsRef.current / 1000,
      // "Reached target" = sustained stable+on-target for >= holdTarget seconds.
      reachedTarget: longestOnTargetMsRef.current / 1000 >= holdTarget,
      startedAt: holdStartedAtIsoRef.current || new Date().toISOString(),
      samples,
      events: [...algoEventsRef.current],
    };
    setPendingHold(h);
    emitCue("release_breath");
    buzzRef.current(40);
    setStage("review");
  }, [
    baseline,
    emitCue,
    holdIdx,
    holdTarget,
    holdsPerSession,
    logEvent,
    traceRef,
  ]);

  const saveHold = useCallback(() => {
    if (!pendingHold) {
      resetHoldState();
      setStage("idle");
      return;
    }
    holdsRef.current.push(pendingHold);
    const payload = {
      kind: "session-hold",
      holdIndex: pendingHold.index,
      settings: { holdTarget, holdsPerSession },
      baseline,
      plateau,
      summary: pendingHold,
      events: pendingHold.events,
      samples: pendingHold.samples,
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
    const next = holdIdx + 1;
    if (next >= holdsPerSession) {
      emitCue("session_done");
      onComplete(holdsRef.current);
      return;
    }
    setHoldIdx(next);
    resetHoldState();
    setStage("idle");
  }, [
    baseline,
    emitCue,
    holdIdx,
    holdTarget,
    holdsPerSession,
    onComplete,
    pendingHold,
    plateau,
    resetHoldState,
  ]);

  const redoPracticeHold = useCallback(() => {
    resetHoldState();
    setStage("idle");
  }, [resetHoldState]);

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

      // Live breath scale 0..1 — fixed 12° reference (typical chest-mode peak).
      // Earlier we tracked running peak, but absDev always equals peak on the
      // current tick → ratio jumps straight to 1.0 and the orb never animates
      // its growth. Fixed reference makes the orb visibly grow during inhale
      // for both belly (peak ~5° → 42% scale) and chest (peak ~12° → full)
      // modes.
      setBreathScale(Math.min(1, absDev / 12));

      // Stability detection. Adaptive threshold = half the breathing-baseline
      // SD measured during calibrate, clamped to a floor/ceiling.
      const sd = rollingSD(traceRef.current, STABILITY_WINDOW_MS);
      const adaptiveThreshold = adaptiveThresholdFor(baseline);
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
            emitCue("locked_in");
          } else {
            logEvent("regained", { sd: +sd.toFixed(3) });
            emitCue("regained");
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
          emitCue("drifting");
          buzzRef.current([100, 100, 100]);
        }
      }

      // Position match: how far from session target is the current pitch
      const targetDelta = pitchRef.current - plateau.targetPitch;
      const onTarget = Math.abs(targetDelta) <= plateau.toleranceDeg;
      const lockAgeMs = firstLockAtRef.current != null ? now - firstLockAtRef.current : null;
      const lockSettled =
        lockAgeMs != null && lockAgeMs >= POSITION_CUE_LOCK_SETTLE_MS;
      if (isStable && onTarget && lockSettled) {
        if (onTargetDwellStartRef.current == null) onTargetDwellStartRef.current = now;
      } else {
        onTargetDwellStartRef.current = null;
      }
      const onTargetDwellMs =
        onTargetDwellStartRef.current != null ? now - onTargetDwellStartRef.current : 0;

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
        // Position cues — stable but off-target → tell them which way.
        // Throttled to 2.5s minimum gap between distinct cues.
        const cueGap = now - lastPositionCueRef.current.t;
        if (lockSettled && !onTarget && cueGap > 2500) {
          if (targetDelta < 0) {
            // Below target depth — need to inhale more
            if (lastPositionCueRef.current.cue !== "deeper") {
              lastPositionCueRef.current = { t: now, cue: "deeper" };
              emitCue("go_deeper");
              logEvent("cue_deeper", { delta: +targetDelta.toFixed(2) });
            }
          } else {
            // Above target depth — need to exhale slightly
            if (lastPositionCueRef.current.cue !== "ease") {
              lastPositionCueRef.current = { t: now, cue: "ease" };
              emitCue("ease_back");
              logEvent("cue_ease", { delta: +targetDelta.toFixed(2) });
            }
          }
        } else if (
          lockSettled &&
          onTarget &&
          onTargetDwellMs >= ON_TARGET_DWELL_MS &&
          lastPositionCueRef.current.cue !== "ontarget"
        ) {
          lastPositionCueRef.current = { t: now, cue: "ontarget" };
          if (cueGap > 1500) emitCue("right_there");
          buzzRef.current(40);
          logEvent("cue_ontarget", {
            delta: +targetDelta.toFixed(2),
            dwellMs: Math.round(onTargetDwellMs),
          });
        }
        setPositionLabel(lockSettled ? (onTarget ? "ontarget" : targetDelta < 0 ? "deeper" : "ease") : "—");
      } else {
        setPositionLabel("—");
      }

      // On-target time accumulation: stable AND on-target.
      const onTargetEligible = isStable && lockSettled && onTarget;
      if (onTargetEligible) {
        onTargetMsAccumRef.current += dt;
        setOnTargetSec(onTargetMsAccumRef.current / 1000);
        if (onTargetRunStartRef.current == null) onTargetRunStartRef.current = now;
        const onRunMs = now - onTargetRunStartRef.current;
        if (onRunMs > longestOnTargetMsRef.current) {
          longestOnTargetMsRef.current = onRunMs;
          setLongestOnTargetSec(onRunMs / 1000);
        }
        if (
          !targetCueFiredRef.current &&
          longestOnTargetMsRef.current / 1000 >= holdTarget
        ) {
          targetCueFiredRef.current = true;
          targetReachedAtRef.current = now;
          setReachedTargetThisHold(true);
          logEvent("target_reached");
          emitCue("target_reached");
          buzzRef.current([100, 50, 100, 50, 250]);
        }
      } else {
        onTargetRunStartRef.current = null;
      }

      // Auto-release path 1: movement plus a clear return toward baseline.
      // High SD alone is too eager during recoverable drift; requiring the
      // pitch to move most of the way back toward baseline makes release a
      // deliberate exhale signal.
      const targetExcursion = Math.abs(plateau.targetPitch - baseline.meanPitch);
      const releaseDepth = Math.max(1, targetExcursion * 0.55);
      const returnedTowardBaseline = targetExcursion > 0.5 && absDev <= releaseDepth;
      if (firstLockAtRef.current != null && sd > adaptiveThreshold * 3 && returnedTowardBaseline) {
        if (releaseCandidateSinceRef.current == null) {
          releaseCandidateSinceRef.current = now;
        } else if (now - releaseCandidateSinceRef.current > RELEASE_SUSTAIN_MS) {
          logEvent("auto_release_sd", {
            sd: +sd.toFixed(3),
            absDev: +absDev.toFixed(2),
            releaseDepth: +releaseDepth.toFixed(2),
          });
          finishHold();
          return;
        }
      } else {
        releaseCandidateSinceRef.current = null;
      }

      if (debugOn) {
        setDebugSnapshot({
          pitch: pitchRef.current,
          targetDelta,
          sd,
          threshold: adaptiveThreshold,
          lockAgeMs,
          onTargetDwellMs,
          lastCue: lastCueRef.current,
          releaseCandidateMs:
            releaseCandidateSinceRef.current != null ? now - releaseCandidateSinceRef.current : 0,
        });
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
  }, [
    stage,
    baseline,
    plateau,
    holdTarget,
    isStable,
    pitchRef,
    traceRef,
    finishHold,
    logEvent,
    emitCue,
    debugOn,
  ]);

  const startHold = () => {
    resetHoldState();
    setStage("active");
    holdStartRef.current = performance.now();
    holdStartedAtIsoRef.current = new Date().toISOString();
    lastSampleAtRef.current = performance.now();
    logEvent("hold_start", {
      breathingSD: +baseline.breathingSD.toFixed(3),
      adaptiveThreshold: +adaptiveThresholdFor(baseline).toFixed(3),
    });
    emitCue("inhale_cue");
  };

  const orbMood: OrbMood =
    stage === "active" ? (isStable ? "calm" : "active") : "calm";
  // While drifting in active mode, color = drifting (warning amber)
  const orbDrifting =
    stage === "active" && !isStable && firstLockAtRef.current != null;

  // Progress = stable AND on-target time relative to holdTarget. The stable-only
  // run is a secondary track on the meter — they get partial credit for
  // holding still even if not on target yet.
  const targetPct = Math.min(100, (longestOnTargetSec / holdTarget) * 100);
  const stablePct = Math.min(100, (longestRunSec / holdTarget) * 100);
  // Target-ring breath scale: where the orb should sit when on target. The
  // patient inhales until their live orb fills this ring.
  const targetBreathScale = Math.min(
    1,
    Math.abs(plateau.targetPitch - baseline.meanPitch) / 12,
  );

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
            freeze={stage === "active" && isStable && positionLabel === "ontarget"}
            mood={orbDrifting ? "drifting" : orbMood}
            targetScale={stage === "active" ? targetBreathScale : undefined}
            secondsLeft={
              stage === "active" && isStable && positionLabel === "ontarget"
                ? Math.max(0, Math.ceil(holdTarget - longestOnTargetSec))
                : null
            }
            label={
              stage === "active" && isStable && positionLabel === "ontarget"
                ? "on target"
                : undefined
            }
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
              : "Review"}
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
              : pendingHold?.reachedTarget
              ? "Nice hold"
              : "Save this hold?"}
          </div>
        </div>
      </div>

      {/* On-target time card */}
      <div style={{ padding: "0 24px 32px", zIndex: 2, position: "relative" }}>
        {/* Position indicator — only during active holds */}
        {stage === "active" && firstLockAtRef.current != null && (
          <div className="mb-3">
            <PositionMeter
              pitch={pitch}
              target={plateau.targetPitch}
              tolerance={plateau.toleranceDeg}
              label={positionLabel}
            />
          </div>
        )}
        {debugOn && stage === "active" && <DebugPanel data={debugSnapshot} />}
        <Card className="p-5">
          <div className="flex items-baseline justify-between">
            <div className="text-[10px] uppercase tracking-widest font-semibold" style={{ color: P.muted }}>
              On-target time
            </div>
            <div className="text-[10px] uppercase tracking-widest font-semibold" style={{ color: P.muted }}>
              Target {holdTarget}s · ±{fmt(plateau.toleranceDeg, 1)}°
            </div>
          </div>
          <div className="flex items-baseline gap-2 mt-1">
            <div style={{ fontSize: 36, fontWeight: 700, color: P.ink, letterSpacing: -1, fontVariantNumeric: "tabular-nums" }}>
              {fmt(longestOnTargetSec, 1)}
            </div>
            <div style={{ fontSize: 13, color: P.ink2 }}>s longest on target</div>
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
            <span>{fmt(longestRunSec, 1)}s stable · {fmt(onTargetSec, 1)}s on-target</span>
            <span>
              tilt {fmt(pitch)}° · target {fmt(plateau.targetPitch)}°
            </span>
          </div>
          <div className="mt-3">
            {stage === "idle" && <Btn onClick={startHold}>Start hold {holdIdx + 1}</Btn>}
            {stage === "active" && (
              <Btn variant="ghost" onClick={finishHold}>
                End hold
              </Btn>
            )}
            {stage === "review" && (
              <div className="flex gap-2.5">
                <Btn variant="ghost" onClick={redoPracticeHold} className="flex-1">
                  Redo
                </Btn>
                <Btn onClick={saveHold} disabled={!pendingHold} className="flex-1">
                  Save hold
                </Btn>
              </div>
            )}
          </div>
        </Card>
      </div>
    </div>
  );
}

// ─── Complete ───────────────────────────────────────────────────────────────
function makeSessionExport({
  startedAt,
  settings,
  baseline,
  plateau,
  holds,
}: {
  startedAt: string | null;
  settings: SessionSettings;
  baseline: Baseline;
  plateau: Plateau;
  holds: Hold[];
}): SessionExport {
  return {
    schema: "dibh-session/v1",
    app: "DIBH Coach",
    exportedAt: new Date().toISOString(),
    startedAt: startedAt ?? holds[0]?.startedAt ?? new Date().toISOString(),
    ua: typeof navigator !== "undefined" ? navigator.userAgent : "",
    settings,
    baseline,
    plateau,
    holds,
  };
}

function Complete({
  holds,
  holdTarget,
  baseline,
  plateau,
  settings,
  sessionStartedAt,
  onAgain,
  onDone,
}: {
  holds: Hold[];
  holdTarget: number;
  baseline: Baseline;
  plateau: Plateau;
  settings: SessionSettings;
  sessionStartedAt: string | null;
  onAgain: () => void;
  onDone: () => void;
}) {
  const [exportStatus, setExportStatus] = useState<string | null>(null);
  const reached = holds.filter((h) => h.reachedTarget).length;
  const meanOnTarget =
    holds.length > 0
      ? holds.reduce((a, h) => a + h.longestOnTargetRunSec, 0) / holds.length
      : 0;
  const meanPlateauPitch = (() => {
    const pp = holds.map((h) => h.plateauPitch).filter((v): v is number => v != null);
    return pp.length ? pp.reduce((a, b) => a + b, 0) / pp.length : null;
  })();
  // Reproducibility = SD of plateau pitch across the practice holds. Lower is
  // better. This is the headline clinical metric.
  const reproSD = (() => {
    const pp = holds.map((h) => h.plateauPitch).filter((v): v is number => v != null);
    if (pp.length < 2) return null;
    const m = pp.reduce((a, b) => a + b, 0) / pp.length;
    return Math.sqrt(pp.reduce((a, b) => a + (b - m) ** 2, 0) / pp.length);
  })();
  const driftTotal = holds.reduce((a, h) => a + h.driftEvents, 0);
  const exportSession = async () => {
    const payload = makeSessionExport({
      startedAt: sessionStartedAt,
      settings,
      baseline,
      plateau,
      holds,
    });
    const stamp = payload.startedAt.replace(/[:.]/g, "-");
    await shareOrDownloadJson(`dibh-session-${stamp}.json`, payload);
    setExportStatus("Session JSON ready to email back.");
  };

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
        style={{ padding: "20px 28px 0", zIndex: 1, overflowY: "auto" }}
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
              [`${fmt(meanOnTarget, 1)}s`, "avg on-target"],
              [reproSD != null ? `±${fmt(reproSD, 2)}°` : "—", "reproducibility"],
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
                const pct = Math.min(100, (h.longestOnTargetRunSec / holdTarget) * 100);
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
                      {fmt(h.longestOnTargetRunSec, 0)}s
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
        <Card className="mt-4 p-4">
          <div
            className="text-[10px] uppercase tracking-widest font-semibold"
            style={{ color: P.muted }}
          >
            Self-test export
          </div>
          <p style={{ fontSize: 13, color: P.ink2, marginTop: 6, lineHeight: 1.45 }}>
            Save this JSON after testing and email it back for recalibration.
          </p>
          <div className="mt-3">
            <Btn onClick={exportSession}>Export session JSON</Btn>
          </div>
          {exportStatus && (
            <p style={{ fontSize: 12, color: P.good, margin: "8px 0 0", textAlign: "center" }}>
              {exportStatus}
            </p>
          )}
        </Card>
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
