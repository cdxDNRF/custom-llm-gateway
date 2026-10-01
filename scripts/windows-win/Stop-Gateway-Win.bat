@echo off
chcp 65001 >nul
title dsh-llm-gateway (Windows) — 停止
rem ============================================================
rem  停止 Windows 端网关。逻辑在 _stop-gateway.ps1（避免 cmd 转义地狱）。
rem  本脚本停不了 WSL 端 —— 那边需要在 WSL 里执行
rem    bash ~/dsh-llm-gateway/scripts/stop.sh
rem ============================================================

for /f "usebackq delims=" %%L in (`powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0_stop-gateway.ps1"`) do (
    for /f "tokens=1,2" %%a in ("%%L") do (
        if /i "%%a"=="STOP"   echo   已停止 Windows 端网关 pid=%%b
        if /i "%%a"=="OCCUPY" (
            if /i "%%b"=="wslrelay" (
                echo   [提示] 端口 8790 仍被 WSL 端网关占用 —— 本脚本停不了它，
                echo          需在 WSL 里执行： bash ~/dsh-llm-gateway/scripts/stop.sh
            ) else (
                echo   [提示] 端口 8790 仍被进程 %%b 占用（非本项目 Windows 端进程）。
            )
        )
        if /i "%%a"=="FREE"   (
            echo   端口 8790 已空闲。
        )
    )
)
echo.
pause
