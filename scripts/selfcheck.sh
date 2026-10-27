#!/usr/bin/env bash
# 项目自检：抓「文档与代码脱节」这类只在长期才暴露的问题。
#
# 为什么需要它：README 里的供应商表、端口、模型数量是**手写的**，
# 每次同步 vendor / 加渠道都会悄悄过期（实测过：表里只有 4 家、实际 18 家）。
# 这些错误不会让程序崩，只会让下一个接手的人按错的信息操作。
#
# 用法：bash scripts/selfcheck.sh        （退出码 0 = 全通过）
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1
FAIL=0
ok()   { echo "   ✓ $1"; }
bad()  { echo "   ✗ $1" >&2; FAIL=$((FAIL+1)); }

echo "① package.json 脚本指向的文件是否存在…"
node -e '
  const p = require("./package.json"), fs = require("fs")
  const bad = []
  for (const [name, cmd] of Object.entries(p.scripts ?? {})) {
    for (const m of String(cmd).matchAll(/(?:^|\s)((?:src|scripts|web)\/[\w./-]+)/g)) {
      if (!fs.existsSync(m[1])) bad.push(`${name} → ${m[1]}`)
    }
  }
  if (bad.length) { console.error("     " + bad.join("\n     ")); process.exit(1) }
' && ok "所有脚本引用的路径都存在" || bad "有脚本指向不存在的文件"

