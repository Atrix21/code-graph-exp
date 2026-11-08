#!/usr/bin/env python
"""Thin benchmark adapter around the REAL Code Review Graph (CRG) implementation.

Run with the CRG venv interpreter:

    ROOT/vendor/.venvs/code-review-graph/bin/python ROOT/src/competitors/py/crg_adapter.py <build|query> ...

CRG (https://github.com/tirth8205/code-review-graph, pinned in
ROOT/vendor/code-review-graph) is a review/diff-oriented MCP server.  This
adapter does NOT re-implement or tune anything: it calls the very same Python
functions that CRG's MCP tools (code_review_graph/main.py) and CLI call, with
their documented defaults, and records exactly what they return.

Functions used (all in the installed `code_review_graph` package)
------------------------------------------------------------------
build   : code_review_graph.tools.build.build_or_update_graph(full_rebuild=True,
          postprocess="full")            == `code-review-graph build`
          code_review_graph.tools.docs.embed_graph(provider="local")
                                          == `code-review-graph embed` / embed_graph_tool
query   : code_review_graph.tools.query.semantic_search_nodes   == semantic_search_nodes_tool
          code_review_graph.tools.query.query_graph             == query_graph_tool
          code_review_graph.tools.query.get_impact_radius       == get_impact_radius_tool
          code_review_graph.tools.query.traverse_graph_func     == traverse_graph_tool
          code_review_graph.tools.context.get_minimal_context   == get_minimal_context_tool

The MCP wrappers in main.py only add (a) an async thread offload and (b) a
`_graph` provenance envelope (build timestamp + `age_seconds`, which changes
every second and so would make outputs non-reproducible).  We call the
underlying functions and serialise their dict result as compact JSON, exactly
like FastMCP does for a dict return value (no envelope).

Isolation
---------
* Graph DB location: `CRG_DATA_DIR=<out dir>` (documented env var), so nothing
  is written under the target repo (verified via `git status --ignored`).
* Per-user state (repo registry): `CRG_HOME=<out dir>/.crg_home`.
* Embedding model is loaded offline from the local HF cache (HF_HUB_OFFLINE=1).
* CRG stores ABSOLUTE file paths in node qualified names; queries therefore
  must be run against the same absolute repo path used for `build`.
"""
from __future__ import annotations

import argparse
import contextlib
import hashlib
import json
import os
import sqlite3
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[3]
VENDOR = ROOT / "vendor" / "code-review-graph"
METHOD = "code_review_graph"
META_FILE = "crg_adapter_build.json"

POLICIES = ("search_expand", "search_only", "search_impact", "search_traverse")
DEFAULT_POLICY = "search_expand"
EXPAND_PATTERNS = ("callers_of", "callees_of")


# --------------------------------------------------------------------------
# environment / helpers
# --------------------------------------------------------------------------
def _setup_env(graph_dir: Path) -> None:
    graph_dir.mkdir(parents=True, exist_ok=True)
    os.environ["CRG_DATA_DIR"] = str(graph_dir)
    os.environ.setdefault("CRG_HOME", str(graph_dir / ".crg_home"))
    os.environ.setdefault("HF_HUB_OFFLINE", "1")
    os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
    for k in ("CRG_OPENAI_API_KEY", "CRG_OPENAI_BASE_URL", "VOYAGE_API_KEY",
              "GOOGLE_API_KEY", "MINIMAX_API_KEY"):
        os.environ.pop(k, None)  # never let a stray key switch embedding provider
    import logging
    logging.basicConfig(level=logging.WARNING, stream=sys.stderr)


def _git(args: list[str], cwd: Path) -> str:
    return subprocess.run(["git", *args], cwd=str(cwd), capture_output=True, text=True,
                          check=False).stdout


def _vendor_commit() -> str | None:
    out = _git(["rev-parse", "HEAD"], VENDOR).strip()
    return out or None


def _vendor_tag() -> str | None:
    out = _git(["describe", "--tags", "--exact-match"], VENDOR).strip()
    return out or None


def _crg_version() -> str:
    from importlib.metadata import version
    return version("code-review-graph")


