"""Key rotation, 429 cooldown, provider fallback and routing — no network (call functions are stubs)."""
import json

import pytest
from pydantic import BaseModel

from app.providers import AllProvidersFailed, InvalidKey, KeyPool, ProviderError, RateLimited, Router


class Out(BaseModel):
    ok: bool


def scripted(results, calls):
    """results: dict key -> list of outcomes (Exception instance or str JSON)."""
    def call(key, model, system, user, max_tokens):
        calls.append(key)
        r = results[key].pop(0)
        if isinstance(r, Exception):
            raise r
        return r
    return call


MODELS = {t: {"gemini": "g", "groq": "q"} for t in ("understand", "place", "conflicts", "report", "radar", "methodology", "goal_plan", "goal_check")}


def router(gem, groq, calls):
    return Router(KeyPool("gemini", list(gem), scripted(gem, calls)), KeyPool("groq", list(groq), scripted(groq, calls)), MODELS)


def test_gemini_rotates_through_keys_on_429():
    calls = []
    gem = {"g1": [RateLimited(30)], "g2": [RateLimited(30)], "g3": [RateLimited(30)], "g4": [json.dumps({"ok": True})]}
    out, prov, _ = router(gem, {"q1": []}, calls).complete_json("understand", "s", "u", 10, Out.model_validate)
    assert out.ok and prov == "gemini" and calls == ["g1", "g2", "g3", "g4"]


def test_all_gemini_limited_falls_back_to_groq_and_rotates():
    calls = []
    gem = {f"g{i}": [RateLimited(30)] for i in range(1, 5)}
    groq = {"q1": [RateLimited(10)], "q2": [RateLimited(10)], "q3": [json.dumps({"ok": True})], "q4": []}
    out, prov, _ = router(gem, groq, calls).complete_json("place", "s", "u", 10, Out.model_validate)
    assert prov == "groq" and calls == ["g1", "g2", "g3", "g4", "q1", "q2", "q3"]


def test_cooled_down_key_is_skipped_next_time():
    calls = []
    gem = {"g1": [RateLimited(60)], "g2": [json.dumps({"ok": True}), json.dumps({"ok": True})]}
    r = router(gem, {}, calls)
    r.complete_json("understand", "s", "u", 10, Out.model_validate)
    r.complete_json("understand", "s", "u", 10, Out.model_validate)
    assert calls == ["g1", "g2", "g2"]


def test_everything_rate_limited_reports_429():
    calls = []
    r = router({"g1": [RateLimited(5)]}, {"q1": [RateLimited(7)]}, calls)
    with pytest.raises(AllProvidersFailed) as e:
        r.complete_json("understand", "s", "u", 10, Out.model_validate)
    assert e.value.rate_limited


def test_invalid_key_and_errors_are_not_rate_limits():
    calls = []
    r = router({"g1": [InvalidKey()]}, {"q1": [ProviderError("boom")]}, calls)
    with pytest.raises(AllProvidersFailed) as e:
        r.complete_json("understand", "s", "u", 10, Out.model_validate)
    assert not e.value.rate_limited and calls == ["g1", "q1"]


def test_invalid_json_retried_once_then_fallback():
    calls = []
    r = router({"g1": ["not json", "{bad"]}, {"q1": [json.dumps({"ok": True})]}, calls)
    out, prov, _ = r.complete_json("understand", "s", "u", 10, Out.model_validate)
    assert prov == "groq" and calls == ["g1", "g1", "q1"]


def test_light_tasks_prefer_gemini_then_groq():
    calls = []
    r = router({"g1": [json.dumps({"ok": True})]}, {"q1": [json.dumps({"ok": True})]}, calls)
    _, prov, _ = r.complete_json("goal_check", "s", "u", 10, Out.model_validate)
    assert prov == "gemini" and calls == ["g1"]


def test_status_never_contains_key_values():
    r = router({"secret-gemini": []}, {"secret-groq": []}, [])
    assert "secret" not in json.dumps(r.status())
