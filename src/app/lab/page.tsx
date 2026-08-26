"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { playClip, stopAudio, unlockAudio } from "@/audio";
import { analyzeLabRecording, LAB_P0_ALGORITHM } from "@/lib/lab-p0-analysis.mjs";
import {
  analyzePositionSignal,
  detectRegularBreathingCycles,
} from "@/lib/breath-cycle-analysis.mjs";
import LabTrace, { type TraceRecording } from "./LabTrace";

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

const CHANNELS = [
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
] as const;

type LabEvent = { t: number; type: string; meta?: Record<string, unknown> };

type GuidedConfig = {
  holdSeconds: number;
  calibrationHoldCount?: number;
  practiceHoldCount: number;
  requiredNormalCycles?: number;
  correctionLimit?: number;
  initialDirection: -1 | 1;
  cycleCount: number;
  baselineSeconds: number;
  recoverySeconds: number;
};

type LearnedTarget = {
  direction: number;
  excursionDeg: number;
  toleranceDeg: number;
};

type BreathingCycleResult = {
  ready: boolean;
  qualifiedPeakCount: number;
  windowStartMs?: number;
  windowEndMs?: number;
  direction?: number;
  peaks?: Array<{ t: number; pitchDeg: number }>;
  troughs?: Array<{ t: number; pitchDeg: number }>;
  meanInspiratoryPeakPitchDeg?: number;
  meanCyclePeriodSec?: number;
  cyclePeriodCv?: number;
  meanAmplitudeDeg?: number;
  amplitudeCv?: number;
};

type GuidedStage =
  | "idle"
  | "setup"
  | "rehearsal"
  | "baseline"
  | "breathing"
  | "calibration"
  | "practice"
  | "cycle"
  | "complete";

type LiveGate = {
  mode: "calibration" | "practice";
  anchorPitch: number;
  direction: number;
  targetExcursionDeg: number | null;
  toleranceDeg: number | null;
  label: string;
};

type PositionSignalAnalysis = {
  enoughData: boolean;
  analyzedDurationSec: number | null;
  settlingSecondsExcluded: number | null;
  usableCycleCount: number;
  medianPeakToTroughAmplitudeDeg: number | null;
  amplitudeCv: number | null;
  medianCyclePeriodSec: number | null;
  cyclePeriodCv: number | null;
  estimatedBreathsPerMinute: number | null;
  noiseRobustSdDeg: number | null;
  noiseFloorDeg: number;
  amplitudeToNoiseRatio: number | null;
  driftDegPerMinute: number | null;
  direction: number;
};

type PositionStudy = {
  mode: "normal_breathing_position_study";
  locationId: string;
  locationLabel: string;
  alignment: "midline" | "left" | "right";
  posture: "supine" | "reclined" | "seated";
  attachment: "resting" | "light-contact" | "secured";
  phoneOrientation: "flat_charging_port_toward_face";
  requestedDurationSec: number;
  analysis: PositionSignalAnalysis;
};

type PositionRun = PositionStudy & {
  sessionId: string;
  recordedAt: string;
};

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
    rehearsal: boolean;
    baselineSeconds: number | null;
    cycleCount: number | null;
    requiredNormalCycles: number | null;
    calibrationHoldCount: number | null;
    correctionLimit: number | null;
    holdSeconds: number | null;
    holdCount: number | null;
    learnHoldCount: number | null;
    calibrationAttemptLimit: number | null;
    practiceHoldCount: number | null;
    practiceAttemptLimit: number | null;
    targetAcquisitionSeconds: number | null;
    recoverySeconds: number | null;
    handsFree: boolean;
    phonePlacement: "charging_port_toward_face" | null;
    targetMethod: "local_three_peak_delta_mean_combined_sd" | "median_relative_excursion" | null;
  };
  positionStudy: PositionStudy | null;
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

const POSITION_LOCATIONS = [
  ["upper-chest", "Upper chest / sternum"],
  ["lower-chest", "Lower chest / xiphoid"],
  ["upper-abdomen", "Upper abdomen"],
  ["navel", "Mid abdomen / navel"],
  ["lower-abdomen", "Lower abdomen"],
  ["custom", "Custom location"],
] as const;

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

