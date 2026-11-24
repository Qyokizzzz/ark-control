#!/usr/bin/env bash
set -euo pipefail

archive=${1:?缺少后端发布包}
[[ -f "$archive" && -s "$archive" ]] || { echo "后端发布包不存在或为空。" >&2; exit 1; }

id="${GITHUB_SHA:?}-${GITHUB_RUN_ID:?}-${GITHUB_RUN_ATTEMPT:?}"
[[ $id =~ ^[0-9a-f]{40}-[0-9]+-[0-9]+$ ]] || { echo "GitHub 运行标识无效。" >&2; exit 1; }

root=${SERVER_DEPLOY_DIR:-"$HOME/ark-control"}
if [[ $root != /* ]]; then
  echo "SERVER_DEPLOY_DIR 需要是服务器上的绝对路径。" >&2
  exit 1
fi

umask 077
mkdir -p -- "$root"
root=$(cd -- "$root" && pwd -P)
[[ $root != / ]] || { echo "请选择应用目录。" >&2; exit 1; }

here=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
digest=$(sha256sum < "$archive")
digest=${digest%% *}

# Keep PM2 and the API running after GitHub Actions cleans up the job's processes.
unset RUNNER_TRACKING_ID
exec flock -w 120 --close "$root/.deploy.lock" \
  node "$here/rollout-backend.mjs" "$root" "$id" "$digest" < "$archive"
