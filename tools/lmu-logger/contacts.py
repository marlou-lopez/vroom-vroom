"""Track-edge contacts from wheel terrain names (used by `decode.py survey`).

Every wheel reports the name of the surface under it at 100 Hz. Where a wheel changes between racing tarmac and
anything else it is on the physical edge of the track (a "tarmac <-> kerb/off" crossing); where it changes between
a kerb and anything that is not tarmac it is on the kerb's outer boundary. A wheel's world position is the car's
`mPos` plus the car's orientation applied to the wheel's offset in vehicle coordinates.

Conventions (from LMU's InternalsPlugin.hpp, checked on a capture: see docs/track-views/edge-survey.md):
  * world is left-handed with +y up; world x/z is the ground plane;
  * vehicle coordinates: +x out of the left side, +y up, +z out of the back (so forward is -z);
  * `mOri[r]` is row r of the matrix that converts vehicle to world: world_r = mOri[r] . local.
Wheel order is FL, FR, RL, RR. Wheel positions are not in shared memory, so they come from offsets.
"""
from __future__ import annotations

import math
from dataclasses import dataclass

TARMAC, KERB, OFF = 0, 1, 2
KIND_EDGE, KIND_KERB_OUTER = "edge", "kerb_outer"

# McLaren 720S GT3 priors (metres). Half-track can only be assumed; the axle offsets are fitted.
DEFAULT_HALF_TRACK = 0.85
DEFAULT_WHEELBASE = 2.70
DEFAULT_FRONT_Z = -DEFAULT_WHEELBASE / 2
DEFAULT_REAR_Z = DEFAULT_WHEELBASE / 2

GRID_M = 0.25            # contacts are deduplicated on this world grid, per kind
PAIR_MAX_S = 1.2         # a rear crossing follows its front crossing within this long
JUMP_M = 4.0             # consecutive 100 Hz samples further apart than this are a teleport, not driving


def classify(name: bytes) -> int | None:
    """Surface class of a terrain name; None for the empty (unknown) name."""
    if not name:
        return None
    if name.startswith(b"RDRACE") or name == b"RDPAINT":
        return TARMAC
    if name.startswith(b"RMBL"):
        return KERB
    return OFF


def crossing_kind(a: int, b: int) -> str | None:
    """What a change from class a to class b marks (None when nothing changed)."""
    if a == b:
        return None
    if TARMAC in (a, b):
        return KIND_EDGE
    return KIND_KERB_OUTER   # kerb <-> off


@dataclass(frozen=True)
class Geometry:
    half_track: float = DEFAULT_HALF_TRACK
    front_z: float = DEFAULT_FRONT_Z    # vehicle z of the front axle (negative: forward)
    rear_z: float = DEFAULT_REAR_Z

    def offset(self, wheel: int) -> tuple[float, float]:
        """(x, z) of a wheel in vehicle coordinates: x is +left."""
        return (self.half_track if wheel % 2 == 0 else -self.half_track,
                self.front_z if wheel < 2 else self.rear_z)


def wheel_world(pos_xz, rows, wheel: int, g: Geometry):
    """World (x, z) of a wheel. `rows` is mOri as three (x, y, z) rows; the wheel sits at height 0 of the vehicle."""
    lx, lz = g.offset(wheel)
    return (pos_xz[0] + rows[0][0] * lx + rows[0][2] * lz,
            pos_xz[1] + rows[2][0] * lx + rows[2][2] * lz)


@dataclass(frozen=True)
class Event:
    """A wheel changed class between two consecutive samples a and b (kept raw so the axle offsets can be fitted after)."""
    car: tuple          # (capture index, telemetry slot)
    t: float            # elapsed time of b
    wheel: int
    kind: str
    trans: tuple        # (class before, class after)
    pos: tuple          # midpoint of the car's x/z over a and b
    ax: tuple           # midpoint of the world x/z direction of vehicle +x
    az: tuple           # ... of vehicle +z

    def at(self, g: Geometry) -> tuple[float, float]:
        lx, lz = g.offset(self.wheel)
        return (self.pos[0] + self.ax[0] * lx + self.az[0] * lz, self.pos[1] + self.ax[1] * lx + self.az[1] * lz)


