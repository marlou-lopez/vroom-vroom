---
name: vroom-issue
description: File GitHub issues for the vroom-vroom project (AI sim racing engineer) with the right type label, area labels, milestone and priority, and put them on the project board. Use this whenever the user wants to create, file, open, log, raise or track an issue, ticket, bug, feature request, task, refactor, chore or epic for this repo, or turn review findings, TODOs, plan tasks or a bug they just hit into issues, even if they don't say "GitHub" or "issue" (e.g. "track this", "add it to the board", "make a ticket for that", "log these findings").
---

# Filing vroom-vroom issues

Issues live in the private repo `marlou-lopez/vroom-vroom` and on the user's Project board
(https://github.com/users/marlou-lopez/projects/7). Each issue gets a type label, one or more area
labels, a milestone, and Status/Priority on the board. `scripts/file_issues.py` does all the
GitHub calls, so you write the content and it handles the rest.

## Workflow

1. **Collect the facts.** If the issue is about code, open the code and confirm what you'll claim:
   the `file:line`, the actual behaviour, why it happens. An issue that's wrong about the cause
   wastes the next session's time. If the user's description is too vague to write a useful
   issue, ask one short question rather than guessing.
2. **Check for duplicates.** Run `gh issue list -R marlou-lopez/vroom-vroom --state all --search "<keywords>"`.
   If a matching issue exists, say so and offer to comment on it instead.
3. **Classify** it using the tables below.
4. **Write the body** from the matching template. Bodies must stand on their own, because the
   plan, spec and handover docs live outside the repo (in `~/.claude/plans/...`) and readers
   can't open them. Copy in whatever details matter.
5. **Show the draft** and wait for an OK. Include the title, labels, milestone, priority and body.
   The user checks wording before it goes out. Skip the draft only when
   the user explicitly says to just file it.
6. **File it.** Write the issue(s) as JSON to the session scratchpad, then run
   `python3 .claude/skills/vroom-issue/scripts/file_issues.py <file.json>`. Pass `--dry-run` first if
   you want to see the exact commands. The script validates the whole batch before it creates anything.
7. **Report** the issue number(s) and link(s).

## Classification

| type | use for |
|---|---|
| `bug` | Wrong behaviour in existing code |
| `feature` | New capability, including plan tasks |
| `refactor` | Code quality with no behaviour change: duplication, perf, structure |
| `chore` | Tooling, lint, deps, repo housekeeping, decisions to make |
| `tuning` | Thresholds or heuristics to check against real recordings |
| `epic` | A whole stage or large body of work to split up later (`feature` is added automatically) |
| `spike` | Open-ended exploration: a prototype plus a write-up in `docs/<topic>/`, ending in a keep / change / drop call |

| area | covers |
|---|---|
| `frontend` | `frontend/`: React app, mock API |
| `backend` | `backend/`: Python package `racecoach`, FastAPI |
| `coach` | LLM coach, prompts, findings, fact packets |
| `lmu` | Le Mans Ultimate recordings, schema, watcher, shared memory |

Use every area that applies.

**Milestones:** `v1` is the post-session coach (current work). `v2` is live coaching (Windows
agent, voice). `v3` is conversation with the coach. `v4` is the setup engineer. `views` is the
"Track views" milestone: detailed 2D and 3D track rendering, elevation, per-lap racing lines.
Default to `v1` unless the work clearly belongs elsewhere.

**Priority:**
- **P0:** blocks work, or loses or corrupts data
- **P1:** a visible bug, or on the critical path (the backend tasks in order)
- **P2:** a minor bug, an edge case, or tuning
- **P3:** cleanup, nice-to-have, later stages

## Body templates

Bug:
```markdown
## Summary
<one or two sentences: what's wrong and the root cause>

**Location:** `path/to/file.ts:LINE`

## Steps to reproduce
1. ...

## Expected
...

## Actual
...

## Suggested fix
<concrete approach, plus the test that should cover it>
```

Feature / tuning / chore / epic:
```markdown
## Summary
<what and why>

## Scope
- ...

## Acceptance criteria
- [ ] <checkable outcome; name tests where known>

## Depends on
#N   <omit the section if none>

## Notes
<optional: constraints, verified facts, gotchas>
```

Refactor:
```markdown
## Problem
<what's duplicated or slow, and the risk if left>

**Location:** `path:LINE`

## Proposed change
...

## Acceptance criteria
- [ ] No behaviour change; existing tests pass
- [ ] `npm run test` and `npm run build` pass   <or the backend equivalents>
```

## Write as if the repo were public

The repo is private since 2026-11-05 but was public before and may be again. Don't put these in titles or bodies: absolute home paths (`/home/...`), email addresses, API keys
or `.env` contents, or the driver name from recordings. Paths relative to the repo root are fine.
Titles state the problem or outcome in plain words ("Lap time can show 60 seconds"), not
the fix ("Fix formatLapTime").

## The JSON the script takes

One object or a list:

```json
[
  {
    "key": "api",
    "title": "Add GET /api/laps/{lap_id}",
    "type": "feature",
    "areas": ["backend"],
    "milestone": "v1",
    "priority": "P1",
    "body": "## Summary\n..."
  },
  {
    "title": "Use GET /api/laps/{lap_id} in the frontend",
    "type": "refactor",
    "areas": ["frontend"],
    "milestone": "v1",
    "priority": "P2",
    "body": "...\n\n## Depends on\n{api}"
  }
]
```

- `key` is optional. Inside a batch, `{key}` in any body turns into `#N` once that issue exists.
  Any `{name}` that isn't a batch key, such as `{lap_id}` above, is left as it is.
- `status` is optional and defaults to `Todo`.
- To refer to an issue that already exists, write `#N` directly.

## Related

- Existing issues: `gh issue list -R marlou-lopez/vroom-vroom --limit 100`
- Close an issue from a commit or PR with `Fixes #N`. When a fix lands without one, offer to close it with
  `gh issue close N -R marlou-lopez/vroom-vroom --comment "<what fixed it>"`.
