# DIBH Coach (Tide)

A browser-based, at-home practice and coaching tool for **deep-inspiration
breath-hold (DIBH)** patients undergoing left-sided breast radiation therapy.
The patient places a smartphone over their sternum, follows audio cues
through three short phases, and receives quantitative feedback on the
**reproducibility** of their hold across attempts.

Live: <https://dibh-coach.vercel.app>
Lab (P0 measurement harness): <https://dibh-coach-lab-p0.vercel.app/lab>
TTS generator: <https://dibh-coach.vercel.app/tts-generator.html>

---

## What the patient does

1. **Welcome** — set hold-target duration (15 / 20 / 25 / 30 / 35 s, default 20 s) and number of practice holds (1 – 5, default 3).
2. **Placement** — phone in portrait, charging-port edge resting on the sternum, the rest extending across the upper belly. Screen up.
3. **Calibration** — 12 s of normal breathing. Establishes the patient's per-session breathing-pitch SD, used to derive an adaptive stability threshold.
4. **Learn** — three "comfortable" chest holds. Each hold's plateau (median pitch over the last 3 s of its longest stable run) is captured. After three, the app averages them: *target = mean(plateaus); tolerance = max(0.5°, 2 × SD across the three)*.
5. **Practice** — five holds with **position-match coaching**: live cues "a little deeper" / "ease back a touch" / "right there, hold steady." The on-screen orb has a dashed target ring; the patient inhales until the live orb fills it and the SD-based stability detector locks. Time-on-target accumulates toward the duration goal.
6. **Complete** — per-session summary with the headline clinical metric: **plateau-pitch reproducibility SD** across the practice holds.

---

## Architecture at a glance

```
┌──────────────────────────────────────────────┐
│  Next.js 16 + React 19 + Tailwind 4          │
│  Single-page coaching app + prototype APIs   │
│  Deployed on Vercel                          │
│  • /api/log dev sink                         │
│  • /api/sessions session ingest/analyze      │
└──────────────────────────────────────────────┘
        │
        ▼
┌──────────────────────────────────────────────┐
│  Browser sensor APIs                         │
│  • DeviceOrientationEvent.beta (pitch deg)   │
│  • DeviceMotionEvent (accel + rotation rate) │
│  • Wake Lock API (screen stays on)           │
└──────────────────────────────────────────────┘
        │
        ▼
┌──────────────────────────────────────────────┐
│  Adaptive stability detection                │
│  • 2-s rolling SD of pitch                   │
│  • Per-session adaptive threshold            │
│    = breathingSD × 0.7  (clamped 0.08-1.2°)  │
│  • Debounced state machine (lock/drift/etc.) │
└──────────────────────────────────────────────┘
        │
        ▼
┌──────────────────────────────────────────────┐
│  Audio coaching                              │
│  • 26 pre-recorded MP3 clips (ElevenLabs via │
│    Puter.js, voice "Rachel")                 │
│  • Web Speech fallback if a clip is missing  │
│  • Web Vibration API for haptic confirmations│
│    (Android only; iOS Safari blocks it)      │
└──────────────────────────────────────────────┘
```

### Why a browser app, not native iOS?

Two real recordings on iOS Safari produced ~58 Hz fused-orientation samples,
sufficient for the algorithm. Browser delivery means:

- Single codebase serves iOS and Android equivalently
- Doctor texts a URL, no App Store review
- Iteration cycle measured in minutes
- No regulatory pathway needed for a wellness/practice tool (vs. SaMD)

