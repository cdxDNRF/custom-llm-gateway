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

echo
if [ "$FAIL" -eq 0 ]; then echo "✅ 自检全通过"; else echo "❌ $FAIL 项失败"; fi
exit "$FAIL"
