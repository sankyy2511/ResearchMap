"""End-to-end test of the Research Map MCP server against a running stack (Go + Python + PostgreSQL).

Uses the official MCP Python SDK over Streamable HTTP, exactly like Claude Code / Claude Desktop would.
Creates its own throw-away users and workspace. Run from the repo root:

    cd agent && uv run --with mcp --with websockets python ../scripts/mcp_e2e.py [--api http://localhost:8080/api/v1]

Exit code 0 = every check passed.
"""
from __future__ import annotations

import argparse, asyncio, json, random, sys, time

import httpx, websockets

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
from mcp import ClientSession
from mcp.client.streamable_http import streamable_http_client

ap = argparse.ArgumentParser()
ap.add_argument("--api", default="http://localhost:8080/api/v1")
ap.add_argument("--wait", type=int, default=90, help="seconds to wait for the AI pipeline")
API = ap.parse_args().api
MCP_URL = API + "/mcp"
WAIT = ap.parse_args().wait
results: list[tuple[bool, str]] = []


def check(cond: bool, name: str, detail: str = "") -> bool:
    results.append((bool(cond), name))
    print(("PASS " if cond else "FAIL ") + name + (f"  [{detail}]" if detail and not cond else ""), flush=True)
    return bool(cond)


def new_user(label: str) -> httpx.Client:
    c = httpx.Client(timeout=30)
    # Needs the backend started with DEV_AUTH_CODES=true (development only): the sign-up code comes back in the response.
    email = f"mcp-e2e-{random.randint(1, 10**9)}@example.com"
    r = c.post(API + "/auth/register", json={"name": "Test " + label.capitalize(), "email": email, "password": "Quiet#Harbor2026"})
    r.raise_for_status()
    body = r.json()
    if body.get("verification_required"):
        if "dev_code" not in body:
            sys.exit("Start the backend with DEV_AUTH_CODES=true to run this test.")
        c.post(API + "/auth/verify", json={"email": email, "code": body["dev_code"]}).raise_for_status()
    return c


def token(c: httpx.Client, kind: str, **extra) -> str:
    r = c.post(API + "/tokens", json={"kind": kind, "name": "e2e", **extra})
    r.raise_for_status()
    return r.json()["token"]


class Client:
    """One MCP session (initialize once, many tool calls), like a real assistant."""

    def __init__(self, tok: str, name: str = "e2e-test-client"):
        self.tok, self.name = tok, name

    async def __aenter__(self):
        from mcp.types import Implementation
        self._http = httpx.AsyncClient(headers={"Authorization": "Bearer " + self.tok}, timeout=90)
        self._cm = streamable_http_client(MCP_URL, http_client=self._http)
        r, w = await self._cm.__aenter__()
        self._s = ClientSession(r, w, client_info=Implementation(name=self.name, version="1.0"))
        await self._s.__aenter__()
        await self._s.initialize()
        return self

    async def __aexit__(self, *a):
        await self._s.__aexit__(*a)
        await self._cm.__aexit__(*a)
        await self._http.aclose()

    async def tools(self) -> list[str]:
        return [t.name for t in (await self._s.list_tools()).tools]

    async def call(self, name: str, args: dict):
        res = await self._s.call_tool(name, args)
        if res.is_error:
            return True, (res.content[0].text if res.content else "")
        return False, (res.structured_content or {}).get("result")


async def one_call(tok: str, name: str, args: dict):
    async with Client(tok) as c:
        return await c.call(name, args)


