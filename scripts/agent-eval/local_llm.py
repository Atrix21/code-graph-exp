"""Local, NON-BILLABLE LLM backend for validating experiment-2 prompts and parsing (not a result-bearing arm).

Usage: python local_llm.py --model Qwen/Qwen3-1.7B --in prompts.jsonl --out outputs.jsonl [--max-new 700]
Input lines:  {"id": str, "system": str, "prompt": str}
Output lines: {"id": str, "text": str, "input_tokens": int, "output_tokens": int, "latency_ms": float}
Greedy decoding (deterministic), thinking disabled.
"""
import argparse, json, sys, time

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="Qwen/Qwen3-1.7B")
    ap.add_argument("--in", dest="inp", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--max-new", type=int, default=700)
    a = ap.parse_args()
    import torch
    from transformers import AutoModelForCausalLM, AutoTokenizer
    torch.manual_seed(0)
    tok = AutoTokenizer.from_pretrained(a.model)
    model = AutoModelForCausalLM.from_pretrained(a.model, dtype=torch.float16).to("cuda")
    model.eval()
    import os
    done = set()
    if os.path.exists(a.out):  # resumable: keep completed items (the process can be OOM-killed on a busy machine)
        for l in open(a.out):
            try:
                done.add(json.loads(l)["id"])
            except Exception:
                pass
    with open(a.out, "a") as out:
        for line in open(a.inp):
            if not line.strip():
                continue
            item = json.loads(line)
            if item["id"] in done:
                continue
            msgs = [{"role": "system", "content": item["system"]}, {"role": "user", "content": item["prompt"]}]
            text = tok.apply_chat_template(msgs, tokenize=False, add_generation_prompt=True, enable_thinking=False)
            ids = tok(text, return_tensors="pt").to("cuda")
            t0 = time.time()
            with torch.no_grad():
                gen = model.generate(**ids, max_new_tokens=a.max_new, do_sample=False)
            new = gen[0][ids["input_ids"].shape[1]:]
            out.write(json.dumps({"id": item["id"], "text": tok.decode(new, skip_special_tokens=True),
                                  "input_tokens": int(ids["input_ids"].shape[1]), "output_tokens": int(len(new)),
                                  "latency_ms": round((time.time() - t0) * 1000, 1)}) + "\n")
            out.flush()
    print(json.dumps({"model": a.model, "done": True}), file=sys.stderr)

if __name__ == "__main__":
    main()
