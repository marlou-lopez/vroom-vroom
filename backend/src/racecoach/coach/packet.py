"""Fact packets for the coach (packet set v3 of the local-LLM spike, vroom-9ki.17 / vroom-aks).

`build_packet` loads the laps, picks the corners and computes every fact in code; it raises
`CoachError` before any model is called. Keys are plain English and a pair reads "110 km/h
against 112" (this lap against the reference; Average: the slowest lap against the fastest), so
the model never subtracts. Each corner lists the numbers its finding may use
(`allowed_numbers`), which the number guard checks against. Positions are never metres: they
are landmark phrases, an offset from the apex ("just after the apex") or an own-lap cue.
"""

from __future__ import annotations

from bisect import bisect_right
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Any

import yaml

from racecoach.analysis.aids import CornerAids, corner_aids, rev_limit
from racecoach.analysis.balance import LapBalance, compare_balance
from racecoach.analysis.consistency import (
    LapPair,
    NotEnoughLaps,
    NoValidLaps,
    corner_spreads,
    corner_time,
    session_consistency,
    timed_laps,
)
from racecoach.analysis.delta import delta_time
from racecoach.analysis.facts import CornerFacts, corner_facts, lap_facts
from racecoach.analysis.landmarks import own_lap_cue, usable_landmarks
from racecoach.analysis.metrics import SideMetrics
from racecoach.api.views import IDEAL_PREFIX, stitch_ideal
from racecoach.coach.errors import CoachError
from racecoach.coach.guard import allowed_numbers
from racecoach.coach.schema import Command, FindingKind
from racecoach.model import LapKind, LapMeta, LapTrace, SessionMeta
from racecoach.store import AppStore
from racecoach.tracks import Corner, Landmark, TrackMap, map_for

ISSUE_MIN_S = 0.05
MINOR_MIN_S = 0.01
MAX_LOSING = 5
MAX_ISSUES = 3
MAX_INCONSISTENT = 3
TRACE_STEP_M = 10
UNDERSTEER_MIN_DEG_S = 5.0
UNDERSTEER_MARGIN_DEG_S = 3.0
DEFAULT_PROFILE = {"driver": "sim racer", "focus_areas": []}


@dataclass(frozen=True)
class PacketCorner:
    corner_id: str
    name: str
    kind: FindingKind
    time_s: float  # delta_s (sd_s for inconsistent), 3 decimals


@dataclass
class Packet:
    command: Command
    lap_id: str
    ref_lap_id: str | None
    session_id: str
    track_id: str
    car_id: str
    data: dict[str, Any]  # what the model reads
    corners: list[PacketCorner]
    stats: dict[str, str]
    header_numbers: list[str] = field(default_factory=list)
    focus_baselines: dict[str, float] = field(default_factory=dict)

    @property
    def guard_view(self) -> dict[str, Any]:
        return {
            "corners": self.data["corners"],
            "car": self.data["car"],
            "header_numbers": self.header_numbers,
        }


# --- formatting -------------------------------------------------------------------------------


def f0(x: float) -> str:
    return f"{round(x):d}"


def f1(x: float) -> str:
    return f"{x:.1f}"


def f3(x: float) -> str:
    return f"{x:.3f}"


def pct(x: float) -> str:
    return f"{round(x * 100):d}%"


def lap_time_text(s: float) -> str:
    return f"{int(s // 60)}:{s % 60:06.3f}"


def offset_phrase(d: float, length: float | None = None) -> str:
    """ "at", "just after", "a little before", "well after": a qualitative offset, never metres."""
    if length:  # the lap is a loop: the short way round the start line
        d = (d + length / 2) % length - length / 2
    a = abs(d)
    if a <= 8:
        return "at"
    way = "after" if d > 0 else "before"
    if a <= 25:
        return f"just {way}"
    return f"a little {way}" if a <= 60 else f"well {way}"


def against(a: str | None, b: str | None, unit: str = "") -> str:
    left = "n/a" if a is None else f"{a}{unit}"
    return f"{left} against {'n/a' if b is None else b}"


# --- one corner, one side ---------------------------------------------------------------------


def _where(pos: int | None, corner: Corner, cue: str | None, length: float) -> str | None:
    if pos is None:
        return None
    return cue or f"{offset_phrase(pos - corner.apex_m, length)} the apex"


