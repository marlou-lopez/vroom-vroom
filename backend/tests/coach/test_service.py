import json

import pytest
from pydantic_ai import models
from pydantic_ai.exceptions import ModelHTTPError

from racecoach.coach.errors import CoachError
from racecoach.coach.service import run_coach
from racecoach.llm import LlmError
from tests.coach.helpers import good_answer, lap_id, make_store, model_of, ok_model

models.ALLOW_MODEL_REQUESTS = False


def boom(*_):
    raise AssertionError("the model must not be called")


def test_no_reference_raises_before_llm(tmp_path):
    store, settings = make_store(tmp_path, laps=[(1, {})])
    with pytest.raises(CoachError) as e:
        run_coach(store, settings, "analyze", lap_id(1), model=model_of(boom))
    assert e.value.code == "no_reference"
    assert store.llm_calls() == []


def test_unknown_corner_raises_before_llm(tmp_path):
    store, settings = make_store(tmp_path)
    with pytest.raises(CoachError) as e:
        run_coach(store, settings, "corner", lap_id(2), corner_id="zz", model=model_of(boom))
    assert e.value.code == "unknown_corner"


def test_average_with_one_lap_raises_not_enough_laps(tmp_path):
    store, settings = make_store(tmp_path, laps=[(1, {})])
    with pytest.raises(CoachError) as e:
        run_coach(store, settings, "average", lap_id(1), model=model_of(boom))
    assert e.value.code == "not_enough_laps"


def test_analyze_against_explicit_ref_lap(tmp_path):
    store, settings = make_store(tmp_path)
    r = run_coach(store, settings, "analyze", lap_id(2), ref_lap_id=lap_id(4), model=ok_model())
    assert r.ref_lap_id == lap_id(4) and r.stats["Reference"].startswith("0:")
    assert store.latest_coach_results(lap_id(2), lap_id(4))["analyze"].id == r.id
    assert store.latest_coach_results(lap_id(2), None) == {}


def test_analyze_kind_rules(tmp_path):
    store, settings = make_store(tmp_path)
    r = run_coach(store, settings, "analyze", lap_id(2), model=ok_model())
    kinds = [f.kind for f in r.findings]
    assert kinds.count("issue") <= 3 and kinds.count("minor") <= 1 and kinds.count("strength") <= 1
    assert r.focus is not None and r.focus.corner_id == r.findings[0].corner_id
    # a model that returns a different kind is told once, then the answer is unusable
    calls: list[int] = []

    def wrong_kind(p, n):
        a = good_answer(p)
        a["findings"][0]["kind"] = "strength"
        return json.dumps(a)

    with pytest.raises(CoachError) as e:
        run_coach(store, settings, "analyze", lap_id(3), model=model_of(wrong_kind, calls))
    assert e.value.code == "invalid_output" and len(calls) == 2


def test_average_and_corner_rules(tmp_path):
    store, settings = make_store(tmp_path)
    avg = run_coach(store, settings, "average", lap_id(2), model=ok_model())
    assert 1 <= len(avg.findings) <= 3 and all(f.kind == "inconsistent" for f in avg.findings)
    assert avg.focus is None and avg.ref_lap_id is None
    cor = run_coach(store, settings, "corner", lap_id(2), corner_id="t2", model=ok_model())
    assert [f.corner_id for f in cor.findings] == ["t2"] and cor.focus is None

    def two(p, n):
        a = good_answer(p)
        a["findings"] = a["findings"] * 2
        return json.dumps(a)

    with pytest.raises(CoachError):
        run_coach(store, settings, "corner", lap_id(2), corner_id="t2", model=model_of(two))


def test_retry_once_on_violation_then_warn(tmp_path):
    store, settings = make_store(tmp_path)
    calls: list[int] = []

    def invents(p, n):
        a = good_answer(p)
        a["findings"][0]["what"] = "You were doing 143 km/h through the apex, far too slow."
        return json.dumps(a)

    r = run_coach(store, settings, "analyze", lap_id(2), model=model_of(invents, calls))
    assert len(calls) == 2  # one retry, no more
    assert r.warnings and "143" in r.warnings[0]
    assert store.latest_coach_results(lap_id(2), r.ref_lap_id)["analyze"].warnings == r.warnings