A native iOS port using `CMDeviceMotion` (which Capaldi's 2020 IRF used) is
listed in `TODO.md`; the only meaningful gain would be a higher sample rate,
not a different signal.

---

## Sensor & algorithm details

See `docs/ALGORITHM.md` for the full explanation. Headline points:

- **Phone placement matters.** The phone must act as a lever across the
  chest-belly seam. A phone laid flat and centered on the belly produces
  almost no rotational signal during inhale; one with its bottom edge
  anchored on the sternum and the rest extending downward produces 5 – 15°
  of pitch swing on a deep chest inhale.
- **Stability is the primary signal**, not absolute pitch. We measure how
  variable the pitch is over a 2-s rolling window. Holding still drops
  that SD by 5 – 11× compared to normal breathing in measured recordings.
- **Adaptive threshold per session.** The 12-s calibration measures each
  patient's breathing-pitch SD; the in-hold threshold is set to 70 % of
  that. Patients vary widely in chest amplitude and how still they hold —
  fixed thresholds flicker.
- **Reproducibility comes from the Learn phase.** Three "comfortable"
  holds set the patient's target depth for the day. Practice holds are
  coached back to that target.
- **On-target time, not just stability**, is what counts as progress.
  Holding still in the wrong place doesn't accumulate toward the duration
  goal.

---

## Repository layout

```
app/
├── src/
│   ├── app/
│   │   ├── page.tsx          ← main coaching app
│   │   ├── lab/page.tsx      ← P0 sensor + repeatability measurement harness
│   │   ├── api/log/route.ts  ← dev-only log sink for live telemetry
│   │   ├── api/sessions/route.js
│   │   │                     ← session ingest + tracking diagnostics
│   │   ├── layout.tsx
│   │   └── globals.css
│   ├── lib/
│   │   └── tracking-analysis.mjs
│   │                         ← shared session analyzer
│   └── audio.ts              ← phrase catalogue + playClip() helper
├── public/
│   ├── audio/                ← checked-in prerecorded coaching clips
│   └── tts-generator.html    ← in-browser regen tool (Puter.js)
├── scripts/
│   ├── generate-tts.mjs      ← one-shot TTS generator
│   ├── replay-check.mjs      ← historical recording smoke check
│   ├── analyze-session.mjs   ← exported-session tracking analysis
│   └── analyze.py            ← lab-recording analyzer (v1 + v2)
├── tools/
│   └── tts-generator.html    ← local-file copy of the generator
├── docs/
│   ├── ALGORITHM.md          ← detailed algorithm + tunables
│   └── SCHEMA.md             ← lab-recording JSON formats
├── paper/
│   ├── main.tex              ← Adv Radonc–style Research Letter draft
│   └── refs.bib              ← reference list
├── README.md                 ← this file
└── TODO.md                   ← deferred features / open questions
```

---

## Building and running

```bash
pnpm install
pnpm dev          # http://localhost:3000
pnpm build        # production build (turbopack)
```

Deploy is wired through Vercel; the active production alias is
`dibh-coach.vercel.app`.

### Re-recording the coaching audio

If you change any phrase in `src/audio.ts`, mirror it in
`scripts/generate-tts.mjs` and `public/tts-generator.html`. Two paths:

```bash
# Server-side, with a real ElevenLabs API key:
ELEVENLABS_API_KEY=sk_xxx pnpm tts:generate

# Client-side, no key, user-pays via Puter.js:
# open https://dibh-coach.vercel.app/tts-generator.html in Chrome,
# sign in to Puter, point at public/audio/, click Generate.
```

### Analyzing a lab recording

```bash
python3 scripts/analyze.py path/to/dibh-*.json
```

The analyzer prints per-phase pitch and rotation-rate statistics, rolling
SD percentiles, ASCII traces, and answers the question "would the current
algorithm have classified this hold as stable" — used heavily during
threshold tuning.

The current `dibh-lab/v3` guided harness is a physiology-driven calibration and
coaching run. Before every hold it waits for three complete, regular respiratory
cycles and averages their inspiratory peaks to establish a local reference. It
then detects the held plateau from the sensor trace rather than from audio
completion and records a 10-second hold with a spoken five-seconds-left cue.

Three calibration holds produce three local peak-to-hold deltas. Their mean is
the session target. The target half-range combines between-hold SD with pooled
within-hold variability, subject to a 0.5-degree sensor-noise floor and
2.5-degree ceiling. Every coached hold recalculates its absolute target from a
fresh three-cycle local reference, so phone-pose drift does not change the
learned excursion target.

The coached 10-second clock never pauses. Simulated beam time accumulates only
while the trace is inside the target band. Sustained low or high drift receives
at most two serialized corrections (“Breathe in a little more” or “Ease back
slightly”). If both corrections fail, the hold aborts, the patient returns to
normal breathing, and a retry cannot begin until three fresh cycles qualify.

The live display is a continuously growing EKG-style trace from the first
baseline sample through final recovery. With the charging port toward the face,
inhalation is normalized upward. The horizontal strip retains all prior points
and auto-scrolls, while the vertical scale expands when a deeper breath arrives.

Free record also includes a separate **Position study** mode for comparing phone
placement during normal breathing. Each run records a labeled body location,
left/midline/right alignment, posture, phone-contact method, fixed phone
orientation, and a standardized 30, 45, or 60-second duration. It contains no
prompts, holds, calibration, targets, or coaching. The first three seconds are
excluded as placement settling time.

The position trace uses a tighter auto-scaling range so small quiet-breathing
oscillations remain visible. Each downloaded JSON includes usable respiratory
cycle count, median peak-to-trough amplitude, amplitude variability, breathing
rate, robust high-frequency noise, amplitude-to-noise ratio, and pose drift.
Completed runs remain in an on-page comparison; the placement with the highest
amplitude-to-noise ratio among sufficiently long recordings is labeled the
strongest measured signal. This is a phone-position signal-quality comparison,
not a lung-volume or clinical-treatment measurement.

### Distributed Lab contributions

The Lab uses a three-screen contributor flow: **Choose → Record → Results**.
The start screen contains the how-to, a non-identifying participant code, an
optional site/group code and run label, a data acknowledgement, and three clear
recording choices: Guided calibration, Position study, and Free record. Only the
selected recorder is shown while collecting data. Once recording stops, setup
controls are hidden and the page shows the trace results, a post-run notes field,
and delivery actions.

Every new `dibh-lab/v3` JSON includes contributor codes plus browser-accessible
device metadata: user-agent/platform, language and time zone, screen and viewport
dimensions, pixel ratio, screen orientation, touch points, hardware concurrency,
and device memory when the browser exposes it. Mobile browsers do not reliably
expose an exact phone model. Do not use participant names, dates of birth, email
addresses, or personal health information in contributor fields or notes.

The preferred delivery path is `POST /api/lab-submissions`. It validates the Lab
recording, adds a server receipt timestamp and SHA-256 checksum, writes the JSON
to a **private Vercel Blob store**, and returns a submission ID. JSON download and
the phone share sheet remain available as backups. The legacy `/api/log` endpoint
only writes to runtime logs and is not durable study storage.

To enable central collection in Vercel:

1. Open the linked `dibh-coach` project, create a **private Blob store**, and
   connect it to Production. New Vercel projects use automatic short-lived OIDC
   credentials plus `BLOB_STORE_ID`; legacy connections may instead supply
   `BLOB_READ_WRITE_TOKEN`.
2. Optionally add `DIBH_LAB_ACCESS_CODE` as a Production environment variable
   and give that shared code only to invited contributors.
3. Redeploy. The Lab start screen will change from **JSON backup mode** to
   **Central upload ready**, and each successful upload will show a receipt ID.

### Private trace administration

Set `DIBH_LAB_ADMIN_KEY` as a secret environment variable for Production and
Preview in Vercel, then open `/lab-admin`. The admin password is checked on the
server for every list, preview, and download request; it is never included in the
client bundle. The page lists private JSON files under `lab-submissions/`, renders
the selected breathing trace, downloads the stored JSON, and can upload an
existing `dibh-lab/v3` JSON export from the current device.

Contributor submission remains public when `DIBH_LAB_ACCESS_CODE` is unset.
`DIBH_LAB_ADMIN_KEY` protects retrieval only and should be a separate, strong
password. For local administration, add both the Blob credentials and
`DIBH_LAB_ADMIN_KEY` to `.env.local`; never commit that file.

Server uploads are capped at 4 MB so they stay below Vercel Function request
limits. If guided traces exceed that size in future, migrate this route to the
Vercel Blob client-upload flow.

Lab P0 uses a dedicated prerecorded prompt set and serializes each MP3 before the
next instruction, with a bounded timeout so audio cannot freeze the runner.
Audio is activated inside the motion and Start taps on mobile, and a Test voice
control confirms playback before the run. If a required prompt fails, the run
stops instead of continuing silently. All cues reuse that same activated audio
element for iPhone reliability. A 10-second hold includes a spoken five-second
remaining cue.
JSON exports record phase transitions plus prompt start/end
events, allowing the trace view to align spoken instructions with measured
inhale, hold, release, and recovery motion.

The export stores all 13 hardware channels plus EMA pitch, exact phase and
coaching markers, versioned detector parameters, stable-segment boundaries,
and separate metrics for local anchors, calibration deltas, between-hold
variability, within-hold drift, combined target range, time in range, longest
beam-on interval, and correction response. These are training proxies, not
measurements of lung volume or treatment suitability.

```bash
pnpm lab:p0:check
```

The synthetic check verifies deterministic legacy replay, both phone-pitch
directions, three-cycle detection, position-signal comparison, local-delta
target calculation, combined variability, and coached time-in-range scoring.

### Analyzing a self-test session export

```bash
pnpm session:analyze path/to/dibh-session-*.json
```

The same logic runs in `POST /api/sessions`. It flags tracking failures
like a hold starting already near the learned target, unstable Learn
holds, wrong-direction plateaus, sample timebase offsets, repeated
drift/regain cycles, and self-test holds that should have been capped at
10 seconds.

---

## Origins & prior art

This work was prompted by a question from Dr. Melissa Mitchell (MD Anderson)
about whether a smartphone could coach DIBH patients to reproduce their
chest-hold position at home. Belisa Vranich (clinical psychologist /
breathing instructor) flagged a complementary 2026 *Advances in Radiation
Oncology* paper from Capaldi *et al.* (UCSF) on `iSGRT` — a smartphone
LiDAR–based replacement for in-clinic SGRT systems.

Tide is the **patient-facing, at-home companion** to that line of work —
not an in-room SGRT replacement. Its design choices (browser, phone-only,
no chest marker, no LiDAR, wellness framing) reflect that gap. See `paper/`
for the full positioning.

---

## License

The current codebase is private during development. No license attached
yet; that decision will be made together with the eventual academic /
clinical collaborators.
