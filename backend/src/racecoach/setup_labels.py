"""Readable names for LMU's garage setting ids. Port of `frontend/src/api/mock/setupLabels.ts`;
an id not listed is shown as itself (the contract's fallback)."""

from __future__ import annotations

import re

LABELS = {
    "VM_REAR_WING": "Rear wing",
    "VM_FRONT_WING": "Front wing",
    "VM_FRONT_ANTISWAY": "Front ARB",
    "VM_REAR_ANTISWAY": "Rear ARB",
    "VM_BRAKE_BALANCE": "Brake balance",
    "VM_BRAKE_PRESSURE": "Brake pressure",
    "VM_BRAKE_DUCTS": "Front brake ducts",
    "VM_BRAKE_DUCTS_REAR": "Rear brake ducts",
    "VM_ANTILOCKBRAKESYSTEMMAP": "ABS map",
    "VM_TRACTIONCONTROLMAP": "TC map",
    "VM_TRACTIONCONTROLPOWERCUTMAP": "TC power cut",
    "VM_TRACTIONCONTROLSLIPANGLEMAP": "TC slip angle",
    "VM_ENGINE_MIXTURE": "Engine mixture",
    "VM_DIFF_PRELOAD": "Diff preload",
    "VM_FRONT_TOEIN": "Front toe",
    "VM_REAR_TOEIN": "Rear toe",
    "VM_FRONT_TIRE_COMPOUND": "Front tyre compound",
    "VM_REAR_TIRE_COMPOUND": "Rear tyre compound",
    "VM_FUEL_LEVEL": "Fuel",
    "VM_VIRTUAL_ENERGY": "Virtual energy",
    "VM_STEER_LOCK": "Steering lock",
}
WHEELS = {"FL": "front left", "FR": "front right", "RL": "rear left", "RR": "rear right"}
WHEEL_ITEMS = {
    "PRESSURE": "tyre pressure", "CAMBER": "camber", "SPRING": "spring",
    "RIDEHEIGHT": "ride height", "PACKERS": "packers", "SLOWBUMP": "slow bump",
    "FASTBUMP": "fast bump", "SLOWREBOUND": "slow rebound", "FASTREBOUND": "fast rebound",
    "BRAKEDISC": "brake disc", "BRAKEPAD": "brake pad", "COMPOUND": "tyre compound",
}  # fmt: skip
_WHEEL_KEY = re.compile(r"^WM_([A-Z]+)-W_(FL|FR|RL|RR)$")


def setup_label(key: str) -> str:
    """"Rear wing" for VM_REAR_WING; "Front left camber" for WM_CAMBER-W_FL; else the key."""
    if key in LABELS:
        return LABELS[key]
    m = _WHEEL_KEY.match(key)
    if m and m.group(1) in WHEEL_ITEMS:
        text = f"{WHEELS[m.group(2)]} {WHEEL_ITEMS[m.group(1)]}"
        return text[0].upper() + text[1:]
    return key
