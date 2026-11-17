# Spike: a local LLM for the post-session coach (vroom-9ki.17)

**Question.** Can a local model under Ollama on the RX 7800 XT (16 GB) phrase the coach's facts packets
well enough, compared with a hosted model? (The design's default is `claude-sonnet-5-5` / `claude-haiku-5-5`;
this spike compared against OpenAI's equivalent tier, see Setup.)

**Status (2026-11-17): measured, awaiting the user's ratings.** One local model (gpt-oss-20b, 40 runs on 4
packets with 2 prompt versions) against one hosted model (OpenAI gpt-6.1-sol, 20 runs; the user has OpenAI
credit and none on Anthropic). Still to do, by the user: VRAM with LMU open in its menus, the blind ratings,
and the hosted-fallback question. The recommendation below is provisional until then.

Prototype: `spikes/local-llm/` (see its `README.md`). No code under `backend/` (there is none yet).

## Setup

| What | Value |
|---|---|
| Engine | Ollama **0.40.15**, native on Windows (installed 2026-11-10 for Sure, see the local-LLM handover), ROCm backend |
| Reached from | WSL, through the NAT gateway `http://172.24.16.1:11434/v1` (OpenAI-compatible endpoint). The issue asked for the script to run on Windows; WSL works because the firewall rule "Ollama (WSL only)" already exists, and the timings are Ollama's, not the network's |
| Model | `gpt-oss-20b-nommap:latest` = `gpt-oss:20b` (20.9 B, MXFP4) with `use_mmap false`; digest `0bebdce7…`; **Apache-2.0** |
| GPU offload | `ollama ps`: `size_vram` = `size` = **12.74 GB**, i.e. 100 % on the GPU, no CPU spill; context 16 384 |
| Structured output | `response_format: json_schema` (strict), grammar-enforced by llama.cpp |
| Sampling | temperature 0.7, reasoning effort left at gpt-oss's default (medium) |
| Hosted | **OpenAI** for this spike (the user has OpenAI credit and no Anthropic credit). `openai:<model>` uses the same OpenAI-SDK client as Ollama, with a JSON-schema `response_format`; `OPENAI_BASE_URL` also points it at OpenRouter, Groq and other OpenAI-compatible hosts. `anthropic:<id>` is kept for later. Cost is logged per call (`SPIKE_PRICE` for non-Claude models). Run by the user with their key, model `gpt-6.1-sol` ($2 / $10 per M tokens, chosen as the match for the design's strong tier) |

### Packets (`spikes/local-llm/packets/`)

Built by `build-packets.mjs` from the real Spa recording of 3 Nov, using the mock API's own corner facts
(`cornerComparison`, landmark phrases), so they follow design §8: facts computed in code, positions as
landmark phrases, every number pre-formatted as a string.

| Packet | Command | Content | Input tokens |
|---|---|---|---|
| `analyze-lap2-vs-lap4` | analyze | lap 2 (2:22.139) vs lap 4 (2:21.525): 3 issues, 1 minor, 1 strength | 2 300 |
| `analyze-lap3-vs-lap4` | analyze | lap 3 vs lap 4: 3 issues, 1 minor, 1 strength | 2 300 |
| `average-session` | average | 4 valid laps, lap sd 0.259 s, the 3 most variable corners | 1 270 |
| `corner-lap2-stavelot` | corner | Stavelot facts plus a 10 m trace of both laps (speed, pedals, steering, gear) | 2 670 |

### Prompt and schema

`prompt.md` is the design's persona (blunt, encouraging on improvements), the hard rules (never calculate,
every number from the facts, no metre distances in a fix, say when ambiguous) and the three commands.
`prompt-v2.md` adds a "Writing" section: no field names in prose, a full sentence for every `what` and `fix`,
corner names as given, and one example finding.

The schema is the part of `CoachResult` the LLM writes (`summary`, `findings[]` with `corner_id`, `corner`,
`kind`, `time_s`, `what`, `fix`, `cue_type`, `evidence`, then `focus`, `encouragement`). Ids, `reviewed`,
`stats`, `cost_usd` and `created_at` are filled in by code.

### Checks (`guard.py`)

