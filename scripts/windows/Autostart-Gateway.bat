@echo off
rem ============================================================
rem  开机自动启动 dsh-llm-gateway（放进启动文件夹即可）
rem  只拉起服务，不打开浏览器 —— 避免开机时弹窗打扰。
rem ============================================================
call "%~dp0_config.bat"
if errorlevel 1 exit /b 1

start "" /min wsl.exe -d %GATEWAY_DISTRO% --cd / --exec bash -lc "bash %GATEWAY_HOME%/scripts/ensure.sh" >nul 2>&1
exit /b 0
