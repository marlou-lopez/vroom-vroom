# vroom-vroom

A personal telemetry coach for Le Mans Ultimate (LMU). It imports LMU's own `.duckdb`
recordings, aligns laps on a 1 m distance grid, plays a lap against a reference lap, and has
an LLM coach annotate where time was lost. The data model is meant to work for any sim, not
just LMU.

## Stages

- **v1**: UI on mock data (current).
- **v2**: real backend.
- **v3**: live voice coaching through a Windows agent.
- **v4**: conversation with the engineer.
- **v5**: setup engineer.

## Status

The frontend runs on a mock API that serves one real Spa recording. The backend has not been
started. For live status, open issues and milestones, see the
[GitHub project board](https://github.com/users/marlou-lopez/projects/7).

## Quick start

You need a current Node LTS.

```bash
cd frontend
npm ci
npm run dev
```

This opens the app at http://localhost:5173 with the mock API enabled. See
[`frontend/README.md`](frontend/README.md) for all commands.

## Repository layout

| Path | What |
|---|---|
| `frontend/` | React + TypeScript + Vite app |
| `docs/` | Verified LMU recording facts, spike write-ups and audits |
| `tools/` | Scripts, such as the one that turns an LMU recording into the mock data |

Start with [`docs/lmu-duckdb-schema.md`](docs/lmu-duckdb-schema.md) for what LMU recordings
contain. Track view spike write-ups are in `docs/track-views/`.

## Working with LMU recordings

- Never modify a recording. Copy it first and work on the copy.
- LMU track files are encrypted and the EULA forbids extracting them. Do not extract them.