def _spot(m: int | None, corner: Corner, tmap: TrackMap, anchors: list[Landmark]) -> str:
    if m is None:
        return "none"
    from racecoach.analysis.landmarks import describe_position

    return (
        describe_position(m, anchors, tmap.length_m)
        or f"{offset_phrase(m - corner.apex_m, tmap.length_m)} the apex"
    )


def _side(
    s: SideMetrics, aids: CornerAids, corner: Corner, brake_cue: str | None,
    throttle_cue: str | None, tmap: TrackMap, anchors: list[Landmark],
) -> dict[str, str | None]:  # fmt: skip
    length = tmap.length_m
    gap = (s.min_speed_m - corner.apex_m + length / 2) % length - length / 2
    near = abs(gap) <= 100
    return {
        "minimum speed": f0(s.min_speed_kmh),
        "where the minimum speed is": (
            f"{offset_phrase(gap)} the apex" if near else None
        ),
        "exit speed": f0(s.exit_speed_kmh),
        "braking starts": _where(s.brake_onset_m, corner, brake_cue, length),
        "peak brake pressure": pct(s.peak_brake),
        "throttle pickup": _where(s.throttle_pickup_m, corner, throttle_cue, length),
        "time coasting": f1(s.coast_s),
        "brake and throttle together": f1(s.overlap_s),
        "steering turning points": str(s.steer_corrections),
        "ABS working": f1(aids.abs_s),
        "traction control working": f1(aids.tc_s),
        "wheel lock-up": _spot(aids.lockup_m, corner, tmap, anchors),
        "wheelspin": _spot(aids.wheelspin_m, corner, tmap, anchors),
        "on the rev limiter": None if aids.limiter_s is None else f1(aids.limiter_s),
        "peak rpm": str(aids.peak_rpm),
        "gear at the slowest point": (
            None if aids.gear_at_min_speed is None else str(aids.gear_at_min_speed)
        ),
        "on a kerb": f1(aids.kerb_s),
    }  # fmt: skip


UNITS = {
    "minimum speed": " km/h", "exit speed": " km/h", "time coasting": " s",
    "brake and throttle together": " s", "ABS working": " s", "traction control working": " s",
    "on the rev limiter": " s", "on a kerb": " s",
}  # fmt: skip


def pair_sides(a: dict[str, str | None], b: dict[str, str | None]) -> dict[str, str]:
    return {k: against(a[k], b[k], UNITS.get(k, "")) for k in a}


def understeer_pair(lap: SideMetrics, ref: SideMetrics) -> dict[str, str]:
    """ "More steering than the car used" (peak deg/s), only when the lap's peak is at least
    5 deg/s and 3 deg/s above the reference's. Understeer only, never oversteer."""
    peak = lap.understeer_peak_deg_s
    if peak is None or peak < UNDERSTEER_MIN_DEG_S:
        return {}
    ref_peak = ref.understeer_peak_deg_s or 0.0
    if peak - ref_peak < UNDERSTEER_MARGIN_DEG_S:
        return {}
    return {
        "more steering than the car used (peak, degrees a second)": against(f1(peak), f1(ref_peak))
    }


def cause_of(lap: SideMetrics, ref: SideMetrics) -> tuple[str, str, str]:
    """(cause, confidence, basis): the scoring of the frontend's `causeOf`, plus a confidence
    from the top score's lead (< 1 low, >= 2 with the runner-up < 1 high, else medium)."""
    scores: list[tuple[str, float]] = [
        (
            "brake",
            abs(lap.brake_onset_m - ref.brake_onset_m) / 15
            if lap.brake_onset_m is not None and ref.brake_onset_m is not None else 0.0,
        ),
        (
            "throttle",
            (lap.throttle_pickup_m - ref.throttle_pickup_m) / 15
            if lap.throttle_pickup_m is not None and ref.throttle_pickup_m is not None else 0.0,
        ),
        ("steering", (lap.steer_corrections - ref.steer_corrections) / 2),
        ("speed", (ref.min_speed_kmh - lap.min_speed_kmh) / 3),
    ]  # fmt: skip
    best = ("speed", 0.0)
    for name, score in scores:
        if score >= 1 and score > best[1]:
            best = (name, score)
    ranked = sorted(scores, key=lambda s: s[1], reverse=True)
    top, second = ranked[0][1], ranked[1][1]
    confidence = "low" if top < 1 else "high" if top >= 2 and second < 1 else "medium"
    basis = {
        "brake": "the braking point differs from the reference",
        "throttle": "the throttle pickup comes later than on the reference",
        "steering": "more steering corrections than the reference",
        "speed": "a lower minimum speed than the reference",
    }[best[0]]
    return best[0], confidence, ("no single input stands out" if top < 1 else basis)


