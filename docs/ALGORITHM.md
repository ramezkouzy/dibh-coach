# Algorithm

The full pipeline from sensor sample to coaching cue, as currently
implemented in `src/app/page.tsx`. Designed against two real recordings
from a single subject; tunables called out at each step.

---

## 1. Sensor capture

**Source:** `DeviceOrientationEvent.beta` — pitch in degrees. The browser
exposes the OS-fused attitude (accel + gyro sensor fusion), with the same
~ ± 0.1° accuracy that Capaldi's 2020 IRF leveraged on iOS.

**Smoothing:** exponential moving average with α = 0.3. Applied at sensor
cadence (~58 Hz on iPhone Safari, ~60 Hz on Android Chrome).

```ts
pitchRef.current = pitchRef.current * (1 - α) + e.beta * α;
```

A timestamped sample (`{t, p}`) is pushed to a rolling 60-second buffer
on every event tick. The display state (`setPitch`) is throttled to
~10 Hz so the parent component does not re-render at sensor cadence —
this avoids the "60 Hz reset" bug where dependent useEffect timers were
torn down faster than they could tick.

---

## 2. Calibration phase

12 seconds of normal breathing. The first 2 s are discarded as a
"settling" window so position adjustments do not enter the statistics.
The remaining 10 s yield:

```ts
breathingSD = std(samples)
breathingMean = mean(samples)
amplitude = max(samples) - min(samples)
bpm = zeroCrossings(samples - mean, hysteresis=0.2°) × 30 / duration
```

**Sanity gates** (any one trips a re-calibrate prompt):

| Condition | Trigger |
|-----------|---------|
| `amplitude < 0.4°` | "Phone may not be on your belly" |
| `amplitude > 30°`  | "Too much movement" |
| `bpm` outside `[4, 30]` | "Breathing rate looked off" |
| `samples < 30`     | "Not enough sensor data yet" |

`breathingSD` becomes the basis for the entire session's stability
threshold.

---

## 3. Adaptive stability threshold

```ts
adaptiveThreshold = clamp(breathingSD × 0.7, [0.08, 1.2])
```

Why 0.7? Two real recordings:

| Subject mode | Breathing SD | Hold SD | Ratio |
|--------------|--------------|---------|-------|
| Belly-only (chest tight) | 0.81° | 0.07° | 11× |
| Chest-led (DIBH-like)    | 0.99° | 0.13° | 6×  |

A 0.5 multiplier puts chest-mode patients right at threshold (their
clean-hold SD ≈ baseline × 0.5), causing the lock to flicker. 0.7 leaves
chest-mode comfortably below and belly-mode dramatically below. The
clamp range tolerates the extremes (a totally still subject's SD could
fall below the floor; a very agitated subject above the ceiling).

---

## 4. In-hold stability detection

Every 100 ms during the active phase:

```ts
sd = rollingSD(traceBuffer, lastMs=2000)
wantStable = sd < adaptiveThreshold
```

**Hysteretic state machine** to avoid flapping on transients:

- A change in `wantStable` starts a candidate timer.
- Lock fires when `wantStable=true` has held for `STABLE_DEBOUNCE_MS` (1000 ms).
- Drift fires when `wantStable=false` has held for `DRIFT_DEBOUNCE_MS` (1500 ms).

On lock: `cue("locked_in")` (or `"regained"` if a prior drift), haptic
confirmation buzz, start a stable-run timer.

On drift: increment drift counter, cue `"drifting"`, three-pulse haptic.

---

## 5. Position-match (Practice phase only)

The Learn phase has captured `plateau.targetPitch` and
`plateau.toleranceDeg`. During Practice:

```ts
targetDelta = pitch - plateau.targetPitch
onTarget = |targetDelta| ≤ plateau.toleranceDeg
```

Position cues fire only while stable, throttled to 2.5 s minimum gap and
only on **transition between cue states**:

- `targetDelta < -tolerance` → `cue("go_deeper")`
- `targetDelta > +tolerance` → `cue("ease_back")`
- `|targetDelta| ≤ tolerance` and we just crossed in → `cue("right_there")` + buzz

This pattern means a stable patient hears one cue per direction change,
not a stream. The throttle is a hard floor; the transition gate is the
softer human one.

**On-target time** is the clinical metric, not just stable time:

```ts
if isStable AND onTarget:
    onTargetMsAccum += dt
    longestOnTargetMs = max(longestOnTargetMs, currentRunMs)
```

The session's hold-duration goal is reached when
`longestOnTargetSec ≥ holdTarget` — at which point `cue("target_reached")`
plays with a celebratory haptic pattern.

---

## 6. Auto-release detection

Two paths can end a hold automatically:

**Path 1 — SD spike post-lock.** Once the patient has locked in at least
once, a sustained SD jump above `adaptiveThreshold × 3` for 1.5 s ends
the hold. The clinical signal of "the patient is moving again" is
movement, not a return to baseline pitch — a low-effort patient who
exhales partially never crosses a fixed pitch threshold but their SD
absolutely spikes.

