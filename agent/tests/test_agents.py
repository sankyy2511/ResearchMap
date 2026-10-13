"""Agent 1 / Agent 2 contract checks with the router stubbed (no network, no model download)."""
import json
import os

os.environ.setdefault("AGENT_INTERNAL_KEY", "test-key-1234567890")

import pytest
from fastapi.testclient import TestClient

import app.main as m

H = {"X-Internal-Key": os.environ["AGENT_INTERNAL_KEY"]}


@pytest.fixture(autouse=True)
def stubs(monkeypatch):
    monkeypatch.setattr(m, "KEY", os.environ["AGENT_INTERNAL_KEY"])
    monkeypatch.setattr(m, "embed", lambda texts: [[0.1] * 384 for _ in texts])
    monkeypatch.setattr(m, "throttle", lambda: None)


def fake(payload):
    return lambda task, system, user, mt, validate: (validate(payload), "gemini", "g")


def test_requires_internal_key():
    assert TestClient(m.app).post("/v1/understand", json={"url": "https://x.org"}).status_code == 401


def test_agent1_drops_invented_quotes(monkeypatch):
    monkeypatch.setattr(m.ROUTER, "complete_json", fake({
        "is_research": True, "is_research_reason": "educational", "page_type": "article", "main_concept": "AI radiology",
        "summary": "s", "topics": ["AI", "Radiology"], "questions_answered": ["q"],
        "claims": [{"text": "real", "quote": "AI matched radiologists in accuracy"}, {"text": "fake", "quote": "not in the page"}]}))
    r = TestClient(m.app).post("/v1/understand", headers=H, json={"url": "https://x.org", "title": "T",
                               "content_text": "In the study, AI matched   radiologists in accuracy on chest X-rays."})
    body = r.json()
    assert r.status_code == 200 and [c["text"] for c in body["claims"]] == ["real"]
    assert len(body["embedding"]) == 384 and body["fallback"] is False
    for k in ("is_research", "is_research_reason", "page_type", "main_concept", "summary", "topics", "questions_answered"):
        assert k in body


def test_agent1_fallback_when_ai_down(monkeypatch):
    def down(*a):
        raise m.AllProvidersFailed(False, 0, "down")
    monkeypatch.setattr(m.ROUTER, "complete_json", down)
    body = TestClient(m.app).post("/v1/understand", headers=H, json={"url": "https://x.org", "title": "Title", "content_text": "t"}).json()
    assert body["fallback"] is True and body["main_concept"] == "Title"


def test_agent1_rate_limit_returns_429(monkeypatch):
    def limited(*a):
        raise m.AllProvidersFailed(True, 12, "limited")
    monkeypatch.setattr(m.ROUTER, "complete_json", limited)
    r = TestClient(m.app).post("/v1/understand", headers=H, json={"url": "https://x.org", "content_text": "t"})
    assert r.status_code == 429 and r.headers["retry-after"] == "13"


def test_agent2_only_keeps_offered_candidates(monkeypatch):
    monkeypatch.setattr(m.ROUTER, "complete_json", fake({"topic_name": "AI in Radiology", "edges": [
        {"candidate_id": "n1", "relation": "supports", "reason": "r", "evidence": ["e"], "confidence": 0.8},
        {"candidate_id": "ghost", "relation": "supports", "reason": "r", "confidence": 0.9}]}))
    body = TestClient(m.app).post("/v1/place", headers=H, json={"page": {"title": "p"}, "candidates": [{"id": "n1", "title": "c"}]}).json()
    assert [e["candidate_id"] for e in body["edges"]] == ["n1"] and body["topic_name"] == "AI in Radiology"


def test_health_reports_pools_without_secrets(monkeypatch):
    body = TestClient(m.app).get("/health").json()
    assert set(body["providers"]) == {"gemini", "groq"} and "routing" in body
    assert body["routing"]["understand"] == ["gemini", "groq"] and body["routing"]["goal_check"] == ["gemini", "groq"]


def test_fetch_blocks_private_and_metadata_addresses():
    from app.main import _public_host, fetch
    for url in ["http://localhost:8080/api/v1/me", "http://127.0.0.1/", "http://169.254.169.254/latest/meta-data/",
                "http://10.0.0.5/", "http://192.168.1.1/", "http://[::1]/", "file:///etc/passwd", "ftp://example.com/"]:
        assert not _public_host(url), url
        assert fetch(url) == ("", ""), url
