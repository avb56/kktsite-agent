@echo off
rem Установка kktsite-agent (Windows) из распакованного архива выпуска.
rem Запускать от имени администратора. Параметры: [--port 16732] [--https-port N] [--dir <каталог>] [--arch x64^|ia32]
rem Ставит в %ProgramFiles%\kktsite-agent и запускает задачей планировщика при старте системы.
rem Архив на обе разрядности: установщик идёт на 32-битном node (работает на любой Windows),
rem а ставит ту половину, что совпадает с драйвером Атола (нет драйвера — спросит).
rem Без chcp 65001: в консоли Windows 7 с ним вывод не-ASCII текста обрывается ошибкой
rem «The system cannot write to the specified device». Все сообщения печатает node (Unicode).
set "KKT_PKG=%~dp0"
if exist "%~dp0ia32\node\node.exe" set "KKT_PKG=%~dp0ia32\"
"%KKT_PKG%node\node.exe" "%KKT_PKG%app\src\main.js" install %*
rem Всегда пауза: двойным щелчком окно иначе закрывается, не дав прочитать итог.
pause
