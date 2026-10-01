@echo off
chcp 65001 >nul
title dsh-llm-gateway (Windows) — 后台运行
setlocal enabledelayedexpansion
rem ============================================================
rem  后台启动 Windows 端网关（不占终端窗口，关掉本窗口不影响）
rem
rem  ⚠️ 与 WSL 端同端口（8790/3901-3904），只能跑一个。
rem     本脚本启动失败最常见的原因就是 WSL 端还在跑 —— 见 ① 的提示。
rem ============================================================

rem %~dp0 带结尾反斜杠（...scripts\windows-win\），"%~dp0.." 只会到 scripts\，
rem 必须上两级才是项目根（真实缺陷，实测 MODULE_NOT_FOUND 指向 scripts\node_modules）。
for %%I in ("%~dp0..\..") do set "PROJDIR=%%~fI"

if not defined GATEWAY_HOME set "GATEWAY_HOME=%USERPROFILE%\.dsh-llm-gateway-win"

rem ── ① 8790 被谁占着？（逻辑在 _port-free.ps1，避开 cmd 转义）──
for /f "usebackq tokens=1,2" %%a in (`powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0_port-free.ps1"`) do (
    if /i "%%a"=="BUSY" (
        echo.
        echo   [提示] 端口 8790 已被占用（进程 %%b）。两个端共用端口，只能留一个：
        echo           - 若 %%b 是 wslrelay：那是 WSL 端在跑，停它需在 WSL 里执行
        echo             bash ~/dsh-llm-gateway/scripts/stop.sh
        echo           - 若 %%b 是 node：Windows 端已在跑，直接用即可。
        start "" "http://127.0.0.1:8790/"
        ping -n 6 127.0.0.1 >nul
        exit /b 0
    )
)

rem ── ② 依赖检查 ──
if not exist "%PROJDIR%\node_modules\tsx\dist\cli.mjs" (
  echo   首次运行：安装依赖…
  pushd "%PROJDIR%"
  call pnpm install --ignore-scripts
  popd
)

rem ── ③ 后台启动（★ 必须 cd 到项目目录，否则 node_modules 相对路径解析错误）──
set "LOGFILE=%GATEWAY_HOME%\gateway.log"
echo   后台启动中…日志: %LOGFILE%
cd /d "%PROJDIR%"
start "dsh-llm-gateway" /min cmd /c "set GATEWAY_HOME=%GATEWAY_HOME%&& node node_modules\tsx\dist\cli.mjs src\main.ts >> "%LOGFILE%" 2>&1"

rem ── ④ 等就绪 ──
for /l %%i in (1,1,25) do (
  ping -n 2 127.0.0.1 >nul
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0_port-free.ps1" | findstr "BUSY" >nul 2>&1
  if not errorlevel 1 (
    echo   已启动：http://127.0.0.1:8790/
    ping -n 3 127.0.0.1 >nul
    exit /b 0
  )
)
echo   启动超时，最后几行日志：
powershell.exe -NoProfile -Command "Get-Content '%LOGFILE%' -Tail 15" 2>nul
pause
