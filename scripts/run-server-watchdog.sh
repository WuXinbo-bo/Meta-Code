#!/usr/bin/env sh
set -eu
cd /opt/Meta-Workbench
echo $$ >/var/run/meta-workbench-watchdog.pid
trap 'rm -f /var/run/meta-workbench-watchdog.pid' EXIT INT TERM
while true; do
  NODE_ENV=production PORT=4318 WORKSPACE_ROOT=/opt/Meta-Workbench/.runtime/user-workspaces node dist-server/index.js >>/var/log/meta-workbench.log 2>&1 || true
  sleep 2
done