ROLES = {
    "brake_board": "braking reference", "kerb_entry": "turn-in", "kerb_apex": "apex",
    "kerb_exit": "exit", "custom": "reference",
}  # fmt: skip


def landmark_roles(corner: Corner, anchors: list[Landmark], length: float) -> list[str]:
    out: list[str] = []
    for a in anchors:
        gap = (a.distance_m - corner.apex_m + length / 2) % length - length / 2
        side = "before the apex" if gap < -8 else "after the apex" if gap > 8 else "at the apex"
        text = f"{a.label} ({ROLES[a.kind]}, {side})"
        if text not in out:
            out.append(text)
    return out


# --- corner dicts -------------------------------------------------------------------------------


@dataclass
class Ctx:
    tmap: TrackMap
    lap: LapTrace
    ref: LapTrace
    limit: float | None
    joins: list[int] = field(default_factory=list)  # ideal reference: segment boundaries


def _across_join(cf: CornerFacts, corner: Corner, joins: list[int]) -> tuple[CornerFacts, bool]:
    """On an ideal reference, a braking or throttle point that lies in another segment than the
    apex comes from a different lap than the corner's own run. Drop those points (and the cues
    built on them) so no fact reads across a join. Returns the facts and whether any was dropped."""

    def crossed(pos: int | None) -> bool:
        return pos is not None and bisect_right(joins, pos) != bisect_right(joins, corner.apex_m)

    drop_brake, drop_throttle = crossed(cf.ref.brake_onset_m), crossed(cf.ref.throttle_pickup_m)
    if not (drop_brake or drop_throttle):
        return cf, False
    ref = cf.ref
    if drop_brake:
        ref = replace(ref, brake_onset_m=None)
    if drop_throttle:
        ref = replace(ref, throttle_pickup_m=None)
    cues = replace(
        cf.cues,
        brake_ref=None if drop_brake else cf.cues.brake_ref,
        throttle_ref=None if drop_throttle else cf.cues.throttle_ref,
    )
    return replace(cf, ref=ref, cues=cues), True


def _corner_dict(
    cf: CornerFacts, corner: Corner, kind: FindingKind, ctx: Ctx, time_s: float
) -> dict[str, Any]:
    cf, joined = _across_join(cf, corner, ctx.joins) if ctx.joins else (cf, False)
    anchors = usable_landmarks([lm for lm in ctx.tmap.landmarks if lm.corner_id == corner.id])
    la = corner_aids(ctx.lap, corner, ctx.limit)
    ra = corner_aids(ctx.ref, corner, ctx.limit)
    lap_side = _side(cf.lap, la, corner, cf.cues.brake_lap, cf.cues.throttle_lap, ctx.tmap, anchors)
    ref_side = _side(cf.ref, ra, corner, cf.cues.brake_ref, cf.cues.throttle_ref, ctx.tmap, anchors)
    cause, confidence, basis = cause_of(cf.lap, cf.ref)
    pairs = pair_sides(lap_side, ref_side) | understeer_pair(cf.lap, cf.ref)
    out = {
        "corner_id": corner.id,
        "corner": corner.name,
        "kind": kind,
        "time_s": f3(time_s),
        "likely cause": cause,
        "how sure the cause is": confidence,
        "why that cause": basis,
        "where in the corner the time goes": (
            f"entry {f3(cf.phases.entry_s)} s, middle {f3(cf.phases.mid_s)} s, "
            f"exit {f3(cf.phases.exit_s)} s"
        ),
        "this lap against the reference": pairs,
        "landmarks": landmark_roles(corner, anchors, ctx.tmap.length_m),
    }
    if joined:
        out["note on the reference"] = (
            "the reference is stitched from several laps and its braking or throttle point here "
            "falls on a stretch from another lap, so it is left out (n/a): do not compare it"
        )
    return out


