# Spike: a local LLM for the post-session coach (vroom-9ki.17)

**Question.** Can a local model under Ollama on the RX 7800 XT (16 GB) phrase the coach's facts packets
well enough, compared with the hosted default (`claude-sonnet-5-5` / `claude-haiku-5-5`)?

**Status (2026-11-17): partly measured, parked.** One local model (gpt-oss-20b) was run 40 times on 4
packets with 2 prompt versions. Still to do, by the user: the hosted comparison (needs the Anthropic key), a
second and third local model (multi-GB downloads onto the Windows box), VRAM with LMU open in its menus,
the blind ratings, and the hosted-fallback question. The recommendation below is provisional until then.

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
| Hosted | `run.py` supports `anthropic:<id>` with `output_config.format` (JSON schema) and logs cost ($2 / $10 per M tokens for Sonnet 5.5). **Not run**: no key in the agent's environment |

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

## Results: gpt-oss-20b, 5 runs per packet and prompt

TTFT counts any first token, including reasoning (gpt-oss streams its reasoning first). "First JSON" is
the first token of the answer itself, which is what a UI could start showing.

| Prompt | Packet | Schema valid | Guard 1st try | After retry | Contract | Prose clean | TTFT s | First JSON s | Total s (median) | Output tok |
|---|---|---|---|---|---|---|---|---|---|---|
| v1 | analyze lap 2 | 5/5 | 5/5 | 5/5 | 5/5 | 0/5 | 0.1 | 10.5 | 17.4 | 1 568 |
| v1 | analyze lap 3 | 5/5 | 5/5 | 5/5 | 5/5 | 1/5 | 0.1 | 15.7 | 23.2 | 2 097 |
| v1 | average | 5/5 | 5/5 | 5/5 | 5/5 | 1/5 | 0.1 | 4.2 | 8.0 | 717 |
| v1 | corner (trace) | 5/5 | 5/5 | 5/5 | 5/5 | 2/5 | 0.1 | 9.3 | 11.5 | 995 |
| v2 | analyze lap 2 | 5/5 | 5/5 | 5/5 | 5/5 | 3/5 | 0.1 | 16.1 | 25.9 | 2 304 |
| v2 | analyze lap 3 | 5/5 | 5/5 | 5/5 | 5/5 | 3/5 | 0.1 | 23.6 | 34.1 | 3 009 |
| v2 | average | 5/5 | 5/5 | 5/5 | 5/5 | 4/5 | 0.1 | 9.6 | 14.5 | 1 292 |
| v2 | corner (trace) | 5/5 | 5/5 | 5/5 | 5/5 | 3/5 | 0.1 | 10.1 | 12.9 | 1 077 |

- **Throughput:** 91 tokens/s median (88–92), matching the 2026-11-10 handover's 85–95. Cold load (the model
  not in VRAM): 43 s to the first token, measured once; Ollama unloads after 5 idle minutes by default.
- **Guard failure reasons:** none. 40/40 passed first time, so the retry path never ran on a real failure.
  (An early guard bug failed the Corner packet; the stored outputs were re-checked after the fix, see
  `summarize.py`.)
- **What the guard misses:**
  - One subtraction in 40 runs ("drops your exit speed by 4 km/h", 151 − 147) passed, because "4" appears
    elsewhere in the packet (a gear). A string guard can't catch small integers; the real guard (vroom-9ki.12)
    should check numbers per finding against that corner's facts only.
  - Prose quality. With v1, 16/20 outputs had an empty `what`/`fix`, a one-word `what` ("steering"), or field
    names ("Reduce steering_extrema when exiting the kerb"). v2 cut that to 7/20; what remains is mostly field
    names in `evidence` ("steering_extrema 5 vs 3").
  - Physics. With v2, 7/20 outputs say "turn in at the exit kerb", copied from the prompt's example, which
    mentioned an exit kerb. The packets list landmarks by label only ("exit kerb"), so the model can't tell a
    turn-in cue from an exit cue. The packet should say what each landmark is for, and the example should not
    name a landmark.
