#!/usr/bin/env bash
# 启动网关（幂等）。已在运行则直接提示，不重复启动。
set -uo pipefail
exec bash "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/ensure.sh"