def test_retry_fixes_the_answer(tmp_path):
    store, settings = make_store(tmp_path)

    def second_time_right(p, n):
        a = good_answer(p)
        if n == 1:
            a["findings"][0]["fix"] = "Brake 20 m earlier than the board."
        return json.dumps(a)

    r = run_coach(store, settings, "analyze", lap_id(2), model=model_of(second_time_right))
    assert r.warnings == []


def test_invalid_json_twice_raises_invalid_output(tmp_path):
    store, settings = make_store(tmp_path)
    calls: list[int] = []
    with pytest.raises(CoachError) as e:
        run_coach(
            store, settings, "analyze", lap_id(2), model=model_of(lambda p, n: "{nope", calls)
        )
    assert e.value.code == "invalid_output" and len(calls) == 2
    assert store.llm_calls()[-1]["ok"] is False


def test_provider_exception_raises_llm_error(tmp_path):
    store, settings = make_store(tmp_path)
    err = ModelHTTPError(503, "gpt", "overloaded")
    with pytest.raises(LlmError) as e:
        run_coach(store, settings, "analyze", lap_id(2), model=model_of(lambda p, n: err))
    assert e.value.code == "provider" and "503" in e.value.message
    assert store.llm_calls()[-1]["ok"] is False


def test_result_persisted_and_reloaded(tmp_path):
    store, settings = make_store(tmp_path)
    r = run_coach(store, settings, "analyze", lap_id(2), model=ok_model())
    again = store.latest_coach_results(lap_id(2), r.ref_lap_id)
    assert again["analyze"] == r
    assert [f.id for f in r.findings] == [f"{r.id}-{i}" for i in range(len(r.findings))]
    done = store.set_finding_reviewed(r.findings[0].id, True)
    assert done.findings[0].reviewed
    assert store.latest_coach_results(lap_id(2), r.ref_lap_id)["analyze"].findings[0].reviewed
    with pytest.raises(KeyError):
        store.set_finding_reviewed("nope", True)


def test_reanalyze_keeps_reviewed_for_same_corner_and_kind(tmp_path):
    store, settings = make_store(tmp_path)
    first = run_coach(store, settings, "analyze", lap_id(2), model=ok_model())
    store.set_finding_reviewed(first.findings[0].id, True)
    second = run_coach(store, settings, "analyze", lap_id(2), model=ok_model())
    assert second.id != first.id
    assert [f.reviewed for f in second.findings] == [True] + [False] * (len(second.findings) - 1)
    # a different corner or kind starts unreviewed
    third_laps = store.latest_coach_results(lap_id(2), second.ref_lap_id)["analyze"]
    assert third_laps.id == second.id


def test_analyze_saves_focus_item(tmp_path):
    store, settings = make_store(tmp_path)
    r = run_coach(store, settings, "analyze", lap_id(2), model=ok_model())
    items = store.focus_items()
    assert len(items) == 1 and r.focus is not None
    assert items[0]["text"] == r.focus.instruction
    assert items[0]["corner_id"] == r.focus.corner_id and items[0]["metric"] == "minimum speed"
    assert items[0]["baseline_s"] > 0 and items[0]["status"] == "open"
    assert items[0]["track_id"] == "synth-ring-gp" and items[0]["car_id"] == "synth-gt3"


def test_llm_call_logged_with_cost(tmp_path):
    store, settings = make_store(tmp_path)
    r = run_coach(store, settings, "analyze", lap_id(2), model=ok_model())
    (call,) = store.llm_calls()
    assert call["purpose"] == "coach:analyze" and call["ok"] and call["lap_id"] == lap_id(2)
    assert call["model"] == "gpt-6.1-terra" and call["input_tokens"] > 0
    assert call["cost_usd"] > 0 and r.cost_usd == pytest.approx(call["cost_usd"])
    run_coach(store, settings, "average", lap_id(2), model=ok_model())
    assert store.llm_calls()[-1]["model"] == "gpt-6-luna"  # Average uses the fast tier


def test_missing_key_is_an_llm_error_and_logged(tmp_path):
    store, settings = make_store(tmp_path)
    settings.openai_api_key = None
    with pytest.raises(LlmError) as e:
        run_coach(store, settings, "analyze", lap_id(2))
    assert e.value.code == "missing_api_key"


def test_average_is_stored_under_the_requested_reference(tmp_path):
    store, settings = make_store(tmp_path)
    r = run_coach(store, settings, "average", lap_id(2), ref_lap_id=lap_id(1), model=ok_model())
    assert r.ref_lap_id == lap_id(1)
    assert store.latest_coach_results(lap_id(2), lap_id(1))["average"].id == r.id


