# Local LLM spike (vroom-9ki.17)

Standalone script, not a test: it calls real models. Write-up: `docs/coach-llm/local-llm-spike.md`.

| File | What |
|---|---|
| `build-packets.mjs` | Builds `packets/*.json` from the Spa mock with the mock API's corner facts (`node spikes/local-llm/build-packets.mjs`, needs `npm ci` in `frontend/`) |
| `packets/` | 4 hand-built facts packets (design §8): 2 × analyze, 1 × average, 1 × corner with trace data |
| `prompt.md` | Persona, hard rules and commands: the system prompt every model gets |
| `guard.py` | Number guard (every number in the prose must be in the packet) with failure reasons, plus the copied-field contract |
| `run.py` | Runs each packet N times per model (`ollama:`, `openai:`, `anthropic:`), one retry on a guard failure, logs `results/runs.jsonl` |
| `summarize.py` | `table` prints the results table; `blind` writes `blind/sheet.md` and `blind/key.json` |

```bash
cd spikes/local-llm
# Ollama on Windows; from WSL use the NAT gateway instead of 127.0.0.1
export OLLAMA_BASE_URL=http://172.24.16.1:11434/v1
uv run --with openai --with anthropic --with jsonschema python -I run.py --model ollama:gpt-oss-20b-nommap --runs 5
# hosted, OpenAI (or any OpenAI-compatible host via OPENAI_BASE_URL); SPIKE_PRICE = $ per 1M input,output tokens
OPENAI_API_KEY=... SPIKE_PRICE=<in>,<out> uv run --with openai --with anthropic --with jsonschema python -I run.py --model openai:<model> --runs 5
uv run --with openai --with anthropic --with jsonschema python -I run.py --model anthropic:claude-sonnet-5-5 --runs 5  # needs ANTHROPIC_API_KEY
python3 -I summarize.py table
python3 -I summarize.py blind --per 2
```