**Path 2 — target-reached + 5 s grace.** Prevents a successful hold from
running indefinitely. Once `target_reached` fires, a 5-second timer
auto-ends the hold so the patient gets to release while their lungs are
still happy.

In both cases, the manual "End hold" button is always available.

---

## 7. Plateau extraction (post-hold)

A hold's plateau is captured for the patient's session log and (in the
Learn phase) for target-setting:

```ts
plateauPitch = median(samples in last 3 s of hold trace)
plateauSD    = std(samples in last 3 s of hold trace)
```

The "last 3 s" is a proxy for "the longest stable run's end" — empirically
that's where the patient's most reproducible position is, since they had
time to settle into it.

---

## 8. Learn-phase target derivation

After three Learn holds:

```ts
peaks = [hold1.plateauPitch, hold2.plateauPitch, hold3.plateauPitch]
target = mean(peaks)
acrossSD = std(peaks)
tolerance = max(0.5°, 2 × acrossSD)
```

A patient whose three Learn holds differ by < 0.5° gets the floor
tolerance (tight); a patient whose holds vary widely (> 1° SD across the
three) gets a more forgiving band so Practice is not impossible.

### Lab P0 consistency gate

The Lab P0 harness does not widen the band to accommodate inconsistent
calibration. It selects the tightest same-direction trio from up to six valid
attempts and requires excursion SD ≤ 0.75°. If no trio qualifies, Practice does
not start. After the first measurable calibration, the live screen shows a blue
position bar and a provisional green range to guide subsequent attempts.

Practice uses an acquire-then-hold state machine. The blue bar must remain in
the green band for 750 ms within a five-second acquisition window. Acquisition
failure releases immediately. During the timed hold, sustained out-of-band
motion receives one directional cue; failure to return aborts and restarts the
attempt. The runner collects a selectable 2, 5, 8, or 10 successful holds and
allows twice that number of attempts. With the charging port toward the face,
negative raw pitch movement is normalized upward for inhale. The practice band
uses a 1.0-degree minimum half-width, three times measured within-hold noise,
and a 2.5-degree maximum half-width.

---

## 9. Audio pipeline

Every phrase key is backed by a pre-rendered MP3 in `public/audio/`.
The phrases are named by event (e.g. `locked_in`, `go_deeper`,
`learn_target_locked`) rather than by literal text, so re-recording with
a different voice (Vranich, etc.) is a file-swap.

Playback is serialized through a single active `<audio>` element. Lab P0
awaits each clip's `ended` event before advancing, while an explicit cancel or
playback error ends the active prompt. The same user-activated media element is
reused for every hands-free cue on iPhone. Timed holds announce five seconds
remaining, and target acquisition plays a dedicated two-note ding.
A higher-priority cue can stop the active clip. A bounded timeout
prevents a missing browser `ended` event from freezing the protocol. On iOS,
audio is unlocked by a `requestPermission`-coupled gesture on the Welcome
screen — without that, non-interactive playback is blocked.

Lab P0 has a dedicated, consistently voiced set for REST, READY, INHALE, HOLD,
RELEASE, calibration, practice, correction, retry, and completion prompts.
There is no system-voice fallback, preventing mixed voices and overlapping
browser speech; missing or blocked audio is instead recorded as a failed cue.

---

## 10. Haptics

`navigator.vibrate(pattern)` for confirmation feedback:

| Event | Pattern |
|-------|---------|
| Stability lock acquired | `50` ms |
| Drift detected | `[100, 100, 100]` ms |
| On-target crossed in | `40` ms |
| Target reached (duration goal) | `[100, 50, 100, 50, 250]` |
| Hold ended | `40` ms |

**Caveat:** iOS Safari ignores Vibration API entirely. Android Chrome
honours it. Falls through silently on iOS.

---

## Tunables, all in `src/app/page.tsx`

| Constant | Value | What it controls |
|----------|-------|------------------|
| `STABILITY_WINDOW_MS` | 2000 | Rolling SD window length |
| `STABLE_SD_FRAC_OF_BASELINE` | 0.7 | Adaptive threshold multiplier |
| `STABLE_SD_FLOOR` / `_CEILING` | 0.08 / 1.2 | Threshold clamp range (deg) |
| `STABLE_DEBOUNCE_MS` | 1000 | Time stable before lock fires |
| `DRIFT_DEBOUNCE_MS` | 1500 | Time unstable before drift fires |
| `LEARN_HOLDS` | 3 | Calibration holds before target is set |
| `TOLERANCE_FLOOR_DEG` | 0.5 | Minimum target band half-width |
| `TOLERANCE_SD_MULT` | 2 | Tolerance = max(floor, this × across-SD) |
| `POST_TARGET_AUTOEND_MS` | 5000 | Grace after target reached |
| `RELEASE_SUSTAIN_MS` | 1500 | SD-spike duration to auto-release |
| `CALIBRATE_SEC` / `_SETTLE_SEC` | 12 / 2 | Calibration window |
| Orb breath reference | 12° | Pitch deviation for full orb size |

Every value above is the result of either Capaldi 2020/2026 reading or
the two real recordings analysed under `data/` (private).
