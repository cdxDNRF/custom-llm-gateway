@echo off
rem ============================================================
rem  静默启动 dsh-llm-gateway（完全无窗口）。
rem  真正的逻辑在 Start-Gateway-Win-Silent.ps1（注释里有设计说明）。
rem  本 bat 只是给桌面快捷方式一个双击目标 —— 快速闪过一瞬即消失。
rem ============================================================
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Start-Gateway-Win-Silent.ps1"