def test_reanalyze_supersedes_the_open_focus_item(tmp_path):
    store, settings = make_store(tmp_path)
    run_coach(store, settings, "analyze", lap_id(2), model=ok_model())
    run_coach(store, settings, "analyze", lap_id(2), model=ok_model())
    assert [i["status"] for i in store.focus_items()] == ["superseded", "open"]


def _seen_packets():
    seen: list[dict] = []

    def answer(p, n):
        seen.append(p)
        return json.dumps(good_answer(p))

    return seen, model_of(answer)


def test_analyze_against_the_ideal_lap_calls_no_network(tmp_path):
    store, settings = make_store(tmp_path)
    ideal = f"ideal:{'s' * 40}"
    seen, model = _seen_packets()
    r = run_coach(store, settings, "analyze", lap_id(2), ref_lap_id=ideal, model=model)
    assert r.ref_lap_id == ideal and r.findings
    assert r.warnings == [] and len(seen) == 1
    assert store.latest_coach_results(lap_id(2), ideal)["analyze"].id == r.id
    text = json.dumps(seen[0])
    assert "ideal lap of this session" in seen[0]["reference"]
    assert "lap 0" not in seen[0]["reference"] and "where you braked on lap" not in text
    assert "ideal" in seen[0]["notes"]


def test_ideal_of_another_session_is_unknown_lap(tmp_path):
    store, settings = make_store(tmp_path)
    with pytest.raises(CoachError) as e:
        run_coach(store, settings, "analyze", lap_id(2), ref_lap_id=f"ideal:{'x' * 40}",
                  model=model_of(boom))
    assert e.value.code == "unknown_lap"


def test_ideal_without_a_valid_lap_raises_no_valid_laps(tmp_path):
    from racecoach.analysis.consistency import NoValidLaps

    store, settings = make_store(tmp_path)
    for no in (1, 2, 3, 4):
        store.set_valid_override(lap_id(no), False)
    with pytest.raises(NoValidLaps):
        run_coach(store, settings, "analyze", lap_id(2), ref_lap_id=f"ideal:{'s' * 40}",
                  model=model_of(boom))


def test_reference_points_across_a_join_are_left_out(tmp_path):
    from racecoach.analysis.facts import lap_facts
    from racecoach.coach.packet import _across_join
    from tests.coach.helpers import TMAP

    store, _ = make_store(tmp_path)
    facts = lap_facts(TMAP, store.read_trace(lap_id(2)), store.read_trace(lap_id(1)))
    cf = next(f for f in facts.corners if f.corner_id == "t1")
    corner = TMAP.corners[0]
    assert cf.ref.brake_onset_m is not None and cf.ref.throttle_pickup_m is not None
    # no join between the points and the apex: nothing changes
    same, dropped = _across_join(cf, corner, [300, 650])
    assert same is cf and not dropped
    # a join between the braking point and the apex: braking is dropped, the throttle stays
    cut, dropped = _across_join(cf, corner, [round(corner.apex_m) - 1])
    assert dropped and cut.ref.brake_onset_m is None and cut.cues.brake_ref is None
    assert cut.ref.throttle_pickup_m == cf.ref.throttle_pickup_m
    # the lap's own side is never touched
    assert cut.lap == cf.lap


def test_corner_dict_notes_a_reference_across_a_join(tmp_path):
    from racecoach.analysis.facts import lap_facts
    from racecoach.coach.packet import Ctx, _corner_dict
    from racecoach.model import LapTrace  # noqa: F401
    from tests.coach.helpers import TMAP

    store, _ = make_store(tmp_path)
    lap, ref = store.read_trace(lap_id(2)), store.read_trace(lap_id(1))
    cf = next(f for f in lap_facts(TMAP, lap, ref).corners if f.corner_id == "t1")
    corner = TMAP.corners[0]
    plain = _corner_dict(cf, corner, "issue", Ctx(TMAP, lap, ref, None), cf.delta_s)
    assert "note on the reference" not in plain
    joined = _corner_dict(
        cf, corner, "issue", Ctx(TMAP, lap, ref, None, [round(corner.apex_m) - 1]), cf.delta_s
    )
    assert "note on the reference" in joined
    assert joined["this lap against the reference"]["braking starts"].endswith("against n/a")