- **Reading the outputs** (not a rating): at its best (v2), gpt-oss gives a correct, plain debrief: "You lost
  0.141 s at Stavelot because you steered too much, keeping the minimum speed 110 km/h versus 112 km/h on the
  reference." The fixes are generic ("hold a steady input") and sometimes contradict the facts ("Brake
  earlier", where the packet shows the same braking point). Blind ratings will decide whether that's good
  enough.

### Not yet measured

| Item | Why not | How |
|---|---|---|
| Hosted default (Sonnet 5.5, and Haiku 5.5 for Average) | no Anthropic key in the agent environment | `run.py --model anthropic:claude-sonnet-5-5` with the key set; the cost is logged per call |
| 2nd and 3rd local model | each is a 10–16 GB download onto the Windows box, and loading it evicts Sure's model | candidates from the handover's 2026-11-10 survey: `gemma4:26b-a4b-it-qat` (Gemma licence, 16 GB, slight CPU spill) and a ~14 B Qwen instruct at Q4 (Apache-2.0; check the exact tag and licence in the Ollama library); `ollama pull <tag>`, then `run.py --model ollama:<tag>` |
| VRAM with LMU open in its menus, and LMU's own VRAM | needs LMU running | Task Manager → GPU → dedicated memory: LMU alone, then LMU + `ollama ps` after one call. gpt-oss alone holds 12.74 GB of the 16 GB, so it probably won't fit next to LMU without spilling to the CPU |
| Blind ratings | need the user | after all runs: `python3 -I summarize.py blind --per 2`, rate `blind/sheet.md` 1–5, then open `blind/key.json` |
| llama.cpp Vulkan rerun | not needed: ROCm already gives 91 tok/s, and the handover measured Vulkan at 68 | – |

## Options

1. **Hosted default, local as a config option.** Keep Sonnet/Haiku as the design says; add an
   OpenAI-compatible provider so a local model is one setting away. Cost per call stays, quality is likely
   the best, and nothing depends on the GPU being free.
2. **Local default, hosted fallback when the GPU is busy** (or split by command: local for Average, the
   simplest packet with 4/5 clean prose, and hosted for Analyze and Corner). It's free, and on this evidence
   reliable in format (40/40 schema-valid and guard-clean). But it is slow (8–34 s, plus a 43 s cold load),
   probably can't share VRAM with LMU, and its prose needs a stronger packet and prompt.
3. **Local only.** No cost and no data leaves the PC, but the coach is unavailable whenever LMU (or anything
   else) holds the GPU, and quality is capped by what fits in 16 GB.

## Recommendation (provisional)

**Change:** build vroom-9ki.11 with the provider as a setting (option 1 now, option 2 possible later), and
decide the default after the hosted run and the blind ratings. Format is no longer the risk: gpt-oss-20b's
grammar-enforced JSON and number grounding were perfect in 40 runs. The open questions are prose quality
next to Sonnet, and whether a 12.7 GB model can share the GPU with LMU.

Config change for vroom-9ki.11, if local wins in any form:

```python
llm_provider: Literal["anthropic", "openai", "gemini", "ollama"] = "anthropic"
llm_base_url: str | None = None  # "ollama" defaults to http://127.0.0.1:11434/v1 (OpenAI-compatible)
llm_strong: str = "claude-sonnet-5-5"  # e.g. "gpt-oss-20b-nommap" with ollama
llm_fast: str = "claude-haiku-5-5"
```

Map `"ollama"` to Pydantic AI's OpenAI-compatible model with `base_url`. Use JSON-schema structured output
(`response_format`) rather than tool calls; the handover saw a malformed nested tool call. `cost_usd` stays
`None` for local calls.

Lessons for vroom-9ki.12 (coach packets and guard), whichever model wins:
- Use plain-English keys in the packet ("minimum speed"), not snake_case; models quote keys back.
- Give each landmark its role ("exit kerb, after the apex"), not only its label.
- Check numbers per finding against that corner's facts, so that small integers from elsewhere in the
  packet can't hide a calculation.
- Add a prose check (empty or one-word `what`/`fix`, field names) next to the number guard.

## Question for the user (before the final recommendation)

Is a **hosted fallback OK when the GPU is busy** (a cost per call, with data sent to Anthropic), or should
the coach be **local-only**? With a fallback, option 2 is viable. Local-only means option 3, and the coach
waits until LMU is closed.
