"""Command line: `racecoach rates apply | probe | fixture`."""

from __future__ import annotations

from pathlib import Path
from typing import Annotated

import typer

from .lmu.fixture import make_fixture
from .lmu.probe import probe as probe_recording
from .lmu.rates import DEFAULT_RATES, UnknownChannelError, set_channel_rates

app = typer.Typer(help="AI sim racing engineer: backend tools.", no_args_is_help=True)
rates_app = typer.Typer(help="LMU recording rates.", no_args_is_help=True)
app.add_typer(rates_app, name="rates")
track_data_app = typer.Typer(help="Derived track geometry data.", no_args_is_help=True)
app.add_typer(track_data_app, name="track-data")
setup_app = typer.Typer(help="Stored car setups.", no_args_is_help=True)
app.add_typer(setup_app, name="setup")


@setup_app.command("backfill")
def setup_backfill() -> None:
    """Fill the setup of sessions imported before it was stored, from their raw copies."""
    from .settings import Settings
    from .setup_backfill import backfill_setups
    from .store import AppStore

    settings = Settings()
    with AppStore(settings.db_path, settings.traces_dir) as store:
        result = backfill_setups(store)
    for session_id, reason in result.unreadable:
        typer.echo(f"could not read {session_id[:12]}: {reason}", err=True)
    typer.echo(
        f"filled {len(result.filled)}, skipped {len(result.skipped)} (already had a setup), "
        f"could not read {len(result.unreadable)}"
    )


@track_data_app.command("install")
def track_data_install(
    preset: Annotated[str, typer.Argument(help="Which track's data to install: spa")] = "spa",
    source: Annotated[
        Path | None,
        typer.Option(help="Folder with the mock JSON files (default: frontend/public/mock)"),
    ] = None,
    track_id: Annotated[
        str | None, typer.Option(help="Track id to install under (default: the preset's own)")
    ] = None,
    force: Annotated[bool, typer.Option(help="Overwrite files that already exist")] = False,
) -> None:
    """Copy a track's elevation, survey and aerial files into the track data folder."""
    from .settings import Settings
    from .track_data import TrackDataError, install_track_data

    settings = Settings()
    try:
        done = install_track_data(
            preset, settings.track_data_path, source_dir=source, track_id=track_id, force=force
        )
    except TrackDataError as err:
        typer.echo(f"error: {err}", err=True)
        raise typer.Exit(1) from err
    for item in done:
        typer.echo(
            f"{'wrote' if item.written else 'kept (exists; --force overwrites)'} {item.path}"
        )


@rates_app.command("apply")
def rates_apply(
    config: Annotated[
        Path,
        typer.Argument(help="LMU's UserData/Telemetry/config.json", exists=True, dir_okay=False),
    ],
) -> None:
    """Set Lap Dist, G Force Lat/Long/Vert and GPS Latitude/Longitude to 50 Hz."""
    try:
        backup = set_channel_rates(config, DEFAULT_RATES)
    except (UnknownChannelError, ValueError) as err:
        typer.echo(f"error: {err}", err=True)
        raise typer.Exit(1) from err
    typer.echo(f"Updated {len(DEFAULT_RATES)} channels in {config}")
    typer.echo(f"Backup: {backup}")


@app.command()
def probe(
    recording: Annotated[Path, typer.Argument(help="An LMU .duckdb recording", exists=True)],
) -> None:
    """Print a Markdown description of a recording (read-only, on a copy)."""
    typer.echo(probe_recording(recording))


@app.command()
def fixture(
    src: Annotated[Path, typer.Argument(help="An LMU .duckdb recording", exists=True)],
    dst: Annotated[Path, typer.Argument(help="Where to write the trimmed recording")],
    laps: Annotated[int, typer.Option(help="Number of full laps to keep")] = 3,
) -> None:
    """Trim a recording to a few laps for use as a test fixture."""
    try:
        out = make_fixture(src, dst, laps)
    except ValueError as err:
        typer.echo(f"error: {err}", err=True)
        raise typer.Exit(1) from err
    typer.echo(f"Wrote {out} ({out.stat().st_size / 1e6:.2f} MB)")


@app.command()
def serve(
    host: Annotated[str, typer.Option(help="Interface to listen on")] = "127.0.0.1",
    port: Annotated[int, typer.Option(help="Port; the frontend's dev proxy expects 8765")] = 8765,
) -> None:
    """Run the API (and the built frontend from frontend/dist, when it exists)."""
    import uvicorn

    from .api.app import create_app

    uvicorn.run(create_app(), host=host, port=port)
