#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$project_root"

# Prefer a system Node.js installation. The fallback keeps this checkout
# runnable in the Codex workspace where Node is supplied as a bundled runtime.
if command -v node >/dev/null 2>&1; then
  node_bin="$(command -v node)"
else
  node_bin="${METACODE_NODE_BIN:-$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node}"
fi

if [[ ! -x "$node_bin" ]]; then
  echo "未找到 Node.js。请安装 Node.js 22+，或设置 METACODE_NODE_BIN 指向 node 可执行文件。" >&2
  exit 1
fi

export METACODE_HOME="${METACODE_HOME:-$HOME/.metacode}"
export WORKBENCH_API_PORT="${WORKBENCH_API_PORT:-4338}"
export WORKBENCH_WEB_PORT="${WORKBENCH_WEB_PORT:-4339}"
export PORT="$WORKBENCH_API_PORT"

if [[ ! -d node_modules ]]; then
  echo "缺少依赖。请先运行：pnpm install（或 npm install）" >&2
  exit 1
fi

"$node_bin" --import tsx scripts/start-dev-server.mjs &
backend_pid=$!
"$node_bin" node_modules/vite/bin/vite.js --host 127.0.0.1 &
web_pid=$!

cleanup() {
  kill "$web_pid" "$backend_pid" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

echo "Meta Code 已启动：http://127.0.0.1:${WORKBENCH_WEB_PORT}/"
echo "数据目录：${METACODE_HOME}"
wait "$backend_pid" "$web_pid"
