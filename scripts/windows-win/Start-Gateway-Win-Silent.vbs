' ============================================================
' dsh-llm-gateway — Windows 静默启动器（完全无窗口）
'
' ★ 用法：桌面快捷方式直接指向本文件。双击后【什么都看不到】，
'   网关在后台运行；想看状态用 Status-Gateway-Win.bat，
'   想停止用 Stop-Gateway-Win.bat。
'
' 为什么用 VBS 而不是 bat：cmd 的 start /min 只是最小化，
'   任务栏里仍有一个常驻窗口（真实缺陷，用户实测抱怨）；
'   wscript + Run(…, 0, False) 才是真正的零窗口（窗口样式 0 = 隐藏）。
'
' 行为：
'   - 端口 8790 空闲 → 隐藏启动网关，无任何窗口、不弹浏览器
'   - 端口 8790 已监听 → 视为已在跑，直接打开控制台页面
' ============================================================
Option Explicit

Dim sh, fso, projDir, home, logfile, tmp, occupied
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

' 项目目录 = 本脚本所在目录（scripts\windows-win\）的上一级
projDir = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
home = sh.ExpandEnvironmentStrings("%USERPROFILE%") & "\.dsh-llm-gateway-win"
logfile = home & "\gateway.log"

If Not fso.FolderExists(home) Then fso.CreateFolder home

' ── 首次运行：装依赖（隐藏窗口执行，等它完成）──
If Not fso.FileExists(projDir & "\node_modules\tsx\dist\cli.mjs") Then
    sh.Run "cmd.exe /c cd /d """ & projDir & """ && pnpm install --ignore-scripts >> """ & logfile & """ 2>&1", 0, True
End If

' ── 端口检查（结果写临时文件，避开 cmd/PowerShell 的引号地狱）──
tmp = home & "\.portcheck.tmp"
sh.Run "cmd.exe /c powershell -NoProfile -Command ""if (Get-NetTCPConnection -LocalPort 8790 -State Listen -ErrorAction SilentlyContinue) { 'BUSY' } else { 'FREE' }"" > """ & tmp & """ 2>nul", 0, True

occupied = False
If fso.FileExists(tmp) Then
    Dim t
    Set t = fso.OpenTextFile(tmp, 1)
    If InStr(t.ReadAll, "BUSY") > 0 Then occupied = True
    t.Close
    fso.DeleteFile tmp, True
End If

If occupied Then
    ' 已在跑：直接打开控制台
    sh.Run "http://127.0.0.1:8790/"
Else
    ' 静默启动：窗口样式 0 = 完全隐藏；False = 不等待（wscript 立即退出，
    ' 隐藏的 cmd+node 进程继续独立运行，日志落 gateway.log）
    sh.Run "cmd.exe /c cd /d """ & projDir & """ && set GATEWAY_HOME=" & home & "&& node node_modules\tsx\dist\cli.mjs src\main.ts >> """ & logfile & """ 2>&1", 0, False
End If
