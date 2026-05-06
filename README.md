# DIBH Coach (Tide)

A browser-based, at-home practice and coaching tool for **deep-inspiration
breath-hold (DIBH)** patients undergoing left-sided breast radiation therapy.
The patient places a smartphone over their sternum, follows audio cues
through three short phases, and receives quantitative feedback on the
**reproducibility** of their hold across attempts.

Live: <https://dibh-coach.vercel.app>
Lab (sensor recording): <https://dibh-coach.vercel.app/lab>
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
│  Single-page client-side app (no backend)    │
│  Deployed on Vercel (static, no serverless   │
│  beyond /api/log dev sink)                   │
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
│   │   ├── lab/page.tsx      ← sensor-recording lab (13 channels)
│   │   ├── api/log/route.ts  ← dev-only log sink for live telemetry
│   │   ├── layout.tsx
│   │   └── globals.css
│   └── audio.ts              ← phrase catalogue + playClip() helper
├── public/
│   ├── audio/                ← 26 pre-recorded clips (Rachel voice)
│   └── tts-generator.html    ← in-browser regen tool (Puter.js)
├── scripts/
│   ├── generate-tts.mjs      ← one-shot TTS generator
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
