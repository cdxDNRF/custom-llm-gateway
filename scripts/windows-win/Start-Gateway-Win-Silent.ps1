# ============================================================
# dsh-llm-gateway — Windows 静默启动（完全无窗口）
#
# ★ 桌面快捷方式指向本文件。双击后什么都不出现，网关在后台跑。
#   状态：Status-Gateway-Win.bat / 控制台 http://127.0.0.1:8790/
#   停止：Stop-Gateway-Win.bat
#
# 为什么用它而不用 bat / VBS（都实测踩过坑）：
#   - bat 的 start /min 只是最小化，任务栏仍有一个常驻黑窗口；
#   - VBS(wscript) 在部分环境报「内存资源不足」误报，不可靠；
#   - PowerShell 的 Start-Process -WindowStyle Hidden 是真·无窗口，
#     且由本脚本自己处理端口检测，行为可预期。
#
# 行为：
#   端口 8790 空闲     → 隐藏启动网关（无窗口、不弹浏览器）
#   端口 8790 已监听   → 视为已在跑，直接打开控制台页面
# ============================================================

# 项目根 = 本文件(…\scripts\windows-win\xxx.ps1) 上三级：
#   文件 → windows-win → scripts → 项目根
# ⚠️ 是三级不是两级（真实缺陷：两级算出 scripts\，node 报
#   "Cannot find module D:\...\scripts\node_modules\tsx\..."）
$proj = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $PSCommandPath))
$home_ = Join-Path $env:USERPROFILE '.dsh-llm-gateway-win'
$log   = Join-Path $home_ 'gateway.log'
if (-not (Test-Path $home_)) { New-Item -ItemType Directory -Path $home_ | Out-Null }

# ── 首次运行：装依赖（隐藏窗口执行，等它完成）──
if (-not (Test-Path (Join-Path $proj 'node_modules\tsx\dist\cli.mjs'))) {
    Start-Process -WindowStyle Hidden -FilePath 'cmd.exe' `
        -ArgumentList "/c cd /d `"$proj`" && pnpm install --ignore-scripts >> `"$log`" 2>&1" `
        -WorkingDirectory $proj -Wait
}

# ── 端口检测 ──
$busy = Get-NetTCPConnection -LocalPort 8790 -State Listen -ErrorAction SilentlyContinue
if ($busy) {
    # 已在跑（无论哪个端）：直接打开控制台
    Start-Process 'http://127.0.0.1:8790/'
    exit 0
}

# ── 隐藏启动网关 ──
# ⚠️ 必须显式传 GATEWAY_HOME：否则网关回退到默认的
#   ~\.dsh-llm-gateway（没有凭据），表现为"起来了但账号是 0"（真实缺陷，实测）。
# node 需要 PATH；Start-Process 会继承当前环境。双击时 PATH 来自用户环境，
# 装过 Node.js 就能找到；找不到时报错到 err.log。
#
# Start-Process 的 -Environment 需要 PS 7.3+；Windows 自带的是 5.1，
# 故先用 $env: 设置当前进程环境，子进程自然继承（对 5.1 同样有效）。
$env:GATEWAY_HOME = $home_
Start-Process -WindowStyle Hidden -FilePath 'node.exe' `
    -ArgumentList 'node_modules\tsx\dist\cli.mjs', 'src\main.ts' `
    -WorkingDirectory $proj `
    -RedirectStandardOutput $log `
    -RedirectStandardError (Join-Path $home_ 'gateway.err.log')
