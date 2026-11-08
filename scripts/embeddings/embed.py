"""Embed texts with a fixed sentence-transformers model.

Usage: python embed.py --model Qwen/Qwen3-Embedding-0.6B --in items.jsonl --out vectors.jsonl
Input lines:  {"id": str, "text": str, "kind": "query" | "doc"}
Output lines: {"id": str, "vector": [float...], "tokens": int}
Vectors are L2-normalised. Deterministic for a fixed model/device (no sampling).
"""
import argparse, json, sys, time

QUERY_INSTRUCTION = "Instruct: Given a natural-language bug report, retrieve the source code most relevant to it\nQuery: "

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True)
    ap.add_argument("--in", dest="inp", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--batch", type=int, default=16)
    ap.add_argument("--max-seq", type=int, default=1024)
    ap.add_argument("--revision", default=None)
    a = ap.parse_args()
    import torch
    from sentence_transformers import SentenceTransformer
    torch.manual_seed(0)
    device = "cuda" if torch.cuda.is_available() else "cpu"
    kw = {"model_kwargs": {"dtype": torch.float16}} if device == "cuda" else {}
    m = SentenceTransformer(a.model, device=device, revision=a.revision, **kw)
    # Fail loudly if the sentence-transformers config is missing (it silently falls back to mean pooling).
    pooling = [mod for mod in m if type(mod).__name__ == "Pooling"]
    mode = pooling[0].get_pooling_mode_str() if pooling else "none"
    if "Qwen3-Embedding" in a.model and mode != "lasttoken":
        raise SystemExit(f"unexpected pooling mode {mode}; incomplete model download?")
    m.max_seq_length = a.max_seq
    items = [json.loads(l) for l in open(a.inp) if l.strip()]
    tok = m.tokenizer
    t0 = time.time()
    out = open(a.out, "w")
    for kind in ("doc", "query"):
        sel = [it for it in items if it["kind"] == kind]
        if not sel:
            continue
        texts = [(QUERY_INSTRUCTION + it["text"]) if kind == "query" else it["text"] for it in sel]
        # sort by length for efficient batching; restore order after
        order = sorted(range(len(texts)), key=lambda i: len(texts[i]))
        vecs = m.encode([texts[i] for i in order], batch_size=a.batch, normalize_embeddings=True, convert_to_numpy=True, show_progress_bar=False)
        back = [None] * len(texts)
        for j, i in enumerate(order):
            back[i] = vecs[j]
        for it, text, v in zip(sel, texts, back):
            n = min(len(tok(text, add_special_tokens=True)["input_ids"]), a.max_seq)
            out.write(json.dumps({"id": it["id"], "vector": [round(float(x), 6) for x in v], "tokens": n}) + "\n")
    out.close()
    print(json.dumps({"model": a.model, "device": device, "n": len(items), "seconds": round(time.time() - t0, 2), "max_seq": a.max_seq, "pooling": mode, "revision": a.revision}), file=sys.stderr)

if __name__ == "__main__":
    main()
