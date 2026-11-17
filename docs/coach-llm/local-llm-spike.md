# Spike: a local LLM for the post-session coach (vroom-9ki.17)

**Question.** Can a local model under Ollama on the RX 7800 XT (16 GB) phrase the coach's facts packets
well enough, compared with a hosted model? (The design's default is `claude-sonnet-5-5` / `claude-haiku-5-5`;
this spike compared against OpenAI's equivalent tier, see Setup.)

**Status (2026-11-17): measured and rated; recommendation below.** One local model (gpt-oss-20b) against
three OpenAI tiers (gpt-6.1-sol, gpt-6.1-terra, gpt-6-luna; the user has OpenAI credit and none on Anthropic),
over 4 facts packets, 3 prompt versions and 2 packet sets, 5 runs each, 195 logged runs (about $0.64 of
OpenAI credit). Two blind rating rounds by the user. Not measured: VRAM with LMU open (see the end).

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
| gpt-6.1-terra (OpenAI) | v2 | analyze lap 2 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 6.1 | 13.3 | 1 048 | 0.038 |
| gpt-6.1-terra (OpenAI) | v2 | analyze lap 3 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 7.2 | 15.2 | 1 166 | 0.041 |
| gpt-6.1-terra (OpenAI) | v2 | average | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 3.7 | 7.8 | 566 | 0.021 |
| gpt-6.1-terra (OpenAI) | v2 | corner (trace) | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 5.5 | 7.5 | 505 | 0.027 |

Totals: gpt-oss **4/20** clean with v1 and **15/20** with v2; gpt-6.1-sol **19/20** with v1; gpt-6-luna **5/20**
with v1 (nearly all misses were field names in `evidence`) and **20/20** with v2; gpt-6.1-terra **20/20** with v2. gpt-6.1-sol costs
about **1.2 cents a call** ($2 / $10 per M tokens, `SPIKE_PRICE=2,10`), $0.24 for its 20 runs; gpt-6-luna about
**0.1 cents a call** ($0.10 / $0.50), about $0.02 for 20; gpt-6.1-terra about **0.6 cents a call** ($1 / $5),
$0.13 for 20. All OpenAI runs together cost about $0.45.

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
  - *gpt-6.1-terra* is close to gpt-6.1-sol on the trace ("After the apex, your throttle drops from 58% to 42%
    as you add steering again, while the reference reaches 100% throttle sooner … the trace does not establish
    what caused the throttle lift"), with plainer fixes ("aim for a smoother, steadier steering input through
    the apex"). It writes half the tokens luna does, so it's faster than luna (7.5–15 s) at half sol's price.

### Blind ratings (round 1)

The user rated 24 samples (one per model, prompt and packet; model names hidden until all were scored) 1–5 on
"does it read like a race engineer?". Scores are in `spikes/local-llm/results/blind-scores-sheet.json`.

| Model / prompt | Mean | Analyze ×2 | Average | Corner |
|---|---|---|---|---|
| gpt-6.1-terra / v2 | **3.6** | 3.5, 4 | 3 | 4 |
| gpt-6-luna / v2 | 3.25 | 4, 3 | 3 | 3 |
| gpt-oss-20b (local) / v2 | 3.25 | 3, 4 | 3 | 3 |
| gpt-6-luna / v1 | 2.25 | 3, 3 | 1 | 2 |
| gpt-6.1-sol / v1 | 2.0 | 1, 2 | 1 | 4 |
| gpt-oss-20b (local) / v1 | 1.5 | 1, 1 | 1 | 3 |

- **The prompt mattered more than the model.** Every v2 run rated 3.25–3.6, every v1 run 1.5–2.25. With v2
  the local gpt-oss tied with gpt-6-luna.
- **Hedging costs points.** gpt-6.1-sol, the most expensive tier, rated near the bottom: none of its 20 runs is
  free of phrases like "does not establish" or "only a clue" (the "Hedge-free" column of `summarize.py table`:
  sol 0/20, terra 4/20, luna 13/20 with v2, gpt-oss 40/40). Only its Corner deep dive rated well (4).
- **The rater's notes:** remove field-name jargon ("steering_extrema"); values written as "110 / 112" are hard
  to read (that format came from the v2 prompt's example).
- This led to packet set v2 and prompt v3 (below).

### Round 2: packet set v2 and prompt v3

**Packet set v2** (`packets-v2/`, built by the same script) adds, per corner and for both laps: seconds with
ABS and traction control working, where a wheel locked or a rear wheel spun, seconds on the rev limiter (from
the setup's 8,000 rpm), peak rpm, gear at the slowest point and seconds on a kerb; a code-computed `cause` with
`cause_confidence` (high / medium / low, from how clearly `causeOf`'s top score wins) and the reason it rests
on; landmarks with their role ("100 board (braking reference, before the apex)"). Average gets each variable
corner's fastest and slowest lap side by side. The Corner trace gains rpm, ABS, TC and kerb columns. On these
laps nobody touched the rev limiter or locked a wheel, and the packets say so, so no model can invent it.

**Prompt v3** states a high or medium cause as fact, bans disclaimers ("does not establish"), says how to
coach from the aid and engine facts (more ABS time: ease the pedal after the initial hit; more TC time: a more
progressive throttle; limiter time: a late upshift), bans field names by name and has no example finding.

| Model (v3, packets v2) | Guard 1st try / after retry | Prose clean | Hedge-free | "a / b" values | Uses aid or engine facts | Total s | Cost (20 runs) |
|---|---|---|---|---|---|---|---|
| gpt-6.1-terra | 20/20 / 20/20 | **20/20** | **20/20** (v2: 4/20) | 0/20 | 15/20 | 5.5–17 | ≈ $0.15 |
| gpt-6-luna | 20/20 / 20/20 | **20/20** | **20/20** | 0/20 | 10/20 | 5.8–29 | $0.026 |
| gpt-oss-20b (local) | 19/20 / 20/20 | 4/20 | 20/20 | 0/20 | 6/20 | 11.7–26.5 | 0 |

- **Hedging is gone** for every model, with no loss of number grounding.
- **The retry earned its keep once:** gpt-oss wrote "11 km/h" (169 − 158, a calculation); the guard caught it
  and the retry fixed it.
- **gpt-oss still writes field names** (`steering_extrema`, `abs_active_s`) despite the explicit ban, and its
  fixes stay generic ("Smooth steering at the exit kerb").
- Example, terra on Average: "You're losing consistency on the steering at Fagnes 2, with more corrections on
  your slowest lap. Traction control also worked longer on that lap." Fix: "Match the calmer steering of lap 2
  and feed the throttle in more progressively on exit."

### Blind ratings (round 2: v3 prompt, v2 packets)

12 samples, one per model and packet, names hidden (`results/blind-scores-sheet-round2.json`):

| Model | Mean | Analyze ×2 | Average | Corner |
|---|---|---|---|---|
| **gpt-6.1-terra** | **4.0** | 4, 4 | 4 | 4 |
| gpt-6-luna | 3.0 | 3, 3 | 3 | 3 |
| gpt-oss-20b (local) | 1.25 | 3, 2 | 0 | 0 |

gpt-oss's two zeros are empty `what`/`fix` strings (2 of its 20 v3 runs; the schema allows empty strings and
the prose check isn't a retry trigger yet). The rater's note on another: "almost good, just need to flesh out
the steering_extrema usage". terra went from 3.6 (round 1) to 4.0, luna from 3.25 to 3.0.

### Round 3: DeepSeek against terra and luna (vroom-9ki.19, 2026-11-18)

Same prompt (v3), same packets (v2, Spa), 5 runs per packet, round tag `2026-11-18-deepseek`. terra and luna were
re-run in the same round so the blind sheet mixes all four. DeepSeek takes JSON mode only (`json_object`): the
schema is in the prompt and the bench validates afterwards, so schema-valid is a real measurement. Costs use the
peak-hour prices in `models.json`; off-peak is half.

| Model | Schema valid | Guard, 1st try | Prose clean | Hedge-free | Median total s | Cost per call |
|---|---|---|---|---|---|---|
| gpt-6.1-terra | 20/20 | 20/20 | 20/20 | 20/20 | 5.9–16.4 | 0.83 cents |
| gpt-6-luna | 20/20 | 20/20 | 20/20 | 20/20 | 7.5–20.7 | 0.12 cents |
| deepseek-flash | 20/20 | 19/20 (1 "calculated", fixed by the retry) | 20/20 | 20/20 | 7.2–14.4 | 0.43 cents |
| deepseek-v4-pro | 18/20 (2 schema failures, both on Analyze) | 18/20 | 18/20 | 18/20 | 18.0–70.2 | 2.3 cents |

Both DeepSeek models spend most of the time before the first JSON token (flash 6.6–10.6 s, V4 Pro 16.8–64.9 s) although
the first streamed token arrives in under a second: they reason first. That also makes V4 Pro cost about twice the
estimate in the issue (1.8k–7.8k output tokens per call, against about 1k for terra).

Blind ratings, 16 samples, one per model and packet (Analyze has two), names hidden
(`results/blind-scores-2026-11-18-deepseek.json`):

| Model | Mean | Analyze ×2 | Average | Corner |
|---|---|---|---|---|
| **gpt-6.1-terra** | **4.38** | 4.5, 4 | 4.5 | 4.5 |
| deepseek-flash | 4.25 | 4, 5 | 4.5 | 3.5 |
| gpt-6-luna | 4.00 | 3, 4.5 | 4 | 4.5 |
| deepseek-v4-pro | 3.75 | 4.5, 3 | 3.5 | 4 |

One rating per cell is noisy (luna scored 3.0 in round 2 and 4.0 here with the same prompt), so differences under a
point mean little. The one written note, on V4 Pro: "almost good, but specifying the number of steering corrections
might not be easily actionable".

**Reading.** deepseek-flash is as good as terra within the noise at about half the price, with perfect schema
validity and prose. It is not cheaper than luna (3.5 times the price) and is slower to the first JSON token.
V4 Pro is the worst on every axis: slowest, 2.3 cents a call (almost three times terra), rated lowest, and the only model
to fail the schema.

**Recommendation: keep OpenAI as the default** (strong terra, fast luna). Neither DeepSeek model beats the
current pair on the axis that matters: flash is not clearly better than luna's price, and V4 Pro is worse than terra on
cost, speed and rating. Do not use V4 Pro. DeepSeek flash is a good optional "strong" setting for anyone who prefers
that host (`llm_provider: "openai"` with `llm_base_url: "https://api.deepseek.com"`, JSON mode, the schema in the prompt,
and the one retry on schema or guard failure); it is untested on Monza and on the corner packet's weaker rating (3.5).

### Not yet measured

| Item | Why not | How |
|---|---|---|
| 2nd and 3rd local model | each is a 10–16 GB download onto the Windows box, and loading it evicts Sure's model | candidates from the handover's 2026-11-10 survey: `gemma4:26b-a4b-it-qat` (Gemma licence, 16 GB, slight CPU spill) and a ~14 B Qwen instruct at Q4 (Apache-2.0; check the exact tag and licence in the Ollama library). Lower priority now: they'd have to beat gpt-oss by a wide margin |
| VRAM with LMU open in its menus, and LMU's own VRAM | needs LMU running | Task Manager → GPU → dedicated memory: LMU alone, then LMU + `ollama ps` after one call. gpt-oss alone holds 12.74 GB of the 16 GB, so it probably won't fit next to LMU without spilling to the CPU |
| Blind ratings | need the user | `python3 -I summarize.py blind --per 2`, rate `blind/sheet.md` 1–5, then open `blind/key.json` |
| llama.cpp Vulkan rerun | not needed: ROCm already gives 91 tok/s, and the handover measured Vulkan at 68 | – |
| Anthropic (the design's default) | no Anthropic credit | `run.py --model anthropic:claude-sonnet-5-5`; same price as gpt-6.1-sol |

## Repeating the exercise

The bench is built to be re-run as telemetry, prompts and providers change; `spikes/local-llm/README.md` has
the steps. In short: packets from any mock recording and lap pairs (`build-packets.mjs --track`; Spa and Monza
so far), models from `models.json` (any OpenAI-compatible host is a config entry: OpenRouter, Groq and Gemini
templates are there, untested; DeepSeek too, through JSON mode with the schema in the prompt, since its chat API has no JSON-schema output), runs tagged by round, and `summarize.py` for the table, the blind sheet and
the unblinded scores. Monza packets (both sets) are built but haven't been through the paid models yet.

Room for improvement, for the next rounds:
- Run the Monza packets, and a Spa session where the car does hit the limiter or lock a wheel (none in these laps).
- Try the design's Anthropic default and a larger open model (gpt-oss-120b on Groq) when there's a key for them.
- A packet set v3 with plain-English keys, "110 km/h against 112" values and per-finding number scopes
  (see the lessons below), against prompt v3.
- More samples per cell in the blind rounds (one per model and packet is thin).

## Options

1. **Hosted default, provider configurable.** OpenAI for now (the user has credit there), Anthropic or a local
   model one setting away. Strong tier gpt-6.1-terra (Analyze, Corner; rated 4.0, about 0.6 cents a call), fast
   tier gpt-6-luna (Average; rated 3.0, about 0.1 cents a call). Uses the trace and the aid facts, no hedging,
   nothing depends on the GPU being free. Facts packets leave the PC.
2. **Local default, hosted fallback when the GPU is busy.** Free when the GPU is idle and reliable in number
   grounding, but rated 1.25–3.25, writes field names despite the ban, sometimes leaves a finding empty, takes
   12–27 s plus a 43–50 s cold load, and probably can't share VRAM with LMU.
3. **Local only.** No cost and no data leaves the PC, but the coach waits until LMU is closed and reads clearly
   worse than the hosted tiers.

## Recommendation

**Change.** A local model on the 7800 XT is not good enough to be the coach's default; keep it as an option.
Build vroom-9ki.11 with the provider and models as settings and a hosted default: **strong = gpt-6.1-terra,
fast = gpt-6-luna** on OpenAI for now (option 1). Anthropic stays one setting away (the design's
Sonnet/Haiku default was not measured: no Anthropic credit), and so does Ollama (`llm_provider: "ollama"`)
for offline or free use, where gpt-oss-20b's number grounding held in every run. Use the v2 packet shape and
the v3 prompt as the starting point for vroom-9ki.12.

Config change for vroom-9ki.11, which makes the provider configurable whichever model wins:

```python
llm_provider: Literal["anthropic", "openai", "gemini", "ollama"] = "openai"
llm_base_url: str | None = None  # "ollama" defaults to http://127.0.0.1:11434/v1; with "openai" it reaches any
                                 # OpenAI-compatible host (OpenRouter, Groq ...)
llm_strong: str = "gpt-6.1-terra"  # Analyze, Corner. e.g. "claude-sonnet-5-5" with anthropic, "gpt-oss-20b-nommap" with ollama
llm_fast: str = "gpt-6-luna"      # Average. e.g. "claude-haiku-5-5" with anthropic
```

Map `"ollama"` to Pydantic AI's OpenAI-compatible model with `base_url`. Use JSON-schema structured output
(`response_format`) rather than tool calls; the handover saw a malformed nested tool call. `cost_usd` stays
`None` for local calls. The spike's `run.py` already has this shape: one OpenAI-compatible client for
`ollama:` and `openai:`, and Anthropic's own SDK for `anthropic:`. Changing the default from Anthropic to OpenAI
updates design line 29 (defaults `claude-sonnet-5-5` / `claude-haiku-5-5`); cost logging needs OpenAI prices
(genai-prices covers them).

Lessons for vroom-9ki.12 (coach packets and guard), whichever model wins:
- Use plain-English keys in the packet ("minimum speed"), not snake_case; models quote keys back.
- Give each landmark its role ("exit kerb, after the apex"), not only its label.
- Check numbers per finding against that corner's facts, so that small integers from elsewhere in the
  packet can't hide a calculation.
- Add a prose check (empty or one-word `what`/`fix`, field names, hedging phrases) next to the number guard,
  and let it trigger the same one retry. Give `what` and `fix` a `minLength` in the schema.
- Compute the cause and its confidence in code and pass both; the prompt states a high or medium cause as
  fact. That removed hedging for every model (sol 0/20 hedge-free with v1, terra 20/20 with v3).
- Add per corner: ABS and TC time, lockup and wheelspin location, rev-limiter time, gear at the slowest
  point, kerb time; for Average, the fastest and slowest lap side by side (`packets-v2/`).
- Write paired values as "110 km/h against 112", not "110 / 112" (the rater found the latter hard to read).

## Decision (the user, 2026-11-17)

**Change.** The coach stays hosted, with the provider and models as settings (option 1):

- **Default: OpenAI**, strong `gpt-6.1-terra` (Analyze, Corner), fast `gpt-6-luna` (Average), as in the config
  above. Hosted by default is fine at well under a cent a call.
- **Local (Ollama) stays an option**, not the default or a fallback. So **VRAM with LMU open was not measured**:
  it only matters for running a local model next to the game, which is no longer the plan. gpt-oss-20b alone
  holds 12.74 GB of the 16 GB, for whoever picks that up.
- **DeepSeek** (`deepseek-flash`, `deepseek-v4-pro`; JSON mode with the schema in the prompt) was checked later in
  vroom-9ki.19 (round 3 above): OpenAI stays the default. Anthropic, the design's original default, stays one setting away and unmeasured.
- The bench (`spikes/local-llm/`) stays for later rounds: more recordings, prompt and packet versions, providers.

## Round 4: packet set v3

Round tag `2026-11-18-r4`. Prompt v3 with packet sets v2 and v3 on Spa and Monza, 5 runs per packet, three models
(gpt-6.1-terra, gpt-6-luna, deepseek-flash): 240 runs, about $1.10 in all: terra $0.64, luna $0.10, flash $0.35.

**What v3 is.** `build-packets.mjs` writes `packets-v3/` (Spa) and `packets-v3-monza/` from the v2 packets, which are
unchanged: plain-English keys ("minimum speed"), pairs written `110 km/h against 112`, and an `allowed_numbers` list on
every corner. `guard.py` checks each finding against its own corner's list when there is one (v1 and v2 packets: the whole
packet, as before). By hand: "147 km/h against 151" passes, "4 km/h" (the round-1 subtraction) fails as calculated, a
number from another corner fails as invented. **The v3 guard is therefore stricter than the v2 guard** (a subtraction
that reuses a small number from the corner's own list, such as "2 km/h down" with a gear 2, still passes): equal pass rates
mean v3 held up under the harder check. One limit for vroom-9ki.12: a corner's list leaves out packet-level numbers (lap delta,
lap times, notes), so a finding that quotes one is flagged as invented under v3. No run here hit it.

**Summary** (20 runs per cell, 4 packets × 5):

| Model | Packets | Schema valid | Guard 1st try | After retry | Prose clean | Hedge-free | Cost, 20 runs |
|---|---|---|---|---|---|---|---|
| terra | v2 Spa / v2 Monza | 20/20, 20/20 | 20/20, 20/20 | 20/20, 20/20 | 20/20, 20/20 | 20/20, 20/20 | $0.161 / $0.155 |
| terra | v3 Spa / v3 Monza | 20/20, 20/20 | 20/20, 20/20 | 20/20, 20/20 | 20/20, 20/20 | 20/20, 20/20 | $0.164 / $0.162 |
| luna | v2 Spa / v2 Monza | 20/20, 20/20 | 20/20, 20/20 | 20/20, 20/20 | 20/20, 20/20 | 20/20, 20/20 | $0.026 / $0.026 |
| luna | v3 Spa / v3 Monza | 20/20, 20/20 | 20/20, 20/20 | 20/20, 20/20 | 20/20, 20/20 | 20/20, 20/20 | $0.027 / $0.025 |
| deepseek-flash | v2 Spa / v2 Monza | 19/20, 20/20 | 19/20, 20/20 | 19/20, 20/20 | 19/20, 20/20 | 19/20, 20/20 | $0.082 / $0.086 |
| deepseek-flash | v3 Spa / v3 Monza | 19/20, 20/20 | 18/20, 19/20 | 19/20, 20/20 | 19/20, 20/20 | 19/20, 20/20 | $0.101 / $0.086 |

Cost per call is about 0.8 cents for terra, 0.13 cents for luna and 0.4 to 0.5 cents for flash (the table below shows
the cost of the 5 runs of each row). The one deepseek-flash schema failure per Spa packet set is on `analyze-lap3-vs-lap4` in both
sets, but not the same failure: in v2 a `fix` came back null (DeepSeek's JSON mode checks the schema only afterwards), in
v3 the reply was not valid JSON ("Extra data").

**Reading it.**
- terra and luna were perfect on all 160 runs, v2 and v3, on both tracks, including the stricter v3 guard. Monza
  packets work with no changes.
- Only deepseek-flash separates the sets: with v3 it failed the number guard on its first try twice in 40 runs (one on Spa,
  one on Monza; "calculated" both times, so it still subtracted despite the pairs) against 0 with v2, and a retry fixed
  both. (The schema failure on `analyze-lap3-vs-lap4` shows up in both sets, with different causes.) Its v3 output is longer on Spa (analyze packets: 3,300 to 4,200 tokens against 2,700 to 2,800, Spa cost +23%); on Monza it is
  mixed (one analyze packet longer, one shorter; cost the same).
  Whether the scoped guard would also have flagged those v2 cases is not known: v2 runs were not re-checked with scopes.
- Speed is unchanged between sets for terra and luna (terra 5 to 16 s a call, luna 7 to 24 s, flash 6 to 21 s).

**Blind sheet.** Generated: `spikes/local-llm/blind/2026-11-18-r4.md` (48 samples, one per model × packet set × packet; the
key is `blind/2026-11-18-r4-key.json`; `blind/` is git-ignored). **Ratings are pending**: rate each **Score:** 1 to 5
(notes after it), then `python3 -I summarize.py scores --name 2026-11-18-r4`. No prose-quality conclusion can be
drawn until then.

**Not yet measured.** `anthropic:claude-sonnet-5-5` and `groq:gpt-oss-120b`: `ANTHROPIC_API_KEY` and `GROQ_API_KEY` were
not set. Run, from `spikes/local-llm/`, with the key exported and the same round tag:

```bash
R=2026-11-18-r4
for set in packets-v2 packets-v3 packets-v2-monza packets-v3-monza; do
  uv run --with openai --with anthropic --with jsonschema python -I run.py --matrix models.json --prompt prompt-v3.md \
    --packets $set --runs 5 --round $R --select anthropic:claude-sonnet-5-5   # or groq:gpt-oss-120b
done
```
(Check the Groq model id and price in `models.json` first; they are untested.)

**Recommendation for vroom-9ki.12.** Use **packet set v3**, provisionally. It costs nothing on the strong and fast tiers
(100% on every check under a stricter guard), the per-finding number list is what lets the real number guard check a
finding against its own corner, and the plain keys and pairs remove the need for the model to subtract. The one
downside is deepseek-flash, which got slightly worse on the first try and longer; it stays a non-default model. Confirm
with the blind ratings: if v3 rates below v2 on prose, fall back to v2 and keep only the scoped guard (it works on both).
**Default models do not change** (terra for Analyze and Corner, luna for Average); round 3's flash result is unchanged.

<details><summary>Full table (<code>summarize.py table --round 2026-11-18-r4</code>; cost is for the 5 runs in a row)</summary>

| Model | Packet | n | Schema valid | Guard pass, 1st try | after 1 retry | Contract kept | Prose clean | Hedge-free | Failure reasons | TTFT s (median, warm) | First JSON token s | Total s (median, warm) | Output tokens | Cost $ |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| deepseek:deepseek-flash / prompt-v3.md / packets-v2 | analyze-lap2-vs-lap4 | 5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | – | 0.8 | 9.9 | 13.6 | 2677.0 | 0.0225 |
| deepseek:deepseek-flash / prompt-v3.md / packets-v2 | analyze-lap3-vs-lap4 | 5 | 4/5 | 4/5 | 4/5 | 4/5 | 4/5 | 4/5 | schema 1 | 0.7 | 11.6 | 15.2 | 2799.0 | 0.0232 |
| deepseek:deepseek-flash / prompt-v3.md / packets-v2 | average-session | 5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | – | 0.6 | 6.3 | 10.0 | 1866.0 | 0.0193 |
| deepseek:deepseek-flash / prompt-v3.md / packets-v2 | corner-lap2-stavelot | 5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | – | 0.6 | 7.2 | 8.2 | 1489.0 | 0.0165 |
| deepseek:deepseek-flash / prompt-v3.md / packets-v2-monza | analyze-lap1-vs-lap2 | 5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | – | 0.6 | 9.7 | 14.2 | 3002.0 | 0.0251 |
| deepseek:deepseek-flash / prompt-v3.md / packets-v2-monza | analyze-lap5-vs-lap2 | 5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | – | 0.6 | 10.3 | 13.4 | 2699.0 | 0.0209 |
| deepseek:deepseek-flash / prompt-v3.md / packets-v2-monza | average-session | 5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | – | 0.6 | 9.2 | 11.9 | 2440.0 | 0.0198 |
| deepseek:deepseek-flash / prompt-v3.md / packets-v2-monza | corner-lap5-curvagrande | 5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | – | 0.8 | 12.4 | 13.2 | 2055.0 | 0.0203 |
| deepseek:deepseek-flash / prompt-v3.md / packets-v3 | analyze-lap2-vs-lap4 | 5 | 5/5 | 4/5 | 5/5 | 5/5 | 5/5 | 5/5 | calculated 1 | 0.7 | 13.6 | 16.7 | 4235.0 | 0.0345 |
| deepseek:deepseek-flash / prompt-v3.md / packets-v3 | analyze-lap3-vs-lap4 | 5 | 4/5 | 4/5 | 4/5 | 4/5 | 4/5 | 4/5 | schema 1 | 0.7 | 12.8 | 17.1 | 3295.0 | 0.0288 |
| deepseek:deepseek-flash / prompt-v3.md / packets-v3 | average-session | 5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | – | 0.7 | 10.1 | 13.2 | 2303.0 | 0.0218 |
| deepseek:deepseek-flash / prompt-v3.md / packets-v3 | corner-lap2-stavelot | 5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | – | 0.6 | 5.8 | 6.3 | 1213.0 | 0.0154 |
| deepseek:deepseek-flash / prompt-v3.md / packets-v3-monza | analyze-lap1-vs-lap2 | 5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | – | 0.6 | 18.2 | 20.8 | 4230.0 | 0.0328 |
| deepseek:deepseek-flash / prompt-v3.md / packets-v3-monza | analyze-lap5-vs-lap2 | 5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | – | 0.5 | 6.4 | 9.5 | 2113.0 | 0.0167 |
| deepseek:deepseek-flash / prompt-v3.md / packets-v3-monza | average-session | 5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | – | 0.5 | 7.4 | 9.6 | 1861.0 | 0.0161 |
| deepseek:deepseek-flash / prompt-v3.md / packets-v3-monza | corner-lap5-curvagrande | 5 | 5/5 | 4/5 | 5/5 | 5/5 | 5/5 | 5/5 | calculated 1 | 0.7 | 6.8 | 7.3 | 1366.0 | 0.0205 |
| openai:gpt-6-luna / prompt-v3.md / packets-v2 | analyze-lap2-vs-lap4 | 5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | – | 11.9 | 11.9 | 17.0 | 1929.0 | 0.0069 |
| openai:gpt-6-luna / prompt-v3.md / packets-v2 | analyze-lap3-vs-lap4 | 5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | – | 17.9 | 17.9 | 22.7 | 2559.0 | 0.0080 |
| openai:gpt-6-luna / prompt-v3.md / packets-v2 | average-session | 5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | – | 15.1 | 15.1 | 19.4 | 2101.0 | 0.0070 |
| openai:gpt-6-luna / prompt-v3.md / packets-v2 | corner-lap2-stavelot | 5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | – | 5.1 | 5.1 | 7.0 | 664.0 | 0.0038 |
| openai:gpt-6-luna / prompt-v3.md / packets-v2-monza | analyze-lap1-vs-lap2 | 5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | – | 17.0 | 17.0 | 22.4 | 2363.0 | 0.0082 |
| openai:gpt-6-luna / prompt-v3.md / packets-v2-monza | analyze-lap5-vs-lap2 | 5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | – | 12.8 | 12.8 | 17.2 | 1995.0 | 0.0068 |
| openai:gpt-6-luna / prompt-v3.md / packets-v2-monza | average-session | 5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | – | 14.2 | 14.2 | 17.9 | 1956.0 | 0.0063 |
| openai:gpt-6-luna / prompt-v3.md / packets-v2-monza | corner-lap5-curvagrande | 5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | – | 5.3 | 5.3 | 7.1 | 697.0 | 0.0042 |
| openai:gpt-6-luna / prompt-v3.md / packets-v3 | analyze-lap2-vs-lap4 | 5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | – | 13.2 | 13.2 | 19.0 | 2251.0 | 0.0075 |
| openai:gpt-6-luna / prompt-v3.md / packets-v3 | analyze-lap3-vs-lap4 | 5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | – | 18.7 | 18.7 | 23.7 | 2556.0 | 0.0085 |
| openai:gpt-6-luna / prompt-v3.md / packets-v3 | average-session | 5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | – | 12.8 | 12.8 | 15.9 | 1707.0 | 0.0061 |
| openai:gpt-6-luna / prompt-v3.md / packets-v3 | corner-lap2-stavelot | 5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | – | 6.1 | 6.1 | 7.8 | 754.0 | 0.0044 |
| openai:gpt-6-luna / prompt-v3.md / packets-v3-monza | analyze-lap1-vs-lap2 | 5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | – | 17.3 | 17.3 | 22.2 | 2514.0 | 0.0082 |
| openai:gpt-6-luna / prompt-v3.md / packets-v3-monza | analyze-lap5-vs-lap2 | 5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | – | 10.9 | 10.9 | 15.5 | 1861.0 | 0.0064 |
| openai:gpt-6-luna / prompt-v3.md / packets-v3-monza | average-session | 5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | – | 10.6 | 10.6 | 13.9 | 1569.0 | 0.0055 |
| openai:gpt-6-luna / prompt-v3.md / packets-v3-monza | corner-lap5-curvagrande | 5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | – | 5.2 | 5.2 | 6.6 | 686.0 | 0.0046 |
| openai:gpt-6.1-terra / prompt-v3.md / packets-v2 | analyze-lap2-vs-lap4 | 5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | – | 6.9 | 6.9 | 14.2 | 989.0 | 0.0447 |
| openai:gpt-6.1-terra / prompt-v3.md / packets-v2 | analyze-lap3-vs-lap4 | 5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | – | 9.3 | 9.3 | 16.0 | 1185.0 | 0.0482 |
| openai:gpt-6.1-terra / prompt-v3.md / packets-v2 | average-session | 5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | – | 8.1 | 8.1 | 13.3 | 932.0 | 0.0391 |
| openai:gpt-6.1-terra / prompt-v3.md / packets-v2 | corner-lap2-stavelot | 5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | – | 3.4 | 3.4 | 5.7 | 324.0 | 0.0289 |
| openai:gpt-6.1-terra / prompt-v3.md / packets-v2-monza | analyze-lap1-vs-lap2 | 5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | – | 6.9 | 6.9 | 14.4 | 1117.0 | 0.0463 |
| openai:gpt-6.1-terra / prompt-v3.md / packets-v2-monza | analyze-lap5-vs-lap2 | 5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | – | 4.9 | 4.9 | 11.7 | 858.0 | 0.0384 |
| openai:gpt-6.1-terra / prompt-v3.md / packets-v2-monza | average-session | 5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | – | 6.7 | 6.7 | 12.2 | 862.0 | 0.0385 |
| openai:gpt-6.1-terra / prompt-v3.md / packets-v2-monza | corner-lap5-curvagrande | 5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | – | 2.0 | 2.0 | 5.0 | 257.0 | 0.0317 |
| openai:gpt-6.1-terra / prompt-v3.md / packets-v3 | analyze-lap2-vs-lap4 | 5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | – | 9.3 | 9.3 | 16.2 | 1252.0 | 0.0484 |
| openai:gpt-6.1-terra / prompt-v3.md / packets-v3 | analyze-lap3-vs-lap4 | 5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | – | 7.7 | 7.7 | 15.2 | 1163.0 | 0.0476 |
| openai:gpt-6.1-terra / prompt-v3.md / packets-v3 | average-session | 5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | – | 4.6 | 4.6 | 9.4 | 654.0 | 0.0339 |
| openai:gpt-6.1-terra / prompt-v3.md / packets-v3 | corner-lap2-stavelot | 5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | – | 4.1 | 4.1 | 6.3 | 372.0 | 0.0337 |
| openai:gpt-6.1-terra / prompt-v3.md / packets-v3-monza | analyze-lap1-vs-lap2 | 5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | – | 8.2 | 8.2 | 15.5 | 1159.0 | 0.0477 |
| openai:gpt-6.1-terra / prompt-v3.md / packets-v3-monza | analyze-lap5-vs-lap2 | 5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | – | 6.8 | 6.8 | 12.9 | 1017.0 | 0.0405 |
| openai:gpt-6.1-terra / prompt-v3.md / packets-v3-monza | average-session | 5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | – | 6.0 | 6.0 | 10.9 | 807.0 | 0.0366 |
| openai:gpt-6.1-terra / prompt-v3.md / packets-v3-monza | corner-lap5-curvagrande | 5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | – | 4.8 | 4.8 | 7.4 | 392.0 | 0.0375 |

</details>