def _trace_rows(lap: LapTrace, corner: Corner) -> list[list[str]]:
    n = len(lap.ch["t"])
    start, end = round(corner.start_m), round(corner.end_m)
    idx = (
        list(range(start, end + 1, TRACE_STEP_M))
        if start <= end
        else (list(range(start, n, TRACE_STEP_M)) + list(range(0, end + 1, TRACE_STEP_M)))
    )
    ch = lap.ch
    on = lambda name, i: "on" if name in ch and ch[name][i] > 0 else "off"  # noqa: E731
    val = lambda name, i: float(ch[name][i]) if name in ch else 0.0  # noqa: E731
    return [
        [
            f0(float(ch["speed_kmh"][i])),
            pct(float(ch["throttle"][i])),
            pct(float(ch["brake"][i])),
            f0(val("steering", i) * 100),
            str(int(val("gear", i))),
            f0(val("rpm", i)),
            on("abs", i), on("tc", i), on("kerb", i),
        ]
        for i in idx
        if 0 <= i < n
    ]  # fmt: skip


TRACE_COLUMNS = [
    "speed (km/h)",
    "throttle",
    "brake",
    "steering (% of lock)",
    "gear",
    "rpm",
    "ABS",
    "traction control",
    "on a kerb",
]


# --- loading ------------------------------------------------------------------------------------

_NOTES = {
    "pairs": "a value written 'x against y' is this lap against the reference "
    "(Average: the slowest "
    "lap against the fastest); quote it as it is, never subtract",
    "aids": "ABS working / traction control working: seconds the system was working in the corner. "
    "wheel lock-up / wheelspin: where it happened, or none",
    "engine": "on the rev limiter: seconds within 1.5% of the highest rpm seen. gear at the "
    "slowest point: the gear at the slowest point",
    "cause": "the likely cause and how sure it is are computed in code; state a high or medium "
    "cause as fact",
    "numbers": "each corner's allowed_numbers lists the only numbers its finding may use",
}


_IDEAL_NOTE = (
    "the reference is the ideal lap: the best stretch of each corner and straight from this "
    "session's valid laps joined together, not one lap anyone drove. Never say the driver drove "
    "it or name a lap number for it"
)


def load_profile(path: Path | str | None) -> dict[str, Any]:
    if path is None or not Path(path).is_file():
        return dict(DEFAULT_PROFILE)
    return {**DEFAULT_PROFILE, **(yaml.safe_load(Path(path).read_text()) or {})}


def _session(store: AppStore, session_id: str) -> SessionMeta:
    for s in store.sessions():
        if s.session_id == session_id:
            return s
    raise CoachError("unknown_lap", f"Session {session_id} is not in the store.")


def _load(store: AppStore, lap_id: str) -> tuple[LapMeta, LapTrace]:
    meta = store.lap(lap_id)
    if meta is None:
        raise CoachError("unknown_lap", f"Lap {lap_id} is not in the store.")
    try:
        return meta, store.read_trace(lap_id)
    except KeyError:
        raise CoachError("no_trace", f"Lap {lap_id} has no trace to coach from.") from None


def _balances(
    store: AppStore, lap: tuple[LapMeta, LapTrace], ref: tuple[LapMeta, LapTrace]
) -> tuple[LapBalance | None, LapBalance | None]:
    ls, rs = _session(store, lap[0].session_id), _session(store, ref[0].session_id)
    return compare_balance(
        lap[1], ref[1], ls.steering_range_deg, rs.steering_range_deg, ls.car_id == rs.car_id
    )


def _header(
    command: Command, session: SessionMeta, lap: LapMeta, ref: LapMeta | None,
    profile: dict[str, Any],
) -> dict[str, Any]:  # fmt: skip
    ideal = ref is not None and ref.lap_id.startswith(IDEAL_PREFIX)
    return {
        "command": command,
        "track": session.track_name,
        "car": session.car_name,
        "session": f"{session.session_type.lower()}, {session.started_at:%-d %b %Y}",
        "lap": f"lap {lap.lap_no}, {lap_time_text(lap.lap_time_s or 0.0)}",
        "reference": (
            None if ref is None
            else f"the ideal lap of this session (stitched), {lap_time_text(ref.lap_time_s or 0.0)}"
            if ideal
            else f"lap {ref.lap_no}, {lap_time_text(ref.lap_time_s or 0.0)}"
        ),
        "profile": profile,
    }  # fmt: skip