class ContactTracker:
    """Feed it the telemetry samples of each car in time order; it collects the class-change events."""

    def __init__(self):
        self.state: dict[tuple, tuple] = {}   # car -> (elapsed time, (x, z), axes, classes)
        self.events: list[Event] = []

    def reset(self, car) -> None:
        self.state.pop(car, None)

    def add(self, car, et: float, pos_xz, rows, classes) -> None:
        """One telemetry sample. `rows`: mOri as 3 rows of 3; `classes`: 4 wheel classes (None = unknown)."""
        axes = ((rows[0][0], rows[2][0]), (rows[0][2], rows[2][2]))
        prev = self.state.get(car)
        self.state[car] = (et, pos_xz, axes, classes)
        if prev is None or et <= prev[0] or et - prev[0] > 0.05:
            return
        if math.hypot(pos_xz[0] - prev[1][0], pos_xz[1] - prev[1][1]) > JUMP_M:
            return
        mid = lambda p, q: ((p[0] + q[0]) / 2, (p[1] + q[1]) / 2)
        changed = {}
        for w in range(4):
            a, b = prev[3][w], classes[w]
            if a is None or b is None:
                continue
            kind = crossing_kind(a, b)
            if kind is not None:
                changed[w] = (kind, (a, b))
        # A front and a rear wheel of one side cannot change in the same 10 ms (they are metres apart): that is the car
        # being put somewhere else (pit exit, reset), not a crossing.
        for side in (0, 1):
            if side in changed and side + 2 in changed:
                del changed[side], changed[side + 2]
        for w, (kind, trans) in changed.items():
            a, b = trans
            self.events.append(Event(car, et, w, kind, (a, b), mid(prev[1], pos_xz),
                                     mid(prev[2][0], axes[0]), mid(prev[2][1], axes[1])))


def axle_pairs(events: list[Event]) -> list[tuple[Event, Event]]:
    """(front, rear) edge events of one car, one side and one transition that follow each other: the same edge seen
    by both axles. Anything with another crossing of that side in between is skipped."""
    by: dict[tuple, list[Event]] = {}
    for e in events:
        if e.kind == KIND_EDGE:
            by.setdefault((e.car, e.wheel % 2), []).append(e)
    pairs = []
    for evs in by.values():
        evs.sort(key=lambda e: e.t)
        for f, r in zip(evs, evs[1:]):
            if f.wheel < 2 <= r.wheel and f.trans == r.trans and 0 < r.t - f.t <= PAIR_MAX_S:
                pairs.append((f, r))
    return pairs


def _percentile(sorted_v, p):
    return sorted_v[min(len(sorted_v) - 1, int(len(sorted_v) * p))]


def pair_distances(pairs, g: Geometry) -> list[float]:
    out = []
    for f, r in pairs:
        a, b = f.at(g), r.at(g)
        out.append(math.hypot(a[0] - b[0], a[1] - b[1]))
    return out


INLIER_M = 0.3   # a pair this close counts as "the same crossing seen twice"
GOOD_M = 1.0     # residual statistics are reported over pairs closer than this; the rest are different features


def fit_axles(events: list[Event], base: Geometry, *, step: float = 0.02, span: float = 1.0):
    """Fit the wheelbase from the crossings of the same edge by a front and a rear wheel. Returns (Geometry, info).

    A rear wheel follows the front wheel over the same spot, so for the right wheelbase their crossings coincide. Many
    pairs do not (a shallow crossing smears the rear one along the edge, a kerb has several steps), so the score is the
    number of pairs closer than INLIER_M, not a median. Only the wheelbase (rear_z - front_z) is determined: moving both
    axles together moves both crossings alike, so the axle pair keeps the midpoint of the prior `base` and the
    split between front and rear stays an assumption (it shifts contacts along the car's heading, not across the edge).
    info: pairs, inliers, wheelbase, and the residual (median, p90) over pairs closer than GOOD_M before and after."""
    pairs = axle_pairs(events)
    if len(pairs) < 20:
        return base, {"pairs": len(pairs), "fitted": False}
    mid = (base.front_z + base.rear_z) / 2
    wb0 = base.rear_z - base.front_z
    best = None
    for i in range(-int(round(span / step)), int(round(span / step)) + 1):
        wb = wb0 + i * step
        g = Geometry(base.half_track, mid - wb / 2, mid + wb / 2)
        d = pair_distances(pairs, g)
        inl = [x for x in d if x < INLIER_M]
        score = (len(inl), -sum(inl) / max(len(inl), 1))
        if best is None or score > best[0]:
            best = (score, g)
    g = best[1]

    def stats(geom):
        d = sorted(x for x in pair_distances(pairs, geom) if x < GOOD_M)
        return {"median_m": round(_percentile(d, 0.5), 3), "p90_m": round(_percentile(d, 0.9), 3),
                "pairs_within_1m": len(d), "pairs_within_0.3m": sum(1 for x in d if x < INLIER_M)}
    return g, {"pairs": len(pairs), "fitted": True, "before": stats(base), "after": stats(g),
               "wheelbase_m": round(g.rear_z - g.front_z, 3)}


def build_contacts(events: list[Event], g: Geometry):
    """[[x, z, kind], ...] at 0.01 m, one per 0.25 m world cell and kind (the first seen), in a stable order."""
    seen: dict[tuple, tuple] = {}
    for e in events:
        x, z = e.at(g)
        key = (e.kind, math.floor(x / GRID_M), math.floor(z / GRID_M))
        if key not in seen:
            seen[key] = (x, z, e.kind)
    return [[round(x, 2), round(z, 2), kind] for _k, (x, z, kind) in sorted(seen.items())]
