@echo off
chcp 65001 >nul
title dsh-llm-gateway
call "%~dp0_config.bat"
if errorlevel 1 ( pause & exit /b 1 )

rem ============================================================
rem  启动 dsh-llm-gateway（含守护进程），然后打开控制台
rem  由桌面快捷方式调用，也可直接双击本文件
rem
rem  ★ 不需要预先启动 WSL，也不需要开着任何 WSL 终端窗口：
rem    wsl.exe 会把处于 Stopped 状态的发行版自动拉起来（实测确认）。
rem ============================================================

set "PORT=8790"

echo.
echo   dsh-llm-gateway — 本地多供应商 LLM 网关
echo   ========================================
echo.
echo   正在启动网关（若 WSL 未启动，首次可能需要十几秒）…

rem --cd / 消除 UNC 当前目录导致的 "Failed to translate" 噪音
wsl.exe -d %GATEWAY_DISTRO% --cd / -- bash -lc "bash %GATEWAY_HOME%/scripts/ensure.sh"
if errorlevel 1 (
  echo.
  echo   [错误] 启动失败。查看日志：
  echo     wsl -d %GATEWAY_DISTRO% -- tail -40 /tmp/dsh-llm-gateway.log
  echo.
  pause
  exit /b 1
)

start "" "http://127.0.0.1:%PORT%/"
exit /b 0
