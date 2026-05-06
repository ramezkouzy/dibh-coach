#!/usr/bin/env python3
"""Analyzer for dibh lab recordings — handles v1 (just pitch) and v2 (full sensors).

v2 schema:
    samples: [[t, alpha, beta, gamma, ax, ay, az, agx, agy, agz, rrA, rrB, rrG], ...]
    channels: [...names matching the array order]

Usage:  python3 analyze.py <recording.json>
"""

import json
import math
import sys
from pathlib import Path


def load(path):
    rec = json.loads(Path(path).read_text())
    if rec.get("schema") == "dibh-lab/v2":
        # Convert array-of-arrays into list of named dicts for the rest of the
        # code's convenience.
        names = rec["channels"]
        samples = []
        for row in rec["samples"]:
            samples.append({names[i]: row[i] for i in range(len(names))})
        rec["_samples"] = samples
        return rec, samples, "v2"
    # v1 — just t,p
    samples = rec["samples"]  # already [{t, p}]
    # Promote p -> beta so the rest of the code is uniform.
    for s in samples:
        s["beta"] = s["p"]
    return rec, samples, "v1"


def channel_stats(samples, key, t_start=None, t_end=None):
    vals = []
    for s in samples:
        if t_start is not None and s["t"] < t_start:
            continue
        if t_end is not None and s["t"] > t_end:
            continue
        v = s.get(key)
        if v is not None:
            vals.append(v)
    if not vals:
        return None
    mean = sum(vals) / len(vals)
    var = sum((v - mean) ** 2 for v in vals) / len(vals)
    return {
        "n": len(vals),
        "min": min(vals),
        "max": max(vals),
        "span": max(vals) - min(vals),
        "mean": mean,
        "sd": math.sqrt(var),
    }


def rolling_sd(samples, key, window_ms):
    out = []
    cur = []
    sum_v = 0.0
    sum_vv = 0.0
    n = 0
    for s in samples:
        v = s.get(key)
        if v is None:
            out.append((s["t"], None))
            continue
        cur.append((s["t"], v))
        sum_v += v
        sum_vv += v * v
        n += 1
        cutoff = s["t"] - window_ms
        while cur and cur[0][0] < cutoff:
            old = cur.pop(0)
            sum_v -= old[1]
            sum_vv -= old[1] ** 2
            n -= 1
        if n >= 4:
            mean = sum_v / n
            var = max(0.0, sum_vv / n - mean * mean)
            out.append((s["t"], math.sqrt(var)))
        else:
            out.append((s["t"], None))
    return out


def ascii_trace(samples, key, width=80, height=10, t_start=None, t_end=None, label=""):
    if t_start is None:
        t_start = samples[0]["t"]
    if t_end is None:
        t_end = samples[-1]["t"]
    sl = [s for s in samples if t_start <= s["t"] <= t_end and s.get(key) is not None]
    if not sl:
        return f"({label} · no data)"
    ps = [s[key] for s in sl]
    p_min, p_max = min(ps), max(ps)
    if p_max - p_min < 1e-6:
        p_max = p_min + 1
    grid = [[" "] * width for _ in range(height)]
    for s in sl:
        x = int((s["t"] - t_start) / max(1, t_end - t_start) * (width - 1))
        y = int((p_max - s[key]) / (p_max - p_min) * (height - 1))
        if 0 <= x < width and 0 <= y < height:
            grid[y][x] = "·"
    lines = []
    if label:
        lines.append(f"  {label}  ({p_min:.2f} … {p_max:.2f}):")
    for i, row in enumerate(grid):
        prefix = ""
        if i == 0:
            prefix = f"{p_max:7.2f}"
        elif i == height - 1:
            prefix = f"{p_min:7.2f}"
        else:
            prefix = "       "
        lines.append(f"  {prefix} │" + "".join(row))
    return "\n".join(lines)


def percentile(xs, p):
    if not xs:
        return None
    s = sorted(xs)
    return s[int(round((len(s) - 1) * p))]


