@echo off
chcp 65001 >nul
title dsh-llm-gateway (Windows) — 状态
for /f "usebackq delims=" %%L in (`powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0_status-gateway.ps1"`) do (
    for /f "tokens=1,2,3,4" %%a in ("%%L") do (
        if /i "%%a"=="STATE" if /i "%%b"=="STOPPED" echo   服务: 未运行
        if /i "%%a"=="STATE" if /i "%%b"=="RUNNING" echo   服务: 运行中（pid %%c, 进程 %%d）
        if /i "%%a"=="PROV" if not "%%b"=="NONE" echo     %%b  :%%c  账号 %%d
    )
)
echo.
echo   控制台:   http://127.0.0.1:8790/
echo   聚合端点: http://127.0.0.1:8790/v1
echo   日志:     %USERPROFILE%\.dsh-llm-gateway-win\gateway.log
echo.
pause
