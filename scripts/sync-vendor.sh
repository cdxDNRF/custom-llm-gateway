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

# ④c Google OAuth 凭据清洗（安全要求，勿删）：
# 上游 gemini-oauth.ts 硬编码了 Google OAuth 的 client id/secret（虽然是开源
# CLI 自带的公开值），会被 **GitHub Push Protection 判定为泄露并拒绝整个推送**
# （GH013 / Google OAuth Client ID + Client Secret）。同步会原样带回来，
# 故这里强制清空这两个字面量 —— 真值由环境变量注入
# （`CMDC_PAK_GOOGLE_CLIENT_ID` / `CMDC_PAK_GOOGLE_CLIENT_SECRET`，
#  覆盖逻辑在 resolveClientId / resolveClientSecret，无需改代码）。
# ⚠️ 本脚本会被提交进仓库，因此**不得**包含真实凭据字面量，只能模式匹配。
GEMINI_OAUTH="$HERE/vendor/src/gemini-oauth.ts"
if [ -f "$GEMINI_OAUTH" ]; then
  # 清空单行赋值的字面量；保留类型/结构，注释另行保留。
  sed -i -E "s/(GEMINI_DEFAULT_CLIENT_ID *= *)'[^']*'/\1''/" "$GEMINI_OAUTH"
  sed -i -E "s/(GEMINI_DEFAULT_CLIENT_SECRET *= *)'[^']*'/\1''/" "$GEMINI_OAUTH"
  # 上游也可能把值折到下一行（形如 `= \n  'xxx'`），一并处理。
  sed -i -E "/^export const GEMINI_DEFAULT_CLIENT_(ID|SECRET) =$/{n;s/^  '[^']*'$/  ''/;}" "$GEMINI_OAUTH"
  if grep -qE "GEMINI_DEFAULT_CLIENT_(ID|SECRET) *= *$" "$GEMINI_OAUTH" \
     && grep -qE "GOCSPX-|apps\.googleusercontent\.com" "$GEMINI_OAUTH"; then
    echo "   ✗ gemini-oauth.ts 仍含 Google OAuth 凭据字面量，" >&2
    echo "     上游格式可能已变化。请手工清空后再提交（否则 GitHub 会拒绝推送）。" >&2
    exit 1
  fi
  echo "   ✓ gemini-oauth.ts 的 Google OAuth 凭据已确认为空（真值走环境变量注入）"
fi

# ④d 本地补丁（功能扩展，勿删）：
# 上游的 Gemini 模型表**硬编码 1 个模型**（用户拍板"不拉远端目录"），
# 而实测账号真正可用 15 个（含 claude-sonnet-4-6 / claude-opus-4-6-thinking）。
# 我们加了两处**增量**改动让它支持动态目录：
#   · gemini-adapter: 新增 `modelsProvider` 选项（缺省仍走静态表，零行为变化）
#   · gemini.ts: `geminiModelSpec` 新增第三参 `allowedModelIds`
#     （缺省退化为"只允许 gemini-3.8-flash"，与改动前逐字节一致）
# 补丁以文件形式维护（改一处要动多行，sed 不适用）。
PATCH_FILE="$HERE/vendor-patches/gemini-dynamic-models.patch"
if [ -f "$PATCH_FILE" ]; then
  if git -C "$HERE" apply --check "$PATCH_FILE" 2>/dev/null; then
    git -C "$HERE" apply "$PATCH_FILE"
    echo "   ✓ 已应用 Gemini 动态模型目录补丁"
  elif git -C "$HERE" apply --check --reverse "$PATCH_FILE" 2>/dev/null; then
    echo "   ✓ Gemini 动态模型目录补丁已在（无需重复应用）"
  else
    echo "   ⚠️ Gemini 补丁无法应用（上游可能已改这些文件）。" >&2
    echo "      请手工核对 vendor/src/gemini{,-adapter}.ts 后更新：" >&2
    echo "      vendor-patches/gemini-dynamic-models.patch" >&2
    echo "      补丁若确实过时，用 git diff 重新生成。" >&2
  fi
fi

# ④e 本地补丁：Qoder WASM 的**通用**请求签名（2026-10-20）
# WASM 里有两个签名入口，我们的 vendor 只接了推理那个：
#   · `qodercontext_prepareInferRequest` —— 仅推理端点（`prepareInfer`）
#   · `qodercontext_prepareRequest`      —— **通用**：任意 endpoint/path/method
# 原生**搜索**（`/api/v1/webSearch/oneSearch`）必须用后者：它的 host 与推理不同
# （搜索挂 center host），且 path 任意。
# 补丁只**新增**一个方法（`prepareRequest`），既有 `prepareInfer` 逐字节不变。
PATCH_QODER="$HERE/vendor-patches/qoder-prepare-request.patch"
if [ -f "$PATCH_QODER" ]; then
  if git -C "$HERE" apply --check "$PATCH_QODER" 2>/dev/null; then
    git -C "$HERE" apply "$PATCH_QODER"
    echo "   ✓ 已应用 Qoder 通用签名补丁"
  elif git -C "$HERE" apply --check --reverse "$PATCH_QODER" 2>/dev/null; then
    echo "   ✓ Qoder 通用签名补丁已在（无需重复应用）"
  else
    echo "   ⚠️ Qoder 补丁无法应用（上游可能已改 qoder-wasm.ts）。" >&2
    echo "      请核对后更新：vendor-patches/qoder-prepare-request.patch" >&2
  fi
fi

# ④f 本地补丁：腾讯风控指纹表补两条触发句（2026-10-20）
# 腾讯网关以 400/11128 拒绝时的两条「客户端身份句」指纹：
#   ① Claude Code v2.1.293 的 system 首句：
#        "You are Claude Code, Anthropic's official CLI for Claude"
#   ② DeepSeek Harness（DSH）自己的 system 首句：
#        "You are an AI agent powered by DeepSeek Harness"
#      后者是 2026-10-20 深夜**新收录**的：同一份 DSH 提示词本机记录
#      14:10 与 22:42 均放行，23:25 起稳定 400 ⇒ 与 DSH 改版、账号、
#      本网关都无关（部署窗口 22:42–23:25）。
# 两条都是整句精确匹配 + 行首锚定、大小写不敏感；改任意一处即放行。
# 补丁只**新增两条改写规则**，既有 ZCode 规则逐字节不变。
PATCH_TCFP="$HERE/vendor-patches/tencent-content-fingerprints.patch"
if [ -f "$PATCH_TCFP" ]; then
  if git -C "$HERE" apply --check "$PATCH_TCFP" 2>/dev/null; then
    git -C "$HERE" apply "$PATCH_TCFP"
    echo "   ✓ 已应用腾讯指纹补丁（Claude Code + DSH）"
  elif git -C "$HERE" apply --check --reverse "$PATCH_TCFP" 2>/dev/null; then
    echo "   ✓ 腾讯指纹补丁已在（无需重复应用）"
  else
    echo "   ⚠️ 腾讯指纹补丁无法应用（上游可能已改 tencent-fingerprint.ts）" >&2
    echo "      请核对后更新：vendor-patches/tencent-content-fingerprints.patch" >&2
  fi
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
