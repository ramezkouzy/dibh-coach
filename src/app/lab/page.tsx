"use client";

import { useEffect, useRef, useState, useCallback } from "react";

type Sample = { t: number; p: number };
type LabEvent = { t: number; type: string };
type Recording = {
  id: string;
  scenario: string;
  note: string;
  startedAt: string;
  durationSec: number;
  samples: Sample[];
  events: LabEvent[];
};

const SCENARIOS = [
  "calm-hold-25s",
  "hold-with-drift",
  "slow-exhale-release",
  "sharp-exhale-release",
  "partial-inhale",
  "natural-breathing-baseline",
  "fail-cant-recover",
  "custom",
];

const EVENTS = [
  ["hold-start", "Start hold"],
  ["peak", "At peak"],
  ["stable", "Steady"],
  ["drift-in", "Drift in"],
  ["drift-out", "Drift out"],
  ["target", "Target hit"],
  ["release", "Released"],
] as const;

export default function LabPage() {
  const [pitch, setPitch] = useState(0);
  const [recording, setRecording] = useState(false);
  const [scenario, setScenario] = useState<string>(SCENARIOS[0]);
  const [customScenario, setCustomScenario] = useState("");
  const [note, setNote] = useState("");
  const [duration, setDuration] = useState(0);
  const [count, setCount] = useState(0);
  const [permissionError, setPermissionError] = useState<string | null>(null);
  const [granted, setGranted] = useState(false);
  const [events, setEvents] = useState<LabEvent[]>([]);
  const [last, setLast] = useState<Recording | null>(null);
  const [uploadStatus, setUploadStatus] = useState<string | null>(null);

  const pitchRef = useRef(0);
  const samplesRef = useRef<Sample[]>([]);
  const eventsRef = useRef<LabEvent[]>([]);
  const startedAtRef = useRef<number>(0);
  const startedAtIsoRef = useRef<string>("");
  const lastDispRef = useRef(0);

  // sensor wiring active whenever permission is granted
  useEffect(() => {
    if (!granted) return;
    const orient = (e: DeviceOrientationEvent) => {
      if (e.beta == null) return;
      const alpha = 0.3;
      const next = pitchRef.current * (1 - alpha) + e.beta * alpha;
      pitchRef.current = next;
      const now = performance.now();
      if (recording) {
        samplesRef.current.push({
          t: +(now - startedAtRef.current).toFixed(1),
          p: +next.toFixed(3),
        });
      }
      if (now - lastDispRef.current > 80) {
        lastDispRef.current = now;
        setPitch(next);
        if (recording) {
          setDuration((now - startedAtRef.current) / 1000);
          setCount(samplesRef.current.length);
        }
      }
    };
    window.addEventListener("deviceorientation", orient);
    return () => window.removeEventListener("deviceorientation", orient);
  }, [granted, recording]);

  const requestPerm = useCallback(async () => {
    setPermissionError(null);
    const Doc = (typeof DeviceOrientationEvent !== "undefined" ? DeviceOrientationEvent : null) as
      | (typeof DeviceOrientationEvent & { requestPermission?: () => Promise<"granted" | "denied"> })
      | null;
    if (Doc && typeof Doc.requestPermission === "function") {
      try {
        const r = await Doc.requestPermission();
        if (r !== "granted") {
          setPermissionError("Motion access denied.");
          return;
        }
      } catch {
        setPermissionError("Couldn't request motion permission.");
        return;
      }
    }
    setGranted(true);
  }, []);

  const startRec = () => {
    samplesRef.current = [];
    eventsRef.current = [];
    setEvents([]);
    startedAtRef.current = performance.now();
    startedAtIsoRef.current = new Date().toISOString();
    setDuration(0);
    setCount(0);
    setUploadStatus(null);
    setRecording(true);
  };

  const mark = (type: string) => {
    if (!recording) return;
    const e: LabEvent = {
      t: +(performance.now() - startedAtRef.current).toFixed(1),
      type,
    };
    eventsRef.current.push(e);
    setEvents([...eventsRef.current]);
  };

  const stopRec = async () => {
    setRecording(false);
    const totalDur = (performance.now() - startedAtRef.current) / 1000;
    const sc = scenario === "custom" && customScenario ? customScenario : scenario;
    const rec: Recording = {
      id: cryptoId(),
      scenario: sc,
      note,
      startedAt: startedAtIsoRef.current,
      durationSec: +totalDur.toFixed(2),
      samples: samplesRef.current,
      events: eventsRef.current,
    };
    setLast(rec);
    // Upload (best-effort)
    setUploadStatus("uploading…");
    try {
      const r = await fetch("/api/log", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(rec),
      });
      setUploadStatus(r.ok ? `uploaded (${rec.samples.length} samples)` : `upload failed: ${r.status}`);
    } catch (err) {
      setUploadStatus(`upload failed: ${(err as Error).message}`);
    }
    // Also offer download
    download(rec);
  };

  const downloadLast = () => {
    if (last) download(last);
  };

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
          <h1 className="text-lg font-semibold">DIBH Lab</h1>
          <a href="/" className="text-xs underline opacity-70">
            ← coach
          </a>
        </div>
        <p className="text-xs opacity-70 leading-relaxed">
          Records raw pitch at sensor cadence. Uploads to /api/log and
          downloads a JSON copy.
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
            <div className="flex items-center justify-between rounded-md p-3" style={{ background: "#1c1f26" }}>
              <span className="text-xs opacity-70">live pitch</span>
              <span className="font-mono text-2xl tabular-nums">{pitch.toFixed(2)}°</span>
            </div>

            <label className="flex flex-col gap-1 text-xs">
              <span className="opacity-70">Scenario</span>
              <select
                value={scenario}
                onChange={(e) => setScenario(e.target.value)}
                disabled={recording}
                className="rounded p-2 text-sm"
                style={{ background: "#1c1f26", color: "#e7e5e4", border: "1px solid #303441" }}
              >
                {SCENARIOS.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </label>
            {scenario === "custom" && (
              <input
                placeholder="custom scenario name"
                value={customScenario}
                onChange={(e) => setCustomScenario(e.target.value)}
                disabled={recording}
                className="rounded p-2 text-sm"
                style={{ background: "#1c1f26", color: "#e7e5e4", border: "1px solid #303441" }}
              />
            )}

            <label className="flex flex-col gap-1 text-xs">
              <span className="opacity-70">Note (optional)</span>
              <input
                placeholder="e.g. drifted at 8s, recovered at 12s"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                disabled={recording}
                className="rounded p-2 text-sm"
                style={{ background: "#1c1f26", color: "#e7e5e4", border: "1px solid #303441" }}
              />
            </label>

            {!recording ? (
              <button
                onClick={startRec}
                className="rounded-lg py-3 font-semibold"
                style={{ background: "#dc2626", color: "white" }}
              >
                ● Start recording
              </button>
            ) : (
              <button
                onClick={stopRec}
                className="rounded-lg py-3 font-semibold"
                style={{ background: "#0ea5e9", color: "white" }}
              >
                ■ Stop & upload
              </button>
            )}

            {recording && (
              <>
                <div className="grid grid-cols-3 gap-2 text-center text-xs">
                  <Stat label="time" value={`${duration.toFixed(1)}s`} />
                  <Stat label="samples" value={String(count)} />
                  <Stat label="events" value={String(events.length)} />
                </div>
                <div className="grid grid-cols-2 gap-2">
                  {EVENTS.map(([type, label]) => (
                    <button
                      key={type}
                      onClick={() => mark(type)}
                      className="rounded-md py-3 text-sm"
                      style={{
                        background: "#1c1f26",
                        color: "#e7e5e4",
                        border: "1px solid #303441",
                      }}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <div
                  className="text-xs leading-relaxed max-h-40 overflow-auto rounded-md p-2 opacity-80"
                  style={{ background: "#0a0c10", border: "1px solid #1c1f26" }}
                >
                  {events.length === 0 ? (
                    <span className="opacity-60">no events yet</span>
                  ) : (
                    events.map((e, i) => (
                      <div key={i} className="flex justify-between font-mono">
                        <span>{(e.t / 1000).toFixed(2)}s</span>
                        <span>{e.type}</span>
                      </div>
                    ))
                  )}
                </div>
              </>
            )}

            {uploadStatus && (
              <div
                className="text-xs rounded-md p-2"
                style={{
                  background: uploadStatus.startsWith("uploaded") ? "#0f3a26" : "#3a0f0f",
                  color: uploadStatus.startsWith("uploaded") ? "#86efac" : "#fca5a5",
                }}
              >
                {uploadStatus}
              </div>
            )}

            {last && !recording && (
              <div
                className="rounded-md p-3 text-xs"
                style={{ background: "#1c1f26", border: "1px solid #303441" }}
              >
                <div className="font-semibold mb-1">Last recording</div>
                <div className="opacity-80">scenario: {last.scenario}</div>
                <div className="opacity-80">duration: {last.durationSec}s · samples: {last.samples.length} · events: {last.events.length}</div>
                {last.note && <div className="opacity-80">note: {last.note}</div>}
                <div className="mt-2 flex gap-2">
                  <button
                    onClick={downloadLast}
                    className="rounded px-3 py-1.5 text-xs"
                    style={{ background: "#0ea5e9", color: "white", border: "none" }}
                  >
                    Download JSON
                  </button>
                </div>
              </div>
            )}
          </>
        )}

        {permissionError && (
          <p className="text-xs" style={{ color: "#fca5a5" }}>
            {permissionError}
          </p>
        )}

        <details className="text-xs opacity-70 mt-4">
          <summary className="cursor-pointer">Recipe — what to record</summary>
          <ol className="mt-2 ml-4 list-decimal space-y-1.5">
            <li>natural-breathing-baseline (just breathe normally for 30s, no holds)</li>
            <li>calm-hold-25s (one good hold to target)</li>
            <li>hold-with-drift (hold, lose it briefly, recover, hold more)</li>
            <li>slow-exhale-release (held, exhale slowly down)</li>
            <li>sharp-exhale-release (held, sudden full exhale)</li>
            <li>partial-inhale (didn't go deep enough, try to hold)</li>
            <li>fail-cant-recover (drifted out and gave up)</li>
          </ol>
          <p className="mt-2">
            Mark events as you go: tap <code>Start hold</code> when you start
            inhaling, <code>At peak</code> when you stop inhaling,{" "}
            <code>Released</code> when you exhale out, etc. Annotations help me
            tune thresholds.
          </p>
        </details>
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

function cryptoId() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return Math.random().toString(36).slice(2, 10);
}

function download(rec: Recording) {
  const blob = new Blob([JSON.stringify(rec, null, 2)], {
    type: "application/json",
  });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  const ts = rec.startedAt.replace(/[:.]/g, "-").replace(/T/, "_").slice(0, 19);
  a.download = `dibh-${rec.scenario}-${ts}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
}
