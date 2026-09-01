"use client";

import { FormEvent, useEffect, useMemo, useRef, useState } from "react";

import LabTrace, { type TraceRecording } from "@/app/lab/LabTrace";

type SubmissionListItem = {
  pathname: string;
  size: number;
  uploadedAt: string;
  etag: string;
};

type StoredRecording = TraceRecording & {
  schema?: string;
  sessionId?: string;
  appBuild?: string;
  startedAt?: string;
  note?: string;
  contributor?: {
    participantCode?: string;
    siteCode?: string | null;
    runLabel?: string | null;
  };
  device?: {
    platform?: string | null;
    userAgent?: string;
    timeZone?: string | null;
    viewport?: { width?: number; height?: number };
    screen?: { width?: number; height?: number };
  };
  submission?: {
    id?: string;
    receivedAt?: string;
    checksumSha256?: string;
  };
};

type ListResponse = {
  ok?: boolean;
  submissions?: SubmissionListItem[];
  count?: number;
  truncated?: boolean;
  error?: string;
};

const ADMIN_KEY_STORAGE = "dibh-lab-admin-key";

function adminHeaders(password: string) {
  return { "x-dibh-admin-key": password };
}

function itemDetails(item: SubmissionListItem) {
  const parts = item.pathname.split("/");
  return {
    date: parts.at(-3) ?? "Unknown date",
    participant: parts.at(-2) ?? "Unknown participant",
    receipt: (parts.at(-1) ?? "submission").replace(/\.json$/, ""),
  };
}

function formatBytes(bytes: number) {
  if (bytes < 1_000) return `${bytes} B`;
  if (bytes < 1_000_000) return `${(bytes / 1_000).toFixed(1)} KB`;
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

function formatDate(value?: string) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString();
}

function isTraceRecording(value: unknown): value is StoredRecording {
  if (!value || typeof value !== "object") return false;
  const recording = value as Partial<StoredRecording>;
  return (
    Array.isArray(recording.samples) &&
    Array.isArray(recording.events) &&
    Array.isArray(recording.channels) &&
    Boolean(recording.analysis && typeof recording.analysis === "object")
  );
}