def select_analyze(
    ordered: list[CornerFacts], complexes: dict[str, str | None]
) -> list[tuple[CornerFacts, FindingKind]]:
    """Top losses, one per complex: up to 3 issues (>= 0.05 s), 1 minor (>= 0.01 s) and the
    best gain as a strength (<= -0.01 s). Issues first, then the minor, then the strength."""
    seen: set[str] = set()
    unique: list[CornerFacts] = []
    for f in ordered:
        key = complexes.get(f.corner_id) or f.corner_id
        if key not in seen:
            seen.add(key)
            unique.append(f)
    losing = unique[:MAX_LOSING]
    issues = [f for f in losing if f.delta_s >= ISSUE_MIN_S][:MAX_ISSUES]
    minor = next((f for f in losing if f not in issues and f.delta_s >= MINOR_MIN_S), None)
    gain = unique[-1] if unique else None
    strength = (
        gain if gain is not None and gain.delta_s <= -MINOR_MIN_S and gain not in issues else None
    )
    chosen: list[tuple[CornerFacts, FindingKind]] = [(f, "issue") for f in issues]
    if minor is not None:
        chosen.append((minor, "minor"))
    if strength is not None and strength is not minor:
        chosen.append((strength, "strength"))
    return chosen


def _baseline(laps: list[LapPair], tmap: TrackMap, corner: Corner, lap: LapTrace) -> float:
    pool = timed_laps(laps)
    if len(pool) >= 2:
        spread = next(
            s for s in corner_spreads([t for _, t in pool], tmap) if s.corner_id == corner.id
        )
        return spread.mean_s
    return round(corner_time(lap, corner), 3)


def _session_laps(store: AppStore, session_id: str) -> list[LapPair]:
    out: list[LapPair] = []
    for meta in store.laps(session_id):
        try:
            out.append((meta, store.read_trace(meta.lap_id)))
        except KeyError:
            continue
    return out


def _ideal_reference(
    store: AppStore, lap: tuple[LapMeta, LapTrace], session: SessionMeta, tracks_dir: Path | str
) -> tuple[tuple[LapMeta, LapTrace, TrackMap], list[int]]:
    """The session's ideal lap as a reference: (meta, stitched trace, track map) and the joins.
    Raises NoValidLaps when the session has no valid timed lap."""
    laps = _session_laps(store, session.session_id)
    pool = timed_laps(laps)
    if not pool:
        raise NoValidLaps("There is no valid timed lap to build an ideal lap from.")
    best = min(pool, key=lambda p: p[0].lap_time_s or 0.0)
    tmap = map_for(tracks_dir, session.track_id, best[1])
    trace, joins, time_s = stitch_ideal(laps, tmap, lap)
    meta = replace(
        lap[0], lap_id=trace.lap_id, kind=LapKind.FLYING, lap_time_s=time_s,
        pinned_reference=False,
    )  # fmt: skip
    return (meta, trace, tmap), joins