async def main() -> int:
    owner = new_user("MCP owner")
    ws_id = owner.post(API + "/workspaces", json={"title": "AI Healthcare Research (MCP e2e)"}).json()["id"]
    tok = token(owner, "mcp")

    events: list[dict] = []
    cookie = "; ".join(f"{k}={v}" for k, v in owner.cookies.items())

    async def listen():
        async with websockets.connect(f"{API.replace('http', 'ws', 1)}/ws?workspace_id={ws_id}",
                                      additional_headers={"Cookie": cookie, "Origin": "http://localhost:3000"}) as w:
            while True:
                events.append(json.loads(await w.recv()))

    lt = asyncio.create_task(listen())
    await asyncio.sleep(1)

    async with Client(tok, "claude-e2e") as ai:
        # ---- discovery
        tools = await ai.tools()
        want = {"list_workspaces", "search_workspace", "get_node", "get_graph_outline", "add_question", "add_source", "add_note",
                "add_finding", "link_nodes", "list_conflicts", "get_references", "get_session_report"}
        check(want <= set(tools), "tool discovery: all 12 tools listed", str(sorted(want - set(tools))))
        err, wss = await ai.call("list_workspaces", {})
        check(not err and any(w["id"] == ws_id and w["can_write"] for w in wss), "list_workspaces finds the workspace (writable)")

        # ---- the AI's research journey
        err, q = await ai.call("add_question", {"workspace_id": ws_id, "question": "How is AI used in medical diagnosis?"})
        check(not err and q["is_new"], "add_question creates a Question node", str(q))
        err, s1 = await ai.call("add_source", {"workspace_id": ws_id, "question": "How is AI used in medical diagnosis?",
            "url": "https://en.wikipedia.org/wiki/Artificial_intelligence_in_healthcare", "title": "Artificial intelligence in healthcare - Wikipedia",
            "content": "Artificial intelligence in healthcare is the application of AI to analyze and understand complex medical and health data. "
                       "AI models have been used to detect diseases such as cancer in medical images with accuracy comparable to radiologists. "
                       "AI tools can reduce diagnostic errors but raise concerns about bias and privacy.",
            "note": "Broad overview; good starting point."})
        check(not err and s1["is_new"], "add_source (with content) creates a node immediately", str(s1))
        err, s2 = await ai.call("add_source", {"workspace_id": ws_id, "url": "https://en.wikipedia.org/wiki/Computer-aided_diagnosis",
                                                "question": "How is AI used in medical diagnosis?"})
        check(not err and s2["is_new"], "add_source (URL only) creates a node; server fetches the public page", str(s2))
        err, dup = await ai.call("add_source", {"workspace_id": ws_id, "url": "https://en.wikipedia.org/wiki/Computer-aided_diagnosis?utm_source=chatgpt"})
        check(not err and not dup["is_new"] and dup["node_id"] == s2["node_id"], "duplicate URL (tracking params) returns the same node")

        # ---- wait for Agent 1 → Agent 2 → Agent 3 on both sources
        deadline = time.time() + WAIT
        nodes = {}
        while time.time() < deadline:
            g = owner.get(API + f"/workspaces/{ws_id}/graph").json()
            nodes = {n["id"]: n for n in g["nodes"]}
            if all(nodes.get(s["node_id"], {}).get("ai_stage") in ("ready", "failed") for s in (s1, s2)):
                break
            await asyncio.sleep(3)
        for s, label in ((s1, "source 1"), (s2, "source 2")):
            check(nodes.get(s["node_id"], {}).get("ai_stage") == "ready", f"AI pipeline finished for {label} (ready)", nodes.get(s["node_id"], {}).get("ai_stage", "missing"))

        err, n2 = await ai.call("get_node", {"node_id": s2["node_id"]})
        check(not err and n2["page"]["summary"], "get_node returns Agent 1 summary for the fetched source")
        check(not err and n2["node"]["title"] != "en.wikipedia.org", "URL-only source got its real page title", n2["node"]["title"] if not err else "")

        # ---- conclusions and relationships
        err, f = await ai.call("add_finding", {"workspace_id": ws_id, "statement": "AI can match radiologist accuracy in image-based diagnosis, but bias remains a risk.",
                                               "source_node_ids": [s1["node_id"], s2["node_id"]]})
        check(not err and len(f["edge_ids"]) == 2, "add_finding creates a Finding with 2 'supports' edges", str(f))
        err, bad = await ai.call("add_finding", {"workspace_id": ws_id, "statement": "x", "source_node_ids": ["00000000-0000-0000-0000-000000000000"]})
        check(not err and bad.get("ignored_source_ids") == ["00000000-0000-0000-0000-000000000000"] and not bad["edge_ids"],
              "add_finding reports unknown source ids and links none")
        err, note = await ai.call("add_note", {"node_id": f["node_id"], "text": "Needs a clinical-trial source."})
        check(not err and note.get("annotation_id"), "add_note on a node")
        err, wnote = await ai.call("add_note", {"workspace_id": ws_id, "text": "Next: look for regulation (FDA) sources."})
        check(not err and wnote.get("node_id"), "add_note with workspace_id creates a Note node")
        err, l = await ai.call("link_nodes", {"source_id": s2["node_id"], "target_id": s1["node_id"], "relation": "example_of", "reason": "CAD is one application of AI in healthcare."})
        check(not err or "already exists" in str(l), "link_nodes creates an explained suggestion", str(l))
        err, msg = await ai.call("link_nodes", {"source_id": s2["node_id"], "target_id": s1["node_id"], "relation": "is_cool", "reason": "x"})
        check(err, "link_nodes rejects unknown relation types")

        # ---- reading back
        err, hits = await ai.call("search_workspace", {"workspace_id": ws_id, "query": "diagnosis"})
        check(not err and any(h.get("node_id") == s2["node_id"] for h in hits), "search_workspace (hybrid) finds the source")
        err, outline = await ai.call("get_graph_outline", {"workspace_id": ws_id})
        check(not err and "[finding]" in outline and "AI Agent branch" in outline, "get_graph_outline shows sources/findings with branch")
        err, refs = await ai.call("get_references", {"workspace_id": ws_id})
        check(not err and len(refs["references"]) == 2 and "[1]" in refs["markdown"], "get_references(workspace_id) lists both sources", str(refs)[:200])
        err, _ = await ai.call("list_conflicts", {"workspace_id": ws_id})
        check(not err, "list_conflicts works")

    # ---- what the user sees (REST, default canvas view = what the web app loads)
    g = owner.get(API + f"/workspaces/{ws_id}/graph").json()
    agent = next(b["id"] for b in g["branches"] if b["kind"] == "agent")
    mine = [n for n in g["nodes"] if n["created_via"] == "mcp"]
    check(len(mine) >= 5, "default canvas view includes the AI's nodes", f"{len(mine)} mcp nodes")
    check(all(n["branch_id"] == agent for n in mine), "every MCP node is in the AI Agent branch")
    check(all((n.get("created_by_name") or "").startswith("AI assistant (claude-e2e)") for n in mine), "provenance: client name stored on nodes",
          str({n.get("created_by_name") for n in mine}))
    ai_edges = [e for e in g["edges"] if e["origin"] == "mcp"]
    check(len(ai_edges) >= 2 and all(e["branch_id"] == agent and e["state"] == "suggested" for e in ai_edges),
          "AI links: origin=mcp, suggested (user-reviewable), AI Agent branch")
    qn = next((n for n in g["nodes"] if n["type"] == "question"), None)
    linked = {e["target_id"] for e in g["edges"] if qn and e["source_id"] == qn["id"]}
    check(qn is not None and (s1["node_id"] in linked or s2["node_id"] in linked), "research journey: question → source edge (answers / opened_from)")
    check(any(n["type"] == "topic" for n in g["nodes"]), "Agent 2 placed sources into a topic group")

    # ---- realtime
    await asyncio.sleep(2)
    lt.cancel()
    kinds = [e["type"] for e in events]
    for k in ("node.created", "page.analyzed", "edge.created", "annotation.created", "job.status"):
        check(k in kinds, f"WebSocket delivered {k}")
    check(any(e["type"] == "node.created" and (e.get("data") or {}).get("type") == "finding" for e in events), "WebSocket delivered the finding live")

    # ---- review: the user accepts one AI link, and can copy AI work to Main
    e0 = ai_edges[0]
    r = owner.patch(API + f"/edges/{e0['id']}", json={"state": "accepted", "version": e0["version"]})
    check(r.status_code == 200 and r.json()["locked"], "user accepts an AI link (locked afterwards)")
    r = owner.post(API + f"/branches/{agent}/merge", json={"node_ids": [f["node_id"], s1["node_id"], s2["node_id"]]})
    check(r.status_code == 200 and len(r.json()["copied_node_ids"]) == 3, "user copies AI research to Main (merge)", r.text[:200])

    # ---- security
    other = new_user("Other user")
    other_ws = other.post(API + "/workspaces", json={"title": "Private"}).json()["id"]
    err, msg = await one_call(tok, "add_source", {"workspace_id": other_ws, "url": "https://example.com"})
    check(err, "cannot write into another user's workspace")
    err, msg = await one_call(token(other, "mcp"), "get_node", {"node_id": s1["node_id"]})
    check(err, "cannot read another user's node")
    link = owner.post(API + f"/workspaces/{ws_id}/share-links", json={"role": "viewer"}).json()
    viewer = new_user("Viewer")
    viewer.post(API + "/join/" + link["url"].rstrip("/").split("/")[-1]).raise_for_status()
    vt = token(viewer, "mcp")
    err, _ = await one_call(vt, "search_workspace", {"workspace_id": ws_id, "query": "AI"})
    check(not err, "viewer can read")
    err, msg = await one_call(vt, "add_finding", {"workspace_id": ws_id, "statement": "x", "source_node_ids": []})
    check(err and "viewers" in msg, "viewer cannot write")
    for url in ("http://localhost:8080/api/v1/me", "http://169.254.169.254/latest/meta-data/", "http://127.0.0.1:8000/health"):
        err, res = await one_call(tok, "add_source", {"workspace_id": ws_id, "url": url})
        if not err:
            time.sleep(15)
            err2, n = await one_call(tok, "get_node", {"node_id": res["node_id"]})
            leaked = (n.get("page") or {}).get("content_text") or ""
            check(not leaked, f"SSRF blocked: no content fetched from {url}", leaked[:80])
        else:
            check(True, f"SSRF blocked: {url} rejected")
    st = httpx.post(MCP_URL, headers={"Authorization": "Bearer " + token(owner, "extension")}, json={}).status_code
    check(st == 401, "extension token is rejected by /mcp")
    check(httpx.post(MCP_URL, json={}).status_code == 401, "no token → 401")
    tid = [t for t in owner.get(API + "/tokens").json() if t["kind"] == "mcp"][0]["id"]
    owner.delete(API + f"/tokens/{tid}")
    check(httpx.post(MCP_URL, headers={"Authorization": "Bearer " + tok}, json={}).status_code == 401, "revoked token → 401")

    passed = sum(ok for ok, _ in results)
    print(f"\n{passed}/{len(results)} checks passed. Workspace: {ws_id}")
    return 0 if passed == len(results) else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