- **Number guard:** every number in the prose must appear in the packet as written. A failure is classified
  as `format` (0.3 vs 0.30), `rounding` (0.141 → 0.14), `calculated` (sum or difference of two packet numbers),
  `invented` or `metres`. One retry, which names the bad numbers.
- **Contract:** one finding per packet corner, with `corner_id`, `kind` and `time_s` copied correctly.
- **Prose lint** (added after reading the first outputs): an empty or under-4-word `what`/`fix`, or a raw
  packet field name (`steering_extrema`) in the prose.

## Results

5 runs per packet, model and prompt. TTFT counts any first token, including reasoning (gpt-oss streams its
reasoning first). "First JSON" is the first token of the answer itself, which is what a UI could start showing.
gpt-6.1-sol was run with the v1 prompt only; it was already clean with it.

| Model | Prompt | Packet | Schema valid | Guard 1st try | After retry | Contract | Prose clean | First JSON s | Total s (median) | Output tok | Cost $ (5 calls) |
|---|---|---|---|---|---|---|---|---|---|---|---|
| gpt-oss-20b (local) | v1 | analyze lap 2 | 5/5 | 5/5 | 5/5 | 5/5 | 0/5 | 10.5 | 17.4 | 1 568 | 0 |
| gpt-oss-20b (local) | v1 | analyze lap 3 | 5/5 | 5/5 | 5/5 | 5/5 | 1/5 | 15.7 | 23.2 | 2 097 | 0 |
| gpt-oss-20b (local) | v1 | average | 5/5 | 5/5 | 5/5 | 5/5 | 1/5 | 4.2 | 8.0 | 717 | 0 |
| gpt-oss-20b (local) | v1 | corner (trace) | 5/5 | 5/5 | 5/5 | 5/5 | 2/5 | 9.0 | 11.0 | 914 | 0 |
| gpt-oss-20b (local) | v2 | analyze lap 2 | 5/5 | 5/5 | 5/5 | 5/5 | 3/5 | 16.1 | 25.9 | 2 304 | 0 |
| gpt-oss-20b (local) | v2 | analyze lap 3 | 5/5 | 5/5 | 5/5 | 5/5 | 3/5 | 23.6 | 34.1 | 3 009 | 0 |
| gpt-oss-20b (local) | v2 | average | 5/5 | 5/5 | 5/5 | 5/5 | 4/5 | 9.6 | 14.5 | 1 292 | 0 |
| gpt-oss-20b (local) | v2 | corner (trace) | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 7.5 | 10.0 | 908 | 0 |
| gpt-6.1-sol (OpenAI) | v1 | analyze lap 2 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 4.7 | 15.6 | 1 069 | 0.076 |
| gpt-6.1-sol (OpenAI) | v1 | analyze lap 3 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 4.9 | 16.0 | 1 098 | 0.078 |
| gpt-6.1-sol (OpenAI) | v1 | average | 5/5 | 5/5 | 5/5 | 5/5 | 4/5 | 2.2 | 8.0 | 542 | 0.039 |
| gpt-6.1-sol (OpenAI) | v1 | corner (trace) | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 2.6 | 6.5 | 290 | 0.043 |
| gpt-6-luna (OpenAI) | v1 | analyze lap 2 | 5/5 | 5/5 | 5/5 | 5/5 | 2/5 | 11.1 | 16.8 | 1 943 | 0.006 |
| gpt-6-luna (OpenAI) | v1 | analyze lap 3 | 5/5 | 5/5 | 5/5 | 5/5 | 1/5 | 12.8 | 18.9 | 2 198 | 0.006 |
| gpt-6-luna (OpenAI) | v1 | average | 5/5 | 5/5 | 5/5 | 5/5 | 0/5 | 4.7 | 7.5 | 859 | 0.003 |
| gpt-6-luna (OpenAI) | v1 | corner (trace) | 5/5 | 5/5 | 5/5 | 5/5 | 2/5 | 7.4 | 9.0 | 890 | 0.004 |
| gpt-6-luna (OpenAI) | v2 | analyze lap 2 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 15.4 | 21.5 | 2 359 | 0.007 |
| gpt-6-luna (OpenAI) | v2 | analyze lap 3 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 17.5 | 23.5 | 2 571 | 0.007 |
| gpt-6-luna (OpenAI) | v2 | average | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 5.8 | 8.8 | 904 | 0.003 |
| gpt-6-luna (OpenAI) | v2 | corner (trace) | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 6.9 | 8.7 | 825 | 0.004 |

