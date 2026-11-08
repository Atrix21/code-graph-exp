#!/usr/bin/env python3
"""Thin adapter around the REAL Graphify (Graphify-Labs/graphify, PyPI `graphifyy`).

Run with the pinned venv interpreter:

    ROOT/vendor/.venvs/graphify/bin/python ROOT/src/competitors/py/graphify_adapter.py <cmd> ...

Commands
--------
build  --repo <abs TS repo> --out <abs out dir>
    Runs Graphify's headless, LLM-free code pipeline:
        python -m graphify extract <repo> --code-only --out <out>
    which (tree-sitter AST -> build -> cluster) writes <out>/graphify-out/graph.json
    (+ cache/, manifest.json, .graphify_*.json).  Nothing is written into the repo
    (`--out` redirects every artifact; verified by `git status` in the notes).
    Prints one JSON line: build_ms, nodes, edges, graphify_version, commit, notes.

query  --graph <out dir | graph.json> --repo <abs repo> --queries in.jsonl --out out.jsonl
       [--budget N] [--depth N] [--mode bfs|dfs]
    For each {"task_id", "query"}: runs the *actual* `graphify query "<q>" --graph ...`
    CLI as a subprocess (exactly what an agent's Bash tool call would do) and records
    its stdout verbatim as `context`.  In the same process-free pass we also run
    Graphify's own `_query_graph_text` in-process (same loader as the CLI) with a
    pass-through hook on `_subgraph_to_text` purely to recover node ids and Graphify's
    internal scores; the two texts are compared and the result is recorded in
    metadata.inprocess_matches_cli.  `results` is the NODE lines of the context in the
    order Graphify printed them (no re-ranking, no filtering).

No Graphify source is modified.  Defaults are Graphify's CLI defaults (bfs, depth 2,
budget 2000) unless --mode/--depth/--budget are passed.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path, PurePosixPath

ROOT = Path(__file__).resolve().parents[3]
VENDOR = ROOT / "vendor" / "graphify"

# Never let Graphify touch anything outside the dirs we hand it.
_ENV = {
    "GRAPHIFY_NO_AUTO_REFRESH": "1",       # otherwise it rewrites ~/.claude skill files on every run
    "GRAPHIFY_QUERY_LOG_DISABLE": "1",     # no ~/.cache/graphify-queries.log writes
    "GRAPHIFY_BACKEND": "none",            # hard-disable every LLM backend (belt and braces)
    "PYTHONIOENCODING": "utf-8",
}


def _env() -> dict:
    e = dict(os.environ)
    e.update(_ENV)
    return e


def _graphify_version() -> str:
    try:
        from importlib.metadata import version
        return version("graphifyy")
    except Exception:
        return "unknown"


def _commit() -> str:
    try:
        return subprocess.check_output(
            ["git", "-C", str(VENDOR), "rev-parse", "HEAD"], text=True, stderr=subprocess.DEVNULL
        ).strip()
    except Exception:
        return "unknown"


def _graph_json_path(p: str) -> Path:
    p = Path(p).resolve()
    if p.is_file():
        return p
    cand = p / "graphify-out" / "graph.json"
    if cand.exists():
        return cand
    cand = p / "graph.json"
    if cand.exists():
        return cand
    raise SystemExit(f"error: no graph.json under {p}")


# --------------------------------------------------------------------------- build
def cmd_build(args) -> int:
    repo = Path(args.repo).resolve()
    out = Path(args.out).resolve()
    if not repo.is_dir():
        raise SystemExit(f"error: repo not found: {repo}")
    if out == repo or repo in out.parents:
        raise SystemExit("error: --out must be outside the target repo")
    gout = out / "graphify-out"
    if gout.exists():
        # Our own previous output only: force a cold, full, non-incremental build
        # (otherwise `extract` would run incrementally against the existing graph).
        shutil.rmtree(gout)
    out.mkdir(parents=True, exist_ok=True)

    cmd = [sys.executable, "-m", "graphify", "extract", str(repo), "--code-only", "--out", str(out)]
    t0 = time.perf_counter()
    proc = subprocess.run(cmd, capture_output=True, text=True, env=_env(), cwd=str(out))
    build_ms = (time.perf_counter() - t0) * 1000.0
    (out / "graphify_build.log").write_text(
        "$ " + " ".join(cmd) + f"\n[exit {proc.returncode}]\n--- stdout ---\n{proc.stdout}\n--- stderr ---\n{proc.stderr}\n",
        encoding="utf-8",
    )
    gp = gout / "graph.json"
    if proc.returncode != 0 or not gp.exists():
        sys.stderr.write(proc.stdout + proc.stderr)
        raise SystemExit(f"error: graphify extract failed (exit {proc.returncode})")

    g = json.loads(gp.read_text(encoding="utf-8"))
    nodes = g.get("nodes", [])
    edges = g.get("links") or g.get("edges") or []
    rel: dict = {}
    conf: dict = {}
    for e in edges:
        rel[e.get("relation")] = rel.get(e.get("relation"), 0) + 1
        conf[e.get("confidence")] = conf.get(e.get("confidence"), 0) + 1
    ftype: dict = {}
    for n in nodes:
        ftype[n.get("file_type")] = ftype.get(n.get("file_type"), 0) + 1
    skipped = [l.strip() for l in proc.stdout.splitlines() if "skipped" in l or "yielded no symbols" in l]
    notes = (
        "graphify extract --code-only (tree-sitter AST, no LLM); cold build into --out/graphify-out; "
        "repo not written to. Includes package.json dependency 'concept' nodes and external stub nodes in counts."
    )
    line = {
        "build_ms": round(build_ms, 1),
        "nodes": len(nodes),
        "edges": len(edges),
        "graphify_version": g.get("graph", {}).get("graphify_version") or _graphify_version(),
        "commit": _commit(),
        "notes": notes,
        "graph_json": str(gp),
        "node_file_types": ftype,
        "edge_relations": rel,
        "edge_confidence": conf,
        "graphify_messages": skipped,
    }
    print(json.dumps(line, ensure_ascii=False))
    return 0


# --------------------------------------------------------------------------- query
_NODE_RE = re.compile(r"^NODE (?P<label>.*?) \[src=(?P<src>.*?) loc=(?P<loc>.*?) community=")
_FOUND_RE = re.compile(r"(\d+) nodes found")
_START_RE = re.compile(r"Start(?: \(given\))?: (\[.*?\])(?: \| |$)")


def _load_inprocess(gp: Path):
    """Load graph.json exactly like the `graphify query` CLI branch (graphify/cli.py)."""
    from networkx.readwrite import json_graph
    from graphify.paths import consumed_graph_rows, read_graph_json
    raw = read_graph_json(gp)
    if "links" not in raw and "edges" in raw:
        raw = dict(raw, links=raw["edges"])
    rows = consumed_graph_rows(dict(raw, links=raw.get("links", [])))
    return json_graph.node_link_graph(rows, edges="links")


def _node_type(d: dict) -> str:
    """Adapter-side classification from Graphify's own node attributes (Graphify has no
    node-kind field for TS code nodes)."""
    label = str(d.get("label") or "")
    if d.get("type") == "external" or not d.get("source_file"):
        return "external"  # import-bound stub (e.g. a NestJS decorator): no file, no line
    if d.get("file_type") == "concept":
        return "dependency"
    sf = str(d.get("source_file") or "")
    if sf and PurePosixPath(sf).name == label.split("/")[-1] and d.get("source_location") == "L1":
        return "file"
    if label.endswith("()"):
        return "method" if label.startswith(".") else "function"
    if d.get("_callable_class"):
        return "class"
    return "type_or_variable"


def _symbol(d: dict, ntype: str):
    if ntype in ("file", "external", "dependency"):
        return None
    label = str(d.get("label") or "")
    if label.endswith("()"):
        label = label[:-2]
    return label.lstrip(".") or None


def _line(loc) -> int | None:
    m = re.fullmatch(r"L(\d+)", str(loc or ""))
    return int(m.group(1)) if m else None


def _rel(sf: str, repo: Path) -> str | None:
    if not sf:
        return None
    p = Path(sf)
    if p.is_absolute():
        try:
            p = p.relative_to(repo)
        except ValueError:
            return p.as_posix()
    return p.as_posix()


def cmd_query(args) -> int:
    repo = Path(args.repo).resolve()
    gp = _graph_json_path(args.graph)
    queries = [json.loads(l) for l in Path(args.queries).read_text(encoding="utf-8").splitlines() if l.strip()]

    # --- in-process side (id/score recovery only) ---------------------------------
    sys.path.insert(0, str(VENDOR))  # no-op for an editable install; keeps `-I`-style runs working
    from graphify import serve as gserve
    from graphify.cli import _graph_root_for
    from graphify.rcfile import load_graphifyrc
    from graphify.security import sanitize_label

    G = _load_inprocess(gp)
    try:
        rc = load_graphifyrc(_graph_root_for(gp))
    except Exception:
        rc = {}
    eff_budget = args.budget if args.budget is not None else rc.get("query_budget", 2000)
    eff_depth = args.depth if args.depth is not None else rc.get("query_depth", 2)

    captured: dict = {}
    orig = gserve._subgraph_to_text

    def _hook(Gx, nodes, edges, token_budget=2000, *, seeds=None, scores=None):
        captured["nodes"] = set(nodes)
        captured["seeds"] = list(seeds or [])
        captured["scores"] = dict(scores or {})
        return orig(Gx, nodes, edges, token_budget, seeds=seeds, scores=scores)

    gserve._subgraph_to_text = _hook  # pass-through observer, output unchanged

    # (label, src, loc) -> [node ids]  using the same sanitisation the renderer applies
    key_index: dict = {}
    for nid, d in G.nodes(data=True):
        k = (sanitize_label(d.get("label", nid)), sanitize_label(str(d.get("source_file", ""))),
             sanitize_label(str(d.get("source_location", ""))))
        key_index.setdefault(k, []).append(nid)

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    cwd = str(gp.parent.parent)
    with out_path.open("w", encoding="utf-8") as fh:
        for q in queries:
            question = q["query"]
            cmd = [sys.executable, "-m", "graphify", "query", question, "--graph", str(gp)]
            if args.mode == "dfs":
                cmd.append("--dfs")
            if args.budget is not None:
                cmd += ["--budget", str(args.budget)]
            if args.depth is not None:
                cmd += ["--depth", str(args.depth)]
            for c in args.context or []:
                cmd += ["--context", c]
            t0 = time.perf_counter()
            proc = subprocess.run(cmd, capture_output=True, text=True, env=_env(), cwd=cwd)
            latency_ms = (time.perf_counter() - t0) * 1000.0
            context = proc.stdout[:-1] if proc.stdout.endswith("\n") else proc.stdout

            captured.clear()
            t1 = time.perf_counter()
            try:
                inproc = gserve._query_graph_text(
                    G, question, mode=args.mode, depth=eff_depth, token_budget=eff_budget,
                    context_filters=list(args.context or []), graph_path=str(gp), seeds=None, seed_root=repo,
                )
            except Exception as exc:  # pragma: no cover
                inproc = f"<<in-process error: {exc!r}>>"
            inproc_ms = (time.perf_counter() - t1) * 1000.0
            # Header embeds the graph path (CLI shows it cwd-relative); compare bodies only.
            body = lambda s: s.split("\n", 1)[1] if "\n" in s else s  # noqa: E731
            match = body(inproc) == body(context)

            scores = captured.get("scores", {})
            in_set = captured.get("nodes", set())
            used: set = set()
            results = []
            ambiguous = 0
            for ln in context.splitlines():
                m = _NODE_RE.match(ln)
                if not m:
                    continue
                k = (m["label"], m["src"], m["loc"])
                cands = [c for c in key_index.get(k, []) if (not in_set or c in in_set)]
                free = [c for c in cands if c not in used]
                if len(cands) > 1:
                    ambiguous += 1
                nid = (free or cands or [None])[0]
                if nid is None:
                    results.append({"file": _rel(m["src"], repo), "symbol": None,
                                    "start_line": _line(m["loc"]), "end_line": None, "score": None,
                                    "node_type": None, "raw_id": f"unresolved:{m['label']}|{m['src']}|{m['loc']}"})
                    continue
                used.add(nid)
                d = G.nodes[nid]
                nt = _node_type(d)
                results.append({
                    "file": _rel(str(d.get("source_file") or ""), repo),
                    "symbol": _symbol(d, nt),
                    "start_line": _line(d.get("source_location")),
                    "end_line": None,  # Graphify stores only "L<start>"
                    "score": float(scores.get(nid, 0.0)) if scores else None,
                    "node_type": nt,
                    "raw_id": nid,
                })

            hdr = context.split("\n", 1)[0]
            found = _FOUND_RE.search(hdr)
            start = _START_RE.search(hdr)
            rec = {
                "task_id": q["task_id"],
                "method": "graphify",
                "context": context,
                "results": results,
                "latency_ms": round(latency_ms, 2),
                "llm_tokens": None,
                "metadata": {
                    "cmd": cmd[2:],
                    "exit_code": proc.returncode,  # 0 answer, 3 ambiguous name, 4 no match
                    "mode": args.mode,
                    "depth": eff_depth,
                    "budget": eff_budget,
                    "truncated": bool(re.search(r"^\[!\] TRUNCATED", context, re.M)),
                    "nodes_found_reported": int(found.group(1)) if found else None,
                    "nodes_shown": len(results),
                    "start_labels_header": start.group(1) if start else None,
                    "seed_ids": captured.get("seeds"),
                    "context_chars": len(context),
                    "inprocess_matches_cli": match,
                    "inprocess_latency_ms": round(inproc_ms, 2),
                    "ambiguous_node_keys": ambiguous,
                    "score_note": "score = Graphify's internal lexical score for the node (0.0 = reached by traversal only); not printed in context",
                    "graphify_version": _graphify_version(),
                },
            }
            fh.write(json.dumps(rec, ensure_ascii=False) + "\n")
    gserve._subgraph_to_text = orig
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    b = sub.add_parser("build")
    b.add_argument("--repo", required=True)
    b.add_argument("--out", required=True)
    q = sub.add_parser("query")
    q.add_argument("--graph", required=True)
    q.add_argument("--repo", required=True)
    q.add_argument("--queries", required=True)
    q.add_argument("--out", required=True)
    q.add_argument("--budget", type=int, default=None, help="Graphify --budget (default: Graphify's 2000)")
    q.add_argument("--depth", type=int, default=None, help="Graphify --depth (default: Graphify's 2)")
    q.add_argument("--context", action="append", default=None,
                   help="optional explicit Graphify --context edge filter (ablation only; default: none, so Graphify's own heuristic inference applies)")
    q.add_argument("--mode", choices=["bfs", "dfs"], default="bfs")
    a = ap.parse_args()
    return cmd_build(a) if a.cmd == "build" else cmd_query(a)


if __name__ == "__main__":
    raise SystemExit(main())
