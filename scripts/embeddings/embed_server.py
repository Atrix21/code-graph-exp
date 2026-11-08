"""Persistent embedding process (experiment 2: query embedding inside an agent loop).

Same model, pinned revision, fp16-on-CUDA, pooling assertion, query instruction, max_seq and output rounding as
embed.py, but the model is loaded ONCE and requests are served from stdin until EOF.

Protocol (JSON lines):
  stdout, once after load:  {"ready": true, "model":..., "revision":..., "device":..., "pooling":..., "load_seconds":...}
  stdin  request:           {"id": str, "text": str, "kind": "query" | "doc"}      (kind defaults to "query")
  stdout response:          {"id": str, "vector": [float...], "tokens": int}       (L2-normalised, 6 decimals)
                            or {"id": str, "error": str}
stdout carries ONLY protocol lines; logs go to stderr.
"""
import argparse, json, sys, time

# Keep identical to embed.py.
QUERY_INSTRUCTION = "Instruct: Given a natural-language bug report, retrieve the source code most relevant to it\nQuery: "


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True)
    ap.add_argument("--max-seq", type=int, default=1024)
    ap.add_argument("--revision", default=None)
    a = ap.parse_args()
    out = sys.stdout
    sys.stdout = sys.stderr  # library prints must never corrupt the protocol stream
    t0 = time.time()
    import torch
    from sentence_transformers import SentenceTransformer
    torch.manual_seed(0)
    device = "cuda" if torch.cuda.is_available() else "cpu"
    kw = {"model_kwargs": {"dtype": torch.float16}} if device == "cuda" else {}
    m = SentenceTransformer(a.model, device=device, revision=a.revision, **kw)
    pooling = [mod for mod in m if type(mod).__name__ == "Pooling"]
    mode = pooling[0].get_pooling_mode_str() if pooling else "none"
    if "Qwen3-Embedding" in a.model and mode != "lasttoken":
        raise SystemExit(f"unexpected pooling mode {mode}; incomplete model download?")
    m.max_seq_length = a.max_seq
    tok = m.tokenizer
    # Warm-up (CUDA kernels / allocator) so the first real request is not slow.
    m.encode([QUERY_INSTRUCTION + "warm up"], batch_size=1, normalize_embeddings=True, convert_to_numpy=True, show_progress_bar=False)
    out.write(json.dumps({"ready": True, "model": a.model, "revision": a.revision, "device": device, "pooling": mode,
                          "max_seq": a.max_seq, "load_seconds": round(time.time() - t0, 2)}) + "\n")
    out.flush()
    for line in sys.stdin:
        if not line.strip():
            continue
        rid = None
        try:
            req = json.loads(line)
            rid = req.get("id")
            kind = req.get("kind", "query")
            text = (QUERY_INSTRUCTION + req["text"]) if kind == "query" else req["text"]
            v = m.encode([text], batch_size=1, normalize_embeddings=True, convert_to_numpy=True, show_progress_bar=False)[0]
            n = min(len(tok(text, add_special_tokens=True)["input_ids"]), a.max_seq)
            resp = {"id": rid, "vector": [round(float(x), 6) for x in v], "tokens": n}
        except Exception as e:  # keep serving
            resp = {"id": rid, "error": f"{type(e).__name__}: {e}"}
        out.write(json.dumps(resp) + "\n")
        out.flush()


if __name__ == "__main__":
    main()