def build_packet(
    store: AppStore,
    command: Command,
    lap_id: str,
    ref_lap_id: str | None = None,
    corner_id: str | None = None,
    *,
    tracks_dir: Path | str,
    profile: dict[str, Any] | None = None,
) -> Packet:
    """Everything the coach is told, or a `CoachError` (no LLM has been called yet)."""
    profile = profile or dict(DEFAULT_PROFILE)
    lap = _load(store, lap_id)
    session = _session(store, lap[0].session_id)
    if command == "average":
        return _average(store, lap, session, tracks_dir, profile)

    joins: list[int] = []
    ideal_ref: tuple[LapMeta, LapTrace, TrackMap] | None = None
    if ref_lap_id is not None and ref_lap_id.startswith(IDEAL_PREFIX):
        if ref_lap_id != f"{IDEAL_PREFIX}{session.session_id}":
            raise CoachError(
                "unknown_lap", f"The ideal lap {ref_lap_id} is not this lap's session's."
            )
        ideal_ref, joins = _ideal_reference(store, lap, session, tracks_dir)
        ref_meta = ideal_ref[0]
    elif ref_lap_id is None:
        ref_meta = store.reference_for(session.track_id, session.car_id)
        if ref_meta is None:
            raise CoachError("no_reference", "There is no valid flying lap to compare against yet.")
    else:
        ref_meta = store.lap(ref_lap_id)
        if ref_meta is None or ref_meta.track_id != session.track_id:
            raise CoachError(
                "unknown_lap", f"Reference lap {ref_lap_id} is not a lap on this track."
            )
    if ref_meta.lap_id == lap_id:
        raise CoachError(
            "no_reference", "This lap is the reference: pick another lap to compare it with."
        )
    if ideal_ref is not None:
        ref, tmap = (ideal_ref[0], ideal_ref[1]), ideal_ref[2]
    else:
        ref = _load(store, ref_meta.lap_id)
        tmap = map_for(tracks_dir, session.track_id, ref[1])
    if corner_id is not None and all(c.id != corner_id for c in tmap.corners):
        raise CoachError("unknown_corner", f"Corner {corner_id} is not on the track map.")
    if command == "corner" and corner_id is None:
        raise CoachError("unknown_corner", "The corner command needs a corner.")

    bal_lap, bal_ref = _balances(store, lap, ref)
    facts = lap_facts(tmap, lap[1], ref[1], bal_lap, bal_ref)
    ctx = Ctx(tmap, lap[1], ref[1], rev_limit(lap[1], ref[1]), joins)
    corners_by_id = {c.id: c for c in tmap.corners}
    header = _header(command, session, lap[0], ref[0], profile)
    total = facts.total_delta_s
    stats = {
        "Lap": lap_time_text(lap[0].lap_time_s or 0.0),
        "Reference": lap_time_text(ref[0].lap_time_s or 0.0),
        "Delta": f"{total:+.3f} s",
    }
    base: dict[str, Any] = {
        **header, "notes": {**_NOTES, "ideal": _IDEAL_NOTE} if ideal_ref else _NOTES
    }

    if command == "analyze":
        chosen = select_analyze(facts.corners, {c.id: c.complex for c in tmap.corners})
        if not chosen:
            raise CoachError("nothing_to_coach", "This lap is level with the reference everywhere.")
        dicts = [
            _corner_dict(cf, corners_by_id[cf.corner_id], k, ctx, cf.delta_s) for cf, k in chosen
        ]
        for d in dicts:
            d["allowed_numbers"] = allowed_numbers(d)
        data = {
            **base,
            "lap_delta": f"{total:+.3f}",
            "rules": "Write one finding per corner below, keeping its kind and time_s. "
            "focus is the first issue's corner.",
            "corners": dicts,
        }
        baselines: dict[str, float] = {}
        first = next((cf for cf, k in chosen if k == "issue"), None)
        if first is not None:
            baselines[first.corner_id] = _baseline(
                _session_laps(store, session.session_id),
                tmap,
                corners_by_id[first.corner_id],
                lap[1],
            )
        pcs = [PacketCorner(cf.corner_id, cf.name, k, round(cf.delta_s, 3)) for cf, k in chosen]
        head = allowed_numbers({k: data[k] for k in ("lap", "reference", "lap_delta")})
        return Packet(command, lap_id, ref_meta.lap_id, session.session_id, session.track_id,
                      session.car_id, data, pcs, stats, head, baselines)  # fmt: skip

    cf = next(f for f in facts.corners if f.corner_id == corner_id)
    corner = corners_by_id[cf.corner_id]
    kind: FindingKind = (
        "issue"
        if cf.delta_s >= ISSUE_MIN_S
        else "strength"
        if cf.delta_s <= -MINOR_MIN_S
        else "minor"
    )
    d = _corner_dict(cf, corner, kind, ctx, cf.delta_s)
    trace = {
        "columns": TRACE_COLUMNS,
        "note": f"one row every {TRACE_STEP_M} m from the corner start to its end; "
        "steering in % of "
        "full lock, -100..100, + = right",
        "lap": _trace_rows(lap[1], corner),
        "reference": _trace_rows(ref[1], corner),
    }
    d["allowed_numbers"] = allowed_numbers({"c": d, "t": trace})
    data = {
        **base,
        "rules": "One finding for this corner, keeping kind and time_s. The trace is for your "
        "reading only: the fix uses no distances.",
        "corners": [d],
        "trace": trace,
    }
    head = allowed_numbers({k: data[k] for k in ("lap", "reference")})
    pcs = [PacketCorner(cf.corner_id, cf.name, kind, round(cf.delta_s, 3))]
    stats = {
        "Corner": cf.name,
        "Delta": f"{cf.delta_s:+.3f} s",
        **{k: v for k, v in stats.items() if k != "Delta"},
    }
    return Packet(command, lap_id, ref_meta.lap_id, session.session_id, session.track_id,
                  session.car_id, data, pcs, stats, head)  # fmt: skip


