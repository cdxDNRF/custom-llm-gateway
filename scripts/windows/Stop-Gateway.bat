@echo off
chcp 65001 >nul
title dsh-llm-gateway 停止
call "%~dp0_config.bat"
if errorlevel 1 ( pause & exit /b 1 )

echo.
wsl.exe -d %GATEWAY_DISTRO% --cd / -- bash -lc "bash %GATEWAY_HOME%/scripts/stop.sh"
echo.
echo   已停止网关。WSL 与其它程序不受影响。
echo.
pause
