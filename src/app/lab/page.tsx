"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { playClip, preloadAll, stopAudio, unlockAudio } from "@/audio";
import { analyzeLabRecording, LAB_P0_ALGORITHM } from "@/lib/lab-p0-analysis.mjs";
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
  holdCount: number;
  recoverySeconds: number;
};

type LearnedTarget = {
  direction: number;
  excursionDeg: number;
  toleranceDeg: number;
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
    holdSeconds: number | null;
    holdCount: number | null;
    learnHoldCount: number | null;
    calibrationAttemptLimit: number | null;
    practiceHoldCount: number | null;
    recoverySeconds: number | null;
    handsFree: boolean;
    targetMethod: "median_relative_excursion" | null;
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

  // ---- guided runner state -----------------------------------------------
  const [guidedActive, setGuidedActive] = useState(false);
  const [guidedPhase, setGuidedPhase] = useState<string>("IDLE");
  const [guidedLabel, setGuidedLabel] = useState<string>("");
  const [guidedHoldSec, setGuidedHoldSec] = useState<number>(10);
  const [guidedRecoverySec, setGuidedRecoverySec] = useState<number>(20);
  const [stepCountdown, setStepCountdown] = useState<number>(0);

  // ---- refs ---------------------------------------------------------------
  const samplesRef = useRef<Sample[]>([]);
  const eventsRef = useRef<LabEvent[]>([]);
  const startedAtRef = useRef<number>(0);
  const startedAtIsoRef = useRef<string>("");
  const sessionIdRef = useRef<string>("");
  const activeScenarioRef = useRef<string>(SCENARIOS[0]);
  const recordingRef = useRef(false);
  const guidedConfigRef = useRef<GuidedConfig | null>(null);
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
    learnedTargetRef.current = null;
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
    return result;
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
      appBuild: "lab-p0.3",
      algorithm: LAB_P0_ALGORITHM,
      scenario: activeScenarioRef.current,
      note,
      startedAt: startedAtIsoRef.current,
      durationSec: +totalDur.toFixed(2),
      ua: navigator.userAgent,
      protocol: {
        mode: guidedConfig ? ("guided" as const) : ("free" as const),
        rehearsal: Boolean(guidedConfig),
        holdSeconds: guidedConfig?.holdSeconds ?? null,
        holdCount: guidedConfig?.holdCount ?? null,
        learnHoldCount: guidedConfig ? Math.min(3, guidedConfig.holdCount) : null,
        calibrationAttemptLimit: guidedConfig ? 6 : null,
        practiceHoldCount: guidedConfig ? Math.max(0, guidedConfig.holdCount - 3) : null,
        recoverySeconds: guidedConfig?.recoverySeconds ?? null,
        handsFree: Boolean(guidedConfig),
        targetMethod: guidedConfig ? ("median_relative_excursion" as const) : null,
      },
      samples: samplesRef.current,
      events: eventsRef.current,
      channels: [...CHANNELS] as Recording["channels"],
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
    while (guidedRunningRef.current && performance.now() < endAt) {
      const remainingMs = endAt - performance.now();
      if (!readyPlayed && remainingMs <= 5000) {
        readyPlayed = true;
        enterGuidedPhase("ready", "READY • Deep breath in five seconds", meta);
        await coach("p0_ready", meta);
      }
      setStepCountdown(Math.max(1, Math.ceil((endAt - performance.now()) / 1000)));
      await sleep(150);
    }
    const nowMs = performance.now() - startedAtRef.current;
    const latest = recentPitchStats(
      samplesRef.current,
      nowMs,
      LAB_P0_ALGORITHM.params.restingWindowMs,
    );
    const startMs = latest?.startMs ?? Math.max(0, nowMs - 2000);
    const isStable = Boolean(
      latest &&
        latest.sdDeg <= LAB_P0_ALGORITHM.params.restingSdCeilingDeg &&
        Math.abs(latest.slopeDegPerSec) <= LAB_P0_ALGORITHM.params.restingSlopeCeilingDegPerSec,
    );
    markAt(startMs, "prehold_start", meta);
    markAt(nowMs, "prehold_end", {
      ...meta,
      source: "fixed_rest_window",
      sdDeg: latest?.sdDeg ?? null,
      slopeDegPerSec: latest?.slopeDegPerSec ?? null,
      stable: isStable,
    });
    markAt(nowMs, "rest_anchor_acquired", {
      ...meta,
      source: "fixed_rest_window",
      pitchDeg: latest?.medianPitchDeg ?? null,
      sdDeg: latest?.sdDeg ?? null,
      slopeDegPerSec: latest?.slopeDegPerSec ?? null,
      stable: isStable,
    });
    if (!isStable) mark("rest_anchor_low_confidence", meta);
    setStepCountdown(0);
    return latest?.medianPitchDeg ?? oRef.current.betaEma ?? oRef.current.beta;
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

  const acquirePracticeTarget = async (
    meta: Record<string, unknown>,
    anchorPitch: number,
    target: LearnedTarget,
  ) => {
    const started = performance.now();
    const deadline = started + 8000;
    let inBandSince: number | null = null;
    let lastCueAt = 0;
    while (guidedRunningRef.current && performance.now() < deadline) {
      const now = performance.now();
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
          await coach("p0_target", {
            ...meta,
            reason: "target_acquired",
            measuredExcursionDeg: roundClient(excursion),
            targetExcursionDeg: target.excursionDeg,
          });
          return true;
        }
      } else {
        inBandSince = null;
        if (
          now - started >= 1500 &&
          now - lastCueAt >= LAB_P0_ALGORITHM.params.targetCueCooldownMs
        ) {
          const cue = error < 0 ? "p0_deeper" : "p0_ease_back";
          await coach(cue, {
            ...meta,
            reason: error < 0 ? "below_learned_excursion" : "above_learned_excursion",
            measuredExcursionDeg: roundClient(excursion),
            targetExcursionDeg: target.excursionDeg,
            errorDeg: roundClient(error),
          });
          lastCueAt = now;
        }
      }
      await sleep(150);
    }
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
  ) => {
    const started = performance.now();
    const deadline = started + seconds * 1000;
    let wasInBand = true;
    let outOfBandSince: number | null = null;
    let lastCueAt = started;
    setGuidedLabel(`HOLD • Practice ${meta.practiceNumber} of 2`);
    while (guidedRunningRef.current && performance.now() < deadline) {
      const now = performance.now();
      setStepCountdown(Math.max(1, Math.ceil((deadline - now) / 1000)));
      const currentPitch = oRef.current.betaEma ?? oRef.current.beta;
      if (currentPitch != null) {
        const excursion = target.direction * (currentPitch - anchorPitch);
        const error = excursion - target.excursionDeg;
        const inBand = Math.abs(error) <= target.toleranceDeg;
        if (inBand !== wasInBand) {
          mark(inBand ? "target_enter" : "target_exit", {
            ...meta,
            measuredExcursionDeg: roundClient(excursion),
            errorDeg: roundClient(error),
          });
          wasInBand = inBand;
        }
        if (inBand) {
          outOfBandSince = null;
        } else {
          outOfBandSince ??= now;
          if (now - outOfBandSince >= 1500 && now - lastCueAt >= 4000) {
            await coach(error < 0 ? "p0_deeper" : "p0_ease_back", {
              ...meta,
              reason: error < 0 ? "drifted_below_target" : "drifted_above_target",
              measuredExcursionDeg: roundClient(excursion),
              targetExcursionDeg: target.excursionDeg,
              errorDeg: roundClient(error),
            });
            lastCueAt = now;
          }
        }
      }
      await sleep(200);
    }
    setStepCountdown(0);
  };

  const startGuided = async () => {
    if (!granted) {
      await requestPerm();
      return;
    }
    if (recording) return;
    const sc = `p0-3cal-2practice-${guidedHoldSec}s`;
    const config = {
      holdSeconds: guidedHoldSec,
      holdCount: 5,
      recoverySeconds: guidedRecoverySec,
    };
    startRec(sc, config);
    setGuidedActive(true);
    guidedRunningRef.current = true;
    try {
      enterGuidedPhase("setup", "SETUP • Place phone flat on your belly");
      await coach("p0_session_intro", { phase: "setup" });
      await waitGuidedSeconds(3, "SETUP • Place phone flat on your belly");

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
      await coach("p0_hold", rehearsalMeta);
      mark("rehearsal_hold_start", rehearsalMeta);
      await waitGuidedSeconds(5, "HOLD • Rehearsal");
      mark("rehearsal_release", rehearsalMeta);
      enterGuidedPhase("release", "RELEASE • Rehearsal", rehearsalMeta);
      await coach("p0_release", rehearsalMeta);
      enterGuidedPhase("rest", "REST • Breathe normally", rehearsalMeta);
      await waitGuidedSeconds(8, "REST • Breathe normally");

      mark("baseline_start");
      enterGuidedPhase("baseline", "BASELINE • Breathe normally");
      await coach("p0_rest", { phase: "baseline" });
      await waitGuidedSeconds(12, "BASELINE • Breathe normally");
      mark("baseline_end");
      enterGuidedPhase("calibration", "CALIBRATION • Three valid holds");
      await coach("p0_calibration_intro", { phase: "calibration" });

      let nextHoldIndex = 1;
      let validCalibrationCount = 0;
      let previousMeta: Record<string, unknown> | null = null;
      let previousReleaseAt: number | null = null;
      const maximumCalibrationAttempts = 6;

      while (
        guidedRunningRef.current &&
        validCalibrationCount < 3 &&
        nextHoldIndex <= maximumCalibrationAttempts
      ) {
        const meta: Record<string, unknown> = {
          holdIndex: nextHoldIndex,
          role: "learn",
          calibrationNumber: validCalibrationCount + 1,
          attemptNumber: nextHoldIndex,
        };
        const anchorPitch = await waitForRestAnchor(
          meta,
          previousReleaseAt == null ? 8 : config.recoverySeconds,
          previousReleaseAt ?? performance.now(),
          previousReleaseAt == null,
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

        enterGuidedPhase(
          "inhale",
          `INHALE • Calibration ${validCalibrationCount + 1} of 3`,
          meta,
        );
        mark("inhale_start", meta);
        const inhaleAt = performance.now();
        await coach("p0_inhale", meta);
        await waitUntil(inhaleAt + 4000, `INHALE • Calibration ${validCalibrationCount + 1} of 3`);
        enterGuidedPhase(
          "hold",
          `HOLD • Calibration ${validCalibrationCount + 1} of 3`,
          meta,
        );
        await coach("p0_hold", meta);
        mark("hold_start", meta);
        await waitGuidedSeconds(
          config.holdSeconds,
          `HOLD • Calibration ${validCalibrationCount + 1} of 3`,
        );
        mark("release", meta);
        previousReleaseAt = performance.now();
        enterGuidedPhase("release", "RELEASE • Breathe normally", meta);
        await coach("p0_release", meta);
        previousMeta = meta;

        const completedHold = currentAnalysis().holds.find(
          (hold: { index: number }) => hold.index === nextHoldIndex,
        );
        if (completedHold?.valid) {
          validCalibrationCount += 1;
          mark("calibration_hold_accepted", {
            ...meta,
            validCalibrationCount,
          });
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
        validCalibrationCount < 3 ||
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
          reason: "three_valid_calibration_holds_required",
        });
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
      });
      enterGuidedPhase("practice", "PRACTICE • Two coached holds");
      await coach("p0_practice_intro", { phase: "practice" });

      for (let practiceNumber = 1; practiceNumber <= 2 && guidedRunningRef.current; practiceNumber++) {
        const meta: Record<string, unknown> = {
          holdIndex: nextHoldIndex,
          role: "practice",
          practiceNumber,
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
        enterGuidedPhase("inhale", `INHALE • Practice ${practiceNumber} of 2`, meta);
        mark("inhale_start", meta);
        await coach("p0_inhale", meta);
        await acquirePracticeTarget(meta, anchorPitch, learnedTargetRef.current);
        enterGuidedPhase("hold", `HOLD • Practice ${practiceNumber} of 2`, meta);
        await coach("p0_hold", meta);
        mark("hold_start", {
          ...meta,
          targetExcursionDeg: excursion,
          toleranceDeg: tolerance,
        });
        await runPracticeHold(
          config.holdSeconds,
          meta,
          anchorPitch,
          learnedTargetRef.current,
        );
        mark("release", meta);
        previousReleaseAt = performance.now();
        enterGuidedPhase("release", "RELEASE • Breathe normally", meta);
        await coach("p0_release", meta);
        previousMeta = meta;
        nextHoldIndex += 1;
      }

      if (guidedRunningRef.current && previousMeta && previousReleaseAt != null) {
        enterGuidedPhase("rest", "REST • Final recovery", previousMeta);
        await waitUntil(previousReleaseAt + Math.min(8, config.recoverySeconds) * 1000, "REST • Final recovery");
        mark("recovery_end", previousMeta);
        enterGuidedPhase("complete", "COMPLETE");
        mark("session_end", { outcome: "practice_complete" });
        await coach("p0_session_complete", { phase: "complete" });
      }
    } finally {
      setGuidedActive(false);
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

  const cancelGuided = () => {
    guidedRunningRef.current = false;
    stopAudio();
    setGuidedActive(false);
    setGuidedPhase("IDLE");
    setGuidedLabel("");
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
          <h1 className="text-lg font-semibold">DIBH Lab P0</h1>
          <a href="/" className="text-xs underline opacity-70">
            ← coach
          </a>
        </div>
        <p className="text-xs opacity-70 leading-relaxed">
          One rehearsal teaches the sequence, three valid calibration holds learn a
          comfortable relative target, and two coached practice holds test how well it can
          be reproduced.
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
                  rehearsal → 3 calibration → 2 practice
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <select
                  value={guidedHoldSec}
                  onChange={(e) => setGuidedHoldSec(parseInt(e.target.value))}
                  disabled={recording}
                  className="rounded p-2 text-xs"
                  style={{ background: "#0a0c10", color: "#e7e5e4", border: "1px solid #303441" }}
                >
                  {[8, 10, 12, 15, 20].map((n) => (
                    <option key={n} value={n}>
                      {n}s hold
                    </option>
                  ))}
                </select>
                <select
                  value={guidedRecoverySec}
                  onChange={(e) => setGuidedRecoverySec(parseInt(e.target.value))}
                  disabled={recording}
                  className="rounded p-2 text-xs"
                  style={{ background: "#0a0c10", color: "#e7e5e4", border: "1px solid #303441" }}
                >
                  {[15, 20, 30].map((n) => (
                    <option key={n} value={n}>{n}s minimum rest</option>
                  ))}
                </select>
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
                One prerecorded voice announces REST, READY, INHALE, HOLD, and RELEASE.
                Prompts never overlap. Invalid calibration breaths are repeated rather than
                counted, up to six attempts.
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
