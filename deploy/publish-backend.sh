#!/usr/bin/env bash
set -euo pipefail

archive=${1:?缺少后端发布包}
[[ -s "$archive" ]] || { echo "后端发布包不存在或为空。" >&2; exit 1; }
for name in SERVER_HOST SERVER_USER SERVER_SSH_KEY SERVER_KNOWN_HOSTS; do
  [[ -n ${!name:-} ]] || { echo "请配置 GitHub Actions Secret $name。" >&2; exit 1; }
done

port=${SERVER_PORT:-22}
if ! [[ $port =~ ^[1-9][0-9]{0,4}$ ]] || (( port > 65535 )); then
  echo "SERVER_PORT 必须是 1 至 65535 的 SSH 端口。" >&2
  exit 1
fi
[[ $SERVER_HOST =~ ^[a-zA-Z0-9:][a-zA-Z0-9.:_-]*$ ]] ||
  { echo "SERVER_HOST 请填写 SSH 主机名或 IP 地址。" >&2; exit 1; }
[[ $SERVER_USER =~ ^[a-zA-Z_][a-zA-Z0-9._-]*$ ]] ||
  { echo "SERVER_USER 请填写 Linux 登录用户。" >&2; exit 1; }

id="${GITHUB_SHA:?}-${GITHUB_RUN_ID:?}-${GITHUB_RUN_ATTEMPT:?}"
[[ $id =~ ^[0-9a-f]{40}-[0-9]+-[0-9]+$ ]] || { echo "GitHub 运行标识无效。" >&2; exit 1; }

umask 077
credentials=$(mktemp -d)
trap 'rm -f -- "$credentials/key" "$credentials/known_hosts"; rmdir -- "$credentials"' EXIT
printf '%s\n' "$SERVER_SSH_KEY" | tr -d '\r' > "$credentials/key"
printf '%s\n' "$SERVER_KNOWN_HOSTS" | tr -d '\r' > "$credentials/known_hosts"

here=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
script=$(base64 -w0 "$here/rollout-backend.mjs")
directory=$(printf '%s' "${SERVER_DEPLOY_DIR:-}" | base64 -w0)
digest=$(sha256sum < "$archive")
digest=${digest%% *}
# Only Base64 strings and validated IDs are interpolated into the remote shell command.
remote=$(cat <<EOF
set -eu
umask 077
root=\$(printf %s '$directory' | base64 -d)
root=\${root:-"\$HOME/ark-control"}
case "\$root" in
  /*) ;;
  *) echo "SERVER_DEPLOY_DIR 需要是服务器上的绝对路径。" >&2; exit 1 ;;
esac
mkdir -p -- "\$root"
root=\$(cd -- "\$root" && pwd -P)
if [ "\$root" = / ]; then
  echo "请选择应用目录。" >&2
  exit 1
fi
exec flock -w 120 --close "\$root/.deploy.lock" \
  node --input-type=module -e "await import('data:text/javascript;base64,$script')" -- "\$root" '$id' '$digest'
EOF
)
ssh -T -F /dev/null -p "$port" -l "$SERVER_USER" -i "$credentials/key" \
  -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes \
  -o UserKnownHostsFile="$credentials/known_hosts" -o GlobalKnownHostsFile=/dev/null \
  -o ConnectTimeout=15 -o ServerAliveInterval=10 -o ServerAliveCountMax=3 \
  "$SERVER_HOST" "$remote" < "$archive"
