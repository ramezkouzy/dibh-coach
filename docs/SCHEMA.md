# Lab recording schemas

Two formats coexist; the analyzer (`scripts/analyze.py`) handles both.

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

## v2 (current, full multi-channel)

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
