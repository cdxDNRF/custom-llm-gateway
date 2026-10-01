@echo off
rem ============================================================
rem  dsh-llm-gateway — WSL 共享配置（由其余 .bat 调用，勿直接运行）
rem
rem  ★ 零配置：不写任何路径。发行版与项目位置都让 WSL 自己回答。
rem    只有项目不在 WSL 家目录时才需要覆盖 —— 新建一个
rem    _config.local.bat（不入库）写入：
rem        set "GATEWAY_HOME=/你的/实际/路径/dsh-llm-gateway"
rem
rem  为什么这么做（两个实测踩过的坑）：
rem   ① 从 Windows 双击时 %~dp0 是 UNC 路径（\\wsl.localhost\...），
rem      CMD 不支持 UNC 作为当前目录，也拿不到对应的 Linux 路径。
rem   ② `wsl -l -q` 的输出是 **UTF-16LE**（每字符后跟 \0），
rem      在 for /f 里会把 "Ubuntu-22.04" 截成 "U" —— 换代码页也救不了。
rem  所以：**不解析 wsl 的列表输出**，改为让 WSL 用 bash 把值打印回来。
rem ============================================================

rem ── ① 发行版名：让 WSL 自己报（不写 -d，用默认发行版）──
if not defined GATEWAY_DISTRO (
  for /f "usebackq delims=" %%d in (`wsl.exe --cd / -- bash -lc "echo $WSL_DISTRO_NAME" 2^>nul`) do set "GATEWAY_DISTRO=%%d"
)

if not defined GATEWAY_DISTRO (
  echo   [错误] 无法确定 WSL 发行版。请运行  wsl -l -v  确认已安装并能启动。
  exit /b 1
)

rem ── ② 项目路径：让 WSL 在自己的家目录里找（零配置）──
if not defined GATEWAY_HOME (
  for /f "usebackq delims=" %%p in (`wsl.exe --cd / -- bash -lc "ls -d $HOME/dsh-llm-gateway 2>/dev/null | head -1"`) do set "GATEWAY_HOME=%%p"
)

rem ── ③ 本地覆盖（不入库）──
if exist "%~dp0_config.local.bat" call "%~dp0_config.local.bat"

if not defined GATEWAY_HOME (
  echo.
  echo   [配置错误] 在 WSL 家目录里找不到 dsh-llm-gateway。
  echo.
  echo   若项目在别处，请新建 %~dp0_config.local.bat 写入：
  echo       set "GATEWAY_HOME=/你的/实际/路径/dsh-llm-gateway"
  echo.
  exit /b 1
)

rem ── ④ 校验入口脚本存在 ──
wsl.exe -d %GATEWAY_DISTRO% --cd / -- test -x "%GATEWAY_HOME%/scripts/ensure.sh" >nul 2>&1
if errorlevel 1 (
  echo   [错误] %GATEWAY_HOME%/scripts/ensure.sh 不存在或不可执行。
  exit /b 1
)
