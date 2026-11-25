"""Imagery sources. One module per source, each with a SOURCE object (see base.py); `load(name)` imports it."""
import importlib

from .base import Source


def load(name: str) -> Source:
    if not name.isidentifier():
        raise SystemExit(f"bad source name {name!r}")
    return importlib.import_module(f"sources.{name}").SOURCE
