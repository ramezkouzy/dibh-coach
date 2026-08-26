# Lab recording schemas

Three formats coexist; the analyzer (`scripts/analyze.py`) handles all of them.

## v1 (legacy, single-channel)

```json
{
  "scenario": "calm-hold-25s",
  "note": "phone horizontal under belly button",
  "startedAt": "2026-05-06T17:28:11.330Z",
  "durationSec": 149.41,
  "samples": [{"t": 12.4, "p": -1.27}, ...],
  "events":  [{"t": 24700, "type": "hold-start"}, ...]
}
```

`samples[i].p` is the EMA-smoothed pitch (β) in degrees. `samples[i].t`
is milliseconds since recording start. `events[i].t` is in the same
millisecond timeline.

Used by the original `/lab` page (now superseded). Older recordings on
disk are still analysable.

## v2 (legacy full multi-channel)

```json
{
  "schema": "dibh-lab/v2",
  "scenario": "guided-20s",
  "note": "chest mode",
  "startedAt": "2026-05-06T18:14:35.123Z",
  "durationSec": 132.11,
  "ua": "Mozilla/5.0 (iPhone; ...)",
  "channels": [
    "t", "alpha", "beta", "gamma",
    "ax", "ay", "az",
    "agx", "agy", "agz",
    "rrAlpha", "rrBeta", "rrGamma"
  ],
  "samples": [
    [12.4, 187.45, -1.27, 1.66, 0.012, -0.003, 0.041, ...],
    ...
  ],
  "events": [
    {"t": 0.06, "type": "baseline_start"},
    {"t": 12870, "type": "baseline_end"},
    {"t": 15710, "type": "inhale_start"},
    {"t": 20550, "type": "hold_start"},
    {"t": 41450, "type": "release"},
    {"t": 48300, "type": "session_end"}
  ]
}
```

### Channel definitions

| Channel | Source | Unit |
|---------|--------|------|
| `t` | `performance.now() - startedAt` | ms |
| `alpha` | `DeviceOrientationEvent.alpha` (compass / yaw) | deg |
| `beta`  | `DeviceOrientationEvent.beta` (pitch) | deg |
| `gamma` | `DeviceOrientationEvent.gamma` (roll) | deg |
| `ax/ay/az` | `DeviceMotionEvent.acceleration` (gravity removed) | m/s² |
| `agx/agy/agz` | `DeviceMotionEvent.accelerationIncludingGravity` | m/s² |
| `rrAlpha/rrBeta/rrGamma` | `DeviceMotionEvent.rotationRate` | deg/s |

`null` is used when a channel hasn't been observed yet for a particular
sample row (the orientation and motion events fire on independent
timers; one row may capture the orientation while motion lags by 1-2
samples).

### Event types

**Guided protocol marks** (auto-emitted by the lab page during a Guided
session):

- `baseline_start`, `baseline_end`
- `inhale_start`, `hold_start`
- `release`, `session_end`

**Free-record annotations** (tapped manually by the user):

- `hold-start`, `peak`, `stable`, `drift-in`, `drift-out`, `target`,
  `release`

The analyzer's `phase_windows` function understands both forms — guided
marks are preferred when present.

### Sampling rate

Empirical: 58 – 60 Hz on iPhone Safari, similar on Android Chrome. The
lab page applies a 12 ms minimum gap between recorded rows, which caps
the rate slightly below the raw event firing rate but prevents
sub-millisecond duplicates from filling the buffer.

A 30-second guided recording is ~1800 rows × 13 fields = ~30 KB of JSON;
a 60-second one is ~60 KB. Plenty under the 1 MB-per-`/api/log`-payload
budget.

### Compatibility

`scripts/analyze.py` detects the schema by checking for the
`schema: "dibh-lab/v2"` key. v1 files are auto-promoted by mapping `p`
to `beta` in the in-memory representation, so the same per-channel and
per-phase reports work uniformly across both.

## v3 (current P0 measurement harness)

`dibh-lab/v3` preserves the v2 raw channels, adds `betaEma`, and embeds a
versioned deterministic analysis. A guided run is hands-free after Start and
records 10 seconds of normal breathing followed by three unconditional
deep-breath/10-second-hold/10-second-recovery cycles. Capture quality is
descriptive post-run metadata only; it never rejects or repeats a cycle.

