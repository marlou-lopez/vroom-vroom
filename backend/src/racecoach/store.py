"""Persistent app store: DuckDB metadata plus one Parquet file per lap trace."""

from __future__ import annotations

import json
from dataclasses import replace
from datetime import UTC, datetime
from pathlib import Path
from types import TracebackType
from typing import Any

import duckdb
import polars as pl

from racecoach.coach.schema import CoachResult
from racecoach.model import LapKind, LapMeta, LapSource, LapTrace, SessionMeta

SCHEMA = """
CREATE TABLE IF NOT EXISTS sessions (
    session_id VARCHAR PRIMARY KEY, track_name VARCHAR, track_layout VARCHAR, track_id VARCHAR,
    track_length_m DOUBLE, car_name VARCHAR, car_id VARCHAR, car_class VARCHAR,
    session_type VARCHAR, game_build VARCHAR, started_at TIMESTAMPTZ, driver VARCHAR,
    steering_range_deg DOUBLE, raw_path VARCHAR
);
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS source_path VARCHAR;
CREATE TABLE IF NOT EXISTS laps (
    lap_id VARCHAR PRIMARY KEY, session_id VARCHAR, lap_no INTEGER, kind VARCHAR,
    lap_time_s DOUBLE, sectors_s DOUBLE[], valid BOOLEAN, valid_override BOOLEAN,
    pinned_reference BOOLEAN, source VARCHAR, driver VARCHAR, track_id VARCHAR, car_id VARCHAR,
    conditions VARCHAR
);
CREATE TABLE IF NOT EXISTS lap_stint_stats (
    lap_id VARCHAR PRIMARY KEY, session_id VARCHAR, stats VARCHAR
);
CREATE TABLE IF NOT EXISTS llm_calls (
    id BIGINT PRIMARY KEY, ts TIMESTAMP, purpose VARCHAR, provider VARCHAR, model VARCHAR,
    input_tokens INTEGER, output_tokens INTEGER, cost_usd DOUBLE, ok BOOLEAN, lap_id VARCHAR,
    detail VARCHAR
);
CREATE SEQUENCE IF NOT EXISTS llm_calls_seq;
CREATE TABLE IF NOT EXISTS focus_items (
    id BIGINT PRIMARY KEY, created_at TIMESTAMP, track_id VARCHAR, car_id VARCHAR,
    text VARCHAR, status VARCHAR
);
CREATE SEQUENCE IF NOT EXISTS focus_items_seq;
ALTER TABLE focus_items ADD COLUMN IF NOT EXISTS corner_id VARCHAR;
ALTER TABLE focus_items ADD COLUMN IF NOT EXISTS metric VARCHAR;
ALTER TABLE focus_items ADD COLUMN IF NOT EXISTS baseline_s DOUBLE;
ALTER TABLE focus_items ADD COLUMN IF NOT EXISTS session_id VARCHAR;
CREATE TABLE IF NOT EXISTS coach_results (
    seq BIGINT PRIMARY KEY, id VARCHAR, command VARCHAR, lap_id VARCHAR, ref_lap_id VARCHAR,
    result VARCHAR
);
CREATE SEQUENCE IF NOT EXISTS coach_results_seq;
"""

LAP_COLUMNS = (
    "lap_id, session_id, lap_no, kind, lap_time_s, sectors_s, valid, valid_override, "
    "pinned_reference, source, driver, track_id, car_id, conditions"
)


def _now() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)


def _lap_from_row(r: tuple[Any, ...]) -> LapMeta:
    return LapMeta(
        lap_id=r[0], session_id=r[1], lap_no=r[2], kind=LapKind(r[3]), lap_time_s=r[4],
        sectors_s=tuple(r[5] or ()), valid=r[6], valid_override=r[7], pinned_reference=r[8],
        source=LapSource(r[9]), driver=r[10], track_id=r[11], car_id=r[12],
        conditions=json.loads(r[13] or "{}"),
    )  # fmt: skip


