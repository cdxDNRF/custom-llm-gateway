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
#   端口 8790 可绑定   → 隐藏启动网关（无窗口、不弹浏览器）
#   端口 8790 不可绑定 → 判断是「Win 端已在跑」还是「WSL 端占着」，分别提示
#   启动后校验       → 起不来就弹窗报原因（不再静默"一闪而过"）
# ============================================================

# -NoGui：把失败原因打到控制台而不弹窗。
#   给「从 cmd/bat 手动运行」和自动化测试用（弹窗是模态的，会阻塞脚本）。
#
# ⚠️ param 必须是脚本第一条语句 —— 放在 $proj 赋值之后会在运行时直接报错
#（PowerShell 语法解析器不检查这一点，只有真跑才发现）。
param([switch]$NoGui)

# 项目根 = 本文件(…\scripts\windows-win\xxx.ps1) 上三级：
#   文件 → windows-win → scripts → 项目根
# ⚠️ 是三级不是两级（真实缺陷：两级算出 scripts\，node 报
#   "Cannot find module D:\...\scripts\node_modules\tsx\..."）
$proj = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $PSCommandPath))
$home_ = Join-Path $env:USERPROFILE '.dsh-llm-gateway-win'
$log   = Join-Path $home_ 'gateway.log'
$err   = Join-Path $home_ 'gateway.err.log'
if (-not (Test-Path $home_)) { New-Item -ItemType Directory -Path $home_ | Out-Null }

# ── 弹窗（失败时用；Add-Type WinForms 在 PS 5.1 自带，不依赖 wscript）──
function Show-ErrorBox([string]$message) {
    if ($NoGui) {
        Write-Host $message
        return
    }
    try {
        Add-Type -AssemblyName System.Windows.Forms -ErrorAction Stop
        [System.Windows.Forms.MessageBox]::Show(
            $message, 'dsh-llm-gateway 启动失败',
            [System.Windows.Forms.MessageBoxButtons]::OK,
            [System.Windows.Forms.MessageBoxIcon]::Error) | Out-Null
    } catch {
        # 弹窗失败也要留下痕迹（用户可能从 bat 里跑，有控制台就能看到）。
        Write-Host $message
    }
}

# ── 端口真实性判据：**必须用真实绑定测试** ──
#
# ⚠️ 真实缺陷（2026-10-01 用户报障「双击闪一下就没了」）：
#   早期实现用 `Get-NetTCPConnection -LocalPort 8790 -State Listen` 判占用。
#   它对 **WSL2 的 localhost 转发端口会漏判** —— 实测：WSL 端网关在跑时
#   Windows 侧 Get-NetTCPConnection 报告「8790 空闲」，而 node 去 bind 时
#   必得 EADDRINUSE。后果链：脚本误判 → 启动 node → node 绑定失败即退出
#   → 因为 -WindowStyle Hidden，用户看不到任何输出 → 「一闪而过」且不知道原因。
#
#   改用「真去 bind 一下」：能绑上才是真空闲。这一判据对 WSL 转发同样成立
#   （转发不占 Windows 的监听套接字，但占住了绑定能力）。
function Test-PortBindable([int]$port) {
    try {
        $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $port)
        $listener.Start()
        $listener.Stop()
        return $true
    } catch {
        return $false
    }
}

