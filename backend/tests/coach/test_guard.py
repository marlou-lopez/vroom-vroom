from racecoach.coach.guard import allowed_numbers, check_numbers, hedges, lint
from racecoach.coach.schema import CoachOutput

CORNER = {
    "corner_id": "t1", "corner": "Pouhon 2", "kind": "issue", "time_s": "0.141",
    "this lap against the reference": {"minimum speed": "110 km/h against 112"},
}  # fmt: skip
CORNER["allowed_numbers"] = allowed_numbers(CORNER)
PACKET = {"corners": [CORNER], "car": "GT3 #1", "header_numbers": ["2:22.139"]}


def out(
    what: str, fix: str = "Brake a little earlier and carry more speed.", summary: str = "ok"
) -> CoachOutput:
    return CoachOutput.model_validate({
        "summary": summary,
        "findings": [{
            "corner_id": "t1", "corner": "Pouhon 2", "kind": "issue", "time_s": 0.141,
            "what": what, "fix": fix, "cue_type": "feel", "evidence": [],
        }],
    })  # fmt: skip


def reasons(o: CoachOutput) -> list[tuple[str, str]]:
    return [(f.number, f.reason) for f in check_numbers(o, PACKET)]


def test_facts_pass_and_names_are_not_numbers():
    assert reasons(out("At Pouhon 2 your minimum speed was 110 km/h against 112.")) == []


def test_invented_number_is_flagged():
    assert reasons(out("You were doing 143 km/h at the apex.")) == [("143", "invented")]


def test_rounding_and_format_are_allowed():
    assert reasons(out("You lost 0.14 s, or 110.0 km/h at the apex.")) == []


def test_units_glued_to_numbers_are_read():
    assert reasons(out("You hit 143km/h and 0.4s of ABS.")) == [
        ("143", "invented"),
        ("0.4", "invented"),
    ]


def test_calculated_number_is_named():
    assert reasons(out("You were 2 km/h slower than the reference at 110 km/h."))[0] == (
        "2", "calculated"
    )  # fmt: skip


def test_metre_cue_is_flagged():
    got = reasons(out("Brake earlier.", fix="Brake 20 m before the board and turn in late."))
    assert ("20 m", "metres") in got


def test_finding_is_checked_against_its_own_corner_only():
    other = {**CORNER, "corner_id": "t2", "corner": "T2", "allowed_numbers": ["77"]}
    packet = {**PACKET, "corners": [CORNER, other]}
    o = out("Your minimum speed was 77 km/h.")  # 77 belongs to t2
    assert [(f.number, f.reason) for f in check_numbers(o, packet)] == [("77", "invented")]


def test_summary_may_quote_header_numbers():
    assert reasons(out("Fine here at 110 km/h against 112.", summary="Lap 2:22.139 it was.")) == []


def test_lint_and_hedges():
    o = out("Slow.", fix="min_speed_kmh low")
    problems = lint(o)
    assert any("what too short" in p for p in problems)
    assert any("fix too short" in p for p in problems)
    assert any("field name" in p for p in problems)
    assert hedges(out("The data does not establish why you were slow here.")) == [
        "does not establish"
    ]
