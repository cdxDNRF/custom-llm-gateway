@echo off
chcp 65001 >nul
title dsh-llm-gateway (Windows)
setlocal enabledelayedexpansion
rem ============================================================
rem  启动 dsh-llm-gateway —— Windows 原生版（不经 WSL），前台运行
rem
rem  ★ 与 WSL 端【同端口】（8790 / 3901-3904），两者只能跑一个。
rem    若 WSL 端正在跑，本脚本会提示你先去那边停掉。
rem    （想不占窗口：用 Start-Gateway-Win-Hidden.bat）
rem
rem  数据目录：%USERPROFILE%\.dsh-llm-gateway-win
rem ============================================================

rem %~dp0 带结尾反斜杠（...scripts\windows-win\），"%~dp0.." 只会到 scripts\，
rem 必须上两级才是项目根（真实缺陷，实测 MODULE_NOT_FOUND 指向 scripts\node_modules）。
for %%I in ("%~dp0..\..") do set "PROJDIR=%%~fI"

where node >nul 2>&1
if errorlevel 1 (
  echo   [错误] 找不到 node。请安装 Node.js 20+（https://nodejs.org）
  pause
  exit /b 1
)

rem ── 端口占用检测 ──
set "OWNERPID="
for /f %%p in ('powershell.exe -NoProfile -Command "if (Get-NetTCPConnection -LocalPort 8790 -State Listen -ErrorAction SilentlyContinue) { (Get-NetTCPConnection -LocalPort 8790 -State Listen | Select-Object -First 1).OwningProcess } else { exit 1 }" 2^>nul') do set "OWNERPID=%%p"

if defined OWNERPID (
  set "OWNERNAME="
  for /f %%n in ('powershell.exe -NoProfile -Command "(Get-Process -Id %OWNERPID% -ErrorAction SilentlyContinue).ProcessName" 2^>nul') do set "OWNERNAME=%%n"
  echo.
  echo   [提示] 端口 8790 已被占用（pid=%OWNERPID%, 进程=!OWNERNAME!）。
  echo.
  if /i "!OWNERNAME!"=="wslrelay" (
    echo          那是 WSL 端的网关在跑。两个端共用端口，只能留一个：
    echo            - 继续用 WSL 端：直接打开 http://127.0.0.1:8790/
    echo            - 改用 Windows 端：在 WSL 里执行 bash ~/dsh-llm-gateway/scripts/stop.sh
  ) else (
    echo          那是 Windows 端的网关已经在跑了。
  )
  start "" "http://127.0.0.1:8790/"
  pause
  exit /b 0
)

rem ── 依赖检查 ──
if not exist "%PROJDIR%\node_modules\tsx\dist\cli.mjs" (
  echo   首次运行：安装依赖…
  pushd "%PROJDIR%"
  call pnpm install --ignore-scripts
  popd
)

if not defined GATEWAY_HOME set "GATEWAY_HOME=%USERPROFILE%\.dsh-llm-gateway-win"
if not exist "%GATEWAY_HOME%" mkdir "%GATEWAY_HOME%"

echo.
echo   dsh-llm-gateway — 本地多供应商 LLM 网关（Windows 原生）
echo   ================================================
echo   项目:   %PROJDIR%
echo   数据:   %GATEWAY_HOME%
echo   控制台: http://127.0.0.1:8790/
echo   关闭本窗口 = 停止网关
echo.

cd /d "%PROJDIR%"
node node_modules\tsx\dist\cli.mjs src\main.ts

echo.
echo   网关已退出。
pause
