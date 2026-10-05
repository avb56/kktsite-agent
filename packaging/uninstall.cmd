@echo off
rem Удаление kktsite-agent. Запускать от имени администратора. Данные агента не удаляются.
rem Без chcp 65001 — см. install.cmd.
set "KKT_PKG=%~dp0"
if exist "%~dp0ia32\node\node.exe" set "KKT_PKG=%~dp0ia32\"
"%KKT_PKG%node\node.exe" "%KKT_PKG%app\src\main.js" uninstall %*
pause
