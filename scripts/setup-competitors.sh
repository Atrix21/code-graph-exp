#!/usr/bin/env bash
# Clone competitors at pinned commits and create isolated Python envs (see vendor/manifest.json).
set -euo pipefail
cd "$(dirname "$0")/.."
clone() { # dir url commit
  if [ ! -d "vendor/$1/.git" ]; then git clone -q "$2" "vendor/$1"; fi
  git -C "vendor/$1" checkout -q "$3"
  test "$(git -C "vendor/$1" rev-parse HEAD)" = "$3"
}
clone graphify https://github.com/Graphify-Labs/graphify 433a57a002908e74c9f0abd2ad93af8b302b71c4
clone code-review-graph https://github.com/tirth8205/code-review-graph 343ab7cea29d47a3e805381e09f8243a43d43d88
mkdir -p vendor/.venvs
[ -x vendor/.venvs/graphify/bin/python ] || uv venv -q --python 3.12 vendor/.venvs/graphify
GRAPHIFY_NO_AUTO_REFRESH=1 uv pip install -q --python vendor/.venvs/graphify/bin/python -e './vendor/graphify[mcp]'
[ -x vendor/.venvs/code-review-graph/bin/python ] || uv venv -q --python 3.12 vendor/.venvs/code-review-graph
uv pip install -q --python vendor/.venvs/code-review-graph/bin/python './vendor/code-review-graph[embeddings,communities]'
[ -x vendor/.venvs/embeddings/bin/python ] || uv venv -q --python 3.12 vendor/.venvs/embeddings
uv pip install -q --python vendor/.venvs/embeddings/bin/python sentence-transformers==5.1.2 transformers==4.57.1 torch==2.9.1 numpy
vendor/.venvs/embeddings/bin/python -c "from huggingface_hub import snapshot_download; snapshot_download('Qwen/Qwen3-Embedding-0.6B', revision='97b0c614be4d77ee51c0cef4e5f07c00f9eb65b3')"
# Target-repo dependencies (type information for the TS checker), installed OUTSIDE the snapshot.
mkdir -p targets/deps
if [ ! -d targets/nestjs-boilerplate-upstream/.git ]; then git clone -q https://github.com/brocoders/nestjs-boilerplate.git targets/nestjs-boilerplate-upstream; fi
git -C targets/nestjs-boilerplate-upstream checkout -q 9620f159eefe38f47747d02ab162852367c5472c
cp targets/nestjs-boilerplate-upstream/package.json targets/nestjs-boilerplate-upstream/package-lock.json targets/deps/
(cd targets/deps && npm install --ignore-scripts --no-audit --no-fund --silent)
ln -sfn deps/node_modules targets/node_modules
echo "competitors + target deps ready"
