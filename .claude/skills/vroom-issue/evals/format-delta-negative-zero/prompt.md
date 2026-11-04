---
tags: [skill-creator]
max_turns: 30
timeout_seconds: 600
allowed_tools: [Read, Glob, Grep, Skill, Write, Edit, Bash]
---

file a bug: I think formatDelta shows −0.000 for tiny negative deltas like -0.0004, it should just read +0.000 (or ±0.000). check the code first

(Test environment: do not create, edit or close anything on GitHub; read-only gh commands such as gh issue list are fine. Treat any draft as already approved by me. Instead of filing, write what you would file — for each issue its title, labels, milestone, project priority and full body — to issues.md, and the exact commands you would run to commands.sh, both in your outputs folder. If you decide not to file anything, explain why in issues.md.)