def main():
    if len(sys.argv) < 2:
        print("usage: analyze.py <recording.json>")
        sys.exit(1)
    path = Path(sys.argv[1])
    rec, samples, schema = load(path)
    print(f"File: {path.name}")
    print(f"Schema: {schema}")
    print(f"Scenario: {rec['scenario']}  ({rec.get('durationSec', '?')}s, {len(samples)} samples)")
    if rec.get("note"):
        print(f"Note: {rec['note']}")
    if rec.get("ua"):
        ua = rec["ua"][:80]
        print(f"UA: {ua}…")
    print()

    # Sample rate
    if len(samples) > 1:
        rate = len(samples) / max(0.001, rec.get("durationSec", samples[-1]["t"] / 1000))
        print(f"Effective sample rate: {rate:.1f} Hz")
    print()

    # Events
    events = rec.get("events", [])
    print(f"Events ({len(events)}):")
    for e in events:
        meta = f"  {e['meta']}" if e.get("meta") is not None else ""
        print(f"  +{e['t']/1000:6.2f}s  {e['type']}{meta}")
    print()

    # Channel stats — overall
    if schema == "v2":
        keys = [
            "beta", "alpha", "gamma",
            "ax", "ay", "az",
            "agx", "agy", "agz",
            "rrAlpha", "rrBeta", "rrGamma",
        ]
    else:
        keys = ["beta"]
    print("Per-channel stats (full recording):")
    print(f"  {'channel':<10}{'n':>6}{'min':>10}{'max':>10}{'span':>10}{'mean':>10}{'sd':>10}")
    for k in keys:
        s = channel_stats(samples, k)
        if not s:
            continue
        print(
            f"  {k:<10}{s['n']:>6}{s['min']:>10.3f}{s['max']:>10.3f}"
            f"{s['span']:>10.3f}{s['mean']:>10.3f}{s['sd']:>10.4f}"
        )
    print()

    # Phase-segmented analysis if guided protocol events are present
    phases = phase_windows(events, samples)
    for name, t0, t1 in phases:
        dur = (t1 - t0) / 1000
        print(f"── Phase: {name}  ({t0/1000:.1f}–{t1/1000:.1f}s · {dur:.1f}s) ──")
        print(f"  channel    span    sd   |  rolling SD over 2s: med   p75   max")
        for k in keys:
            s = channel_stats(samples, k, t0, t1)
            if not s:
                continue
            sds = [v for (t, v) in rolling_sd(samples, k, 2000) if t0 <= t <= t1 and v is not None]
            if sds:
                med = percentile(sds, 0.5)
                p75 = percentile(sds, 0.75)
                mx = max(sds)
                print(
                    f"  {k:<10}{s['span']:>6.2f}{s['sd']:>7.3f}    |"
                    f"  {med:>7.3f}{p75:>7.3f}{mx:>7.3f}"
                )
            else:
                print(f"  {k:<10}{s['span']:>6.2f}{s['sd']:>7.3f}    |  (no rolling data)")
        # Trace (β only — most familiar)
        print()
        print(ascii_trace(samples, "beta", width=80, height=6, t_start=t0, t_end=t1, label="beta"))
        # rrBeta during phase — rotation rate around X = direct breath signal
        if schema == "v2":
            print()
            print(
                ascii_trace(
                    samples,
                    "rrBeta",
                    width=80,
                    height=6,
                    t_start=t0,
                    t_end=t1,
                    label="rotation rate β (deg/s)",
                )
            )
        print()


def phase_windows(events, samples):
    """Build (name, t0, t1) windows from guided-protocol marks; fall back to
    free-form hold-start/release pairs otherwise.
    """
    out = []
    by_type = {e["type"]: e["t"] for e in events}
    if "baseline_start" in by_type and "baseline_end" in by_type:
        out.append(("baseline", by_type["baseline_start"], by_type["baseline_end"]))
    if "inhale_start" in by_type and "hold_start" in by_type:
        out.append(("inhale", by_type["inhale_start"], by_type["hold_start"]))
    if "hold_start" in by_type and "release" in by_type:
        out.append(("hold", by_type["hold_start"], by_type["release"]))
    if "release" in by_type and "session_end" in by_type:
        out.append(("recovery", by_type["release"], by_type["session_end"]))
    if out:
        return out
    # Fallback for free-form
    cur = None
    for e in events:
        if e["type"] == "hold-start":
            cur = e["t"]
        elif e["type"] == "release" and cur is not None:
            out.append((f"hold-{len(out)+1}", cur, e["t"]))
            cur = None
    if not out and samples:
        out.append(("full", samples[0]["t"], samples[-1]["t"]))
    return out


if __name__ == "__main__":
    main()
