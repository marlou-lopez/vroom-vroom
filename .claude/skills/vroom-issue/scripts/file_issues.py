#!/usr/bin/env python3
"""File one or more vroom-vroom GitHub issues and put them on the project board.

Usage:
    python3 file_issues.py issues.json [--dry-run]

issues.json is one issue object or a list of them:
    {
      "key": "fmt",                      # optional; lets other issues in the batch say {fmt}
      "title": "Lap time can show 60 seconds",
      "type": "bug",                     # bug | feature | refactor | chore | tuning | epic | spike
      "areas": ["frontend"],             # any of: frontend, backend, coach, lmu
      "milestone": "v1",                 # v1 | v2 | v3 | v4 | views (or the full milestone title)
      "priority": "P1",                  # P0 | P1 | P2 | P3
      "status": "Todo",                  # optional, default Todo
      "body": "## Summary\\n..."         # Markdown; {key} -> #N for issues in this batch
    }

Everything is validated before anything is created. --dry-run validates, prints the
commands it would run and the final bodies, and changes nothing on GitHub.
"""
import json
import re
import subprocess
import sys

REPO = "marlou-lopez/vroom-vroom"
OWNER = "marlou-lopez"
PROJECT_NUMBER = 7

TYPES = {"bug", "feature", "refactor", "chore", "tuning", "epic", "spike"}
AREAS = {"frontend", "backend", "coach", "lmu"}
PRIORITIES = {"P0", "P1", "P2", "P3"}
MILESTONES = {
    "v1": "v1 – Post-session coach",
    "v2": "v2 – Live coaching",
    "v3": "v3 – Conversation",
    "v4": "v4 – Setup engineer",
    "views": "Track views",
}
REF = re.compile(r"\{([A-Za-z][\w-]*)\}")


def gh(*args, capture=True):
    return subprocess.run(["gh", *args], check=True, text=True,
                          capture_output=capture).stdout


def validate(issues):
    errors, keys = [], set()
    for i, it in enumerate(issues):
        where = f"issue[{i}] {it.get('title', '<no title>')!r}"
        for f in ("title", "type", "areas", "milestone", "priority", "body"):
            if f not in it:
                errors.append(f"{where}: missing '{f}'")
        if it.get("type") not in TYPES:
            errors.append(f"{where}: type must be one of {sorted(TYPES)}")
        bad = [a for a in it.get("areas", []) if a not in AREAS]
        if bad or not it.get("areas"):
            errors.append(f"{where}: areas must be a non-empty subset of {sorted(AREAS)}")
        ms = it.get("milestone", "")
        if ms not in MILESTONES and ms not in MILESTONES.values():
            errors.append(f"{where}: milestone must be one of {sorted(MILESTONES)}")
        if it.get("priority") not in PRIORITIES:
            errors.append(f"{where}: priority must be one of {sorted(PRIORITIES)}")
        if "key" in it:
            if it["key"] in keys:
                errors.append(f"{where}: duplicate key {it['key']!r}")
            keys.add(it["key"])
    # {name} in a body becomes #N only when name is a batch key, so code such as
    # `GET /api/laps/{lap_id}` is left alone. Avoid keys that collide with code in bodies.
    return errors, keys


def labels_for(it):
    labels = [it["type"]] + [f"area: {a}" for a in it["areas"]]
    if it["type"] == "epic":
        labels.append("feature")
    return labels


def resolve_body(body, nums):
    return REF.sub(lambda m: f"#{nums[m.group(1)]}" if m.group(1) in nums else m.group(0), body)


def project_fields():
    data = json.loads(gh("project", "field-list", str(PROJECT_NUMBER), "--owner", OWNER, "--format", "json"))
    fields = {f["name"]: f for f in data["fields"]}
    proj = json.loads(gh("project", "view", str(PROJECT_NUMBER), "--owner", OWNER, "--format", "json"))
    return proj["id"], fields


def option_id(field, name):
    for o in field.get("options", []):
        if o["name"].lower() == name.lower():
            return o["id"]
    raise SystemExit(f"Project field {field['name']!r} has no option {name!r}")


def main():
    if len(sys.argv) < 2:
        raise SystemExit(__doc__)
    dry = "--dry-run" in sys.argv
    raw = json.load(open(sys.argv[1]))
    issues = raw if isinstance(raw, list) else [raw]

    errors, keys = validate(issues)
    if errors:
        raise SystemExit("Not filing anything; fix these first:\n  " + "\n  ".join(errors))

    if dry:
        fake = {it["key"]: f"<new:{it['key']}>" for it in issues if "key" in it}
        for it in issues:
            ms = MILESTONES.get(it["milestone"], it["milestone"])
            cmd = ["gh", "issue", "create", "--repo", REPO, "--title", it["title"], "--milestone", ms]
            for l in labels_for(it):
                cmd += ["--label", l]
            cmd += ["--body-file", "<body below>"]
            print("$ " + " ".join(json.dumps(c, ensure_ascii=False) if " " in c else c for c in cmd))
            print(f"$ gh project item-add {PROJECT_NUMBER} --owner {OWNER} --url <issue url>")
            print(f"  -> set Status={it.get('status', 'Todo')}, Priority={it['priority']}")
            print("----- body -----")
            print(resolve_body(it["body"], fake))
            print("----------------\n")
        print(f"DRY RUN: {len(issues)} issue(s) validated, nothing created.")
        return

    project_id, fields = project_fields()
    status_f, prio_f = fields["Status"], fields["Priority"]

    # Pass 1: create every issue so all batch keys have numbers.
    nums, created = {}, []
    for it in issues:
        ms = MILESTONES.get(it["milestone"], it["milestone"])
        args = ["issue", "create", "--repo", REPO, "--title", it["title"],
                "--milestone", ms, "--body", "(filling in…)"]
        for l in labels_for(it):
            args += ["--label", l]
        url = gh(*args).strip()
        n = int(url.rsplit("/", 1)[1])
        if "key" in it:
            nums[it["key"]] = n
        created.append((it, n, url))

    # Pass 2: real bodies (refs resolved) and board fields.
    for it, n, url in created:
        subprocess.run(["gh", "issue", "edit", str(n), "--repo", REPO, "--body-file", "-"],
                       input=resolve_body(it["body"], nums), text=True, check=True,
                       capture_output=True)
        item = json.loads(gh("project", "item-add", str(PROJECT_NUMBER), "--owner", OWNER,
                             "--url", url, "--format", "json"))["id"]
        for field, value in ((status_f, it.get("status", "Todo")), (prio_f, it["priority"])):
            gh("project", "item-edit", "--project-id", project_id, "--id", item,
               "--field-id", field["id"], "--single-select-option-id", option_id(field, value))
        print(f"#{n}  {it['priority']}  {it['title']}\n     {url}")


if __name__ == "__main__":
    main()