def _installed_matches_vendor() -> bool | None:
    """True iff every .py file of the vendored package is byte-identical to the installed one."""
    try:
        import code_review_graph
        inst = Path(code_review_graph.__file__).parent
        src = VENDOR / "code_review_graph"
        if not src.is_dir():
            return None
        for p in sorted(src.rglob("*.py")):
            q = inst / p.relative_to(src)
            if not q.is_file() or hashlib.sha256(p.read_bytes()).digest() != \
                    hashlib.sha256(q.read_bytes()).digest():
                return False
        return True
    except Exception:
        return None


def _repo_state(repo: Path) -> str:
    return _git(["status", "--porcelain", "--ignored", "--untracked-files=all"], repo)


def _db_path(graph_dir: Path) -> Path:
    return graph_dir / "graph.db"


def _count(graph_dir: Path) -> tuple[int, int]:
    con = sqlite3.connect(f"file:{_db_path(graph_dir)}?mode=ro", uri=True)
    try:
        n = con.execute("SELECT COUNT(*) FROM nodes").fetchone()[0]
        e = con.execute("SELECT COUNT(*) FROM edges").fetchone()[0]
        return int(n), int(e)
    finally:
        con.close()


def _dump(obj: Any) -> str:
    """Serialise like FastMCP does for a dict tool result (compact, UTF-8)."""
    return json.dumps(obj, separators=(",", ":"), ensure_ascii=False, default=str)


# --------------------------------------------------------------------------
# build
# --------------------------------------------------------------------------
def cmd_build(args: argparse.Namespace) -> int:
    repo = Path(args.repo).resolve()
    graph_dir = Path(args.out).resolve()
    if not (repo / ".git").exists():
        print(f"error: {repo} is not a git checkout (CRG requires .git; it indexes `git ls-files`)",
              file=sys.stderr)
        return 2
    # clean slate so the build is a pure function of the repo
    for suffix in ("", "-wal", "-shm", "-journal"):
        p = Path(str(_db_path(graph_dir)) + suffix)
        if p.exists():
            p.unlink()
    _setup_env(graph_dir)
    if args.device == "cpu":
        os.environ["CUDA_VISIBLE_DEVICES"] = ""

    from code_review_graph.tools.build import build_or_update_graph

    before = _repo_state(repo)
    notes: list[str] = [
        "pipeline=build_or_update_graph(full_rebuild=True, postprocess='full') [== `code-review-graph build`]",
        f"CRG_DATA_DIR={graph_dir} (graph kept outside target repo)",
    ]
    t0 = time.perf_counter()
    with contextlib.redirect_stdout(sys.stderr):
        res = build_or_update_graph(full_rebuild=True, repo_root=str(repo), postprocess="full")
    graph_ms = (time.perf_counter() - t0) * 1000.0

    details: dict[str, Any] = {
        "status": res.get("status"),
        "files_parsed": res.get("files_parsed"),
        "parse_errors": len(res.get("errors") or []),
        "parse_total_nodes": res.get("total_nodes"),
        "parse_total_edges": res.get("total_edges"),
        "flows_detected": res.get("flows_detected"),
        "communities_detected": res.get("communities_detected"),
        "warnings": res.get("warnings"),
        "graph_build_ms": round(graph_ms, 1),
    }
    if res.get("status") not in ("ok", "partial"):
        print(json.dumps({"error": "build failed", "details": res}), file=sys.stderr)
        return 1

    embed_info: dict[str, Any] | None = None
    embed_ms = 0.0
    if args.embeddings:
        from code_review_graph.tools.docs import embed_graph
        t1 = time.perf_counter()
        with contextlib.redirect_stdout(sys.stderr):
            er = embed_graph(repo_root=str(repo), provider="local")
        embed_ms = (time.perf_counter() - t1) * 1000.0
        if er.get("status") != "ok":
            print(json.dumps({"error": "embedding failed", "details": er}), file=sys.stderr)
            return 1
        device = "unknown"
        try:
            from code_review_graph.embeddings import _MODEL_CACHE
            m = next(iter(_MODEL_CACHE.values()))
            device = str(m.device)
        except Exception:
            pass
        embed_info = {"provider": "local", "model": os.environ.get("CRG_EMBEDDING_MODEL",
                      "all-MiniLM-L6-v2"), "device": device,
                      "newly_embedded": er.get("newly_embedded"),
                      "total_embeddings": er.get("total_embeddings"),
                      "embed_ms": round(embed_ms, 1)}
        details["embeddings"] = embed_info
        notes.append("embeddings=local sentence-transformers all-MiniLM-L6-v2 via embed_graph (explicit opt-in)")
    else:
        notes.append("embeddings=off -> search is FTS5 BM25 (+CRG's own name/kind boosts) only")

    after = _repo_state(repo)
    repo_clean = before == after
    details["target_repo_untouched"] = repo_clean
    if not repo_clean:
        notes.append("WARNING: target repo git status changed during build")

    nodes, edges = _count(graph_dir)
    build_ms = graph_ms + embed_ms
    meta = {
        "repo": str(repo), "embeddings": bool(args.embeddings), "device": args.device,
        "version": _crg_version(), "commit": _vendor_commit(), "nodes": nodes, "edges": edges,
        "embed": embed_info,
    }
    (graph_dir / META_FILE).write_text(json.dumps(meta, indent=2))

    out = {
        "build_ms": round(build_ms, 1),
        "nodes": nodes,
        "edges": edges,
        "version": _crg_version(),
        "commit": _vendor_commit(),
        "notes": "; ".join(notes),
        "details": {**details, "vendor_tag": _vendor_tag(),
                    "installed_matches_vendor": _installed_matches_vendor()},
    }
    print(json.dumps(out))
    return 0


