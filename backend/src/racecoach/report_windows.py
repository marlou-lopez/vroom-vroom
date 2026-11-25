"""The working windows the session report judges against.

Port of `frontend/src/lib/reportWindows.ts`.

One table for the code; the same values, with their sources, are in
`docs/session-report/windows.md`. Every value is an editable assumption. `tests/test_report.py`
compares this table with the one the frontend rules produce (`tests/fixtures/report_golden.json`),
so the two cannot drift apart unnoticed.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal

Axle = Literal["front", "rear"]


@dataclass(frozen=True)
class Range:
    min: float
    max: float


@dataclass(frozen=True)
class Window:
    """One range for both axles, or one per axle. `tolerance` is in the window's unit: an event
    fires only when the per-lap average is outside the range by more than this, and 'problem'
    needs twice as much."""

    source: str
    tolerance: float
    both: Range | None = None
    front: Range | None = None
    rear: Range | None = None

    def range_for(self, axle: Axle) -> Range:
        r = self.both if self.both is not None else (self.front if axle == "front" else self.rear)
        assert r is not None
        return r


@dataclass(frozen=True)
class ClassWindows:
    compound: str
    tyre_surface_c: Window
    tyre_carcass_c: Window
    tyre_pressure_kpa: Window
    tyre_spread_c: Window
    brake_c: Window
    brake_front_rear_ratio: Window


UNITS = {
    "tyre_surface_c": "°C", "tyre_carcass_c": "°C", "tyre_pressure_kpa": "kPa",
    "tyre_spread_c": "°C", "brake_c": "°C", "brake_front_rear_ratio": "ratio",
}  # fmt: skip

_SRC_TYRE_TEMP = (
    "Community guidance for LMU: 80-100 C typical (clockwerkradio.com 'How to Heat Tyres Quickly "
    "During Qualifying in LMU'); TheTenths LMU GT3 setup guides give 85-100 C for grip and 80-95 C "
    "for a race stint"
)
_SRC_MEASURED = (
    "Measured with tools/measure-windows.py: 66 laps, 3 car entries (all Garage 59), 4 tracks, "
    "2026-11-18 (10th to 90th percentile of the fastest 20 % of each car and track's flying laps)"
)
_SRC_NO_FIGURE = (
    "No published LMU figure found (searched 2026-11-18); engineering assumption, to be replaced "
    "with measured values"
)


def _w(source: str, tol: float, lo: float, hi: float) -> Window:
    return Window(source, tol, both=Range(lo, hi))


def _axles(
    source: str, tol: float, front: tuple[float, float], rear: tuple[float, float]
) -> Window:
    return Window(source, tol, front=Range(*front), rear=Range(*rear))


GT3 = ClassWindows(
    compound="dry (medium)",
    tyre_surface_c=_w(
        f"{_SRC_TYRE_TEMP}. Measured on the driver's fastest GT3 laps (66 laps, 3 car entries (all "
        "Garage 59), 4 tracks, 2026-11-18) it was cooler, 74.9-84.7 C; the published range is kept",
        3, 80, 100,
    ),
    tyre_carcass_c=_axles(
        f"{_SRC_MEASURED}; carcass runs a little above the surface (LMU wiki, Tire management: low "
        "pressure raises carcass temperature)",
        3, (79.4, 88.1), (77.3, 82.1),
    ),
    tyre_pressure_kpa=_axles(
        f"{_SRC_MEASURED}; TheTenths lists 27.1-27.3 psi as cold setup values, a different "
        "quantity",
        3, (169.4, 174.3), (166.3, 170.1),
    ),
    tyre_spread_c=_axles(
        f"{_SRC_MEASURED}; agrees with the rule of thumb of 10-15 C", 2, (0, 11.3), (0, 9.2)
    ),
    brake_c=_axles(
        f"{_SRC_MEASURED}; the LMU brake display shows red while braking and asks for more duct "
        "when it stays red all lap (Simracing Arnout, 'More Tire Heat LMU')",
        10, (389, 468), (310, 371),
    ),
    brake_front_rear_ratio=_w(_SRC_MEASURED, 0.05, 1.22, 1.27),
)  # fmt: skip

HYPERCAR = ClassWindows(
    compound="dry (medium)",
    tyre_surface_c=_w(_SRC_TYRE_TEMP, 3, 80, 100),
    tyre_carcass_c=_w(f"{_SRC_NO_FIGURE}; as GT3", 3, 80, 110),
    tyre_pressure_kpa=_w(
        f"{_SRC_NO_FIGURE}; the FIA WEC hypercar/LMP2 rule sets a minimum hot pressure per tyre "
        "(FIA WEC decision D0048, 2023) but the value is not public",
        3, 160, 190,
    ),
    tyre_spread_c=_w(f"{_SRC_NO_FIGURE}; as GT3", 2, 0, 12),
    brake_c=_w(
        f"{_SRC_NO_FIGURE}; carbon discs run hotter than GT3 steel, so the window is moved up",
        10, 350, 700,
    ),
    brake_front_rear_ratio=_w(
        f"{_SRC_NO_FIGURE}; hypercars brake on both axles with regeneration at the rear",
        0.05, 0.8, 1.5,
    ),
)  # fmt: skip

LMP2 = ClassWindows(
    compound=HYPERCAR.compound,
    tyre_surface_c=HYPERCAR.tyre_surface_c,
    tyre_carcass_c=HYPERCAR.tyre_carcass_c,
    tyre_pressure_kpa=_w(f"{_SRC_NO_FIGURE}; as hypercar", 3, 160, 190),
    tyre_spread_c=HYPERCAR.tyre_spread_c,
    brake_c=_w(f"{_SRC_NO_FIGURE}; steel discs, as GT3", 10, 300, 650),
    brake_front_rear_ratio=_w(f"{_SRC_NO_FIGURE}; as GT3", 0.05, 1.0, 1.5),
)

CLASS_WINDOWS: dict[str, ClassWindows] = {"GT3": GT3, "Hypercar": HYPERCAR, "LMP2": LMP2}


def windows_for(car_class: str) -> ClassWindows | None:
    return CLASS_WINDOWS.get(car_class)


def window_list(w: ClassWindows) -> list[dict[str, Any]]:
    """The windows as the report returns them: one row per metric, or a front and a rear row."""
    rows: list[dict[str, Any]] = []
    for key, unit in UNITS.items():
        x: Window = getattr(w, key)
        base = {"key": key, "unit": unit, "tolerance": x.tolerance, "source": x.source}
        if x.both is not None:
            rows.append({**base, "axle": "both", "min": x.both.min, "max": x.both.max})
        else:
            for axle in ("front", "rear"):
                r = x.range_for(axle)  # type: ignore[arg-type]
                rows.append({**base, "axle": axle, "min": r.min, "max": r.max})
    return rows
