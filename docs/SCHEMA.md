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
contains one unscored rehearsal, the tightest consistent trio found within up
to six Learn-style calibration attempts, and two successful audio-guided
Practice-style checks against the fixed learned target. Practice may use up to
four attempts; acquisition or sustained-drift failures abort to RELEASE and
retry rather than becoming scored holds.

```json
{
  "schema": "dibh-lab/v3",
  "sessionId": "33d87e61-79ee-45c7-9543-7c8d5e4e7405",
  "appBuild": "lab-p0.4",
  "algorithm": {
    "id": "dibh-lab-p0",
    "version": "0.3.0",
    "params": {
      "emaAlpha": 0.3,
      "stabilityWindowMs": 2000,
      "stableSlopeCeilingDegPerSec": 0.25,
      "calibrationExcursionSdCeilingDeg": 0.75
    }
  },
  "protocol": {
    "mode": "guided",
    "rehearsal": true,
    "holdSeconds": 10,
    "holdCount": 5,
    "learnHoldCount": 3,
    "calibrationAttemptLimit": 6,
    "practiceHoldCount": 2,
    "practiceAttemptLimit": 4,
    "targetAcquisitionSeconds": 5,
    "recoverySeconds": 20,
    "handsFree": true,
    "targetMethod": "median_relative_excursion"
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

Each hold records its quiet prehold anchor immediately before the READY prompt,
before anticipatory inhale motion can contaminate it. The learned target is the
robust median of the tightest three valid, direction-normalized excursions,
provided their SD does not exceed 0.75 degrees. Absolute pitch is diagnostic
only; every practice target is translated
from the current attempt's relaxed anchor. The target remains fixed for the
session and is not weakened by later performance. Session reproducibility is
decomposed into:

- `preholdPoseSdDeg`: phone/starting-pose consistency
- `absolutePlateauSdDeg`: absolute held phone-angle consistency
- `signedExcursionSdDeg`: breath-excursion consistency after normalizing the
  direction in which pitch moved

`freshInhaleExcursionAtHoldStartDeg` records how far the phone moved from that
anchor before the hold began. A hold is flagged when it does not show at least
1.5 degrees of new movement in its learned direction; this makes a phone that
was already near the target distinguishable from a new inhalation.

The two successful Practice holds also report absolute and excursion target
error, target-acquisition time, whether their plateau falls inside the
experimental band, their longest continuous stable-and-on-target run, whether
that run reached the selected duration, and the audio guidance issued. If three
matching calibration holds do not produce a target, practice stops rather than
silently using an invalid target. Practice must acquire the target band within
five seconds. Sustained drift receives one correction, then aborts to RELEASE
if the signal remains outside the band.

Recovery is also hands-free and ends at the configured duration. The two-second
window immediately before READY provides the next attempt's relaxed anchor;
low-confidence anchors are flagged without silently extending the rest.
`guided_stage`, `guided_phase`, `coach_cue`, `coach_cue_end`,
`calibration_hold_measured`, `calibration_hold_rejected`,
`calibration_acquisition_aborted`, `practice_attempt_aborted`,
`practice_hold_aborted`, `practice_hold_completed`,
`recovery_minimum_complete`, `rest_anchor_acquired`, `recovery_end`,
`target_learned`, `target_acquired`, `target_enter`, and `target_exit` events
make the complete instruction and measurement flow replayable.

The embedded target band is explicitly named
`experimentalTrainingToleranceDeg`. It is derived from typical within-hold
noise and clamped to 0.5–2.0 degrees; inconsistent Learn holds do not
automatically widen it. It is a detector-development value, not a clinically
validated RT tolerance.

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