# --------------------------------------------------------------------------
# query
# --------------------------------------------------------------------------
class Session:
    """Calls CRG tool functions and records raw responses in call order."""

    def __init__(self, repo: Path) -> None:
        self.repo = repo
        self.calls: list[dict[str, Any]] = []
        self.chunks: list[str] = []

    def call(self, tool: str, fn, **kwargs) -> dict[str, Any]:
        t0 = time.perf_counter()
        err = None
        try:
            resp = fn(**kwargs)
        except Exception as exc:  # CRG tools normally return {"status": "error"}; be defensive
            err = f"{type(exc).__name__}: {exc}"
            resp = {"status": "error", "error": err}
        ms = (time.perf_counter() - t0) * 1000.0
        text = _dump(resp)
        start = sum(len(c) + 1 for c in self.chunks)
        self.chunks.append(text)
        self.calls.append({
            "tool": tool,
            "args": {k: v for k, v in kwargs.items() if k != "repo_root"},
            "status": resp.get("status") if isinstance(resp, dict) else None,
            "latency_ms": round(ms, 2),
            "response_chars": len(text),
            "context_char_range": [start, start + len(text)],
            **({"exception": err} if err else {}),
        })
        return resp if isinstance(resp, dict) else {}

    @property
    def context(self) -> str:
        return "\n".join(self.chunks)


def _rel(path: str | None, repo: Path) -> str | None:
    if not path:
        return None
    try:
        return Path(path).resolve().relative_to(repo).as_posix()
    except (ValueError, OSError):
        p = Path(path)
        return p.as_posix() if not p.is_absolute() else None


def _row(d: dict[str, Any], repo: Path, *, file_key: str = "file_path",
         score: float | None = None) -> dict[str, Any] | None:
    qn = d.get("qualified_name") or d.get("name")
    f = _rel(d.get(file_key), repo)
    if not qn or f is None:
        return None  # unresolved bare-name target (e.g. `map`): no file -> not a locatable result
    kind = d.get("kind")
    symbol = qn.split("::", 1)[1] if "::" in qn else None
    ls, le = d.get("line_start"), d.get("line_end")
    return {
        "file": f,
        "symbol": symbol,
        "start_line": int(ls) if isinstance(ls, int) else None,
        "end_line": int(le) if isinstance(le, int) else None,
        "score": float(score) if score is not None else None,
        "node_type": kind,
        "raw_id": qn,
    }


