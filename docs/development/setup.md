# Development setup

## Requirements

- Windows 10/11、macOS 13+（Apple Silicon 或 Intel）
- Node.js 24+
- npm
- One supported Agent CLI for end-to-end execution tests

macOS 可使用仓库根目录的 `npm run start:macos` 启动脚本，也可以使用 `npm run desktop:package:dir` 生成当前架构的 `.app` 解包目录。Linux 当前支持从源码运行；桌面打包暂不提供 Linux 目标。

## Start

```bash
npm install
npm run dev
```

The API listens on `127.0.0.1:4338` and Vite on `127.0.0.1:4339`. Override them with `WORKBENCH_API_PORT` and `WORKBENCH_WEB_PORT` when needed.

## Verification

```powershell
npm run typecheck
npm run build
npm run test:help
npm run test:first-run
npm run test:provider-host
npm run test:acp
```

Run the domain-specific tests listed in `package.json` for any changed subsystem. Real CLI tests require the corresponding executable and credentials and should never print secrets.

## Data

Development uses `~/.metacode` by default. Set `METACODE_HOME` to a disposable directory for destructive recovery or migration tests. Never point tests at another application's data directory.
