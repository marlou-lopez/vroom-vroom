# racecoach

Backend for the AI sim racing engineer. See `../CLAUDE.md` for the project and `../docs/spec.md`
for the plan.

```bash
uv sync
uv run pytest && uv run ruff check && uv run pyright
uv run racecoach rates apply "<LMU>/UserData/Telemetry/config.json"
uv run racecoach probe recording.duckdb > probe.md
uv run racecoach fixture recording.duckdb tests/fixtures/spa_720s.duckdb --laps 3
```
