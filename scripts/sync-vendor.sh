#!/usr/bin/env bash
# 从上游同步 vendor/（= 跟上插件作者的更新）。
#
# 背景（用户问的正是这个）：
#   网关的模型来自两条路 ——
#     ① 远端目录（登录后向官方拉，永远是最新的）
#     ② vendor/src/*-product.ts 里的**静态兜底表**（编译期快照，会过时）
#   远端目录是主体；静态表只负责「远端拉不到时兜底」以及**白名单校正**
#   （buddy/workbuddy 会用静态表过滤远端返回的别名/内部模型）。
#   所以静态表过时会导致：上游新增的模型被过滤掉、或列出早已下线的模型。
#   同步方式 = 更新 vendor/。
#
# 用法：
#   bash scripts/sync-vendor.sh              # 同步源码 + 重建
#   bash scripts/sync-vendor.sh --check      # 只看有没有更新，不动文件
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$HERE"
REPO="https://gitee.com/iJetLi/deepseek-harness-codearts.git"
CHECK_ONLY="${1:-}"

echo "── 同步 vendor/（上游：dsh-codearts-auth）──"
echo

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "① 拉取上游…"
if ! git clone --depth 1 "$REPO" "$TMP/codearts" >/dev/null 2>&1; then
  echo "   ✗ 克隆失败（网络？）。请检查网络后重试。" >&2
  exit 1
fi
UPSTREAM_HEAD=$(git -C "$TMP/codearts" rev-parse --short HEAD)
echo "   上游 HEAD: $UPSTREAM_HEAD"

# 记录我们同步的来源，便于日后核对
STAMP="$HERE/vendor/.upstream-revision"
LOCAL_HEAD="(未记录)"
[ -f "$STAMP" ] && LOCAL_HEAD=$(cat "$STAMP")
echo "   本地已同步: $LOCAL_HEAD"

echo
echo "② 差异摘要"
DIFF_COUNT=$(diff -rq "$TMP/codearts/src" "$HERE/vendor/src" 2>/dev/null | wc -l | tr -d ' ')
echo "   与本地 vendor/src 的差异文件数: $DIFF_COUNT"
if [ "$DIFF_COUNT" -gt 0 ]; then
  diff -rq "$TMP/codearts/src" "$HERE/vendor/src" 2>/dev/null | head -20 | sed 's/^/     /'
fi

if [ "$CHECK_ONLY" = "--check" ]; then
  echo
  if [ "$DIFF_COUNT" -eq 0 ]; then
    echo "✅ 已是最新。"
  else
    echo "⬆️  有更新可用。执行  bash scripts/sync-vendor.sh  同步。"
  fi
  exit 0
fi

if [ "$DIFF_COUNT" -eq 0 ]; then
  echo
  echo "✅ 已是最新（$UPSTREAM_HEAD），无需改动。"
  echo "$UPSTREAM_HEAD" > "$STAMP"
  exit 0
fi

echo
echo "③ 备份当前 vendor/src…"
BACKUP="$HERE/vendor/.backup-$(date +%Y%m%d-%H%M%S)"
cp -a "$HERE/vendor/src" "$BACKUP"
echo "   已备份到: ${BACKUP#$HERE/}"

echo "④ 覆盖 vendor/src…"
rsync -a --delete "$TMP/codearts/src/" "$HERE/vendor/src/"
echo "$UPSTREAM_HEAD" > "$STAMP"

# ④b 密钥清洗（安全要求，勿删）：
# 上游的 loomy-product.ts 仍带讯飞 AccessKey 字面量，同步会原样带回来、
# 随下次提交进公开仓库。这里按**字段形态**强制清空这两个字段 ——
# 真值由网关从 <数据目录>/loomy.env 或环境变量注入（src/providers/extended.ts）。
# ⚠️ 本脚本会被提交进仓库，因此**不得**包含真实密钥字面量，只能模式匹配。
LOOMY_PRODUCT="$HERE/vendor/src/loomy-product.ts"
if [ -f "$LOOMY_PRODUCT" ]; then
  sed -i -E "s/(accessKeyId: *')[^']*'/\1'/; s/(accessKeySecret: *')[^']*'/\1'/" "$LOOMY_PRODUCT"
  if grep -qE "accessKey(Id|Secret): *'[^']+'" "$LOOMY_PRODUCT"; then
    echo "   ✗ loomy-product.ts 仍含非空 accessKeyId/accessKeySecret 字面量，" >&2
    echo "     上游格式可能已变化。请手工清空后再提交（防止真实密钥进公开仓库）。" >&2
    exit 1
  fi
  echo "   ✓ loomy-product.ts 密钥字段已确认为空（真值走本地 loomy.env 注入）"
fi

echo "⑤ 类型检查（自有代码）…"
if [ ! -x ./node_modules/.bin/tsc ]; then
  echo "   跳过（未装 typescript）"
else
  if ./node_modules/.bin/tsc --noEmit -p tsconfig.json 2>&1 | head -20; then
    echo "   ✓ 类型检查通过"
  else
    echo "   ⚠️  类型检查有报错（见上）。可回滚："
    echo "        rm -rf vendor/src && mv ${BACKUP#$HERE/} vendor/src"
  fi
fi

echo
echo "⑥ 重启网关让新代码生效"
bash "$HERE/scripts/stop.sh" >/dev/null 2>&1
bash "$HERE/scripts/start.sh" | tail -1

echo
echo "✅ 同步完成（$LOCAL_HEAD → $UPSTREAM_HEAD）"
echo
echo "   ⚠️ vendor 的静态模型表已更新。建议在 Web 控制台点一次"
echo "      「模型管理 → ↻ 重拉」，确认各供应商模型目录正常。"