def run_policy(policy: str, query: str, repo: Path, a: argparse.Namespace) -> tuple[Session, list[dict], dict]:
    from code_review_graph.tools.context import get_minimal_context
    from code_review_graph.tools.query import (
        get_impact_radius, query_graph, semantic_search_nodes, traverse_graph_func,
    )

    s = Session(repo)
    root = str(repo)
    meta: dict[str, Any] = {"query_has_double_quotes": '"' in query}
    rows: list[dict[str, Any]] = []

    def add(row: dict | None) -> None:
        if row is not None:
            rows.append(row)

    if a.include_minimal_context:
        s.call("get_minimal_context_tool", get_minimal_context, task=f"debug: {query}", repo_root=root)

    # ---- step 1: search (all policies) -----------------------------------
    sk: dict[str, Any] = {"query": query, "repo_root": root, "detail_level": a.detail_level}
    if a.limit is not None:
        sk["limit"] = a.limit  # otherwise the tool's own default (20) applies
    sr = s.call("semantic_search_nodes_tool", semantic_search_nodes, **sk)
    meta["search_mode"] = sr.get("search_mode")
    hits = sr.get("results") or []
    for h in hits:
        add(_row(h, repo, score=h.get("score")))

    # callers_of / callees_of are call-graph patterns ("Find functions that call/are called by the
    # target", tools/query.py::_QUERY_PATTERNS), so only callable hits are expanded.  Expanding a
    # Class/File hit with them returns nothing (verified), which would waste the seed budget.
    kinds = set(a.seed_kinds)
    seeds = [h for h in hits if h.get("kind") in kinds][: a.seeds]
    meta["seeds"] = [h.get("qualified_name") for h in seeds]

    # ---- step 2: policy-specific expansion --------------------------------
    if policy == "search_only":
        pass
    elif policy == "search_expand":
        # CRG's shipped debug workflow (prompts.debug_issue_prompt + skills/debug-issue):
        # search -> query_graph(callers_of) [+ callees_of] on the top 1-2 hits.
        for h in seeds:
            target = h.get("qualified_name") or h.get("name")
            for pat in a.expand_patterns:
                kw: dict[str, Any] = {"pattern": pat, "target": target, "repo_root": root,
                                      "detail_level": a.detail_level}
                if a.expand_limit is not None:
                    kw["max_results"] = a.expand_limit
                r = s.call("query_graph_tool", query_graph, **kw)
                for x in r.get("results") or []:
                    add(_row(x, repo))
    elif policy == "search_impact":
        files: list[str] = []
        for h in seeds:
            rf = _rel(h.get("file_path"), repo)
            if rf and rf not in files:
                files.append(rf)
        if files:
            r = s.call("get_impact_radius_tool", get_impact_radius, changed_files=files,
                       repo_root=root, detail_level=a.detail_level)
            for x in r.get("impacted_nodes") or []:
                add(_row(x, repo, score=x.get("impact_score")))
        meta["impact_changed_files"] = files
    elif policy == "search_traverse":
        r = s.call("traverse_graph_tool", traverse_graph_func, query=query, repo_root=root)
        for x in r.get("traversal") or []:
            add(_row(x, repo, file_key="file"))
    else:  # pragma: no cover
        raise ValueError(policy)

    # dedupe by raw_id keeping first occurrence
    seen: set[str] = set()
    out: list[dict] = []
    for r_ in rows:
        if r_["raw_id"] in seen:
            continue
        seen.add(r_["raw_id"])
        out.append(r_)
    meta["n_rows_before_dedupe"] = len(rows)
    return s, out, meta


