# TODO

Deferred features, known gaps, and open product questions, ordered roughly
by impact-per-effort.

## Near-term — algorithmic refinement

- [ ] **Adaptive tolerance from Learn phase variance.** Currently
      `tolerance = max(0.5°, 2 × SD-across-3-plateaus)`. Once we have more
      patient data, validate the 0.5° floor and the 2× multiplier. Floor
      may need to drop for very steady patients; multiplier may need to
      rise for highly variable ones.
- [ ] **Re-do hold UX.** Right now if Learn hold #2 is bad (patient
      coughed, phone slipped), the patient cannot redo it without aborting
      the whole session. Add a `Redo` button after each Learn hold's
      release, before it's accepted into the running average.
- [ ] **Drift-recovery vs. release detection.** The auto-release path is
      "rolling SD > 3× threshold for 1.5 s." After a brief drift the
      patient often re-stabilises and would like the hold to continue.
      Consider raising the SD multiplier or only ending when the pitch
      also returned near baseline.
- [ ] **Inhale-completion auto-advance.** Today the patient taps Start,
      then inhales, then waits for the lock to fire. Could auto-detect
      the inhale peak (rotation-rate sign change) and skip the wait.

## Near-term — UX

- [ ] **Per-hold "Redo" in Practice.** Same as Learn — patient should be
      able to discard a bad practice attempt without it counting against
      reproducibility.
- [ ] **Visual breath-cycle hint during Calibration.** Today the orb
      stays at rest pose. Animating it gently with a fixed inhale/exhale
      rhythm would give patients confidence that the sensor is live.
- [ ] **Progress dots / numeric readout for Learn holds.** The session
      currently shows "Hold N of 3" but no visual record of which holds
      are in the bag. Three dots that fill as each hold succeeds.
- [ ] **Settings persistence.** Hold target, holds-per-session, voice and
      haptic toggles reset every page load. Save to `localStorage`.
- [ ] **iOS install-as-PWA banner.** Add `manifest.json` and an Apple
      add-to-Home-Screen instruction so patients launch from a real icon
      and get full-screen behaviour.

## Mid-term — clinical fidelity

- [ ] **Cross-session anchor (the long-promised feature).** Persist the
      Learn-phase target to `localStorage` keyed by patient. On the next
      session, after Learn finishes, show "Today's target: X°. Your
      7-day average: Y°. Drift: Z°." Useful for the clinician's
      day-over-day review.
- [ ] **Per-hold trace export.** A "Download today's session" button on
      the Complete screen that emits a JSON identical to the lab v2
      schema — so a clinician (or this project's analyzer) can review
      any session offline.
- [ ] **Clinician dashboard.** Once we have enough patients, a private
      web view that lists a patient's sessions, plateau stability, and
      cross-session drift. Probably a separate small app over Supabase.
- [ ] **Vranich coaching audio.** Replace the Rachel-voice clips with
      Belisa Vranich's actual recordings. File names already align —
      drop them into `public/audio/` and redeploy.
- [ ] **Baseline placement check via the position meter.** After Learn
      sets the target, verify the next day's calibration baseline is
      within a few degrees of yesterday's — if not, prompt the patient
      to re-position the phone before redoing Learn.

## Mid-term — research / collaboration

- [ ] **MDACC IRB pilot protocol.** Single-arm feasibility,
      30 – 50 left-breast DIBH patients. Endpoints: home-vs-clinic
      plateau reproducibility CV, sim-day breath-hold time, treatment-day
      setup time, patient-reported preparedness. See `paper/main.tex` for
      the rationale.
- [ ] **Outreach to Capaldi (UCSF).** Bring a working prototype. Frame
      Tide as the at-home companion to their in-room iSGRT — distinct IP
      surface (their pending SAVB patent emphasises in-vault
      audio-visual biofeedback). Propose a joint validation study on a
      small cohort.
- [ ] **Outreach to Vranich.** Recordings request + co-author
      conversation. Her TEDx + clinical-psychology background gives the
      coaching content authority.

## Long-term — hardening

- [ ] **Native iOS port (Swift + CoreMotion).** Same algorithms, higher
      sample rate, HealthKit storage, push reminders, calendar
      integration with sim/treatment dates. Probably worth doing only if
      a sponsor wants iOS-only or we hit a sample-rate ceiling that
      browser cannot meet.
- [ ] **Android native port.** Lower priority — older breast-cancer
      cohorts skew iOS in the U.S. — but deserves consideration for a
      global rollout.
- [ ] **Regulatory pathway**, if and only if we want clinical
      decision-support claims. Today's wellness framing keeps us under
      FDA enforcement discretion. Crossing into "the device tells you
      whether your hold is acceptable for treatment" would require
      510(k), and a predicate (likely RPM or AlignRT once iSGRT clears).

## Investigations / open questions

- [ ] Does the "lever-on-sternum" placement work for very thin or very
      large chests? Two recordings to date — both adult male, average
      build. Need a wider sample.
- [ ] How quickly does the breathing-baseline SD change between
      sessions? If it's stable, we could cache it and skip the 12 s
      calibration for return users.
- [ ] What happens with deep-breathers vs. shallow-breathers? The
      adaptive threshold scales with breathing SD, but the orb's fixed
      12° peak reference may saturate too easily for deep-breathers.
- [ ] Confirm haptics on Android. iOS Safari blocks `navigator.vibrate`
      so the lock/drift buzz only lands for Android users. Need to test.
- [ ] Wake Lock acquisition robustness under iOS low-power mode.

## Tooling debts

- [ ] **Lab page event-timeline visualiser** so we can scrub through a
      recording and see what the algorithm would have fired at each
      sample, without re-running through prod.
- [ ] **Headless replay mode** for the algorithm so we can run a recipe
      of historical recordings and assert that none of them break with
      a parameter tweak.
- [ ] **Audio diff tool** — when we change a phrase, only regen the
      changed clips, not all 26.