export default function LabAdminPage() {
  const [password, setPassword] = useState("");
  const [authorized, setAuthorized] = useState(false);
  const [submissions, setSubmissions] = useState<SubmissionListItem[]>([]);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [recording, setRecording] = useState<StoredRecording | null>(null);
  const [status, setStatus] = useState("Enter the admin password to load submissions.");
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const saved = window.sessionStorage.getItem(ADMIN_KEY_STORAGE);
    if (saved) setPassword(saved);
  }, []);

  const selectedItem = useMemo(
    () => submissions.find((item) => item.pathname === selectedPath) ?? null,
    [selectedPath, submissions],
  );

  const loadSubmissions = async (candidatePassword = password) => {
    if (!candidatePassword) {
      setStatus("Enter the admin password.");
      return;
    }

    setBusy(true);
    setStatus("Loading submissions…");
    try {
      const response = await fetch("/api/lab-submissions/admin", {
        cache: "no-store",
        headers: adminHeaders(candidatePassword),
      });
      const result = (await response.json()) as ListResponse;
      if (!response.ok || !result.ok || !result.submissions) {
        throw new Error(result.error || "Could not load submissions.");
      }

      window.sessionStorage.setItem(ADMIN_KEY_STORAGE, candidatePassword);
      setAuthorized(true);
      setSubmissions(result.submissions);
      setStatus(
        result.truncated
          ? `Showing ${result.submissions.length} submissions. Additional records are available in Vercel.`
          : `${result.count ?? result.submissions.length} submission${result.submissions.length === 1 ? "" : "s"} found.`,
      );
      if (selectedPath && !result.submissions.some((item) => item.pathname === selectedPath)) {
        setSelectedPath(null);
        setRecording(null);
      }
    } catch (error) {
      setAuthorized(false);
      setSubmissions([]);
      setRecording(null);
      setStatus(error instanceof Error ? error.message : "Could not load submissions.");
    } finally {
      setBusy(false);
    }
  };

  const signIn = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void loadSubmissions();
  };

  const signOut = () => {
    window.sessionStorage.removeItem(ADMIN_KEY_STORAGE);
    setPassword("");
    setAuthorized(false);
    setSubmissions([]);
    setSelectedPath(null);
    setRecording(null);
    setStatus("Signed out. Enter the admin password to reconnect.");
  };

  const openSubmission = async (item: SubmissionListItem) => {
    setSelectedPath(item.pathname);
    setRecording(null);
    setBusy(true);
    setStatus("Loading trace…");
    try {
      const response = await fetch(
        `/api/lab-submissions/admin?pathname=${encodeURIComponent(item.pathname)}`,
        { cache: "no-store", headers: adminHeaders(password) },
      );
      if (!response.ok) {
        const result = (await response.json()) as { error?: string };
        throw new Error(result.error || "Could not load this trace.");
      }
      const result: unknown = await response.json();
      if (!isTraceRecording(result)) throw new Error("This file is not a readable DIBH trace.");
      setRecording(result);
      setStatus(`Loaded ${itemDetails(item).receipt}.`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not load this trace.");
    } finally {
      setBusy(false);
    }
  };

  const downloadSubmission = async (item: SubmissionListItem) => {
    setBusy(true);
    setStatus("Preparing download…");
    try {
      const response = await fetch(
        `/api/lab-submissions/admin?pathname=${encodeURIComponent(item.pathname)}&download=1`,
        { cache: "no-store", headers: adminHeaders(password) },
      );
      if (!response.ok) {
        const result = (await response.json()) as { error?: string };
        throw new Error(result.error || "Could not download this trace.");
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = item.pathname.split("/").at(-1) ?? "dibh-lab-submission.json";
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
      setStatus(`Downloaded ${itemDetails(item).receipt}.`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not download this trace.");
    } finally {
      setBusy(false);
    }
  };

  const uploadLocalTrace = async (file: File) => {
    setUploading(true);
    setStatus(`Reading ${file.name}…`);
    try {
      const raw = await file.text();
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || (parsed as { schema?: string }).schema !== "dibh-lab/v3") {
        throw new Error("Choose a DIBH Lab v3 JSON export.");
      }

      const response = await fetch("/api/lab-submissions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: raw,
      });
      const result = (await response.json()) as { ok?: boolean; id?: string; error?: string };
      if (!response.ok || !result.ok || !result.id) {
        throw new Error(result.error || "The local trace could not be submitted.");
      }
      setStatus(`Uploaded successfully. Receipt: ${result.id}`);
      await loadSubmissions(password);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "The local trace could not be submitted.");
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  return (
    <main className="min-h-screen bg-[#07090d] text-stone-100">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-5 px-4 py-6 sm:px-6 lg:px-8">
        <header className="flex flex-col gap-3 border-b border-slate-800 pb-5 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-sky-400">DIBH Lab</p>
            <h1 className="mt-1 text-2xl font-semibold sm:text-3xl">Trace administration</h1>
            <p className="mt-2 max-w-2xl text-sm text-slate-400">
              Review private Vercel submissions, inspect the recorded breathing curve, and download the original JSON.
            </p>
          </div>
          {authorized && (
            <button
              type="button"
              onClick={signOut}
              className="self-start rounded-md border border-slate-700 px-3 py-2 text-xs font-semibold text-slate-300 hover:border-slate-500"
            >
              Lock admin
            </button>
          )}
        </header>

        {!authorized ? (
          <section className="mx-auto mt-8 w-full max-w-md rounded-xl border border-slate-800 bg-[#0d1118] p-5 shadow-2xl">
            <h2 className="text-lg font-semibold">Admin password</h2>
            <p className="mt-2 text-sm leading-relaxed text-slate-400">
              The password is checked by the server and retained only for this browser tab.
            </p>
            <form onSubmit={signIn} className="mt-5 flex flex-col gap-3">
              <label className="text-xs font-semibold text-slate-300" htmlFor="admin-password">
                Password
              </label>
              <input
                id="admin-password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                className="rounded-md border border-slate-700 bg-slate-950 px-3 py-2.5 text-sm outline-none focus:border-sky-500"
              />
              <button
                type="submit"
                disabled={busy || !password}
                className="rounded-md bg-sky-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-sky-500 disabled:opacity-40"
              >
                {busy ? "Checking…" : "Open trace inbox"}
              </button>
            </form>
            <p className="mt-4 text-xs text-amber-300" role="status">{status}</p>
          </section>
        ) : (
          <>
            <section className="grid gap-3 sm:grid-cols-[1fr_auto_auto] sm:items-center">
              <p className="text-sm text-slate-300" role="status">{status}</p>
              <button
                type="button"
                onClick={() => void loadSubmissions()}
                disabled={busy}
                className="rounded-md border border-slate-700 px-3 py-2 text-xs font-semibold hover:border-sky-500 disabled:opacity-40"
              >
                Refresh inbox
              </button>
              <label className="cursor-pointer rounded-md bg-emerald-600 px-3 py-2 text-center text-xs font-semibold text-white hover:bg-emerald-500">
                {uploading ? "Uploading…" : "Upload local JSON"}
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="application/json,.json"
                  disabled={uploading}
                  className="sr-only"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) void uploadLocalTrace(file);
                  }}
                />
              </label>
            </section>

            <div className="grid min-h-[560px] gap-5 lg:grid-cols-[340px_minmax(0,1fr)]">
              <aside className="overflow-hidden rounded-xl border border-slate-800 bg-[#0d1118]">
                <div className="border-b border-slate-800 px-4 py-3 text-xs font-semibold uppercase tracking-wider text-slate-400">
                  Submissions ({submissions.length})
                </div>
                <div className="max-h-[70vh] overflow-y-auto">
                  {submissions.length === 0 ? (
                    <p className="p-4 text-sm text-slate-500">No submitted traces were found.</p>
                  ) : (
                    submissions.map((item) => {
                      const details = itemDetails(item);
                      const selected = item.pathname === selectedPath;
                      return (
                        <button
                          key={item.pathname}
                          type="button"
                          onClick={() => void openSubmission(item)}
                          className={`block w-full border-b border-slate-800 px-4 py-3 text-left transition ${
                            selected ? "bg-sky-950/70" : "hover:bg-slate-900"
                          }`}
                        >
                          <span className="block text-sm font-semibold text-slate-100">{details.participant}</span>
                          <span className="mt-1 block text-xs text-slate-400">{formatDate(item.uploadedAt)}</span>
                          <span className="mt-1 block truncate text-[11px] text-slate-500">{details.receipt}</span>
                        </button>
                      );
                    })
                  )}
                </div>
              </aside>

              <section className="min-w-0 rounded-xl border border-slate-800 bg-[#0d1118] p-4 sm:p-5">
                {!recording || !selectedItem ? (
                  <div className="flex min-h-[420px] items-center justify-center text-center text-sm text-slate-500">
                    {busy ? "Loading trace…" : "Choose a submission to inspect its trace."}
                  </div>
                ) : (
                  <div className="flex flex-col gap-5">
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                      <div>
                        <p className="text-xs uppercase tracking-wider text-slate-500">Participant</p>
                        <h2 className="mt-1 text-xl font-semibold">
                          {recording.contributor?.participantCode || itemDetails(selectedItem).participant}
                        </h2>
                        <p className="mt-1 text-xs text-slate-400">
                          {recording.submission?.id || itemDetails(selectedItem).receipt}
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => void downloadSubmission(selectedItem)}
                        disabled={busy}
                        className="rounded-md bg-sky-600 px-4 py-2.5 text-xs font-semibold text-white hover:bg-sky-500 disabled:opacity-40"
                      >
                        Download JSON
                      </button>
                    </div>

                    <dl className="grid grid-cols-2 gap-3 text-xs sm:grid-cols-4">
                      <AdminStat label="Received" value={formatDate(recording.submission?.receivedAt || selectedItem.uploadedAt)} />
                      <AdminStat label="Scenario" value={recording.scenario || "—"} />
                      <AdminStat label="Duration" value={`${Number(recording.durationSec || 0).toFixed(1)} sec`} />
                      <AdminStat label="Samples" value={recording.samples.length.toLocaleString()} />
                      <AdminStat label="Site" value={recording.contributor?.siteCode || "—"} />
                      <AdminStat label="Run label" value={recording.contributor?.runLabel || "—"} />
                      <AdminStat label="App build" value={recording.appBuild || "—"} />
                      <AdminStat label="File size" value={formatBytes(selectedItem.size)} />
                    </dl>

                    {recording.note && (
                      <div className="rounded-md border border-slate-700 bg-slate-950 p-3">
                        <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">Notes</p>
                        <p className="mt-2 whitespace-pre-wrap text-sm text-slate-200">{recording.note}</p>
                      </div>
                    )}

                    <div className="overflow-x-auto rounded-lg border border-slate-800 bg-[#07090d] p-3">
                      <div className="min-w-[680px]">
                        <LabTrace recording={recording} />
                      </div>
                    </div>

                    <details className="rounded-md border border-slate-800 bg-slate-950 p-3 text-xs text-slate-400">
                      <summary className="cursor-pointer font-semibold text-slate-300">Device metadata</summary>
                      <pre className="mt-3 overflow-x-auto whitespace-pre-wrap">
                        {JSON.stringify(recording.device ?? {}, null, 2)}
                      </pre>
                    </details>
                  </div>
                )}
              </section>
            </div>
          </>
        )}
      </div>
    </main>
  );
}

function AdminStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-slate-800 bg-slate-950 p-3">
      <dt className="uppercase tracking-wider text-slate-500">{label}</dt>
      <dd className="mt-1 break-words font-semibold text-slate-200">{value}</dd>
    </div>
  );
}
