@echo off
chcp 65001 >nul
title dsh-llm-gateway 状态
call "%~dp0_config.bat"
if errorlevel 1 ( pause & exit /b 1 )

echo.
wsl.exe -d %GATEWAY_DISTRO% --cd / -- bash -lc "bash %GATEWAY_HOME%/scripts/status.sh"
echo.
echo   控制台:   http://127.0.0.1:8790/
echo   聚合端点: http://127.0.0.1:8790/v1
echo.
pause