class AppStore:
    def __init__(self, db_path: Path | str, traces_dir: Path | str) -> None:
        self.db_path = Path(db_path)
        self.traces_dir = Path(traces_dir)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self.traces_dir.mkdir(parents=True, exist_ok=True)
        self.con = duckdb.connect(str(self.db_path))
        self.con.execute(SCHEMA)

    def close(self) -> None:
        self.con.close()

    def view(self) -> AppStore:
        """A store on the same database with its own cursor, for one request in a worker
        thread (a DuckDB connection must not be shared between threads)."""
        other = object.__new__(AppStore)
        other.db_path, other.traces_dir = self.db_path, self.traces_dir
        other.con = self.con.cursor()
        return other

    def __enter__(self) -> AppStore:
        return self

    def __exit__(
        self, exc_type: type[BaseException] | None, exc: BaseException | None,
        tb: TracebackType | None,
    ) -> None:  # fmt: skip
        self.close()

    def _transaction(self, statements: list[tuple[str, list[Any]]]) -> None:
        self.con.execute("BEGIN TRANSACTION")
        try:
            for sql, args in statements:
                self.con.execute(sql, args)
            self.con.execute("COMMIT")
        except BaseException:
            self.con.execute("ROLLBACK")
            raise

    # --- sessions and laps ---------------------------------------------------------------

    def session(self, session_id: str) -> SessionMeta | None:
        return next((s for s in self.sessions() if s.session_id == session_id), None)

    def has_session(self, session_id: str) -> bool:
        row = self.con.execute(
            "SELECT 1 FROM sessions WHERE session_id = ?", [session_id]
        ).fetchone()
        return row is not None

    def trace_path(self, lap_id: str) -> Path:
        return self.traces_dir / f"{lap_id}.parquet"

    def add_session(
        self,
        meta: SessionMeta,
        laps: list[tuple[LapMeta, LapTrace]],
        raw_path: Path | str,
        stint_stats: dict[str, dict[str, Any]] | None = None,
        source_path: Path | str | None = None,
        replaces: str | None = None,
    ) -> None:
        """Insert a session, its laps and their traces. The metadata goes in one transaction;
        if anything fails, the trace files written for it are removed again.

        `replaces` is the id of an earlier import of the same recording: in the same transaction
        it is removed, and its manual validity overrides and pin carry over to the laps that
        still match (same lap number, kind and time). Its trace files go after the commit."""
        if self.has_session(meta.session_id):
            raise ValueError(f"session {meta.session_id} is already in the store")
        old_laps: list[LapMeta] = []
        if replaces is not None:
            old_laps = self.laps(replaces)
            old = {(x.lap_no, x.kind, x.lap_time_s): x for x in old_laps}
            carried: list[tuple[LapMeta, LapTrace]] = []
            for lap, trace in laps:
                prev = old.get((lap.lap_no, lap.kind, lap.lap_time_s))
                if prev is not None:
                    lap = replace(
                        lap, valid_override=prev.valid_override,
                        pinned_reference=prev.pinned_reference,
                    )  # fmt: skip
                carried.append((lap, trace))
            laps = carried
        written: list[Path] = []
        try:
            for _, trace in laps:
                written.append(self.write_trace(trace))
            stmts: list[tuple[str, list[Any]]] = [(
                "INSERT INTO sessions VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                [
                    meta.session_id, meta.track_name, meta.track_layout, meta.track_id,
                    meta.track_length_m, meta.car_name, meta.car_id, meta.car_class,
                    meta.session_type, meta.game_build, meta.started_at, meta.driver,
                    meta.steering_range_deg, str(raw_path),
                    str(source_path) if source_path is not None else None,
                ],
            )]  # fmt: skip
            if replaces is not None:
                stmts[:0] = [
                    ("DELETE FROM lap_stint_stats WHERE session_id = ?", [replaces]),
                    ("DELETE FROM laps WHERE session_id = ?", [replaces]),
                    ("DELETE FROM sessions WHERE session_id = ?", [replaces]),
                    (
                        "UPDATE focus_items SET session_id = ? WHERE session_id = ?",
                        [meta.session_id, replaces],
                    ),
                ]  # fmt: skip
            for lap, _ in laps:
                stmts.append((
                    f"INSERT INTO laps ({LAP_COLUMNS}) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    [
                        lap.lap_id, lap.session_id, lap.lap_no, lap.kind.value, lap.lap_time_s,
                        list(lap.sectors_s), lap.valid, lap.valid_override, lap.pinned_reference,
                        lap.source.value, lap.driver, lap.track_id, lap.car_id,
                        json.dumps(lap.conditions),
                    ],
                ))  # fmt: skip
            for lap_id, stats in (stint_stats or {}).items():
                stmts.append((
                    "INSERT INTO lap_stint_stats VALUES (?,?,?)",
                    [lap_id, meta.session_id, json.dumps(stats)],
                ))  # fmt: skip
            self._transaction(stmts)
        except BaseException:
            for p in written:
                p.unlink(missing_ok=True)
            raise
        for x in old_laps:
            self.trace_path(x.lap_id).unlink(missing_ok=True)

    def session_from_source(self, source_path: Path | str) -> tuple[SessionMeta, str | None] | None:
        """The newest import of a recording file, with the raw copy's path, or None."""
        row = self.con.execute(
            "SELECT session_id, raw_path FROM sessions WHERE source_path = ?"
            " ORDER BY rowid DESC LIMIT 1",  # the latest import
            [str(source_path)],
        ).fetchone()
        if row is None:
            return None
        meta = self.session(row[0])
        return (meta, row[1]) if meta else None

    def stint_stats(self, session_id: str) -> dict[str, dict[str, Any]]:
        """lap_id -> the stored per-lap stint stats (vroom-9ki.18); empty when there are none."""
        rows = self.con.execute(
            "SELECT lap_id, stats FROM lap_stint_stats WHERE session_id = ?", [session_id]
        ).fetchall()
        return {r[0]: json.loads(r[1]) for r in rows}

    def sessions(self) -> list[SessionMeta]:
        rows = self.con.execute(
            "SELECT session_id, track_name, track_layout, track_id, track_length_m, car_name,"
            " car_id, car_class, session_type, game_build, started_at, driver, steering_range_deg"
            " FROM sessions ORDER BY started_at, session_id"
        ).fetchall()
        return [SessionMeta(*r) for r in rows]

    def laps(self, session_id: str | None = None) -> list[LapMeta]:
        sql = f"SELECT {LAP_COLUMNS} FROM laps"
        args: list[Any] = []
        if session_id is not None:
            sql += " WHERE session_id = ?"
            args.append(session_id)
        rows = self.con.execute(sql + " ORDER BY session_id, lap_no", args).fetchall()
        return [_lap_from_row(r) for r in rows]

    def lap(self, lap_id: str) -> LapMeta | None:
        row = self.con.execute(
            f"SELECT {LAP_COLUMNS} FROM laps WHERE lap_id = ?", [lap_id]
        ).fetchone()
        return _lap_from_row(row) if row else None

    def _require_lap(self, lap_id: str) -> LapMeta:
        lap = self.lap(lap_id)
        if lap is None:
            raise KeyError(lap_id)
        return lap

    # --- traces --------------------------------------------------------------------------

    def write_trace(self, trace: LapTrace) -> Path:
        df = pl.DataFrame({"distance": trace.distance, **trace.ch})
        path = self.trace_path(trace.lap_id)
        tmp = path.with_suffix(".tmp")
        df.write_parquet(tmp)
        tmp.replace(path)
        return path

    def read_trace(self, lap_id: str) -> LapTrace:
        path = self.trace_path(lap_id)
        if not path.is_file():
            raise KeyError(lap_id)
        df = pl.read_parquet(path)
        return LapTrace(
            lap_id,
            df["distance"].to_numpy(),
            {c: df[c].to_numpy() for c in df.columns if c != "distance"},
        )

    # --- validity, pinning and the reference lap -------------------------------------------

    def set_valid_override(self, lap_id: str, valid: bool | None) -> LapMeta:
        """Mark a lap valid or invalid by hand; None goes back to the recording's own flag."""
        self._require_lap(lap_id)
        self.con.execute("UPDATE laps SET valid_override = ? WHERE lap_id = ?", [valid, lap_id])
        return self._require_lap(lap_id)

    def pin_reference(self, lap_id: str) -> LapMeta:
        """Pin a lap as the reference for its track and car; the previous pin is dropped."""
        lap = self._require_lap(lap_id)
        self._transaction([
            (
                "UPDATE laps SET pinned_reference = FALSE WHERE track_id = ? AND car_id = ?",
                [lap.track_id, lap.car_id],
            ),
            ("UPDATE laps SET pinned_reference = TRUE WHERE lap_id = ?", [lap_id]),
        ])  # fmt: skip
        return self._require_lap(lap_id)

    def unpin_reference(self, lap_id: str) -> LapMeta:
        self._require_lap(lap_id)
        self.con.execute("UPDATE laps SET pinned_reference = FALSE WHERE lap_id = ?", [lap_id])
        return self._require_lap(lap_id)

    def reference_for(self, track_id: str, car_id: str) -> LapMeta | None:
        """The pinned lap, else the fastest flying lap that counts as valid; None if neither."""
        pinned = self.con.execute(
            f"SELECT {LAP_COLUMNS} FROM laps WHERE track_id = ? AND car_id = ?"
            " AND pinned_reference ORDER BY lap_id LIMIT 1",
            [track_id, car_id],
        ).fetchone()
        if pinned:
            return _lap_from_row(pinned)
        best = self.con.execute(
            f"SELECT {LAP_COLUMNS} FROM laps WHERE track_id = ? AND car_id = ? AND kind = ?"
            " AND lap_time_s IS NOT NULL AND coalesce(valid_override, valid)"
            " ORDER BY lap_time_s, lap_id LIMIT 1",
            [track_id, car_id, LapKind.FLYING.value],
        ).fetchone()
        return _lap_from_row(best) if best else None

    # --- LLM call log ----------------------------------------------------------------------

    def log_llm_call(
        self, *, purpose: str, provider: str, model: str, input_tokens: int = 0,
        output_tokens: int = 0, cost_usd: float = 0.0, ok: bool = True,
        lap_id: str | None = None, detail: str | None = None,
    ) -> int:  # fmt: skip
        row = self.con.execute(
            "INSERT INTO llm_calls VALUES (nextval('llm_calls_seq'),?,?,?,?,?,?,?,?,?,?)"
            " RETURNING id",
            [_now(), purpose, provider, model, input_tokens, output_tokens, cost_usd, ok,
             lap_id, detail],
        ).fetchone()  # fmt: skip
        assert row is not None
        return int(row[0])

    def _rows(self, sql: str, args: list[Any] | None = None) -> list[dict[str, Any]]:
        cur = self.con.execute(sql, args or [])
        names = [d[0] for d in cur.description or []]
        return [dict(zip(names, r, strict=True)) for r in cur.fetchall()]

    def llm_calls(self) -> list[dict[str, Any]]:
        return self._rows("SELECT * FROM llm_calls ORDER BY id")

    def llm_cost_total(self) -> float:
        row = self.con.execute("SELECT coalesce(sum(cost_usd), 0) FROM llm_calls").fetchone()
        return float(row[0]) if row else 0.0

    # --- focus items -----------------------------------------------------------------------

    def add_focus_item(
        self, track_id: str, car_id: str, text: str, *, corner_id: str | None = None,
        metric: str | None = None, baseline_s: float | None = None, session_id: str | None = None,
    ) -> int:  # fmt: skip
        row = self.con.execute(
            "INSERT INTO focus_items (id, created_at, track_id, car_id, text, status, corner_id,"
            " metric, baseline_s, session_id)"
            " VALUES (nextval('focus_items_seq'),?,?,?,?,'open',?,?,?,?) RETURNING id",
            [_now(), track_id, car_id, text, corner_id, metric, baseline_s, session_id],
        ).fetchone()
        assert row is not None
        return int(row[0])

    def set_focus_status(self, item_id: int, status: str) -> None:
        self.con.execute("UPDATE focus_items SET status = ? WHERE id = ?", [status, item_id])

    def focus_items(
        self, track_id: str | None = None, car_id: str | None = None, status: str | None = None
    ) -> list[dict[str, Any]]:
        where, args = [], []
        for col, val in (("track_id", track_id), ("car_id", car_id), ("status", status)):
            if val is not None:
                where.append(f"{col} = ?")
                args.append(val)
        sql = "SELECT * FROM focus_items" + (" WHERE " + " AND ".join(where) if where else "")
        return self._rows(sql + " ORDER BY id", args)

    # --- coach results ---------------------------------------------------------------------

    def save_coach_result(self, result: CoachResult) -> CoachResult:
        """Store a result as the latest of its command for its (lap, reference) pair. A finding
        on the same corner and kind as a reviewed finding of the result it replaces stays
        reviewed (a re-analysis must not lose what the driver ticked off)."""
        previous = self.latest_coach_results(result.lap_id, result.ref_lap_id).get(result.command)
        if previous is not None:
            kept = {(f.corner_id, f.kind) for f in previous.findings if f.reviewed}
            for f in result.findings:
                if (f.corner_id, f.kind) in kept:
                    f.reviewed = True
        self.con.execute(
            "INSERT INTO coach_results VALUES (nextval('coach_results_seq'),?,?,?,?,?)",
            [result.id, result.command, result.lap_id, result.ref_lap_id, result.model_dump_json()],
        )
        return result

    def latest_coach_results(self, lap_id: str, ref_lap_id: str | None) -> dict[str, CoachResult]:
        """command -> the newest stored result for the lap and reference (None: no reference)."""
        rows = self.con.execute(
            "SELECT command, result FROM coach_results WHERE lap_id = ?"
            " AND ref_lap_id IS NOT DISTINCT FROM ? ORDER BY seq",
            [lap_id, ref_lap_id],
        ).fetchall()
        return {r[0]: CoachResult.model_validate_json(r[1]) for r in rows}  # later rows win

    def set_finding_reviewed(self, finding_id: str, reviewed: bool) -> CoachResult:
        """Tick a finding off (or back on) in the newest result that holds it; KeyError if none."""
        rows = self.con.execute(
            "SELECT seq, result FROM coach_results WHERE result LIKE ? ORDER BY seq DESC",
            [f'%"id":"{finding_id}"%'],
        ).fetchall()
        for seq, raw in rows:
            result = CoachResult.model_validate_json(raw)
            hit = [f for f in result.findings if f.id == finding_id]
            if hit:
                hit[0].reviewed = reviewed
                self.con.execute(
                    "UPDATE coach_results SET result = ? WHERE seq = ?",
                    [result.model_dump_json(), seq],
                )
                return result
        raise KeyError(finding_id)