```json
{
  "schema": "dibh-lab/v3",
  "sessionId": "33d87e61-79ee-45c7-9543-7c8d5e4e7405",
  "appBuild": "lab-p0.8",
  "algorithm": {
    "id": "dibh-lab-p0",
    "version": "0.5.0",
    "params": {
      "emaAlpha": 0.3,
      "stabilityWindowMs": 2000,
      "stableSlopeCeilingDegPerSec": 0.25,
      "calibrationExcursionSdCeilingDeg": 0.75
    }
  },
  "protocol": {
    "mode": "guided",
    "rehearsal": false,
    "baselineSeconds": 0,
    "cycleCount": 6,
    "requiredNormalCycles": 3,
    "calibrationHoldCount": 3,
    "correctionLimit": 2,
    "holdSeconds": 10,
    "holdCount": 6,
    "learnHoldCount": 3,
    "calibrationAttemptLimit": 6,
    "practiceHoldCount": 3,
    "practiceAttemptLimit": 6,
    "targetAcquisitionSeconds": null,
    "recoverySeconds": null,
    "handsFree": true,
    "phonePlacement": "charging_port_toward_face",
    "targetMethod": "local_three_peak_delta_mean_combined_sd"
  },
  "channels": [
    "t", "alpha", "beta", "betaEma", "gamma",
    "ax", "ay", "az", "agx", "agy", "agz",
    "rrAlpha", "rrBeta", "rrGamma"
  ],
  "samples": [],
  "events": [
    {"t": 0, "type": "guided_phase", "meta": {"phase": "setup"}},
    {"t": 5, "type": "coach_cue", "meta": {"cue": "p0_session_intro"}},
    {"t": 8240, "type": "coach_cue_end", "meta": {"cue": "p0_session_intro", "result": "ended"}},
    {"t": 30000, "type": "baseline_start"},
    {"t": 42000, "type": "baseline_end"},
    {"t": 48600, "type": "prehold_start", "meta": {"holdIndex": 1, "role": "learn"}},
    {"t": 50600, "type": "prehold_end", "meta": {"holdIndex": 1, "role": "learn"}},
    {"t": 50600, "type": "inhale_start", "meta": {"holdIndex": 1, "role": "learn"}},
    {"t": 55400, "type": "hold_start", "meta": {"holdIndex": 1, "role": "learn"}},
    {"t": 65400, "type": "release", "meta": {"holdIndex": 1, "role": "learn"}},
    {"t": 85400, "type": "recovery_end", "meta": {"holdIndex": 1, "role": "learn"}}
  ],
  "analysis": {
    "schema": "dibh-lab-analysis/v1",
    "quality": {},
    "baseline": {},
    "holds": [],
    "summary": {},
    "valid": true,
    "issues": []
  }
}
```

### P0 analysis semantics

The analyzer uses `betaEma` when available and falls back to raw `beta` for
older recordings. A stable window must satisfy both:

```text
rolling pitch SD < adaptive threshold
absolute rolling pitch slope < 0.25 degrees/second
```

This prevents a slow, smooth inhale ramp from being mistaken for a plateau.
The SD condition must persist for 1 second before lock; loss of the combined
condition must persist for 1.5 seconds before a confirmed drift. Stable
segments retain their exact boundaries, and plateau statistics are calculated
from the segment interior rather than from the end of the entire attempt.

P0.8 stores `breathing_cycles_qualified` before every hold. Its metadata includes
three inspiratory peak times and pitches, intervening troughs, their mean peak,
cycle-period CV, mean amplitude, and amplitude CV. That three-peak mean is copied
to `hold_start.meta.localAnchorPitchDeg`; absolute pitch remains diagnostic only.

Each calibration hold stores its median direction-normalized delta from that
local anchor plus its full-window and robust within-hold variability. The learned
target is the arithmetic mean of the first three valid calibration deltas. Its
half-range is the root-sum-square of sample SD between those deltas and pooled
robust SD within the three 10-second holds, clamped to 0.5–2.5 degrees. The
target delta remains fixed for the session, but every coaching attempt translates
it from a new local three-cycle anchor. Session reproducibility is decomposed into:

- `preholdPoseSdDeg`: phone/starting-pose consistency
- `absolutePlateauSdDeg`: absolute held phone-angle consistency
- `signedExcursionSdDeg`: breath-excursion consistency after normalizing the
  direction in which pitch moved

`physiological_hold_detected` records the excursion, slope/dwell method, and
detection latency that established the hold boundary. The deep-breath audio and
detector run concurrently; audio completion is not used as `hold_start`.

