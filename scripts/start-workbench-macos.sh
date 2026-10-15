#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$project_root"

# Prefer an explicit path, then the user's shell PATH, then common nvm/Homebrew
# locations. Finder-launched apps do not source .zshrc, so PATH alone is not
# sufficient on macOS.
node_bin="${METACODE_NODE_BIN:-}"
if [[ -z "$node_bin" ]] && command -v node >/dev/null 2>&1; then
  node_bin="$(command -v node)"
fi
if [[ -z "$node_bin" ]]; then
  nvm_root="${NVM_DIR:-$HOME/.nvm}"
  best_score=0
  for candidate in "$nvm_root/current/bin/node" "$nvm_root"/versions/node/*/bin/node; do
    [[ -x "$candidate" ]] || continue
    candidate_version="$($candidate --version 2>/dev/null || true)"
    if [[ "$candidate_version" =~ ^v([0-9]+)\.([0-9]+)\.([0-9]+) ]]; then
      candidate_score=$((10#${BASH_REMATCH[1]} * 1000000 + 10#${BASH_REMATCH[2]} * 1000 + 10#${BASH_REMATCH[3]}))
      if (( candidate_score > best_score )); then node_bin="$candidate"; best_score=$candidate_score; fi
    fi
  done
fi
if [[ -z "$node_bin" ]]; then
  for candidate in /opt/homebrew/bin/node /usr/local/bin/node \
    "$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node"; do
    if [[ -x "$candidate" ]]; then node_bin="$candidate"; break; fi
  done
fi

if [[ ! -x "$node_bin" ]]; then
  echo "未找到 Node.js。请安装 Node.js 24+，或设置 METACODE_NODE_BIN 指向 node 可执行文件。" >&2
  exit 1
fi

node_version="$($node_bin --version 2>/dev/null || true)"
if [[ ! "$node_version" =~ ^v([0-9]+)\. ]]; then
  echo "无法读取 Node.js 版本：$node_bin" >&2
  exit 1
fi
node_major="${BASH_REMATCH[1]}"
if (( node_major < 24 )); then
  echo "Meta Code 需要 Node.js 24 或更高版本，当前为 $node_version（$node_bin）。" >&2
  exit 1
fi

# npm is needed for dependency installation and managed CLI repair. A bundled
# Codex Node may intentionally omit npm; in that case existing node_modules can
# still run, but make the limitation explicit instead of failing mysteriously.
npm_bin="${METACODE_NPM_BIN:-}"
if [[ -z "$npm_bin" ]] && command -v npm >/dev/null 2>&1; then npm_bin="$(command -v npm)"; fi
if [[ -z "$npm_bin" ]]; then
  node_root="$(cd "$(dirname "$node_bin")/.." && pwd)"
  for candidate in "$node_root/lib/node_modules/npm/bin/npm-cli.js" "$node_root/node_modules/npm/bin/npm-cli.js"; do
    if [[ -f "$candidate" ]]; then npm_bin="$candidate"; break; fi
  done
fi
if [[ -n "$npm_bin" ]]; then
  npm_version="$($npm_bin --version 2>/dev/null || "$node_bin" "$npm_bin" --version 2>/dev/null || true)"
  if [[ ! "$npm_version" =~ ^[0-9]+\. ]]; then
    echo "检测到 npm 路径但无法运行：$npm_bin。请重新安装 npm，或设置 METACODE_NPM_BIN。" >&2
    exit 1
  fi
  export METACODE_NPM_BIN="$npm_bin"
else
  echo "警告：未检测到 npm。已有依赖时仍可启动；安装依赖或 Claude/Codex CLI 前请安装 npm，或设置 METACODE_NPM_BIN。" >&2
fi

export METACODE_HOME="${METACODE_HOME:-$HOME/.metacode}"
export WORKBENCH_API_PORT="${WORKBENCH_API_PORT:-4338}"
export WORKBENCH_WEB_PORT="${WORKBENCH_WEB_PORT:-4339}"
export PORT="$WORKBENCH_API_PORT"

if [[ ! -d node_modules ]]; then
  if [[ -z "$npm_bin" ]]; then
    echo "缺少依赖且 npm 不可用。请先安装 npm 24+，再运行 npm install。" >&2
  else
    echo "缺少依赖。请先运行：npm install（或 pnpm install）" >&2
  fi
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