echo "② provider 端口表与 catalog 是否一一对应…"
node -e '
  const s = require("fs").readFileSync("src/providers/catalog.ts", "utf8")
  const ids = [...s.matchAll(/\{\s*id:\s*[\x27"]([a-z]+)[\x27"]/g)].map((m) => m[1])
  const ports = [...s.matchAll(/defaultPort:\s*(\d+)/g)].map((m) => Number(m[1]))
  if (ids.length === 0) { console.error("     catalog 里没解析到任何 provider"); process.exit(1) }
  if (ids.length !== ports.length) { console.error(`     id ${ids.length} 个 vs 端口 ${ports.length} 个`); process.exit(1) }
  const dup = ports.filter((p, i) => ports.indexOf(p) !== i)
  if (dup.length) { console.error("     端口重复: " + dup.join(", ")); process.exit(1) }
  console.log(`     ${ids.length} 家，端口唯一`)
' && ok "catalog 端口表一致" || bad "catalog 端口表不一致"

echo "③ README 的供应商表格是否覆盖全部 catalog 条目…"
node -e '
  const fs = require("fs")
  const s = fs.readFileSync("src/providers/catalog.ts", "utf8")
  const md = fs.readFileSync("README.md", "utf8")
  const ids = [...new Set([...s.matchAll(/\{\s*id:\s*[\x27"]([a-z]+)[\x27"]/g)].map((m) => m[1]))]
  const missing = ids.filter((id) => !md.includes("`" + id + "`"))
  if (missing.length) { console.error("     README 未列出: " + missing.join(", ")); process.exit(1) }
  console.log(`     README 覆盖 ${ids.length} 家`)
' && ok "README 供应商表完整" || bad "README 漏了供应商"

echo "④ README 引用的 docs 与脚本是否存在…"
MISS=0
while read -r f; do [ -f "$f" ] || { echo "     缺 $f" >&2; MISS=1; }; done < <(grep -oE '(docs|scripts)/[a-zA-Z0-9_.-]+\.(md|sh|bat)' README.md | sort -u)
[ "$MISS" -eq 0 ] && ok "README 的引用都存在" || bad "README 有失效引用"

echo "⑤ 类型检查…"
if bash scripts/typecheck.sh >/dev/null 2>&1; then ok "类型检查通过"; else bad "类型检查失败（跑 bash scripts/typecheck.sh 看详情）"; fi

echo "⑥ vendor 本地补丁是否仍然适用…"
PATCHFAIL=0
for p in vendor-patches/*.patch; do
  [ -f "$p" ] || continue
  if git apply --check --reverse "$p" 2>/dev/null; then :
  elif git apply --check "$p" 2>/dev/null; then :
  else echo "     $(basename "$p") 既不能正向也不能反向应用" >&2; PATCHFAIL=1; fi
done
[ "$PATCHFAIL" -eq 0 ] && ok "补丁全部可用（含已应用的）" || bad "有补丁失效 —— 下次同步 vendor 会丢失修复"

echo "⑦ 本机自有修复是否仍在（同步 vendor 后最容易被覆盖的就是这一层）…"
node -e '
  const fs = require("fs")
  // 每一项 = 【修复来历, 文件, 必须存在的标记】
  // ⚠️ 加新项时**必须写进这里**，否则下次 sync-vendor 覆盖掉也没人知道。
  const checks = [
    // 腾讯风控指纹：6 条。上游陆续吸收了 5 条，计费头那条至今仍是我们独有。
    ["678ebf7 计费头指纹",      "vendor/src/openai-gateway/tencent-fingerprint.ts", "x-anthropic-billing-header"],
    ["eca0b0c ZCode 指纹",      "vendor/src/openai-gateway/tencent-fingerprint.ts", "Main branch (you will usually use this for PRs)"],
    ["e348519 Claude 身份句",   "vendor/src/openai-gateway/tencent-fingerprint.ts", "official CLI for Claude"],
    ["92dd6ef Claude 反馈句",   "vendor/src/openai-gateway/tencent-fingerprint.ts", "To give feedback, users should report the issue at"],
    ["757ed70 DSH 身份句",      "vendor/src/openai-gateway/tencent-fingerprint.ts", "You are an AI agent powered by DeepSeek Harness"],
    ["92dd6ef DSH Web 面",      "vendor/src/openai-gateway/tencent-fingerprint.ts", "whose URL the runtime context names"],
    // gemini 动态目录三处（上游至今仍是单模型静态表）
    ["c4bcbf1 modelsProvider",  "vendor/src/gemini-adapter.ts", "modelsProvider?:"],
    ["c4bcbf1 allowedModels",   "vendor/src/gemini.ts",         "allowedModels?:"],
    ["c4bcbf1 预算抬升",        "vendor/src/gemini-messages.ts", "needsHeadroom"],
    // 原生搜索的几处接线（这些在 src/ 里，rsync 不碰 vendor 之外的，但仍登记防手滑）
    ["2287eb7 工具名排除",      "src/core/native-search.ts", "toolsearch"],
    ["6346c26 服务端搜索工具",  "src/core/anthropic.ts",     "web_search"],
    ["54d3ba3 断开中止",        "src/core/server.ts",        "client disconnected"],
    ["df004fe remoteMeta 重置", "src/core/provider-common.ts", "target.remoteMeta = new Map()"],
    // 插件热修（不在本仓库，但同步/升级插件后最易丢）
    ["插件 billing-header 热修", "PLUGIN:lib/openai-gateway/tencent-fingerprint.js", "x-anthropic-billing-header"],
  ]
  const PLUGIN = process.env.HOME + "/.dsh/profiles/web/node_modules/dsh-providers-hub/"
  const missing = []
  for (const [name, file, marker] of checks) {
    const path = file.startsWith("PLUGIN:") ? PLUGIN + file.slice(7) : file
    let text
    try { text = fs.readFileSync(path, "utf8") } catch { missing.push(`${name}（文件不存在: ${file}）`); continue }
    // ⚠️⚠️ **不能只判 includes**：指纹串在文档注释里也出现（实测：删掉 `find:` 行后
    //    注释里还剩 2 处，includes 仍为 true ⇒ 该判据对「规则被删」是瞎的）。
    //    故判据是「**作为代码行**出现」：`find:` / 赋值 / 调用，而不是注释里的提及。
    //    做法：去掉 // 注释行后再找。
    const code = text.split("\n").filter((l) => {
      const t = l.trim()
      return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*")
    }).join("\n")
    if (!code.includes(marker)) {
      const inCommentsOnly = text.includes(marker)
      missing.push(`${name}（${file} 的**代码**里找不到 ${JSON.stringify(marker.slice(0,40))}${inCommentsOnly ? "；只剩注释里的提及" : ""}）`)
    }
  }
  if (missing.length) { console.error("     丢失:"); for (const m of missing) console.error("       - " + m); process.exit(1) }
  console.log(`     ${checks.length} 项全部在位`)
' && ok "本机自有修复完整" || bad "有本机修复丢失 —— 跑 scripts/sync-vendor.sh 会重放补丁；插件热修见 .hotfix-backup/README.md"

echo
if [ "$FAIL" -eq 0 ]; then echo "✅ 自检全通过"; else echo "❌ $FAIL 项失败"; fi
exit "$FAIL"