const GUIDED_JOURNEY: Array<{
  id: Exclude<GuidedStage, "idle">;
  title: string;
  detail: string;
  data: string;
}> = [
  {
    id: "breathing",
    title: "1. Three cycles",
    detail: "Wait for three complete regular breaths before every hold.",
    data: "Three local inspiratory peaks",
  },
  {
    id: "calibration",
    title: "2. Calibrate ×3",
    detail: "Measure each local peak-to-10-second-hold delta.",
    data: "Three local deltas plus within-hold drift",
  },
  {
    id: "practice",
    title: "3. Coach ×3",
    detail: "Guide each 10-second hold inside the learned band.",
    data: "Beam-on time and up to two corrections",
  },
  {
    id: "complete",
    title: "4. Review",
    detail: "Inspect the uninterrupted trace and download the JSON.",
    data: "Local anchors, deltas, range, and coaching response",
  },
];

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
  const [imported, setImported] = useState<Recording | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [freeMode, setFreeMode] = useState<"standard" | "position-study">("standard");
  const [positionLocation, setPositionLocation] = useState<string>(POSITION_LOCATIONS[0][0]);
  const [positionCustomLocation, setPositionCustomLocation] = useState("");
  const [positionAlignment, setPositionAlignment] = useState<"midline" | "left" | "right">("midline");
  const [positionPosture, setPositionPosture] = useState<"supine" | "reclined" | "seated">("supine");
  const [positionAttachment, setPositionAttachment] = useState<"resting" | "light-contact" | "secured">("resting");
  const [positionDurationSec, setPositionDurationSec] = useState(30);
  const [positionTraceAnchorPitch, setPositionTraceAnchorPitch] = useState<number | null>(null);
  const [positionTraceSessionStart, setPositionTraceSessionStart] = useState<number | null>(null);
  const [positionRuns, setPositionRuns] = useState<PositionRun[]>([]);

  // ---- guided runner state -----------------------------------------------
  const [guidedActive, setGuidedActive] = useState(false);
  const [guidedStage, setGuidedStage] = useState<GuidedStage>("idle");
  const [guidedPhase, setGuidedPhase] = useState<string>("IDLE");
  const [guidedLabel, setGuidedLabel] = useState<string>("");
  const [guidedHoldSec, setGuidedHoldSec] = useState<number>(10);
  const [guidedRecoverySec, setGuidedRecoverySec] = useState<number>(20);
  const [guidedPracticeGoal, setGuidedPracticeGoal] = useState<number>(8);
  const [stepCountdown, setStepCountdown] = useState<number>(0);
  const [liveGate, setLiveGate] = useState<LiveGate | null>(null);
  const [audioStatus, setAudioStatus] = useState<"ready" | "testing" | "error" | null>(null);
  const [traceAnchorPitch, setTraceAnchorPitch] = useState<number | null>(null);
  const [traceSessionStart, setTraceSessionStart] = useState<number | null>(null);

  // ---- refs ---------------------------------------------------------------
  const samplesRef = useRef<Sample[]>([]);
  const eventsRef = useRef<LabEvent[]>([]);
  const startedAtRef = useRef<number>(0);
  const startedAtIsoRef = useRef<string>("");
  const sessionIdRef = useRef<string>("");
  const activeScenarioRef = useRef<string>(SCENARIOS[0]);
  const recordingRef = useRef(false);
  const guidedConfigRef = useRef<GuidedConfig | null>(null);
  const positionStudyRef = useRef<Omit<PositionStudy, "analysis"> | null>(null);
  const positionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const learnedTargetRef = useRef<LearnedTarget | null>(null);
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

  useEffect(() => () => {
    if (positionTimerRef.current) clearTimeout(positionTimerRef.current);
  }, []);

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
    // Run before either permission await so iOS sees it inside the tap.
    unlockAudio();
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
    setGranted(true);
  }, []);

  // ---- recording control --------------------------------------------------
  const startRec = (
    sc?: string,
    guidedConfig?: GuidedConfig | null,
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

  const markAt = (t: number, type: string, meta?: Record<string, unknown>) => {
    const e: LabEvent = {
      t: +Math.max(0, t).toFixed(1),
      type,
      ...(meta !== undefined ? { meta } : {}),
    };
    eventsRef.current.push(e);
    eventsRef.current.sort((a, b) => a.t - b.t);
    setEvents([...eventsRef.current]);
  };

  const mark = (type: string, meta?: Record<string, unknown>) => {
    markAt(performance.now() - startedAtRef.current, type, meta);
  };

  const coach = async (
    cue: Parameters<typeof playClip>[0],
    meta: Record<string, unknown> = {},
  ) => {
    mark("coach_cue", { ...meta, cue });
    const result = await playClip(cue);
    mark("coach_cue_end", { ...meta, cue, result });
    if (result === "ended") setAudioStatus("ready");
    if (result === "failed" || result === "timed_out") setAudioStatus("error");
    return result;
  };

  const testVoice = async () => {
    setAudioStatus("testing");
    unlockAudio();
    const result = await playClip("p0_inhale");
    setAudioStatus(result === "ended" ? "ready" : "error");
  };

  const stopRec = () => {
    if (!recordingRef.current) return;
    recordingRef.current = false;
    setRecording(false);
    if (positionTimerRef.current) {
      clearTimeout(positionTimerRef.current);
      positionTimerRef.current = null;
    }
    const totalDur = (performance.now() - startedAtRef.current) / 1000;
    const guidedConfig = guidedConfigRef.current;
    const positionStudyMeta = positionStudyRef.current;
    if (positionStudyMeta) {
      markAt(totalDur * 1000, "position_study_end", {
        locationId: positionStudyMeta.locationId,
        alignment: positionStudyMeta.alignment,
        posture: positionStudyMeta.posture,
        attachment: positionStudyMeta.attachment,
      });
    }
    const positionAnalysis = positionStudyMeta
      ? analyzePositionSignal(
          samplesRef.current.flatMap((sample) => {
            const samplePitch = sample[3] ?? sample[2];
            return samplePitch == null ? [] : [{ t: sample[0], p: samplePitch }];
          }),
          { direction: -1, startMs: 0, endMs: totalDur * 1000, settlingMs: 3000 },
        ) as PositionSignalAnalysis
      : null;
    const positionStudy = positionStudyMeta && positionAnalysis
      ? { ...positionStudyMeta, analysis: positionAnalysis }
      : null;
    const recordingBase = {
      schema: "dibh-lab/v3" as const,
      sessionId: sessionIdRef.current,
      appBuild: "lab-p0.9",
      algorithm: LAB_P0_ALGORITHM,
      scenario: activeScenarioRef.current,
      note,
      startedAt: startedAtIsoRef.current,
      durationSec: +totalDur.toFixed(2),
      ua: navigator.userAgent,
      protocol: {
        mode: guidedConfig ? ("guided" as const) : ("free" as const),
        rehearsal: false,
        baselineSeconds: guidedConfig?.baselineSeconds ?? null,
        cycleCount:
          guidedConfig?.calibrationHoldCount != null && guidedConfig?.practiceHoldCount != null
            ? guidedConfig.calibrationHoldCount + guidedConfig.practiceHoldCount
            : guidedConfig?.cycleCount ?? null,
        requiredNormalCycles: guidedConfig?.requiredNormalCycles ?? null,
        calibrationHoldCount: guidedConfig?.calibrationHoldCount ?? null,
        correctionLimit: guidedConfig?.correctionLimit ?? null,
        holdSeconds: guidedConfig?.holdSeconds ?? null,
        holdCount:
          guidedConfig?.calibrationHoldCount != null && guidedConfig?.practiceHoldCount != null
            ? guidedConfig.calibrationHoldCount + guidedConfig.practiceHoldCount
            : guidedConfig?.cycleCount ?? null,
        learnHoldCount: guidedConfig?.calibrationHoldCount ?? null,
        calibrationAttemptLimit: guidedConfig?.calibrationHoldCount != null ? 6 : null,
        practiceHoldCount: guidedConfig?.practiceHoldCount ?? null,
        practiceAttemptLimit:
          guidedConfig?.practiceHoldCount != null ? guidedConfig.practiceHoldCount * 2 : null,
        targetAcquisitionSeconds: null,
        recoverySeconds: null,
        handsFree: Boolean(guidedConfig),
        phonePlacement: guidedConfig ? "charging_port_toward_face" as const : null,
        targetMethod: guidedConfig?.calibrationHoldCount
          ? "local_three_peak_delta_mean_combined_sd" as const
          : null,
      },
      positionStudy,
      samples: samplesRef.current,
      events: eventsRef.current,
      channels: [...CHANNELS] as Recording["channels"],
    };
    const rec: Recording = {
      ...recordingBase,
      analysis: analyzeLabRecording(recordingBase),
    };
    setLast(rec);
    if (positionStudy) {
      setPositionRuns((previous) => [
        ...previous,
        {
          ...positionStudy,
          sessionId: rec.sessionId,
          recordedAt: rec.startedAt,
        },
      ]);
    }
    positionStudyRef.current = null;
    download(rec);
  };

  const startPositionStudy = () => {
    const preset = POSITION_LOCATIONS.find(([id]) => id === positionLocation);
    const locationLabel =
      positionLocation === "custom"
        ? positionCustomLocation.trim() || "Custom location"
        : preset?.[1] ?? positionLocation;
    const studyMeta: Omit<PositionStudy, "analysis"> = {
      mode: "normal_breathing_position_study",
      locationId: positionLocation,
      locationLabel,
      alignment: positionAlignment,
      posture: positionPosture,
      attachment: positionAttachment,
      phoneOrientation: "flat_charging_port_toward_face",
      requestedDurationSec: positionDurationSec,
    };
    positionStudyRef.current = studyMeta;
    startRec(`position-${positionLocation}-${positionAlignment}-${positionDurationSec}s`, null);
    setPositionTraceAnchorPitch(pitch);
    setPositionTraceSessionStart(startedAtRef.current);
    markAt(0, "position_study_start", {
      locationId: studyMeta.locationId,
      locationLabel: studyMeta.locationLabel,
      alignment: studyMeta.alignment,
      posture: studyMeta.posture,
      attachment: studyMeta.attachment,
      phoneOrientation: studyMeta.phoneOrientation,
      requestedDurationSec: studyMeta.requestedDurationSec,
      instruction: "breathe_normally",
    });
    positionTimerRef.current = setTimeout(stopRec, positionDurationSec * 1000);
  };

  // ---- guided runner ------------------------------------------------------
  const guidedRunningRef = useRef(false);

  const enterGuidedStage = (stage: GuidedStage) => {
    setGuidedStage(stage);
    mark("guided_stage", { stage });
  };

  const enterGuidedPhase = (
    phase: string,
    label: string,
    meta: Record<string, unknown> = {},
  ) => {
    setGuidedPhase(phase.toUpperCase());
    setGuidedLabel(label);
    mark("guided_phase", { ...meta, phase, label });
  };

  const waitUntil = async (endAt: number, label: string) => {
    setGuidedLabel(label);
    while (guidedRunningRef.current && performance.now() < endAt) {
      setStepCountdown(Math.max(1, Math.ceil((endAt - performance.now()) / 1000)));
      await sleep(150);
    }
    setStepCountdown(0);
  };

  const waitGuidedSeconds = async (seconds: number, label: string) => {
    await waitUntil(performance.now() + seconds * 1000, label);
  };

  const waitThroughTimedHold = async (
    holdStartedAt: number,
    seconds: number,
    label: string,
    meta: Record<string, unknown>,
  ) => {
    const deadline = holdStartedAt + seconds * 1000;
    let fiveSecondsAnnounced = seconds <= 5;
    let audioAvailable = true;
    setGuidedLabel(label);
    while (guidedRunningRef.current && performance.now() < deadline) {
      const now = performance.now();
      setStepCountdown(Math.max(1, Math.ceil((deadline - now) / 1000)));
      if (!fiveSecondsAnnounced && now >= deadline - 5000) {
        fiveSecondsAnnounced = true;
        const result = await coach("p0_five_seconds_left", {
          ...meta,
          reason: "five_seconds_remaining",
        });
        if (result !== "ended") {
          audioAvailable = false;
          guidedRunningRef.current = false;
          break;
        }
      }
      await sleep(150);
    }
    setStepCountdown(0);
    return audioAvailable && guidedRunningRef.current;
  };

  const waitForRestAnchor = async (
    meta: Record<string, unknown>,
    seconds: number,
    restStartedAt = performance.now(),
    announceRest = true,
  ) => {
    enterGuidedPhase("rest", `REST • Breathe normally`, meta);
    if (announceRest) await coach("p0_rest", meta);
    const endAt = restStartedAt + seconds * 1000;
    let readyPlayed = false;
    let capturedAnchor:
      | {
          pitch: number | null;
          stable: boolean;
        }
      | null = null;
    const captureAnchor = () => {
      const captureAtMs = performance.now() - startedAtRef.current;
      const latest = recentPitchStats(
        samplesRef.current,
        captureAtMs,
        LAB_P0_ALGORITHM.params.restingWindowMs,
      );
      const startMs = latest?.startMs ?? Math.max(0, captureAtMs - 2000);
      const stable = Boolean(
        latest &&
          latest.sdDeg <= LAB_P0_ALGORITHM.params.restingSdCeilingDeg &&
          Math.abs(latest.slopeDegPerSec) <= LAB_P0_ALGORITHM.params.restingSlopeCeilingDegPerSec,
      );
      markAt(startMs, "prehold_start", meta);
      markAt(captureAtMs, "prehold_end", {
        ...meta,
        source: "pre_ready_rest_window",
        sdDeg: latest?.sdDeg ?? null,
        slopeDegPerSec: latest?.slopeDegPerSec ?? null,
        stable,
      });
      markAt(captureAtMs, "rest_anchor_acquired", {
        ...meta,
        source: "pre_ready_rest_window",
        pitchDeg: latest?.medianPitchDeg ?? null,
        sdDeg: latest?.sdDeg ?? null,
        slopeDegPerSec: latest?.slopeDegPerSec ?? null,
        stable,
      });
      if (!stable) mark("rest_anchor_low_confidence", meta);
      return {
        pitch: latest?.medianPitchDeg ?? oRef.current.betaEma ?? oRef.current.beta,
        stable,
      };
    };
    while (guidedRunningRef.current && performance.now() < endAt) {
      const remainingMs = endAt - performance.now();
      if (!readyPlayed && remainingMs <= 5000) {
        readyPlayed = true;
        capturedAnchor = captureAnchor();
        enterGuidedPhase("ready", "READY • Deep breath in five seconds", meta);
        await coach("p0_ready", meta);
      }
      setStepCountdown(Math.max(1, Math.ceil((endAt - performance.now()) / 1000)));
      await sleep(150);
    }
    capturedAnchor ??= captureAnchor();
    setStepCountdown(0);
    return capturedAnchor.pitch;
  };

  const currentAnalysis = () => {
    const elapsedSec = (performance.now() - startedAtRef.current) / 1000;
    return analyzeLabRecording({
      schema: "dibh-lab/v3",
      durationSec: elapsedSec,
      protocol: { holdSeconds: guidedConfigRef.current?.holdSeconds ?? null },
      channels: CHANNELS,
      samples: samplesRef.current,
      events: eventsRef.current,
    });
  };

  const provisionalCalibrationGate = () => {
    const analysis = currentAnalysis();
    const candidates = analysis.holds.filter(
      (hold: { role: string; valid: boolean; relativeExcursionDeg?: number | null }) =>
        hold.role === "learn" && hold.valid && Number.isFinite(hold.relativeExcursionDeg),
    );
    const excursions = candidates.map(
      (hold: { relativeExcursionDeg: number }) => hold.relativeExcursionDeg,
    );
    const target = medianClient(excursions);
    return {
      direction: Number.isFinite(analysis.summary.learnedDirection)
        ? (analysis.summary.learnedDirection as number)
        : (guidedConfigRef.current?.initialDirection ?? -1),
      target,
      tolerance:
        target == null ? null : Math.min(2, Math.max(1.25, target * 0.35)),
      candidateCount: candidates.length,
    };
  };

  const acquirePracticeTarget = async (
    meta: Record<string, unknown>,
    anchorPitch: number,
    target: LearnedTarget,
    deadline: number,
  ) => {
    const started = performance.now();
    let inBandSince: number | null = null;
    let correctionIssued = false;
    while (guidedRunningRef.current && performance.now() < deadline) {
      const now = performance.now();
      setStepCountdown(Math.max(1, Math.ceil((deadline - now) / 1000)));
      const currentPitch = oRef.current.betaEma ?? oRef.current.beta;
      if (currentPitch == null) {
        await sleep(150);
        continue;
      }
      const excursion = target.direction * (currentPitch - anchorPitch);
      const error = excursion - target.excursionDeg;
      const inBand = Math.abs(error) <= target.toleranceDeg;
      if (inBand) {
        inBandSince ??= now;
        if (now - inBandSince >= LAB_P0_ALGORITHM.params.targetAcquireDwellMs) {
          mark("target_acquired", {
            ...meta,
            measuredExcursionDeg: roundClient(excursion),
            targetExcursionDeg: target.excursionDeg,
            toleranceDeg: target.toleranceDeg,
          });
          await coach("p0_in_range_ding", {
            ...meta,
            reason: "target_acquired",
            measuredExcursionDeg: roundClient(excursion),
            targetExcursionDeg: target.excursionDeg,
          });
          return true;
        }
      } else {
        inBandSince = null;
        if (!correctionIssued && now - started >= 1800) {
          correctionIssued = true;
          const cue = error < 0 ? "p0_deeper" : "p0_ease_back";
          await coach(cue, {
            ...meta,
            reason: error < 0 ? "below_learned_excursion" : "above_learned_excursion",
            measuredExcursionDeg: roundClient(excursion),
            targetExcursionDeg: target.excursionDeg,
            errorDeg: roundClient(error),
          });
        }
      }
      await sleep(150);
    }
    setStepCountdown(0);
    mark("target_acquisition_timeout", {
      ...meta,
      targetExcursionDeg: target.excursionDeg,
      toleranceDeg: target.toleranceDeg,
    });
    return false;
  };

  const runPracticeHold = async (
    seconds: number,
    meta: Record<string, unknown>,
    anchorPitch: number,
    target: LearnedTarget,
    holdStartedAt: number,
  ) => {
    const deadline = holdStartedAt + seconds * 1000;
    let wasInBand: boolean | null = null;
    let outOfBandSince: number | null = null;
    let correctionIssued = false;
    let fiveSecondsAnnounced = seconds <= 5;
    const practiceGoal = guidedConfigRef.current?.practiceHoldCount ?? 2;
    setGuidedLabel(`HOLD • Practice ${meta.practiceNumber} of ${practiceGoal}`);
    while (guidedRunningRef.current && performance.now() < deadline) {
      const now = performance.now();
      setStepCountdown(Math.max(1, Math.ceil((deadline - now) / 1000)));
      if (!fiveSecondsAnnounced && now >= deadline - 5000) {
        fiveSecondsAnnounced = true;
        await coach("p0_five_seconds_left", {
          ...meta,
          reason: "five_seconds_remaining",
        });
      }
      const currentPitch = oRef.current.betaEma ?? oRef.current.beta;
      if (currentPitch != null) {
        const excursion = target.direction * (currentPitch - anchorPitch);
        const error = excursion - target.excursionDeg;
        const inBand = Math.abs(error) <= target.toleranceDeg;
        if (wasInBand != null && inBand !== wasInBand) {
          mark(inBand ? "target_enter" : "target_exit", {
            ...meta,
            measuredExcursionDeg: roundClient(excursion),
            errorDeg: roundClient(error),
          });
          wasInBand = inBand;
        }
        if (inBand) {
          outOfBandSince = null;
          correctionIssued = false;
        } else {
          outOfBandSince ??= now;
          if (!correctionIssued && now - outOfBandSince >= 1200) {
            correctionIssued = true;
            await coach(error < 0 ? "p0_deeper" : "p0_ease_back", {
              ...meta,
              reason: error < 0 ? "drifted_below_target" : "drifted_above_target",
              measuredExcursionDeg: roundClient(excursion),
              targetExcursionDeg: target.excursionDeg,
              errorDeg: roundClient(error),
            });
          }
          if (outOfBandSince != null && performance.now() - outOfBandSince >= 3500) {
            mark("practice_hold_aborted", {
              ...meta,
              reason: error < 0 ? "sustained_below_target" : "sustained_above_target",
              measuredExcursionDeg: roundClient(excursion),
              targetExcursionDeg: target.excursionDeg,
              errorDeg: roundClient(error),
            });
            setStepCountdown(0);
            return false;
          }
        }
        wasInBand = inBand;
      }
      await sleep(200);
    }
    setStepCountdown(0);
    return guidedRunningRef.current;
  };

  const startGuidedObservationLegacy = async () => {
    unlockAudio();
    if (!granted) {
      await requestPerm();
      return;
    }
    if (recording) return;

    const config: GuidedConfig = {
      holdSeconds: 10,
      cycleCount: 3,
      baselineSeconds: 10,
      recoverySeconds: 10,
      initialDirection: -1,
      practiceHoldCount: 0,
    };
    startRec("p0-observation-3x10s", config);
    const sessionStart = startedAtRef.current;
    const initialPitch = oRef.current.betaEma ?? oRef.current.beta ?? pitch;
    setTraceAnchorPitch(initialPitch);
    setTraceSessionStart(sessionStart);
    setGuidedActive(true);
    guidedRunningRef.current = true;

    const requireCue = async (
      cue: Parameters<typeof playClip>[0],
      meta: Record<string, unknown>,
    ) => {
      const result = await coach(cue, meta);
      if (result === "ended") return true;
      mark("session_end", { outcome: "audio_unavailable", cue, result });
      setGuidedLabel("AUDIO UNAVAILABLE • Stop and use Test voice before restarting");
      return false;
    };

    const markQuietWindow = (meta: Record<string, unknown>) => {
      const endMs = performance.now() - startedAtRef.current;
      markAt(Math.max(0, endMs - 2000), "prehold_start", meta);
      markAt(endMs, "prehold_end", {
        ...meta,
        source: "continuous_trace_pre_inhale_window",
      });
    };

    try {
      enterGuidedStage("baseline");
      mark("baseline_start");
      enterGuidedPhase("baseline", "BREATHE NORMALLY • First 10 seconds");
      const baselineStartedAt = performance.now();
      if (!(await requireCue("p0_rest", { phase: "baseline" }))) return;
      await waitUntil(
        baselineStartedAt + config.baselineSeconds * 1000,
        "BREATHE NORMALLY • First 10 seconds",
      );
      mark("baseline_end");

      for (let cycle = 1; cycle <= config.cycleCount && guidedRunningRef.current; cycle++) {
        const meta: Record<string, unknown> = {
          holdIndex: cycle,
          role: "observation",
          cycleNumber: cycle,
        };
        markQuietWindow(meta);
        enterGuidedStage("cycle");
        enterGuidedPhase(
          "inhale",
          `DEEP BREATH • Cycle ${cycle} of ${config.cycleCount}`,
          meta,
        );
        mark("inhale_start", meta);
        if (!(await requireCue("p0_inhale", meta))) return;

        enterGuidedPhase(
          "hold",
          `HOLD • Cycle ${cycle} of ${config.cycleCount}`,
          meta,
        );
        const holdStartedAt = performance.now();
        mark("hold_start", meta);
        const holdCompleted = await waitThroughTimedHold(
          holdStartedAt,
          config.holdSeconds,
          `HOLD • Cycle ${cycle} of ${config.cycleCount}`,
          meta,
        );
        if (!holdCompleted) {
          mark("session_end", {
            outcome: "audio_unavailable",
            cue: "p0_five_seconds_left",
          });
          return;
        }

        mark("release", meta);
        const releaseStartedAt = performance.now();
        enterGuidedPhase(
          "release",
          `BREATHE NORMALLY • Cycle ${cycle} complete`,
          meta,
        );
        if (!(await requireCue("p0_release", meta))) return;
        enterGuidedPhase(
          "rest",
          cycle < config.cycleCount
            ? `BREATHE NORMALLY • Next breath in 10 seconds`
            : "BREATHE NORMALLY • Final recovery",
          meta,
        );
        await waitUntil(
          releaseStartedAt + config.recoverySeconds * 1000,
          cycle < config.cycleCount
            ? `BREATHE NORMALLY • Next breath in 10 seconds`
            : "BREATHE NORMALLY • Final recovery",
        );
        mark("recovery_end", meta);
      }

      if (guidedRunningRef.current) {
        enterGuidedStage("complete");
        enterGuidedPhase("complete", "COMPLETE • Three cycles recorded");
        mark("session_end", { outcome: "observation_complete", cycleCount: 3 });
      }
    } finally {
      setGuidedActive(false);
      setGuidedStage("idle");
      setGuidedPhase("IDLE");
      setGuidedLabel("");
      setStepCountdown(0);
      guidedRunningRef.current = false;
      if (recordingRef.current) {
        await sleep(400);
        stopRec();
      }
    }
  };

  const startGuided = async () => {
    unlockAudio();
    if (!granted) {
      await requestPerm();
      return;
    }
    if (recording) return;

    const config: GuidedConfig = {
      holdSeconds: 10,
      calibrationHoldCount: 3,
      practiceHoldCount: 3,
      requiredNormalCycles: 3,
      correctionLimit: 2,
      initialDirection: -1,
      cycleCount: 6,
      baselineSeconds: 0,
      recoverySeconds: 0,
    };
    startRec("p0-local-3peak-calibration-coaching", config);
    const sessionStart = startedAtRef.current;
    const initialPitch = oRef.current.betaEma ?? oRef.current.beta ?? pitch;
    setTraceAnchorPitch(initialPitch);
    setTraceSessionStart(sessionStart);
    setGuidedActive(true);
    guidedRunningRef.current = true;

    const requireCue = async (
      cue: Parameters<typeof playClip>[0],
      meta: Record<string, unknown>,
    ) => {
      const result = await coach(cue, meta);
      if (result === "ended") return true;
      mark("session_end", { outcome: "audio_unavailable", cue, result });
      setGuidedLabel("AUDIO UNAVAILABLE • Stop and use Test voice before restarting");
      guidedRunningRef.current = false;
      return false;
    };

    const signalPoints = () =>
      samplesRef.current
        .map((sample) => ({ t: sample[0], p: sample[3] ?? sample[2] }))
        .filter((point): point is { t: number; p: number } =>
          point.p != null && Number.isFinite(point.p),
        );

    const waitForThreeCycles = async (
      meta: Record<string, unknown>,
      observationStartMs: number,
      announceRest: boolean,
    ) => {
      const waitingStage: GuidedStage =
        meta.role === "practice"
          ? "practice"
          : Number(meta.calibrationNumber) > 1
            ? "calibration"
            : "breathing";
      enterGuidedStage(waitingStage);
      enterGuidedPhase("rest", "BREATHE NORMALLY • Waiting for 3 regular cycles", meta);
      mark("breathing_cycle_observation_start", {
        ...meta,
        requiredCycles: config.requiredNormalCycles,
        source: "physiology_driven",
      });
      if (announceRest && !(await requireCue("p0_rest", meta))) return null;
      while (guidedRunningRef.current) {
        const result = detectRegularBreathingCycles(signalPoints(), {
          direction: config.initialDirection,
          startMs: observationStartMs,
          requiredCycles: config.requiredNormalCycles,
        }) as BreathingCycleResult;
        setStepCountdown(result.qualifiedPeakCount ?? 0);
        setGuidedLabel(
          `BREATHE NORMALLY • ${result.qualifiedPeakCount ?? 0} of ${config.requiredNormalCycles} regular cycles`,
        );
        if (
          result.ready &&
          result.windowStartMs != null &&
          result.windowEndMs != null &&
          result.direction != null &&
          result.peaks &&
          result.troughs &&
          result.meanInspiratoryPeakPitchDeg != null &&
          result.meanAmplitudeDeg != null
        ) {
          const cycleMeta = {
            ...meta,
            source: "three_complete_regular_cycles",
            direction: result.direction,
            requiredCycles: config.requiredNormalCycles,
            peakTimesMs: result.peaks.map((peak: { t: number }) => peak.t),
            peakPitchesDeg: result.peaks.map((peak: { pitchDeg: number }) => peak.pitchDeg),
            troughTimesMs: result.troughs.map((trough: { t: number }) => trough.t),
            meanInspiratoryPeakPitchDeg: result.meanInspiratoryPeakPitchDeg,
            meanCyclePeriodSec: result.meanCyclePeriodSec,
            cyclePeriodCv: result.cyclePeriodCv,
            meanAmplitudeDeg: result.meanAmplitudeDeg,
            amplitudeCv: result.amplitudeCv,
          };
          markAt(result.windowStartMs, "prehold_start", cycleMeta);
          markAt(result.windowEndMs, "prehold_end", cycleMeta);
          mark("breathing_cycles_qualified", cycleMeta);
          setStepCountdown(0);
          return result;
        }
        await sleep(200);
      }
      setStepCountdown(0);
      return null;
    };

    const waitForPhysiologicalHold = async (
      meta: Record<string, unknown>,
      anchorPitch: number,
      normalAmplitudeDeg: number,
      inhaleCuePromise: Promise<ReturnType<typeof playClip> extends Promise<infer T> ? T : never>,
    ) => {
      const detectorStartedAt = performance.now();
      const deadline = detectorStartedAt + 12_000;
      const minimumDelta = Math.max(0.4, Math.min(1, normalAmplitudeDeg * 0.25));
      let candidateSince: number | null = null;
      let cueResult: Awaited<ReturnType<typeof playClip>> | null = null;
      void inhaleCuePromise.then((result) => {
        cueResult = result;
      });
      setGuidedLabel("DEEP BREATH IN AND HOLD • Detecting the held plateau");
      while (guidedRunningRef.current && performance.now() < deadline) {
        if (cueResult != null && cueResult !== "ended") return null;
        const now = performance.now();
        const nowMs = now - startedAtRef.current;
        const stats = recentPitchStats(samplesRef.current, nowMs, 1000);
        const excursion =
          stats == null
            ? null
            : config.initialDirection * (stats.medianPitchDeg - anchorPitch);
        const plateauLike = Boolean(
          stats &&
            excursion != null &&
            excursion >= minimumDelta &&
            stats.sdDeg <= Math.max(0.4, normalAmplitudeDeg * 0.3) &&
            Math.abs(stats.slopeDegPerSec) <= 0.45,
        );
        if (!plateauLike) {
          candidateSince = null;
        } else {
          candidateSince ??= now;
          if (now - candidateSince >= 600) {
            const holdStartPerformanceMs = candidateSince;
            const holdStartSessionMs = holdStartPerformanceMs - startedAtRef.current;
            markAt(holdStartSessionMs, "physiological_hold_detected", {
              ...meta,
              method: "deep_excursion_plus_low_slope_dwell",
              detectionDwellMs: 600,
              minimumDeltaDeg: roundClient(minimumDelta),
              measuredDeltaDeg: roundClient(excursion as number),
              detectionLatencyMs: roundClient(now - candidateSince),
            });
            return {
              performanceMs: holdStartPerformanceMs,
              sessionMs: holdStartSessionMs,
            };
          }
        }
        await sleep(150);
      }
      return null;
    };

    const runCoachedHold = async (
      meta: Record<string, unknown>,
      anchorPitch: number,
      target: LearnedTarget,
      holdStartedAt: number,
    ) => {
      const deadline = holdStartedAt + config.holdSeconds * 1000;
      let fiveSecondsAnnounced = false;
      let wasInBand: boolean | null = null;
      let outOfBandSince: number | null = null;
      let correctionCount = 0;
      let lastCorrectionCompletedAt: number | null = null;
      let pendingCorrection: number | null = null;
      let targetTonePlayed = false;

      while (guidedRunningRef.current && performance.now() < deadline) {
        const now = performance.now();
        setStepCountdown(Math.max(1, Math.ceil((deadline - now) / 1000)));
        if (!fiveSecondsAnnounced && now >= deadline - 5000) {
          fiveSecondsAnnounced = true;
          if (!(await requireCue("p0_five_seconds_left", {
            ...meta,
            reason: "five_seconds_remaining",
          }))) return { completed: false, aborted: true, correctionCount };
        }

        const currentPitch = oRef.current.betaEma ?? oRef.current.beta;
        if (currentPitch == null) {
          await sleep(150);
          continue;
        }
        const excursion = target.direction * (currentPitch - anchorPitch);
        const error = excursion - target.excursionDeg;
        const inBand = Math.abs(error) <= target.toleranceDeg;

        if (inBand && wasInBand !== true) {
          mark("target_enter", {
            ...meta,
            measuredExcursionDeg: roundClient(excursion),
            targetExcursionDeg: target.excursionDeg,
            toleranceDeg: target.toleranceDeg,
          });
          mark("beam_on", { ...meta, reason: "inside_target_band" });
          if (pendingCorrection != null) {
            mark("correction_succeeded", {
              ...meta,
              correctionNumber: pendingCorrection,
              measuredExcursionDeg: roundClient(excursion),
            });
            pendingCorrection = null;
          }
          if (!targetTonePlayed) {
            targetTonePlayed = true;
            mark("target_acquired", {
              ...meta,
              measuredExcursionDeg: roundClient(excursion),
              targetExcursionDeg: target.excursionDeg,
              toleranceDeg: target.toleranceDeg,
            });
            if (!(await requireCue("p0_in_range_ding", {
              ...meta,
              reason: "target_acquired",
            }))) return { completed: false, aborted: true, correctionCount };
          }
        } else if (!inBand && wasInBand === true) {
          mark("target_exit", {
            ...meta,
            measuredExcursionDeg: roundClient(excursion),
            errorDeg: roundClient(error),
          });
          mark("beam_off", { ...meta, reason: "outside_target_band" });
        }

        if (inBand) {
          outOfBandSince = null;
        } else {
          outOfBandSince ??= now;
          const responseWindowComplete =
            lastCorrectionCompletedAt == null || now - lastCorrectionCompletedAt >= 1800;
          const fiveSecondCueProtected =
            !fiveSecondsAnnounced && now >= deadline - 6200;
          const hasTimeForCorrection = deadline - now > 1400;
          if (
            now - outOfBandSince >= 1000 &&
            responseWindowComplete &&
            !fiveSecondCueProtected &&
            hasTimeForCorrection
          ) {
            if (correctionCount < (config.correctionLimit ?? 2)) {
              correctionCount += 1;
              pendingCorrection = correctionCount;
              const below = error < 0;
              mark("correction_issued", {
                ...meta,
                correctionNumber: correctionCount,
                direction: below ? "deeper" : "ease_back",
                measuredExcursionDeg: roundClient(excursion),
                errorDeg: roundClient(error),
              });
              const cueResult = await coach(below ? "p0_deeper" : "p0_ease_back", {
                ...meta,
                correctionNumber: correctionCount,
                reason: below ? "below_target_band" : "above_target_band",
                measuredExcursionDeg: roundClient(excursion),
                targetExcursionDeg: target.excursionDeg,
                errorDeg: roundClient(error),
              });
              if (cueResult !== "ended") {
                guidedRunningRef.current = false;
                return { completed: false, aborted: true, correctionCount };
              }
              lastCorrectionCompletedAt = performance.now();
              outOfBandSince = lastCorrectionCompletedAt;
            } else {
              mark("practice_hold_aborted", {
                ...meta,
                reason: error < 0
                  ? "two_corrections_failed_below_target"
                  : "two_corrections_failed_above_target",
                correctionCount,
                measuredExcursionDeg: roundClient(excursion),
                targetExcursionDeg: target.excursionDeg,
              });
              if (wasInBand) mark("beam_off", { ...meta, reason: "hold_aborted" });
              setStepCountdown(0);
              return { completed: false, aborted: true, correctionCount };
            }
          }
        }
        wasInBand = inBand;
        await sleep(150);
      }

      if (
        wasInBand === false &&
        pendingCorrection != null &&
        correctionCount >= (config.correctionLimit ?? 2)
      ) {
        mark("practice_hold_aborted", {
          ...meta,
          reason: "two_corrections_failed_before_hold_end",
          correctionCount,
        });
        setStepCountdown(0);
        return { completed: false, aborted: true, correctionCount };
      }
      if (wasInBand) mark("beam_off", { ...meta, reason: "hold_complete" });
      setStepCountdown(0);
      return { completed: guidedRunningRef.current, aborted: false, correctionCount };
    };

    let nextHoldIndex = 1;
    let nextBreathingObservationStartMs = 0;
    let previousMeta: Record<string, unknown> | null = null;

    try {
      mark("baseline_start");
      enterGuidedStage("calibration");
      if (!(await requireCue("p0_calibration_intro", { phase: "calibration" }))) return;

      let completedCalibrationCount = 0;
      let calibrationAttemptCount = 0;
      while (
        guidedRunningRef.current &&
        completedCalibrationCount < (config.calibrationHoldCount ?? 3) &&
        calibrationAttemptCount < 6
      ) {
        calibrationAttemptCount += 1;
        const calibrationNumber = completedCalibrationCount + 1;
        const meta: Record<string, unknown> = {
          holdIndex: nextHoldIndex,
          role: "calibration",
          calibrationNumber,
          calibrationAttemptNumber: calibrationAttemptCount,
        };
        const cycles = await waitForThreeCycles(
          meta,
          nextBreathingObservationStartMs,
          calibrationAttemptCount === 1,
        );
        if (!cycles || !guidedRunningRef.current) return;
        if (completedCalibrationCount === 0) mark("baseline_end");
        if (previousMeta) {
          mark("recovery_end", {
            ...previousMeta,
            readyForHoldIndex: nextHoldIndex,
            source: "three_complete_regular_cycles",
          });
        }
        const anchorPitch = cycles.meanInspiratoryPeakPitchDeg as number;
        setLiveGate({
          mode: "calibration",
          anchorPitch,
          direction: config.initialDirection,
          targetExcursionDeg: null,
          toleranceDeg: null,
          label: `Calibration ${calibrationNumber} of ${config.calibrationHoldCount} • local reference is the mean of three peaks`,
        });
        enterGuidedStage("calibration");
        enterGuidedPhase(
          "inhale",
          `DEEP BREATH • Calibration ${calibrationNumber} of ${config.calibrationHoldCount}`,
          meta,
        );
        mark("inhale_start", meta);
        const inhaleCuePromise = coach("p0_inhale", meta);
        const onset = await waitForPhysiologicalHold(
          meta,
          anchorPitch,
          cycles.meanAmplitudeDeg as number,
          inhaleCuePromise,
        );
        const inhaleResult = await inhaleCuePromise;
        if (inhaleResult !== "ended") {
          guidedRunningRef.current = false;
          return;
        }
        if (!onset) {
          mark("calibration_attempt_aborted", { ...meta, reason: "physiological_hold_not_detected" });
          mark("release", { ...meta, reason: "physiological_hold_not_detected" });
          enterGuidedPhase("release", "RELEASE • Hold not detected", meta);
          if (!(await requireCue("p0_calibration_retry", meta))) return;
          nextBreathingObservationStartMs = performance.now() - startedAtRef.current;
          previousMeta = meta;
          nextHoldIndex += 1;
          continue;
        }

        enterGuidedPhase(
          "hold",
          `HOLD • Calibration ${calibrationNumber} of ${config.calibrationHoldCount}`,
          meta,
        );
        markAt(onset.sessionMs, "hold_start", {
          ...meta,
          source: "physiological_hold_detection",
          direction: config.initialDirection,
          localAnchorPitchDeg: anchorPitch,
          normalPeakPitchesDeg: cycles.peaks!.map((peak) => peak.pitchDeg),
          normalMeanAmplitudeDeg: cycles.meanAmplitudeDeg,
        });
        const completed = await waitThroughTimedHold(
          onset.performanceMs,
          config.holdSeconds,
          `HOLD • Calibration ${calibrationNumber} of ${config.calibrationHoldCount}`,
          meta,
        );
        if (!completed) return;
        mark("release", meta);
        enterGuidedPhase("release", "RELEASE • Breathe normally", meta);
        if (!(await requireCue("p0_release", meta))) return;
        const analysis = currentAnalysis();
        const completedHold = analysis.holds.find(
          (hold: { index: number }) => hold.index === nextHoldIndex,
        );
        if (completedHold?.valid) {
          completedCalibrationCount += 1;
          mark("calibration_hold_measured", {
            ...meta,
            completedCalibrationCount,
            calibrationDeltaDeg: completedHold.calibrationDeltaDeg,
            withinHoldRobustSdDeg: completedHold.withinHoldRobustSdDeg,
          });
        } else {
          mark("calibration_hold_rejected", {
            ...meta,
            issues: completedHold?.issues ?? ["not_measurable"],
          });
        }
        nextBreathingObservationStartMs = performance.now() - startedAtRef.current;
        previousMeta = meta;
        nextHoldIndex += 1;
      }

      const learned = currentAnalysis().summary.learnedTarget;
      const learnedDirection = currentAnalysis().summary.learnedDirection;
      if (
        !learned.available ||
        !Number.isFinite(learnedDirection) ||
        !Number.isFinite(learned.targetSignedExcursionDeg) ||
        !Number.isFinite(learned.experimentalTrainingToleranceDeg)
      ) {
        enterGuidedStage("complete");
        enterGuidedPhase("complete", "CALIBRATION NEEDS ANOTHER RUN");
        mark("session_end", {
          outcome: "calibration_failed",
          validCalibrationCount: learned.learnHoldCount,
        });
        await requireCue("p0_calibration_failed", { phase: "calibration" });
        return;
      }

      learnedTargetRef.current = {
        direction: learnedDirection as number,
        excursionDeg: learned.targetSignedExcursionDeg as number,
        toleranceDeg: learned.experimentalTrainingToleranceDeg as number,
      };
      mark("target_learned", {
        direction: learnedDirection,
        targetExcursionDeg: learned.targetSignedExcursionDeg,
        toleranceDeg: learned.experimentalTrainingToleranceDeg,
        betweenHoldSdDeg:
          "betweenHoldDeltaSdDeg" in learned ? learned.betweenHoldDeltaSdDeg : null,
        pooledWithinHoldSdDeg:
          "pooledWithinHoldSdDeg" in learned ? learned.pooledWithinHoldSdDeg : null,
        combinedSdDeg: "combinedSdDeg" in learned ? learned.combinedSdDeg : null,
        method: "local_three_peak_delta_mean_combined_sd",
        selectedHoldIndexes: learned.selectedHoldIndexes,
      });
      enterGuidedStage("practice");
      enterGuidedPhase("practice", "COACHING • Three 10-second target holds");
      if (!(await requireCue("p0_practice_intro", { phase: "practice" }))) return;

      let completedPracticeCount = 0;
      let practiceAttemptCount = 0;
      const maximumPracticeAttempts = config.practiceHoldCount * 2;
      while (
        guidedRunningRef.current &&
        completedPracticeCount < config.practiceHoldCount &&
        practiceAttemptCount < maximumPracticeAttempts
      ) {
        practiceAttemptCount += 1;
        const practiceNumber = completedPracticeCount + 1;
        const meta: Record<string, unknown> = {
          holdIndex: nextHoldIndex,
          role: "practice",
          practiceNumber,
          practiceAttemptNumber: practiceAttemptCount,
        };
        const cycles = await waitForThreeCycles(meta, nextBreathingObservationStartMs, false);
        if (!cycles || !guidedRunningRef.current) return;
        if (previousMeta) {
          mark("recovery_end", {
            ...previousMeta,
            readyForHoldIndex: nextHoldIndex,
            source: "three_complete_regular_cycles",
          });
        }
        const anchorPitch = cycles.meanInspiratoryPeakPitchDeg as number;
        const target = learnedTargetRef.current;
        setLiveGate({
          mode: "practice",
          anchorPitch,
          direction: target.direction,
          targetExcursionDeg: target.excursionDeg,
          toleranceDeg: target.toleranceDeg,
          label: `Coaching ${practiceNumber} of ${config.practiceHoldCount} • beam is on only inside green`,
        });
        enterGuidedPhase(
          "inhale",
          `DEEP BREATH • Coaching ${practiceNumber} of ${config.practiceHoldCount}`,
          meta,
        );
        mark("inhale_start", meta);
        const inhaleCuePromise = coach("p0_inhale", meta);
        const onset = await waitForPhysiologicalHold(
          meta,
          anchorPitch,
          cycles.meanAmplitudeDeg as number,
          inhaleCuePromise,
        );
        const inhaleResult = await inhaleCuePromise;
        if (inhaleResult !== "ended") {
          guidedRunningRef.current = false;
          return;
        }
        if (!onset) {
          mark("practice_attempt_aborted", { ...meta, reason: "physiological_hold_not_detected" });
          mark("release", { ...meta, reason: "physiological_hold_not_detected" });
          enterGuidedPhase("release", "RELEASE • Hold not detected", meta);
          if (!(await requireCue("p0_abort", meta))) return;
          nextBreathingObservationStartMs = performance.now() - startedAtRef.current;
          previousMeta = meta;
          nextHoldIndex += 1;
          continue;
        }

        enterGuidedPhase(
          "hold",
          `HOLD • Coaching ${practiceNumber} of ${config.practiceHoldCount}`,
          meta,
        );
        markAt(onset.sessionMs, "hold_start", {
          ...meta,
          source: "physiological_hold_detection",
          direction: target.direction,
          localAnchorPitchDeg: anchorPitch,
          normalPeakPitchesDeg: cycles.peaks!.map((peak) => peak.pitchDeg),
          normalMeanAmplitudeDeg: cycles.meanAmplitudeDeg,
          targetExcursionDeg: target.excursionDeg,
          toleranceDeg: target.toleranceDeg,
        });
        const outcome = await runCoachedHold(meta, anchorPitch, target, onset.performanceMs);
        mark("release", {
          ...meta,
          outcome: outcome.aborted ? "aborted_after_two_corrections" : "ten_second_hold_complete",
          correctionCount: outcome.correctionCount,
        });
        if (outcome.aborted) {
          enterGuidedPhase("release", "RELEASE • Two corrections were unsuccessful", meta);
          if (!(await requireCue("p0_abort", meta))) return;
        } else {
          completedPracticeCount += 1;
          mark("practice_hold_completed", {
            ...meta,
            completedPracticeCount,
            requestedHoldSeconds: config.holdSeconds,
            correctionCount: outcome.correctionCount,
          });
          enterGuidedPhase("release", "RELEASE • Breathe normally", meta);
          if (!(await requireCue("p0_release", meta))) return;
        }
        nextBreathingObservationStartMs = performance.now() - startedAtRef.current;
        previousMeta = meta;
        nextHoldIndex += 1;
      }

      if (guidedRunningRef.current) {
        setLiveGate(null);
        enterGuidedStage("complete");
        const completed = completedPracticeCount === config.practiceHoldCount;
        enterGuidedPhase(
          "complete",
          completed
            ? "COMPLETE • Calibration and coaching recorded"
            : `COMPLETE • ${completedPracticeCount} of ${config.practiceHoldCount} coached holds completed`,
        );
        mark("session_end", {
          outcome: completed ? "calibration_and_coaching_complete" : "practice_incomplete",
          completedPracticeCount,
          practiceAttemptCount,
        });
        await requireCue(
          completed ? "p0_session_complete" : "p0_practice_incomplete",
          { phase: "complete", completedPracticeCount },
        );
      }
    } finally {
      setGuidedActive(false);
      setGuidedStage("idle");
      setGuidedPhase("IDLE");
      setGuidedLabel("");
      setStepCountdown(0);
      setLiveGate(null);
      guidedRunningRef.current = false;
      if (recordingRef.current) {
        await sleep(400);
        stopRec();
      }
    }
  };

  // Retained only for deterministic replay development of older guided files;
  // the live Start button invokes the observation sequence above.
  const startGuidedLegacy = async () => {
    // Keep audio activation in the Start button's user gesture on mobile.
    unlockAudio();
    if (!granted) {
      await requestPerm();
      return;
    }
    if (recording) return;
    const sc = `p0-3cal-${guidedPracticeGoal}practice-${guidedHoldSec}s`;
    const config = {
      holdSeconds: guidedHoldSec,
      practiceHoldCount: guidedPracticeGoal,
      cycleCount: 3,
      baselineSeconds: 10,
      recoverySeconds: guidedRecoverySec,
      initialDirection: -1 as const,
    };
    startRec(sc, config);
    setGuidedActive(true);
    guidedRunningRef.current = true;
    try {
      enterGuidedStage("setup");
      enterGuidedPhase(
        "setup",
        "SETUP • Phone flat on belly, charging port toward the face",
      );
      const introResult = await coach("p0_session_intro", { phase: "setup" });
      if (introResult !== "ended") {
        mark("session_end", { outcome: "audio_unavailable", introResult });
        setGuidedLabel("AUDIO UNAVAILABLE • Tap Test voice, then restart");
        return;
      }
      await waitGuidedSeconds(3, "SETUP • Place phone flat on your belly");

      enterGuidedStage("rehearsal");
      enterGuidedPhase("rehearsal", "REHEARSAL • Learn the four cues");
      await coach("p0_rehearsal_intro", { phase: "rehearsal" });
      const rehearsalMeta = { holdIndex: 0, role: "rehearsal" };
      await waitForRestAnchor(rehearsalMeta, 7);
      if (!guidedRunningRef.current) return;
      enterGuidedPhase("inhale", "INHALE • Rehearsal", rehearsalMeta);
      mark("rehearsal_inhale_start", rehearsalMeta);
      const rehearsalInhaleAt = performance.now();
      await coach("p0_inhale", rehearsalMeta);
      await waitUntil(rehearsalInhaleAt + 4000, "INHALE • Rehearsal");
      enterGuidedPhase("hold", "HOLD • Rehearsal", rehearsalMeta);
      const rehearsalHoldAt = performance.now();
      mark("rehearsal_hold_start", rehearsalMeta);
      await coach("p0_hold", rehearsalMeta);
      await waitUntil(rehearsalHoldAt + 5000, "HOLD • Rehearsal");
      mark("rehearsal_release", rehearsalMeta);
      enterGuidedPhase("release", "RELEASE • Rehearsal", rehearsalMeta);
      await coach("p0_release", rehearsalMeta);
      enterGuidedPhase("rest", "REST • Breathe normally", rehearsalMeta);
      await waitGuidedSeconds(8, "REST • Breathe normally");

      enterGuidedStage("baseline");
      mark("baseline_start");
      enterGuidedPhase("baseline", "BASELINE • Breathe normally");
      await coach("p0_rest", { phase: "baseline" });
      await waitGuidedSeconds(12, "BASELINE • Breathe normally");
      mark("baseline_end");
      enterGuidedStage("calibration");
      enterGuidedPhase("calibration", "CALIBRATION • Three matching holds");
      await coach("p0_calibration_intro", { phase: "calibration" });

      let nextHoldIndex = 1;
      let measuredCalibrationCount = 0;
      let calibrationReady = false;
      let previousMeta: Record<string, unknown> | null = null;
      let previousReleaseAt: number | null = null;
      const maximumCalibrationAttempts = 6;

      while (
        guidedRunningRef.current &&
        !calibrationReady &&
        nextHoldIndex <= maximumCalibrationAttempts
      ) {
        const provisional = provisionalCalibrationGate();
        const calibrationNumber = Math.min(provisional.candidateCount + 1, 3);
        const meta: Record<string, unknown> = {
          holdIndex: nextHoldIndex,
          role: "learn",
          calibrationNumber,
          attemptNumber: nextHoldIndex,
        };
        const anchorPitch = await waitForRestAnchor(
          meta,
          config.recoverySeconds,
          previousReleaseAt ?? performance.now(),
          previousReleaseAt == null,
        );
        if (!guidedRunningRef.current || anchorPitch == null) return;
        setLiveGate({
          mode: "calibration",
          anchorPitch,
          direction: provisional.direction,
          targetExcursionDeg: provisional.target,
          toleranceDeg: provisional.tolerance,
          label:
            provisional.target == null
              ? "First calibration sets your reference"
              : "Match the green calibration range",
        });
        if (previousMeta) {
          mark("recovery_minimum_complete", {
            ...previousMeta,
            minimumRecoverySeconds: config.recoverySeconds,
          });
          mark("recovery_end", {
            ...previousMeta,
            readyForHoldIndex: nextHoldIndex,
            source: "fixed_recovery",
          });
        }

        enterGuidedPhase(
          "inhale",
          `INHALE • Calibration ${calibrationNumber} of 3`,
          meta,
        );
        mark("inhale_start", meta);
        const inhaleAt = performance.now();
        await coach("p0_inhale", meta);
        let calibrationAcquired = true;
        if (provisional.target != null && provisional.tolerance != null) {
          calibrationAcquired = await acquirePracticeTarget(
            meta,
            anchorPitch,
            {
              direction: provisional.direction,
              excursionDeg: provisional.target,
              toleranceDeg: provisional.tolerance,
            },
            performance.now() + 5000,
          );
        } else {
          await waitUntil(inhaleAt + 4000, `INHALE • Calibration ${calibrationNumber} of 3`);
        }
        if (!calibrationAcquired) {
          mark("calibration_acquisition_aborted", meta);
          mark("release", { ...meta, reason: "target_not_acquired" });
          previousReleaseAt = performance.now();
          enterGuidedPhase("release", "RELEASE • Reset and try again", meta);
          await coach("p0_abort", meta);
          previousMeta = meta;
          nextHoldIndex += 1;
          continue;
        }
        enterGuidedPhase(
          "hold",
          `HOLD • Calibration ${calibrationNumber} of 3`,
          meta,
        );
        const calibrationHoldAt = performance.now();
        mark("hold_start", meta);
        await coach(holdCueForSeconds(config.holdSeconds), meta);
        await waitThroughTimedHold(
          calibrationHoldAt,
          config.holdSeconds,
          `HOLD • Calibration ${calibrationNumber} of 3`,
          meta,
        );
        mark("release", meta);
        previousReleaseAt = performance.now();
        enterGuidedPhase("release", "RELEASE • Breathe normally", meta);
        await coach("p0_release", meta);
        previousMeta = meta;

        const updatedAnalysis = currentAnalysis();
        const completedHold = updatedAnalysis.holds.find(
          (hold: { index: number }) => hold.index === nextHoldIndex,
        );
        measuredCalibrationCount = updatedAnalysis.summary.learnedTarget.learnHoldCount;
        calibrationReady = Boolean(updatedAnalysis.summary.learnedTarget.available);
        if (completedHold?.valid) {
          mark("calibration_hold_measured", {
            ...meta,
            measuredCalibrationCount,
            calibrationReady,
          });
          if (!calibrationReady && measuredCalibrationCount >= 3) {
            await coach("p0_calibration_mismatch", {
              ...meta,
              measuredCalibrationCount,
              calibrationExcursionSdDeg:
                updatedAnalysis.summary.learnedTarget.observedLearnExcursionSdDeg,
            });
          }
        } else {
          mark("calibration_hold_rejected", {
            ...meta,
            issues: completedHold?.issues ?? ["not_measurable"],
          });
          await coach("p0_calibration_retry", {
            ...meta,
            issues: completedHold?.issues ?? ["not_measurable"],
          });
        }
        nextHoldIndex += 1;
      }

      const calibration = currentAnalysis().summary;
      const learned = calibration.learnedTarget;
      const direction = calibration.learnedDirection;
      const excursion = learned.targetSignedExcursionDeg;
      const tolerance = learned.experimentalTrainingToleranceDeg;
      if (
        !learned.available ||
        typeof direction !== "number" ||
        !Number.isFinite(direction) ||
        typeof excursion !== "number" ||
        !Number.isFinite(excursion) ||
        typeof tolerance !== "number" ||
        !Number.isFinite(tolerance)
      ) {
        mark("target_learning_failed", {
          afterHoldIndex: nextHoldIndex - 1,
          validLearnHoldCount: learned.learnHoldCount,
          reason: "three_matching_calibration_holds_required",
        });
        enterGuidedStage("complete");
        setLiveGate(null);
        enterGuidedPhase("complete", "CALIBRATION NEEDS A RETRY");
        await coach("p0_calibration_failed", {
          phase: "calibration",
          validLearnHoldCount: learned.learnHoldCount,
        });
        mark("session_end", { outcome: "calibration_failed" });
        return;
      }

      learnedTargetRef.current = {
        direction,
        excursionDeg: excursion,
        toleranceDeg: tolerance,
      };
      mark("target_learned", {
        afterHoldIndex: nextHoldIndex - 1,
        direction,
        targetExcursionDeg: excursion,
        toleranceDeg: tolerance,
        method: "median_relative_excursion",
        selectedHoldIndexes: learned.selectedHoldIndexes,
      });
      enterGuidedStage("practice");
      enterGuidedPhase(
        "practice",
        `PRACTICE • Collect ${config.practiceHoldCount} coached holds`,
      );
      await coach("p0_practice_intro", { phase: "practice" });

      let completedPracticeCount = 0;
      let practiceAttemptCount = 0;
      const maximumPracticeAttempts = Math.max(4, config.practiceHoldCount * 2);
      while (
        completedPracticeCount < config.practiceHoldCount &&
        practiceAttemptCount < maximumPracticeAttempts &&
        guidedRunningRef.current
      ) {
        practiceAttemptCount += 1;
        const practiceNumber = completedPracticeCount + 1;
        const meta: Record<string, unknown> = {
          holdIndex: nextHoldIndex,
          role: "practice",
          practiceNumber,
          practiceAttemptNumber: practiceAttemptCount,
        };
        const anchorPitch = await waitForRestAnchor(
          meta,
          config.recoverySeconds,
          previousReleaseAt ?? performance.now(),
          false,
        );
        if (!guidedRunningRef.current || anchorPitch == null) return;
        if (previousMeta) {
          mark("recovery_minimum_complete", {
            ...previousMeta,
            minimumRecoverySeconds: config.recoverySeconds,
          });
          mark("recovery_end", {
            ...previousMeta,
            readyForHoldIndex: nextHoldIndex,
            source: "fixed_recovery",
          });
        }
        setLiveGate({
          mode: "practice",
          anchorPitch,
          direction: learnedTargetRef.current.direction,
          targetExcursionDeg: learnedTargetRef.current.excursionDeg,
          toleranceDeg: learnedTargetRef.current.toleranceDeg,
          label: `Practice ${practiceNumber} of ${config.practiceHoldCount} • place the blue bar in green`,
        });
        enterGuidedPhase(
          "inhale",
          `INHALE • Practice ${practiceNumber} of ${config.practiceHoldCount}`,
          meta,
        );
        mark("inhale_start", meta);
        await coach("p0_inhale", meta);
        const acquired = await acquirePracticeTarget(
          meta,
          anchorPitch,
          learnedTargetRef.current,
          performance.now() + 5000,
        );
        if (!acquired) {
          mark("practice_attempt_aborted", { ...meta, reason: "target_not_acquired" });
          mark("release", { ...meta, reason: "target_not_acquired" });
          previousReleaseAt = performance.now();
          enterGuidedPhase("release", "RELEASE • Target not acquired", meta);
          await coach("p0_abort", meta);
          previousMeta = meta;
          nextHoldIndex += 1;
          continue;
        }
        enterGuidedPhase(
          "hold",
          `HOLD • Practice ${practiceNumber} of ${config.practiceHoldCount}`,
          meta,
        );
        const practiceHoldAt = performance.now();
        mark("hold_start", {
          ...meta,
          targetExcursionDeg: excursion,
          toleranceDeg: tolerance,
        });
        await coach(holdCueForSeconds(config.holdSeconds), meta);
        const holdCompleted = await runPracticeHold(
          config.holdSeconds,
          meta,
          anchorPitch,
          learnedTargetRef.current,
          practiceHoldAt,
        );
        mark("release", meta);
        previousReleaseAt = performance.now();
        if (holdCompleted) {
          completedPracticeCount += 1;
          mark("practice_hold_completed", {
            ...meta,
            completedPracticeCount,
            requestedHoldSeconds: config.holdSeconds,
          });
          enterGuidedPhase("release", "RELEASE • Breathe normally", meta);
          await coach("p0_release", meta);
        } else {
          enterGuidedPhase("release", "RELEASE • Outside target range", meta);
          await coach("p0_abort", meta);
        }
        previousMeta = meta;
        nextHoldIndex += 1;
      }

      if (guidedRunningRef.current && previousMeta && previousReleaseAt != null) {
        enterGuidedPhase("rest", "REST • Final recovery", previousMeta);
        await waitUntil(previousReleaseAt + Math.min(8, config.recoverySeconds) * 1000, "REST • Final recovery");
        mark("recovery_end", previousMeta);
        enterGuidedStage("complete");
        setLiveGate(null);
        if (completedPracticeCount === config.practiceHoldCount) {
          enterGuidedPhase(
            "complete",
            `COMPLETE • ${config.practiceHoldCount} practice holds collected`,
          );
          mark("session_end", { outcome: "practice_complete" });
          await coach("p0_session_complete", { phase: "complete" });
        } else {
          enterGuidedPhase(
            "complete",
            `COMPLETE • ${completedPracticeCount} of ${config.practiceHoldCount} practice holds collected`,
          );
          mark("session_end", {
            outcome: "practice_incomplete",
            completedPracticeCount,
            practiceAttemptCount,
          });
          await coach("p0_practice_incomplete", {
            phase: "complete",
            completedPracticeCount,
          });
        }
      }
    } finally {
      setGuidedActive(false);
      setGuidedStage("idle");
      setGuidedPhase("IDLE");
      setGuidedLabel("");
      setStepCountdown(0);
      setLiveGate(null);
      guidedRunningRef.current = false;
      if (recordingRef.current) {
        await sleep(400);
        stopRec();
      }
    }
  };

  const cancelGuided = () => {
    guidedRunningRef.current = false;
    stopAudio();
    setGuidedActive(false);
    setGuidedStage("idle");
    setGuidedPhase("IDLE");
    setGuidedLabel("");
    setLiveGate(null);
    if (recordingRef.current) stopRec();
  };

  const importJson = async (file: File | null) => {
    if (!file) return;
    setImportError(null);
    try {
      const parsed = JSON.parse(await file.text()) as Partial<Recording>;
      if (!Array.isArray(parsed.samples) || !Array.isArray(parsed.events) || !Array.isArray(parsed.channels)) {
        throw new Error("The file is not a DIBH Lab recording.");
      }
      const refreshed = {
        ...parsed,
        durationSec: Number(parsed.durationSec ?? 0),
        samples: parsed.samples,
        events: parsed.events,
        channels: parsed.channels,
      } as Recording;
      refreshed.analysis = analyzeLabRecording(refreshed);
      setImported(refreshed);
    } catch (error) {
      setImportError(error instanceof Error ? error.message : "Could not read this JSON file.");
    }
  };

  const displayedRecording = imported ?? last;

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
      <div className="max-w-5xl w-full mx-auto flex flex-col gap-3">
        <div className="flex items-baseline justify-between">
          <h1 className="text-lg font-semibold flex items-center gap-2">
            DIBH Lab P0
            <span
              className="rounded px-1.5 py-0.5 text-[9px] uppercase tracking-wider"
              style={{ background: "#0c2d48", color: "#7dd3fc", border: "1px solid #0369a1" }}
            >
              v0.9
            </span>
          </h1>
          <a href="/" className="text-xs underline opacity-70">
            ← coach
          </a>
        </div>
        <p className="text-xs opacity-70 leading-relaxed">
          Three local breathing peaks set each reference. Three 10-second calibration holds
          learn the target delta and variability; three coached holds then simulate beam gating.
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
              <div className="flex items-center justify-between gap-3">
                <div className="text-xs uppercase tracking-wider opacity-60">P0 guided run</div>
                <div className="text-[10px] uppercase tracking-wider" style={{ color: "#38bdf8" }}>
                  3 breaths → calibrate ×3 → coach ×3
                </div>
              </div>
              <GuidedJourney stage={guidedStage} />
              {traceAnchorPitch != null && traceSessionStart != null && (
                <ContinuousBreathingTrace
                  pitch={pitch}
                  anchorPitch={traceAnchorPitch}
                  sessionStartedAt={traceSessionStart}
                  active={guidedActive}
                  events={events}
                />
              )}
              {liveGate && (
                <LiveTargetGate pitch={pitch} gate={liveGate} phase={guidedPhase} />
              )}
              <div
                className="rounded-md p-2 flex items-center justify-between gap-3"
                style={{
                  background: audioStatus === "error" ? "#2a1010" : "#0a0c10",
                  border: `1px solid ${audioStatus === "error" ? "#7f1d1d" : "#303441"}`,
                }}
              >
                <div className="text-[11px] leading-relaxed">
                  <div className="font-semibold">
                    {audioStatus === "ready"
                      ? "Voice ready"
                      : audioStatus === "testing"
                        ? "Testing voice…"
                        : audioStatus === "error"
                          ? "Voice could not play"
                          : "Check the prerecorded voice first"}
                  </div>
                  <div className="opacity-60">
                    {audioStatus === "error"
                      ? "Turn up media volume, then tap Test voice again."
                      : "You should hear the complete deep-breath instruction."}
                  </div>
                </div>
                <button
                  onClick={testVoice}
                  disabled={recording || audioStatus === "testing"}
                  className="rounded-md px-3 py-2 text-xs font-semibold shrink-0 disabled:opacity-40"
                  style={{ background: "#2563eb", color: "white" }}
                >
                  Test voice
                </button>
              </div>
              <div className="text-[11px] leading-relaxed opacity-70">
                Phone placement: flat on the belly with the charging port pointing toward
                the patient&apos;s face. Inhale is normalized upward on the continuous trace.
              </div>
              {!guidedActive ? (
                <button
                  onClick={startGuided}
                  className="rounded-md py-3 font-semibold"
                  style={{ background: "#16a34a", color: "white" }}
                >
                  ▶ Start hands-free run
                </button>
              ) : (
                <>
                  <div className="text-center py-2">
                    <div className="text-2xl font-semibold tracking-widest" style={{ color: guidedPhaseColor(guidedPhase) }}>
                      {guidedPhase}
                    </div>
                    <div className="text-xs opacity-70 mt-1 mb-1">{guidedLabel}</div>
                    <div className="text-3xl font-mono">
                      {guidedPhase === "REST"
                        ? `${stepCountdown}/${3} breaths`
                        : stepCountdown > 0
                          ? `${stepCountdown}s`
                          : "…"}
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
                Every hold begins only after three complete regular cycles and physiological
                hold detection. The 10-second clock never pauses; simulated beam time runs
                only inside the green band. Two unsuccessful corrections return the patient
                to three fresh breathing cycles before retrying.
              </div>
            </div>

            {/* Free record */}
            <div
              className="rounded-lg p-3 flex flex-col gap-2"
              style={{ background: "#1c1f26", border: "1px solid #303441" }}
            >
              <div className="flex items-center justify-between gap-3">
                <div className="text-xs uppercase tracking-wider opacity-60">Free record</div>
                <div className="text-[10px] opacity-60">separate from guided calibration</div>
              </div>
              <div className="grid grid-cols-2 gap-1 rounded-md p-1" style={{ background: "#0a0c10" }}>
                {([
                  ["standard", "Standard"],
                  ["position-study", "Position study"],
                ] as const).map(([mode, label]) => (
                  <button
                    key={mode}
                    onClick={() => setFreeMode(mode)}
                    disabled={recording}
                    className="rounded py-2 text-xs font-semibold disabled:opacity-40"
                    style={{
                      background: freeMode === mode ? "#0c2d48" : "transparent",
                      color: freeMode === mode ? "#7dd3fc" : "#a8a29e",
                      border: freeMode === mode ? "1px solid #0369a1" : "1px solid transparent",
                    }}
                  >
                    {label}
                  </button>
                ))}
              </div>

              {freeMode === "standard" ? (
                <>
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
                </>
              ) : (
                <>
                  <div className="rounded-md p-2 text-[11px] leading-relaxed" style={{ background: "#071018", color: "#bae6fd", border: "1px solid #164e63" }}>
                    Keep posture, phone orientation, attachment pressure, and duration the same.
                    Breathe normally—there are no voice cues, holds, targets, or coaching in this mode.
                    The first 3 seconds are excluded from analysis for placement settling.
                  </div>
                  <label className="text-[11px] opacity-70" htmlFor="position-location">Body location</label>
                  <select
                    id="position-location"
                    value={positionLocation}
                    onChange={(e) => setPositionLocation(e.target.value)}
                    disabled={recording}
                    className="rounded p-2 text-sm"
                    style={{ background: "#0a0c10", color: "#e7e5e4", border: "1px solid #303441" }}
                  >
                    {POSITION_LOCATIONS.map(([id, label]) => (
                      <option key={id} value={id}>{label}</option>
                    ))}
                  </select>
                  {positionLocation === "custom" && (
                    <input
                      aria-label="Custom body location"
                      placeholder="describe the exact body location"
                      value={positionCustomLocation}
                      onChange={(e) => setPositionCustomLocation(e.target.value)}
                      disabled={recording}
                      className="rounded p-2 text-sm"
                      style={{ background: "#0a0c10", color: "#e7e5e4", border: "1px solid #303441" }}
                    />
                  )}
                  <div className="grid grid-cols-2 gap-2">
                    <label className="text-[11px] opacity-70 flex flex-col gap-1">
                      Alignment
                      <select
                        value={positionAlignment}
                        onChange={(e) => setPositionAlignment(e.target.value as "midline" | "left" | "right")}
                        disabled={recording}
                        className="rounded p-2 text-sm"
                        style={{ background: "#0a0c10", color: "#e7e5e4", border: "1px solid #303441" }}
                      >
                        <option value="midline">Midline</option>
                        <option value="left">Patient left</option>
                        <option value="right">Patient right</option>
                      </select>
                    </label>
                    <label className="text-[11px] opacity-70 flex flex-col gap-1">
                      Recording length
                      <select
                        value={positionDurationSec}
                        onChange={(e) => setPositionDurationSec(Number(e.target.value))}
                        disabled={recording}
                        className="rounded p-2 text-sm"
                        style={{ background: "#0a0c10", color: "#e7e5e4", border: "1px solid #303441" }}
                      >
                        <option value={30}>30 seconds</option>
                        <option value={45}>45 seconds</option>
                        <option value={60}>60 seconds</option>
                      </select>
                    </label>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <label className="text-[11px] opacity-70 flex flex-col gap-1">
                      Posture
                      <select
                        value={positionPosture}
                        onChange={(e) => setPositionPosture(e.target.value as "supine" | "reclined" | "seated")}
                        disabled={recording}
                        className="rounded p-2 text-sm"
                        style={{ background: "#0a0c10", color: "#e7e5e4", border: "1px solid #303441" }}
                      >
                        <option value="supine">Lying flat</option>
                        <option value="reclined">Reclined</option>
                        <option value="seated">Seated</option>
                      </select>
                    </label>
                    <label className="text-[11px] opacity-70 flex flex-col gap-1">
                      Phone contact
                      <select
                        value={positionAttachment}
                        onChange={(e) => setPositionAttachment(e.target.value as "resting" | "light-contact" | "secured")}
                        disabled={recording}
                        className="rounded p-2 text-sm"
                        style={{ background: "#0a0c10", color: "#e7e5e4", border: "1px solid #303441" }}
                      >
                        <option value="resting">Resting, hands off</option>
                        <option value="light-contact">Light hand contact</option>
                        <option value="secured">Secured / strapped</option>
                      </select>
                    </label>
                  </div>
                  <div className="text-[11px] opacity-70 leading-relaxed">
                    Phone: flat on the body, charging port toward the patient&apos;s face.
                  </div>
                </>
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
                  onClick={() => {
                    if (freeMode === "position-study") {
                      startPositionStudy();
                    } else {
                      positionStudyRef.current = null;
                      startRec();
                    }
                  }}
                  className="rounded-md py-2.5 font-semibold"
                  style={{ background: freeMode === "position-study" ? "#16a34a" : "#dc2626", color: "white" }}
                >
                  {freeMode === "position-study" ? "▶ Record this position" : "● Start free record"}
                </button>
              ) : guidedActive ? (
                <div className="rounded-md py-2.5 text-center text-xs opacity-60" style={{ background: "#0a0c10" }}>
                  Guided run is recording above
                </div>
              ) : (
                <button
                  onClick={stopRec}
                  className="rounded-md py-2.5 font-semibold"
                  style={{ background: "#0ea5e9", color: "white" }}
                >
                  {freeMode === "position-study"
                    ? `■ Finish & analyze · ${Math.max(0, Math.ceil(positionDurationSec - duration))}s left`
                    : "■ Stop & download"}
                </button>
              )}
              {freeMode === "position-study" && positionTraceAnchorPitch != null && positionTraceSessionStart != null && (
                <ContinuousBreathingTrace
                  pitch={pitch}
                  anchorPitch={positionTraceAnchorPitch}
                  sessionStartedAt={positionTraceSessionStart}
                  active={recording && !guidedActive}
                  events={[]}
                  title="Position breathing trace"
                  description="normal breathing • inhale ↑ • auto-scaling"
                  minimumHalfRangeDeg={0.15}
                />
              )}
              {recording && !guidedActive && freeMode === "standard" && (
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

            {positionRuns.length > 0 && !recording && (
              <PositionStudyComparison runs={positionRuns} />
            )}

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
                {last.positionStudy && (
                  <div className="mt-2 rounded p-2 leading-relaxed" style={{ background: "#071018", color: "#bae6fd", border: "1px solid #164e63" }}>
                    Position study: {last.positionStudy.locationLabel} · {last.positionStudy.alignment}
                    <br />
                    {last.positionStudy.analysis.usableCycleCount} usable cycles · {last.positionStudy.analysis.medianPeakToTroughAmplitudeDeg ?? "—"}° amplitude · {last.positionStudy.analysis.amplitudeToNoiseRatio ?? "—"}× signal/noise
                  </div>
                )}
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
                    label="target delta"
                    value={`${last.analysis.summary.learnedTarget.targetSignedExcursionDeg ?? "—"}°`}
                  />
                  <MiniStat
                    label="target half-range"
                    value={`±${last.analysis.summary.learnedTarget.experimentalTrainingToleranceDeg ?? "—"}°`}
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

        <div
          className="rounded-lg p-3 flex flex-col gap-2"
          style={{ background: "#1c1f26", border: "1px solid #303441" }}
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <div className="text-xs uppercase tracking-wider opacity-60">Trace analyzer</div>
              <div className="mt-1 text-[11px] opacity-70">
                Open any P0 JSON to replay phases, compare holds, and inspect coaching.
              </div>
            </div>
            <label
              className="cursor-pointer rounded px-3 py-2 text-xs font-semibold"
              style={{ background: "#0ea5e9", color: "white" }}
            >
              Open JSON
              <input
                type="file"
                accept="application/json,.json"
                className="sr-only"
                onChange={(event) => {
                  void importJson(event.target.files?.[0] ?? null);
                  event.currentTarget.value = "";
                }}
              />
            </label>
          </div>
          {imported && (
            <div className="flex items-center justify-between gap-3 text-xs">
              <span className="opacity-70">Viewing imported session: {imported.scenario}</span>
              <button className="underline opacity-80" onClick={() => setImported(null)}>
                Show latest run
              </button>
            </div>
          )}
          {importError && <div className="text-xs" style={{ color: "#fca5a5" }}>{importError}</div>}
        </div>

        {displayedRecording && !recording && !guidedActive && (
          <LabTrace recording={displayedRecording as unknown as TraceRecording} />
        )}
      </div>
    </main>
  );
}

function GuidedJourney({ stage }: { stage: GuidedStage }) {
  const currentIndex = GUIDED_JOURNEY.findIndex((item) => item.id === stage);
  const current = currentIndex >= 0 ? GUIDED_JOURNEY[currentIndex] : null;
  return (
    <div className="rounded-md p-2.5" style={{ background: "#0a0c10", border: "1px solid #303441" }}>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5">
        {GUIDED_JOURNEY.map((item, index) => {
          const isCurrent = index === currentIndex;
          const isComplete = currentIndex >= 0 && index < currentIndex;
          return (
            <div
              key={item.id}
              className="rounded p-2 min-h-16"
              style={{
                background: isCurrent ? "#0c2d48" : isComplete ? "#0d2b1a" : "#151820",
                border: `1px solid ${isCurrent ? "#38bdf8" : isComplete ? "#22c55e" : "#303441"}`,
                opacity: currentIndex < 0 || isCurrent || isComplete ? 1 : 0.58,
              }}
            >
              <div className="text-[10px] font-semibold uppercase tracking-wide">{item.title}</div>
              <div className="mt-1 text-[9px] leading-tight opacity-70">{item.detail}</div>
            </div>
          );
        })}
      </div>
      <div className="mt-2 text-[10px] leading-relaxed" style={{ color: current ? "#bae6fd" : "#a8a29e" }}>
        {current
          ? `Collecting now: ${current.data}.`
          : "Journey: three regular cycles → three calibrations → three coached holds → review."}
      </div>
    </div>
  );
}

function PositionStudyComparison({ runs }: { runs: PositionRun[] }) {
  const setupVaries = new Set(
    runs.map((run) => `${run.posture}|${run.attachment}|${run.requestedDurationSec}`),
  ).size > 1;
  const eligible = runs.filter(
    (run) => run.analysis.enoughData && run.analysis.amplitudeToNoiseRatio != null,
  );
  const strongest = eligible.reduce<PositionRun | null>(
    (best, run) =>
      best == null ||
      (run.analysis.amplitudeToNoiseRatio ?? -Infinity) >
        (best.analysis.amplitudeToNoiseRatio ?? -Infinity)
        ? run
        : best,
    null,
  );
  const degreeScale = Math.max(
    0.25,
    ...runs.flatMap((run) => [
      run.analysis.medianPeakToTroughAmplitudeDeg ?? 0,
      run.analysis.noiseRobustSdDeg ?? 0,
    ]),
  );
  const pct = (value: number | null) =>
    value == null ? 0 : Math.max(1.5, Math.min(100, (value / degreeScale) * 100));
  const percent = (value: number | null) =>
    value == null ? "—" : `${Math.round(value * 100)}%`;

  return (
    <div
      className="rounded-lg p-3 flex flex-col gap-3"
      style={{ background: "#1c1f26", border: "1px solid #303441" }}
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-xs uppercase tracking-wider opacity-60">Position comparison</div>
          <div className="mt-1 text-[11px] opacity-70 leading-relaxed">
            Blue and pink bars share the same degree scale. Strongest signal means the highest
            measured peak-to-trough amplitude divided by high-frequency noise, using a 0.02°
            noise floor.
          </div>
        </div>
        <div className="text-[10px] text-right shrink-0 opacity-60">{runs.length} recording{runs.length === 1 ? "" : "s"}</div>
      </div>

      {strongest && (
        <div className="rounded-md p-2 text-xs" style={{ background: "#0d2b1a", color: "#bbf7d0", border: "1px solid #166534" }}>
          Strongest measured signal so far: <span className="font-semibold">{strongest.locationLabel} · {strongest.alignment}</span>
          {` (${strongest.analysis.amplitudeToNoiseRatio}× amplitude/noise)`}
        </div>
      )}
      {setupVaries && (
        <div className="rounded-md p-2 text-[10px] leading-relaxed" style={{ background: "#3a260f", color: "#fdba74", border: "1px solid #78350f" }}>
          Posture, phone contact, or duration changed between recordings. Repeat with those
          settings matched before treating the ranking as a fair location comparison.
        </div>
      )}

      <div className="flex flex-col gap-3">
        {runs.map((run, index) => {
          const analysis = run.analysis;
          const isStrongest = strongest?.sessionId === run.sessionId;
          return (
            <div
              key={run.sessionId}
              className="rounded-md p-2.5"
              style={{ background: "#0a0c10", border: `1px solid ${isStrongest ? "#22c55e" : "#303441"}` }}
            >
              <div className="flex items-center justify-between gap-3 text-xs">
                <span className="font-semibold">{index + 1}. {run.locationLabel} · {run.alignment}</span>
                <span style={{ color: analysis.enoughData ? "#86efac" : "#fdba74" }}>
                  {analysis.enoughData ? `${analysis.amplitudeToNoiseRatio ?? "—"}× signal/noise` : "needs more cycles"}
                </span>
              </div>
              <div className="mt-1 text-[9px] opacity-55">
                {run.posture} · {run.attachment} · {run.requestedDurationSec}s
              </div>
              <div className="mt-2 grid grid-cols-[68px_1fr_48px] gap-x-2 gap-y-1 items-center text-[10px]">
                <span style={{ color: "#7dd3fc" }}>amplitude</span>
                <div className="h-2 rounded-full overflow-hidden" style={{ background: "#172033" }}>
                  <div className="h-full rounded-full" style={{ width: `${pct(analysis.medianPeakToTroughAmplitudeDeg)}%`, background: "#38bdf8" }} />
                </div>
                <span className="text-right">{analysis.medianPeakToTroughAmplitudeDeg ?? "—"}°</span>
                <span style={{ color: "#fda4af" }}>noise</span>
                <div className="h-2 rounded-full overflow-hidden" style={{ background: "#172033" }}>
                  <div className="h-full rounded-full" style={{ width: `${pct(analysis.noiseRobustSdDeg)}%`, background: "#fb7185" }} />
                </div>
                <span className="text-right">{analysis.noiseRobustSdDeg ?? "—"}°</span>
              </div>
              <div className="mt-2 grid grid-cols-2 sm:grid-cols-4 gap-1.5 text-[10px]">
                <MiniStat label="usable cycles" value={`${analysis.usableCycleCount}`} />
                <MiniStat label="breathing rate" value={analysis.estimatedBreathsPerMinute == null ? "—" : `${analysis.estimatedBreathsPerMinute}/min`} />
                <MiniStat label="amplitude variation" value={percent(analysis.amplitudeCv)} />
                <MiniStat label="drift" value={analysis.driftDegPerMinute == null ? "—" : `${analysis.driftDegPerMinute}°/min`} />
              </div>
            </div>
          );
        })}
      </div>
      <div className="text-[10px] opacity-60 leading-relaxed">
        This comparison ranks phone-position signal quality only. It does not determine lung
        volume, treatment suitability, or the clinical target location.
      </div>
    </div>
  );
}

function ContinuousBreathingTrace({
  pitch,
  anchorPitch,
  sessionStartedAt,
  active,
  events,
  title = "Continuous breathing trace",
  description,
  minimumHalfRangeDeg = 1,
}: {
  pitch: number;
  anchorPitch: number;
  sessionStartedAt: number;
  active: boolean;
  events: LabEvent[];
  title?: string;
  description?: string;
  minimumHalfRangeDeg?: number;
}) {
  const [history, setHistory] = useState<Array<{ t: number; excursion: number }>>([]);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setHistory([]);
  }, [sessionStartedAt]);

  useEffect(() => {
    if (!active) return;
    const elapsed = Math.max(0, performance.now() - sessionStartedAt);
    const excursion = -(pitch - anchorPitch);
    setHistory((previous) => [...previous, { t: elapsed, excursion }]);
  }, [active, anchorPitch, pitch, sessionStartedAt]);

  useEffect(() => {
    if (!active || !scrollRef.current) return;
    scrollRef.current.scrollLeft = scrollRef.current.scrollWidth;
  }, [active, history.length]);

  const chartHeight = 230;
  const pad = { top: 24, right: 18, bottom: 28, left: 42 };
  const lastMs = Math.max(history.at(-1)?.t ?? 0, events.at(-1)?.t ?? 0, 15000);
  const chartWidth = Math.max(360, pad.left + pad.right + (lastMs / 1000) * 18);
  const values = history.map((point) => point.excursion);
  const observedMin = Math.min(-minimumHalfRangeDeg, ...values);
  const observedMax = Math.max(minimumHalfRangeDeg, ...values);
  const paddingDeg = Math.max(0.5, (observedMax - observedMin) * 0.12);
  const minimum = observedMin - paddingDeg;
  const maximum = observedMax + paddingDeg;
  const range = Math.max(1, maximum - minimum);
  const plotHeight = chartHeight - pad.top - pad.bottom;
  const xFor = (timeMs: number) => pad.left + (timeMs / 1000) * 18;
  const yFor = (value: number) => pad.top + ((maximum - value) / range) * plotHeight;
  const path = history
    .map(
      (point, index) =>
        `${index === 0 ? "M" : "L"}${xFor(point.t).toFixed(1)},${yFor(point.excursion).toFixed(1)}`,
    )
    .join(" ");
  const markerEvents = events.filter(
    (event) =>
      ["inhale_start", "hold_start", "release"].includes(event.type) ||
      (event.type === "coach_cue" && event.meta?.cue === "p0_five_seconds_left"),
  );
  const localPeakMarkers = events.flatMap((event) => {
    if (event.type !== "breathing_cycles_qualified") return [];
    const times = Array.isArray(event.meta?.peakTimesMs) ? event.meta.peakTimesMs : [];
    return times
      .map(Number)
      .filter(Number.isFinite)
      .map((time, index) => ({
        time,
        holdIndex: Number(event.meta?.holdIndex),
        peakNumber: index + 1,
      }));
  });
  const markerLabel = (event: LabEvent) => {
    if (event.type === "inhale_start") return "DEEP BREATH";
    if (event.type === "hold_start") return "HOLD";
    if (event.type === "release") return "RELEASE";
    return "5s LEFT";
  };
  const markerColor = (event: LabEvent) => {
    if (event.type === "inhale_start") return "#38bdf8";
    if (event.type === "hold_start") return "#a78bfa";
    if (event.type === "release") return "#fb7185";
    return "#f59e0b";
  };

  return (
    <div className="rounded-md overflow-hidden" style={{ background: "#0a0c10", border: "1px solid #303441" }}>
      <div className="px-3 py-2 flex items-center justify-between gap-3 text-[10px] uppercase tracking-wider">
        <span>{title}</span>
        <span className="opacity-60">
          {description ?? "inhale ↑ • green dots = local peaks"} • {minimum.toFixed(1)}° to {maximum.toFixed(1)}°
        </span>
      </div>
      <div ref={scrollRef} className="overflow-x-auto" aria-label="Continuously growing breathing trace">
        <svg
          width={chartWidth}
          height={chartHeight}
          role="img"
          aria-label="A continuous phone-measured breathing trace from baseline through all three breath holds. Inspiration moves upward and the vertical scale expands as larger breaths arrive."
        >
          {[0.25, 0.5, 0.75].map((fraction) => (
            <line
              key={fraction}
              x1={pad.left}
              x2={chartWidth - pad.right}
              y1={pad.top + plotHeight * fraction}
              y2={pad.top + plotHeight * fraction}
              stroke="#253044"
              strokeWidth="1"
            />
          ))}
          <line
            x1={pad.left}
            x2={chartWidth - pad.right}
            y1={yFor(0)}
            y2={yFor(0)}
            stroke="#64748b"
            strokeWidth="1"
          />
          {Array.from({ length: Math.floor(lastMs / 5000) + 1 }, (_, index) => index * 5000).map(
            (time) => (
              <g key={time}>
                <line
                  x1={xFor(time)}
                  x2={xFor(time)}
                  y1={pad.top}
                  y2={chartHeight - pad.bottom}
                  stroke="#1f2937"
                  strokeWidth="1"
                />
                <text x={xFor(time) + 2} y={chartHeight - 8} fill="#94a3b8" fontSize="9">
                  {Math.round(time / 1000)}s
                </text>
              </g>
            ),
          )}
          {markerEvents.map((event, index) => (
            <g key={`${event.type}-${event.t}-${index}`}>
              <line
                x1={xFor(event.t)}
                x2={xFor(event.t)}
                y1={pad.top}
                y2={chartHeight - pad.bottom}
                stroke={markerColor(event)}
                strokeWidth="1.5"
              />
              <text
                x={xFor(event.t) + 3}
                y={12 + (index % 2) * 10}
                fill={markerColor(event)}
                fontSize="8"
              >
                {markerLabel(event)}
              </text>
            </g>
          ))}
          {localPeakMarkers.map((marker) => {
            const nearest = history.reduce<{ t: number; excursion: number } | null>(
              (best, point) =>
                best == null || Math.abs(point.t - marker.time) < Math.abs(best.t - marker.time)
                  ? point
                  : best,
              null,
            );
            if (!nearest) return null;
            return (
              <circle
                key={`local-peak-${marker.holdIndex}-${marker.peakNumber}-${marker.time}`}
                cx={xFor(marker.time)}
                cy={yFor(nearest.excursion)}
                r="3.5"
                fill="#22c55e"
                stroke="#bbf7d0"
                strokeWidth="1"
              >
                <title>{`Local normal peak ${marker.peakNumber} before hold ${marker.holdIndex}`}</title>
              </circle>
            );
          })}
          {path && (
            <path
              d={path}
              fill="none"
              stroke="#38bdf8"
              strokeWidth="2.5"
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          )}
          <text x="4" y={pad.top + 4} fill="#94a3b8" fontSize="9">
            {maximum.toFixed(1)}°
          </text>
          <text x="12" y={Math.min(chartHeight - pad.bottom - 2, yFor(0) + 3)} fill="#94a3b8" fontSize="9">
            0°
          </text>
          <text x="4" y={chartHeight - pad.bottom} fill="#94a3b8" fontSize="9">
            {minimum.toFixed(1)}°
          </text>
        </svg>
      </div>
    </div>
  );
}

function LiveTargetGate({
  pitch,
  gate,
  phase,
}: {
  pitch: number;
  gate: LiveGate;
  phase: string;
}) {
  const excursion = gate.direction * (pitch - gate.anchorPitch);
  const [history, setHistory] = useState<Array<{ t: number; excursion: number }>>([]);
  useEffect(() => {
    setHistory([]);
  }, [gate.anchorPitch, gate.direction]);
  useEffect(() => {
    const now = performance.now();
    setHistory((previous) => [
      ...previous.filter((point) => now - point.t <= 15000),
      { t: now, excursion },
    ]);
  }, [excursion]);

  const target = gate.targetExcursionDeg;
  const tolerance = gate.toleranceDeg;
  const hasBand = target != null && tolerance != null;
  const observed = history.map((point) => point.excursion);
  const minimum = Math.min(-1, excursion - 0.5, ...observed);
  const maximum = Math.max(
    4,
    excursion + 0.5,
    ...observed,
    (target ?? Math.max(2, excursion)) + (tolerance ?? 1) * 2,
  );
  const range = Math.max(1, maximum - minimum);
  const bandLow = hasBand ? Math.max(0, target - tolerance) : 0;
  const bandHigh = hasBand ? target + tolerance : 0;
  const barMinimum = Math.min(0, minimum);
  const barRange = Math.max(1, maximum - barMinimum);
  const barMarkerBottom = ((excursion - barMinimum) / barRange) * 100;
  const bandBottom = ((bandLow - barMinimum) / barRange) * 100;
  const bandHeight = ((bandHigh - bandLow) / barRange) * 100;
  const error = hasBand ? excursion - target : null;
  const inRange = error != null && Math.abs(error) <= (tolerance ?? 0);
  const status = !hasBand
    ? "CALIBRATION • recording the full 10-second hold"
    : inRange
      ? phase === "HOLD"
        ? "IN RANGE • keep the blue bar here"
        : "IN RANGE • ready to hold"
      : error! < 0
        ? "BELOW RANGE • inhale a little more"
        : "ABOVE RANGE • ease back slightly";
  const chartWidth = 320;
  const chartHeight = 150;
  const chartPadding = { top: 12, right: 8, bottom: 22, left: 34 };
  const plotWidth = chartWidth - chartPadding.left - chartPadding.right;
  const plotHeight = chartHeight - chartPadding.top - chartPadding.bottom;
  const latestTime = history.at(-1)?.t ?? performance.now();
  const startTime = latestTime - 15000;
  const xFor = (time: number) =>
    chartPadding.left + ((Math.max(startTime, time) - startTime) / 15000) * plotWidth;
  const yFor = (value: number) =>
    chartPadding.top + ((maximum - value) / range) * plotHeight;
  const curvePath = history
    .filter((point) => point.t >= startTime)
    .map((point, index) => `${index === 0 ? "M" : "L"}${xFor(point.t).toFixed(1)},${yFor(point.excursion).toFixed(1)}`)
    .join(" ");
  const baselineY = yFor(0);
  const chartBandTop = hasBand ? yFor(bandHigh) : 0;
  const chartBandBottom = hasBand ? yFor(bandLow) : 0;
  return (
    <div
      className="rounded-lg p-3"
      style={{ background: "#071018", border: `1px solid ${inRange ? "#22c55e" : "#303441"}` }}
    >
      <div className="flex items-start justify-between gap-3">
        <div>
        <div className="text-[10px] uppercase tracking-wider opacity-60">Live target gate</div>
        <div className="mt-1 text-sm font-semibold" style={{ color: inRange ? "#4ade80" : "#e7e5e4" }}>
          {status}
        </div>
        </div>
        <div className="text-right text-[10px] opacity-60">INHALE ↑<br />EXHALE ↓</div>
      </div>
      <div className="mt-3 grid grid-cols-1 sm:grid-cols-[1fr_76px] gap-3 items-stretch">
        <div className="rounded-md overflow-hidden" style={{ background: "#111827", border: "1px solid #334155" }}>
          <div className="px-2 pt-2 text-[9px] uppercase tracking-wider opacity-55">
            Breathing curve • latest 15 seconds
          </div>
          <svg
            viewBox={`0 0 ${chartWidth} ${chartHeight}`}
            className="block w-full h-auto"
            role="img"
            aria-label="Live breathing curve. Inspiration rises, expiration falls, and the green area is the target hold range."
          >
            {[0.25, 0.5, 0.75].map((fraction) => (
              <line
                key={fraction}
                x1={chartPadding.left}
                x2={chartWidth - chartPadding.right}
                y1={chartPadding.top + plotHeight * fraction}
                y2={chartPadding.top + plotHeight * fraction}
                stroke="#253044"
                strokeWidth="1"
              />
            ))}
            {hasBand && (
              <rect
                x={chartPadding.left}
                y={chartBandTop}
                width={plotWidth}
                height={Math.max(4, chartBandBottom - chartBandTop)}
                rx="3"
                fill="rgba(34,197,94,0.32)"
                stroke="#4ade80"
              />
            )}
            <line
              x1={chartPadding.left}
              x2={chartWidth - chartPadding.right}
              y1={baselineY}
              y2={baselineY}
              stroke="#94a3b8"
              strokeWidth="1"
            />
            {curvePath && <path d={curvePath} fill="none" stroke="#38bdf8" strokeWidth="3" strokeLinejoin="round" strokeLinecap="round" />}
            <text x="3" y={Math.max(12, yFor(maximum) + 5)} fill="#94a3b8" fontSize="9">{maximum.toFixed(1)}°</text>
            <text x="12" y={Math.min(chartHeight - 23, baselineY + 3)} fill="#94a3b8" fontSize="9">0°</text>
            <text x={chartPadding.left} y={chartHeight - 6} fill="#94a3b8" fontSize="9">−15s</text>
            <text x={chartWidth - chartPadding.right - 18} y={chartHeight - 6} fill="#94a3b8" fontSize="9">now</text>
          </svg>
        </div>
        <div className="relative min-h-48 rounded-md overflow-hidden" style={{ background: "#111827", border: "1px solid #334155" }}>
          {[25, 50, 75].map((value) => (
            <div key={value} className="absolute left-0 right-0 border-t" style={{ bottom: `${value}%`, borderColor: "#253044" }} />
          ))}
          {hasBand && (
            <div
              className="absolute left-1 right-1 rounded"
              style={{
                bottom: `${bandBottom}%`,
                height: `${Math.max(4, bandHeight)}%`,
                background: "rgba(34,197,94,0.42)",
                border: "1px solid #4ade80",
              }}
            />
          )}
          <div
            className="absolute left-0 right-0 h-1 rounded transition-[bottom] duration-100"
            style={{ bottom: `calc(${Math.max(0, Math.min(100, barMarkerBottom))}% - 2px)`, background: "#38bdf8", boxShadow: "0 0 8px #38bdf8" }}
          />
          <div className="absolute left-1 top-1 text-[8px] opacity-50">INHALE ↑</div>
          <div className="absolute left-1 bottom-1 text-[8px] opacity-50">EXHALE ↓</div>
        </div>
      </div>
      <div>
        <div className="mt-3 grid grid-cols-2 gap-2 text-[10px]">
          <MiniStat label="blue bar" value={`${excursion.toFixed(2)}°`} />
          <MiniStat
            label="green range"
            value={hasBand ? `${bandLow.toFixed(2)}–${bandHigh.toFixed(2)}°` : "learning"}
          />
        </div>
        <div className="mt-2 text-[10px] leading-relaxed opacity-65">{gate.label}</div>
      </div>
    </div>
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

function guidedPhaseColor(phase: string) {
  if (phase === "INHALE") return "#38bdf8";
  if (phase === "HOLD") return "#a78bfa";
  if (phase === "RELEASE") return "#fb7185";
  if (phase === "READY") return "#f59e0b";
  if (phase === "COMPLETE") return "#22c55e";
  return "#e7e5e4";
}

function holdCueForSeconds(seconds: number) {
  if (seconds === 8) return "p0_hold_8" as const;
  if (seconds === 10) return "p0_hold_10" as const;
  if (seconds === 12) return "p0_hold_12" as const;
  if (seconds === 15) return "p0_hold_15" as const;
  if (seconds === 20) return "p0_hold_20" as const;
  return "p0_hold" as const;
}

function medianClient(values: number[]) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function sleep(ms: number) {
  return new Promise<void>((res) => setTimeout(res, ms));
}

function recentPitchStats(samples: Sample[], endMs: number, windowMs: number) {
  const points = samples
    .filter((sample) => sample[0] >= endMs - windowMs && sample[0] <= endMs)
    .map((sample) => ({ t: sample[0], p: sample[3] ?? sample[2] }))
    .filter((point): point is { t: number; p: number } => point.p != null && Number.isFinite(point.p));
  if (points.length < 20 || points.at(-1)!.t - points[0].t < windowMs * 0.85) return null;
  const values = points.map((point) => point.p);
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const sd = Math.sqrt(
    values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length,
  );
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  const t0 = points[0].t;
  const xs = points.map((point) => (point.t - t0) / 1000);
  const xMean = xs.reduce((sum, value) => sum + value, 0) / xs.length;
  let numerator = 0;
  let denominator = 0;
  for (let index = 0; index < points.length; index++) {
    numerator += (xs[index] - xMean) * (points[index].p - mean);
    denominator += (xs[index] - xMean) ** 2;
  }
  return {
    startMs: points[0].t,
    endMs: points.at(-1)!.t,
    medianPitchDeg: roundClient(median),
    sdDeg: roundClient(sd),
    slopeDegPerSec: roundClient(denominator > 0 ? numerator / denominator : 0),
  };
}

function roundClient(value: number) {
  return +value.toFixed(3);
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
