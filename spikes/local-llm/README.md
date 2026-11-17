# Coach LLM bench (vroom-9ki.17)

Compares LLMs on phrasing the coach's facts packets: number grounding, prose, hedging, speed, cost, and blind
ratings. It started as the local-LLM spike; the write-up and every result so far are in
`docs/coach-llm/local-llm-spike.md`. Standalone scripts, not tests: they call real models and spend real money.

| File | What |
|---|---|
| `build-packets.mjs` | Builds facts packets from a mock recording with the mock API's corner facts |
| `packets/`, `packets-v2/` | Spa packet sets v1 (round 1) and v2 (aids, engine, kerbs, cause confidence, landmark roles; round 2) |
| `packets-monza/`, `packets-v2-monza/` | The same two sets for the Monza recording (not run through the paid models yet) |
| `packets-v3/`, `packets-v3-monza/` | Set v3 (round 4, vroom-aks): plain-English keys, `a against b` pairs, a per-corner `allowed_numbers` list that `guard.py` checks each finding against. Built from v2, which stays unchanged |
| `prompt.md`, `prompt-v2.md`, `prompt-v3.md` | System prompts. v3 is the current one (it goes with packet set v2) |
| `models.json` | The models to compare: provider, model id, price, key variable, enabled |
| `guard.py` | Number guard with failure reasons, copied-field contract, prose lint, hedge count |
| `run.py` | Runs packets × models × N, one retry on a guard failure, appends to `results/runs.jsonl` with a round tag |
| `summarize.py` | `table`, `blind` (rating sheet) and `scores` (unblind a rated sheet) |
| `results/` | Every logged run, blind scores per round, run logs. `blind/` (sheets and keys) is git-ignored |

## Repeat the exercise

Run from `spikes/local-llm/`. Pick a round name first, e.g. `R=2026-12-01-r3`.

1. **Packets.** `node build-packets.mjs [--track spa|monza] [--laps auto|2:4,3:4]` (once `npm ci` has been run
   in `frontend/`). `auto` takes the slowest and second-slowest valid laps against the best one, plus Average
   and a Corner deep dive on the biggest loss. Spa writes `packets*/`, other tracks `packets*-<track>/`.
   **New telemetry:** extract a recording with `tools/extract-laps.mjs` into `frontend/public/mock/`, add it to
   `TRACKS` at the top of `build-packets.mjs` (file, loader, name, session label, straights), and build.
   **New facts:** add them in `extrasOf()` / `cornerFactsV2()` as a new packet set (`packets-v3`), so earlier
   runs keep checking against the packets they were run on.
2. **Models.** Edit `models.json`. Any OpenAI-compatible host is an entry with `provider: "openai"`,
   `base_url`, `key_env` and `price`; `enabled: false` entries run only with `--select`. Export the keys in your
   own shell (never paste them into a chat); a model whose key is missing is skipped, not logged.
3. **Run.**
   ```bash
   export OLLAMA_BASE_URL=http://172.24.16.1:11434/v1   # from WSL; 127.0.0.1 on Windows
   uv run --with openai --with anthropic --with jsonschema python -I run.py \
       --matrix models.json --prompt prompt-v3.md --packets packets-v2 --runs 5 --round $R
   # one model: --select openai:gpt-6.1-terra   ad hoc: --model provider:model (price from SPIKE_PRICE)
   ```
   Cost per run is logged; 20 runs (4 packets × 5) cost about $0.13 with terra and $0.03 with luna.
4. **Read the numbers.** `python3 -I summarize.py table --round $R`
5. **Blind rating.** `python3 -I summarize.py blind --round $R --per 1 --name $R`, rate `blind/$R.md` (a 1–5
   number after each **Score:**, notes after it), then `python3 -I summarize.py scores --name $R`.
6. **Write it up** in `docs/coach-llm/local-llm-spike.md` (or a new round doc) and commit `results/`.

## Improving the prompt or the packets

Change one thing per round (a new prompt file or a new packet set, never an edit in place), so the
comparison stays fair and the old runs stay checkable. `summarize.py table` re-runs the guard on every stored
output, so a guard change applies to all rounds without new model calls.