Coached holds report excursion error, target-acquisition time, total and percent
time in range, longest continuous beam-on interval, 10-second completion,
correction count, successful correction count, and abort state. The hold clock
does not pause outside the band. Sustained low/high drift receives the matching
directional cue. Two unsuccessful corrections abort to release.

Recovery is hands-free and ends only after three new complete, sufficiently
regular cycles qualify; it is not a fixed-duration rest.
`guided_stage`, `guided_phase`, `coach_cue`, `coach_cue_end`,
`breathing_cycle_observation_start`, `breathing_cycles_qualified`,
`physiological_hold_detected`,
`calibration_hold_measured`, `calibration_hold_rejected`,
`calibration_attempt_aborted`, `practice_attempt_aborted`,
`practice_hold_aborted`, `practice_hold_completed`,
`recovery_end`, `target_learned`, `target_acquired`, `target_enter`,
`target_exit`, `beam_on`, `beam_off`, `correction_issued`, and
`correction_succeeded` events
make the complete instruction and measurement flow replayable.

The embedded target band is explicitly named
`experimentalTrainingToleranceDeg`. It is derived from both between-hold and
within-hold variability and clamped to 0.5–2.5 degrees. It is a
detector-development value, not a clinically validated RT tolerance.

---

## Session export: `dibh-session/v1`

The coaching app's Complete screen exports the self-test payload. This is
the primary feedback handoff for prototype recalibration.

```json
{
  "schema": "dibh-session/v1",
  "app": "DIBH Coach",
  "exportedAt": "2026-05-30T19:37:49.162Z",
  "startedAt": "2026-05-30T19:34:16.303Z",
  "ua": "Mozilla/5.0 ...",
  "settings": {
    "holdTarget": 20,
    "holdsPerSession": 3,
    "voiceOn": true,
    "hapticsOn": true,
    "debugOn": true
  },
  "baseline": {
    "meanPitch": -0.42,
    "amplitudeDeg": 2.73,
    "breathingSD": 0.68
  },
  "plateau": {
    "targetPitch": -6.48,
    "toleranceDeg": 1.82,
    "calibrationHolds": [
      {"plateauPitch": -7.22, "plateauSD": 0.21}
    ]
  },
  "holds": [
    {
      "index": 1,
      "totalDurationSec": 20.1,
      "stableSec": 16.2,
      "longestRunSec": 11.4,
      "driftEvents": 1,
      "timeToLockSec": 3.1,
      "plateauPitch": -6.7,
      "plateauSD": 0.18,
      "onTargetSec": 10.2,
      "longestOnTargetRunSec": 10.2,
      "reachedTarget": true,
      "startedAt": "2026-05-30T19:35:02.011Z",
      "samples": [{"t": 0, "p": -0.5}],
      "events": [{"t": 0, "type": "hold_start"}]
    }
  ]
}
```

`holds[].samples` are intended to be milliseconds since hold start. The
backend now tolerates older exports where sample times still carry a
larger session offset and rebases them during analysis.

## Tracking analysis: `dibh-tracking-analysis/v1`

`POST /api/sessions` accepts a `dibh-session/v1` payload and returns a
tracking diagnostic object:

```json
{
  "ok": true,
  "id": "6e4f8d7a1b2c3456",
  "storage": {"mode": "file"},
  "analysis": {
    "schema": "dibh-tracking-analysis/v1",
    "trackingConfidence": "guarded",
    "summary": {
      "requestedHoldTargetSec": 20,
      "suggestedSelfTestCapSec": 10,
      "targetExcursionDeg": -6.07,
      "reachedTargetCount": 0
    },
    "issues": [
      {
        "code": "hold_started_near_target",
        "severity": "warn",
        "holdIndex": 1,
        "message": "The hold began already near or beyond the learned target..."
      }
    ],
    "recommendations": [
      {
        "code": "require_fresh_breath_evidence",
        "priority": "high",
        "message": "Before saying locked-in or hold-steady, require a new inhale excursion after Start..."
      }
    ]
  }
}
```

The first backend pass is intentionally storage-light:

- In local development, accepted sessions are written to
  `.data/dibh-sessions/*.json`.
- In production, the route logs a compact summary unless
  `DIBH_SESSION_STORE=file` is configured. Vercel filesystem writes are not
  durable, so a real store can be added later behind the same endpoint.

Run the same analyzer locally against exported sessions:

```bash
pnpm session:analyze path/to/dibh-session-*.json
```