# ── 首次运行：装依赖（隐藏窗口执行，等它完成）──
if (-not (Test-Path (Join-Path $proj 'node_modules\tsx\dist\cli.mjs'))) {
    Start-Process -WindowStyle Hidden -FilePath 'cmd.exe' `
        -ArgumentList "/c cd /d `"$proj`" && pnpm install --ignore-scripts >> `"$log`" 2>&1" `
        -WorkingDirectory $proj -Wait
}

# ── 判断 8790：能不能绑 ──
#
# ⚠️ 端口「交还延迟」：刚停掉 WSL 端时，WSL2 的 localhost 转发端点不会立即
# 回收，几秒内本侧仍绑不上（实测 2~10 秒不等）。这会造成「刚停 WSL 就启 Win
# 必失败」，用户看到的就是闪退。故先重试若干次再下结论。
$bindable = Test-PortBindable 8790
$attempt = 0
while (-not $bindable -and $attempt -lt 10) {
    $attempt++
    Start-Sleep -Milliseconds 800
    $bindable = Test-PortBindable 8790
}

if (-not $bindable) {
    # 端口已被占。区分「Win 端自己已在跑」与「WSL 端占着」——
    # 前者直接开控制台即可；后者必须告诉用户，否则他以为 Win 端起来了。
    $winRunning = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -match 'dsh-llm-gateway' })
    if ($winRunning.Count -gt 0) {
        Start-Process 'http://127.0.0.1:8790/'
        exit 0
    }
    Show-ErrorBox @"
8790 端口被占用，但不是 Windows 端网关（很可能是 WSL 端的网关在运行，
或刚停掉 WSL 端、其转发端点尚未回收）。

两端共用同一组端口，同时只能跑一个。请选择：

  ① 用 WSL 端（现在就能用）
     直接访问控制台：http://127.0.0.1:8790/

  ② 改用 Windows 端（推荐日常使用，可关掉 WSL 省内存）
     先在 WSL 里停止：cd ~/dsh-llm-gateway && bash scripts/stop.sh
     等 10 秒后再双击本快捷方式（WSL2 释放端口需要几秒）。

提示：判断哪一端在跑 —— 桌面「状态(Win)」脚本，或 WSL 里 bash scripts/status.sh。
"@
    exit 1
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

# 每次启动前清空 err.log：避免用户把上一次的旧错误当成本次原因。
Remove-Item $err -ErrorAction SilentlyContinue

$proc = Start-Process -WindowStyle Hidden -FilePath 'node.exe' `
    -ArgumentList 'node_modules\tsx\dist\cli.mjs', 'src\main.ts' `
    -WorkingDirectory $proj `
    -RedirectStandardOutput $log `
    -RedirectStandardError $err `
    -PassThru

# ── 启动后校验（补上「静默失败」这个盲点）──
#
# 为什么必须校验：Hidden 启动时一切错误用户都看不到。若不校验，绑定失败、
# 模块缺失、配置损坏都表现为「双击无反应」，用户只能猜。这里等最多 20 秒，
# 期间探测 HTTP；进程提前退出或始终不响应就弹窗报真实原因。
$ready = $false
for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Milliseconds 500
    if ($proc.HasExited) { break }
    try {
        $resp = Invoke-WebRequest -Uri 'http://127.0.0.1:8790/' -TimeoutSec 2 -UseBasicParsing -ErrorAction Stop
        if ($resp.StatusCode -eq 200) { $ready = $true; break }
    } catch {
        # 还没起来，继续等。
    }
}

if ($ready) { exit 0 }

# ── 失败：从 err.log 提取关键错误并弹窗 ──
$detail = ''
if (Test-Path $err) {
    # 只保留有价值的行：错误行 + EADDRINUSE 之类的 code 行。
    $lines = Get-Content $err -ErrorAction SilentlyContinue |
        Where-Object { $_ -match 'ERROR|错误|失败|EADDRINUSE|Cannot find|Error:' } |
        Select-Object -Last 8
    $detail = ($lines -join "`n").Trim()
}
if ([string]::IsNullOrWhiteSpace($detail)) { $detail = '（err.log 无明确错误行，请查看上方日志文件）' }

$reason = if ($proc.HasExited) { "网关进程已退出（退出码 $($proc.ExitCode)）。" } else { '网关进程仍在运行但 20 秒内未响应 HTTP。' }

Show-ErrorBox @"
$reason

错误摘要：
$detail

完整日志：
  $err
  $log

常见原因：
  • 端口被占用（WSL 端网关在跑 / 另一个 Win 端实例）
  • node_modules 不完整 —— 在项目目录执行 pnpm install
  • 查看上面的错误摘要可确认具体原因
"@
exit 1