Totals: gpt-oss **4/20** clean with v1 and **15/20** with v2; gpt-6.1-sol **19/20** with v1; gpt-6-luna **5/20**
with v1 (nearly all misses were field names in `evidence`) and **20/20** with v2. gpt-6.1-sol costs
about **1.2 cents a call** ($2 / $10 per M tokens, `SPIKE_PRICE=2,10`), $0.24 for its 20 runs; gpt-6-luna about
**0.1 cents a call** ($0.10 / $0.50), about $0.02 for 20.

- **Packet bug found by the hosted model.** The first Corner packet rounded the normalised steering (−1..1) to
  whole numbers, so the trace showed 0 everywhere. gpt-6.1-sol said so ("the summary reports 5 extrema versus
  3, but the trace shows only 0 steering"); gpt-oss didn't notice. The packet now gives steering in % of
  lock, and the Corner rows above are re-runs on the fixed packet (the old rows are kept in
  `results/runs-corner-steering-bug.jsonl`).
- **Throughput (local):** 91 tokens/s median (88–92), matching the 2026-11-10 handover's 85–95. Cold load
  (model not in VRAM): 43–50 s to the first token; Ollama unloads after 5 idle minutes by default.
- **Guard failure reasons:** none for either model. Every run passed first time, so the retry path never ran
  on a real failure. (An early guard bug failed the Corner packet; the stored outputs were re-checked after
  the fix, see `summarize.py`.)
- **Every model leans on "use the exit kerb as your cue"**, because the exit kerb is often the only landmark
  in the packet and the packet doesn't say what each landmark is for. That's a packet problem for vroom-9ki.12,
  not a model one.
- **What the guard misses:**
  - One subtraction in gpt-oss's 40 runs ("drops your exit speed by 4 km/h", 151 − 147) passed, because "4"
    appears elsewhere in the packet (a gear). A string guard can't catch small integers; the real guard
    (vroom-9ki.12) should check numbers per finding against that corner's facts only.
  - Prose quality. gpt-oss with v1 left `what`/`fix` empty or one-word ("steering"), or used field names
    ("Reduce steering_extrema when exiting the kerb"). v2 fixed most of that. gpt-6.1-sol's one miss was
    field names (`sd_s`) in Average evidence.
  - Physics. gpt-oss with v2 said "turn in at the exit kerb" in 7/20 runs, copied from the prompt's example,
    which mentioned an exit kerb. The packets list landmarks by label only ("exit kerb"), so a model can't
    tell a turn-in cue from an exit cue. The packet should say what each landmark is for, and the example
    should not name a landmark.
- **Reading the outputs** (not a rating):
  - *gpt-oss-20b* restates the summary numbers correctly ("You lost 0.141 s at Stavelot because you steered
    too much, keeping the minimum speed 110 km/h versus 112 km/h"). Its fixes are generic ("hold a steady
    input") and sometimes contradict the facts ("brake later" or "brake earlier" where the braking point is
    the same). On the Corner packet it doesn't use the trace.
  - *gpt-6.1-sol* uses the trace: "After the apex, you add steering back in while throttle falls from 58% to
    42%; the reference unwinds more steadily and builds from 75% to 100%." Fix: "build throttle as the
    steering opens, rather than forcing the throttle through a correction". It says what the data can't
    establish, often enough that it can read as hedged rather than the persona's "blunt". The blind ratings
    decide whether that's a problem.
  - *gpt-6-luna* sits in between. It uses the trace ("throttle at 58% then 42% before reaching 100%, while
    the reference goes from 75% to 100%") but explains less than gpt-6.1-sol, and quotes field names in its
    evidence. It writes about twice as many tokens as gpt-6.1-sol, so it is slower (7.5–19 s) despite being the
    small tier.

### Not yet measured

| Item | Why not | How |
|---|---|---|
| 2nd and 3rd local model | each is a 10–16 GB download onto the Windows box, and loading it evicts Sure's model | candidates from the handover's 2026-11-10 survey: `gemma4:26b-a4b-it-qat` (Gemma licence, 16 GB, slight CPU spill) and a ~14 B Qwen instruct at Q4 (Apache-2.0; check the exact tag and licence in the Ollama library). Lower priority now: they'd have to beat gpt-oss by a wide margin |
| VRAM with LMU open in its menus, and LMU's own VRAM | needs LMU running | Task Manager → GPU → dedicated memory: LMU alone, then LMU + `ollama ps` after one call. gpt-oss alone holds 12.74 GB of the 16 GB, so it probably won't fit next to LMU without spilling to the CPU |
| Blind ratings | need the user | `python3 -I summarize.py blind --per 2`, rate `blind/sheet.md` 1–5, then open `blind/key.json` |
| llama.cpp Vulkan rerun | not needed: ROCm already gives 91 tok/s, and the handover measured Vulkan at 68 | – |
| Anthropic (the design's default) | no Anthropic credit | `run.py --model anthropic:claude-sonnet-5-5`; same price as gpt-6.1-sol |

## Options

1. **Hosted default, provider configurable.** OpenAI for now (the user has credit there), Anthropic or a local
   model one setting away; strong tier gpt-6.1-sol (Analyze, Corner), fast tier gpt-6-luna (Average, or
   everything if its prose rates well). Best prose, uses the trace, about 0.1–1.2 cents a call, and nothing
   depends on the GPU being free. Packets leave the PC.
2. **Local default, hosted fallback when the GPU is busy** (or split by command: local for Average, hosted
   for Analyze and Corner). Free, and reliable in format (40/40 schema-valid and guard-clean). But it is
   slower (8–34 s, plus a 43–50 s cold load), probably can't share VRAM with LMU, needs the v2 prompt to write
   usable prose, and doesn't use the Corner trace.
3. **Local only.** No cost and no data leaves the PC, but the coach is unavailable whenever LMU (or anything
   else) holds the GPU, and the deep dive (Corner) is noticeably weaker.

## Recommendation (provisional)

**Change:** local isn't good enough to be the default, but keep it as an option. Build vroom-9ki.11 with the
provider as a setting and a hosted default (option 1), with a strong and a fast model as the design already
plans. At 0.1–1.2 cents a call, the cost is small next to the quality gap, which is widest on the Corner command, the one place the coach reads raw telemetry. Keep the local
path (`llm_provider: "ollama"`) for anyone who wants offline or free use: its format and grounding were
perfect in 40 runs. Final call after the blind ratings and the fallback question below.

Config change for vroom-9ki.11, which makes the provider configurable whichever model wins:

```python
llm_provider: Literal["anthropic", "openai", "gemini", "ollama"] = "anthropic"
llm_base_url: str | None = None  # "ollama" defaults to http://127.0.0.1:11434/v1; with "openai" it reaches any
                                 # OpenAI-compatible host (OpenRouter, Groq ...)
llm_strong: str = "claude-sonnet-5-5"  # e.g. "gpt-oss-20b-nommap" with ollama
llm_fast: str = "claude-haiku-5-5"
```

Map `"ollama"` to Pydantic AI's OpenAI-compatible model with `base_url`. Use JSON-schema structured output
(`response_format`) rather than tool calls; the handover saw a malformed nested tool call. `cost_usd` stays
`None` for local calls. The spike's `run.py` already has this shape: one OpenAI-compatible client for
`ollama:` and `openai:`, and Anthropic's own SDK for `anthropic:`. The design's Anthropic default is a
separate decision and stays as it is until the comparison is in.

Lessons for vroom-9ki.12 (coach packets and guard), whichever model wins:
- Use plain-English keys in the packet ("minimum speed"), not snake_case; models quote keys back.
- Give each landmark its role ("exit kerb, after the apex"), not only its label.
- Check numbers per finding against that corner's facts, so that small integers from elsewhere in the
  packet can't hide a calculation.
- Add a prose check (empty or one-word `what`/`fix`, field names) next to the number guard.

## Question for the user (before the final recommendation)

The issue asked: is a **hosted fallback OK when the GPU is busy**, or should the coach be **local-only**? With
these results the question becomes: is **hosted by default** OK (0.1–1.2 cents a call, with the facts packets
sent to OpenAI or Anthropic)? If yes, option 1. If you'd rather pay nothing when the GPU is free, option 2.
Local-only means option 3, and the coach waits until LMU is closed.