def cmd_query(args: argparse.Namespace) -> int:
    graph_dir = Path(args.graph).resolve()
    repo = Path(args.repo).resolve()
    if not _db_path(graph_dir).is_file():
        print(f"error: no CRG graph at {_db_path(graph_dir)}; run `build` first", file=sys.stderr)
        return 2
    _setup_env(graph_dir)
    build_meta: dict[str, Any] = {}
    mp = graph_dir / META_FILE
    if mp.is_file():
        build_meta = json.loads(mp.read_text())
        if build_meta.get("device") == "cpu":
            os.environ["CUDA_VISIBLE_DEVICES"] = ""
        if build_meta.get("repo") and Path(build_meta["repo"]) != repo:
            print(f"error: graph was built for {build_meta['repo']}, not {repo}", file=sys.stderr)
            return 2

    policy = args.policy
    if policy not in POLICIES:
        print(f"error: unknown policy {policy}; choose from {POLICIES}", file=sys.stderr)
        return 2

    # Same as `code-review-graph serve` startup (main.main): load the local embedding model once
    # before serving, so first-query latency is not dominated by model load.
    if build_meta.get("embeddings"):
        t0 = time.perf_counter()
        from code_review_graph.embeddings import prewarm_local_embeddings
        prewarm_local_embeddings()
        print(f"[crg_adapter] embedding model prewarmed in {(time.perf_counter()-t0)*1000:.0f} ms",
              file=sys.stderr)

    # Untimed warm-up: the first search call lazily imports sentence_transformers/torch
    # (code_review_graph.embeddings._check_available) even for FTS-only graphs, a ~3-5 s one-off that
    # an MCP server pays at startup, not per query.
    from code_review_graph.tools.query import semantic_search_nodes as _warm
    _warm(query="warmup", limit=1, repo_root=str(repo))

    tasks = [json.loads(l) for l in Path(args.queries).read_text().splitlines() if l.strip()]
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as fh:
        for t in tasks:
            t0 = time.perf_counter()
            sess, results, meta = run_policy(policy, t["query"], repo, args)
            latency = (time.perf_counter() - t0) * 1000.0
            ctx = sess.context
            meta.update({
                "policy": policy,
                "tool_calls": sess.calls,
                "embeddings_in_graph": bool(build_meta.get("embeddings")),
                "detail_level": args.detail_level,
                "context_chars": len(ctx),
                "crg_token_estimate_chars_div_4": max(1, len(ctx) // 4) if ctx else 0,
                "crg_version": _crg_version(),
            })
            rec = {
                "task_id": t["task_id"],
                "method": METHOD,
                "context": ctx,
                "results": results,
                "latency_ms": round(latency, 2),
                "llm_tokens": None,
                "metadata": meta,
            }
            fh.write(json.dumps(rec, ensure_ascii=False) + "\n")
    return 0


# --------------------------------------------------------------------------
def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)

    b = sub.add_parser("build", help="build CRG graph (full rebuild, postprocess=full)")
    b.add_argument("--repo", required=True, help="absolute path to a git checkout of the TS repo")
    b.add_argument("--out", required=True, help="output dir (becomes CRG_DATA_DIR; holds graph.db)")
    b.add_argument("--embeddings", action="store_true",
                   help="also run embed_graph (local sentence-transformers all-MiniLM-L6-v2)")
    b.add_argument("--device", choices=("auto", "cpu"), default="auto",
                   help="auto: sentence-transformers picks CUDA if available; cpu: hide GPUs")
    b.set_defaults(fn=cmd_build)

    q = sub.add_parser("query", help="answer NL queries with CRG's agent-facing tools")
    q.add_argument("--graph", required=True, help="dir given as --out to build")
    q.add_argument("--repo", required=True, help="same absolute repo path used at build")
    q.add_argument("--queries", required=True, help="jsonl: {task_id, query}")
    q.add_argument("--out", required=True, help="output jsonl")
    q.add_argument("--policy", default=DEFAULT_POLICY, choices=POLICIES)
    q.add_argument("--limit", type=int, default=None,
                   help="results requested from the search tool (default: tool default = 20)")
    q.add_argument("--seeds", type=int, default=2,
                   help="top-N search hits (of --seed-kinds) expanded (CRG debug prompt: 'top 1-2 results')")
    q.add_argument("--seed-kinds", nargs="+", default=["Function", "Test"],
                   help="node kinds eligible as expansion seeds (callers_of/callees_of are call-graph queries)")
    q.add_argument("--expand-patterns", nargs="+", default=list(EXPAND_PATTERNS),
                   help="query_graph patterns used by search_expand (default callers_of callees_of)")
    q.add_argument("--expand-limit", type=int, default=None,
                   help="max_results for query_graph (default: tool default = 100)")
    q.add_argument("--detail-level", choices=("standard", "minimal"), default="standard",
                   help="CRG detail_level passed to every tool (tool default = standard)")
    q.add_argument("--include-minimal-context", action="store_true",
                   help="prepend get_minimal_context_tool (CRG prompts say 'call first'); adds ~100 tokens, no results")
    q.set_defaults(fn=cmd_query)

    args = ap.parse_args(argv)
    return args.fn(args)


if __name__ == "__main__":
    sys.exit(main())
