"""Watch LMU's Telemetry folder and import finished recordings.

LMU keeps writing a recording while the session runs, so a file is only imported once it
has been quiet for a while and can be read. The original is only read, never changed.
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import Callable
from pathlib import Path

from watchfiles import awatch

from racecoach.importer import ImportResult, import_file
from racecoach.model import LapSource
from racecoach.store import AppStore

log = logging.getLogger(__name__)

# (mtime_ns, size) of files already dealt with, so a scan doesn't hash them again.
Seen = dict[Path, tuple[int, int]]
# Failed files: path -> ((mtime_ns, size), next_try_epoch_s, delay_s). A file that fails is not
# retried before `next_try` unless it changed; the delay doubles up to MAX_RETRY_S.
Failed = dict[Path, tuple[tuple[int, int], float, float]]
FIRST_RETRY_S = 30.0
MAX_RETRY_S = 600.0


def is_finished(path: Path | str, quiet_s: float, now: float | None = None) -> bool:
    """True when the file's mtime is older than `quiet_s` seconds and it opens read-only."""
    path = Path(path)
    now = time.time() if now is None else now
    try:
        if now - path.stat().st_mtime < quiet_s:
            return False
        with path.open("rb") as f:
            f.read(1)
    except OSError:
        return False
    return True


def scan_once(
    store: AppStore,
    telemetry_dir: Path | str,
    raw_dir: Path | str,
    quiet_s: float,
    now: float | None = None,
    seen: Seen | None = None,
    failed: Failed | None = None,
    source: LapSource = LapSource.OWN_RECORDING,
    cars_config: Path | str | None = None,
) -> list[ImportResult]:
    """Import every finished `.duckdb` file in the folder that the store doesn't know yet.

    Returns the results of recordings imported by this scan (already-known ones are not
    reported). A file that fails (corrupt, locked) is logged and left for a later scan.
    """
    results: list[ImportResult] = []
    folder = Path(telemetry_dir)
    now = time.time() if now is None else now
    try:
        paths = sorted(folder.glob("*.duckdb"))
    except OSError as err:
        log.warning("Cannot list %s: %s", folder, err)
        return results
    if not paths and not folder.is_dir():
        log.warning("Telemetry folder %s does not exist", folder)
        return results
    for path in paths:
        try:
            st = path.stat()
        except OSError:
            continue  # vanished or unreadable; the next scan looks again
        key = (st.st_mtime_ns, st.st_size)
        try:
            if seen is not None and seen.get(path) == key:
                continue
            if not is_finished(path, quiet_s, now):
                continue
            prev = failed.get(path) if failed is not None else None
            if prev is not None and prev[0] == key and now < prev[1]:
                continue
            result = import_file(store, path, raw_dir, source, cars_config)
        except Exception as err:
            delay = FIRST_RETRY_S
            if failed is not None:
                prev = failed.get(path)
                if prev is not None and prev[0] == key:
                    delay = min(prev[2] * 2, MAX_RETRY_S)
                failed[path] = (key, now + delay, delay)
            log.warning("Could not import %s, will retry: %s", path, err)
            continue
        if failed is not None:
            failed.pop(path, None)
        if seen is not None:
            seen[path] = key
        if result.imported:
            log.info("Imported %s (%d laps)", path.name, result.lap_count)
            results.append(result)
    return results


async def watch_forever(
    store: AppStore,
    telemetry_dir: Path | str,
    raw_dir: Path | str,
    quiet_s: float = 10.0,
    poll_s: float = 5.0,
    on_import: Callable[[ImportResult], None] | None = None,
    cars_config: Path | str | None = None,
) -> None:
    """Scan now, then again on every change and at least every `poll_s` seconds.

    Polling is forced because /mnt/d (9P) has no inotify; the periodic tick lets files
    that were still being written at the last change mature. Scans run in a worker thread, so
    `store` must not be used by other threads at the same time (give the watcher its own).
    """
    seen: Seen = {}
    failed: Failed = {}

    async def scan() -> None:
        try:
            results = await asyncio.to_thread(
                scan_once,
                store,
                telemetry_dir,
                raw_dir,
                quiet_s,
                seen=seen,
                failed=failed,
                cars_config=cars_config,
            )
        except Exception:
            log.exception("Scan of %s failed", telemetry_dir)
            return
        for result in results:
            if on_import:
                on_import(result)

    await scan()
    while True:
        try:
            async for _ in awatch(
                telemetry_dir,
                force_polling=True,
                poll_delay_ms=int(poll_s * 1000),
                rust_timeout=int(poll_s * 1000),
                yield_on_timeout=True,
            ):
                await scan()
        except FileNotFoundError:
            # The folder isn't there (yet), e.g. the drive isn't mounted: wait and look again.
            log.warning("Telemetry folder %s is missing, waiting", telemetry_dir)
            await asyncio.sleep(poll_s)
            await scan()