def _average(
    store: AppStore, lap: tuple[LapMeta, LapTrace], session: SessionMeta,
    tracks_dir: Path | str, profile: dict[str, Any],
) -> Packet:  # fmt: skip
    pool = timed_laps(_session_laps(store, session.session_id))
    if len(pool) < 2:
        raise CoachError(
            "not_enough_laps", "Checking consistency needs at least 2 valid timed laps."
        )
    best = min(pool, key=lambda p: p[0].lap_time_s or 0.0)
    tmap = map_for(tracks_dir, session.track_id, best[1])
    try:
        cons = session_consistency(pool, tmap)
    except NotEnoughLaps as e:  # pragma: no cover - guarded above
        raise CoachError("not_enough_laps", str(e)) from e
    by_id = {c.id: c for c in tmap.corners}
    limit = rev_limit(*(t for _, t in pool))
    dicts: list[dict[str, Any]] = []
    pcs: list[PacketCorner] = []
    for sp in [s for s in cons.corners if s.sd_s > 0][:MAX_INCONSISTENT]:
        corner = by_id[sp.corner_id]
        times = {m.lap_id: corner_time(t, corner) for m, t in pool}
        fast = min(pool, key=lambda p: times[p[0].lap_id])
        slow = max(pool, key=lambda p: times[p[0].lap_id])
        bal_slow, bal_fast = _balances(store, slow, fast)
        cf = corner_facts(
            corner, slow[1], fast[1], delta_time(slow[1], fast[1]), tmap.landmarks,
            bal_slow, bal_fast, tmap.length_m,
        )  # fmt: skip
        ctx = Ctx(tmap, slow[1], fast[1], limit)
        d = _corner_dict(cf, corner, "inconsistent", ctx, sp.sd_s)
        side = d.pop("this lap against the reference")
        d.pop("where in the corner the time goes")
        fast_brake = cf.ref.brake_onset_m
        own = None if fast_brake is None else own_lap_cue(fast_brake, [(fast[0].lap_no, fast[1])])
        d = {
            **d,
            "spread of the corner time (sd)": f"{f3(sp.sd_s)} s",
            "fastest against slowest corner time": f"{f3(sp.min_s)} against {f3(sp.max_s)}",
            "laps": str(cons.n_laps),
            "slowest lap against the fastest": {
                "laps": f"lap {slow[0].lap_no} against lap {fast[0].lap_no}",
                "corner time": against(f3(times[slow[0].lap_id]), f3(times[fast[0].lap_id]), " s"),
                **side,
            },
        }
        if own:
            d["your own braking point on the fastest lap"] = own
        d["allowed_numbers"] = allowed_numbers(d)
        dicts.append(d)
        pcs.append(PacketCorner(corner.id, corner.name, "inconsistent", round(sp.sd_s, 3)))
    if not dicts:
        raise CoachError("nothing_to_coach", "Every corner takes the same time on every lap.")
    stats = {
        "Laps": str(cons.n_laps),
        "Mean": lap_time_text(cons.mean_s),
        "Lap sd": f"{f3(cons.sd_s)} s",
        "Best": lap_time_text(cons.best_s),
        "Theoretical best": lap_time_text(cons.theoretical_best_s),
    }
    header = _header("average", session, lap[0], None, profile)
    header["lap"] = f"{cons.n_laps} valid laps: " + ", ".join(
        f"lap {m.lap_no} {lap_time_text(m.lap_time_s or 0.0)}" for m, _ in pool
    )
    header["reference"] = None
    worst = max(m.lap_time_s or 0.0 for m, _ in pool)
    data = {
        **header,
        "notes": {
            **_NOTES,
            "cause": "cause compares the slowest lap with the fastest; state a high or medium "
            "cause as fact",
        },
        "stats": {
            "laps": str(cons.n_laps),
            "mean lap": lap_time_text(cons.mean_s),
            "lap spread (sd)": f"{f3(cons.sd_s)} s",
            "best against worst": f"{lap_time_text(cons.best_s)} against {lap_time_text(worst)}",
        },  # fmt: skip
        "rules": "Write one inconsistent finding per corner below, with time_s = the spread. "
        "No focus.",
        "corners": dicts,
    }
    head = allowed_numbers({k: data[k] for k in ("lap", "stats")})
    return Packet("average", lap[0].lap_id, None, session.session_id, session.track_id,
                  session.car_id, data, pcs, stats, head)  # fmt: skip


__all__ = ["Packet", "PacketCorner", "build_packet", "load_profile"]
