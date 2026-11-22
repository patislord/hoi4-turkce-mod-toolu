@echo off
rem Starts the HOI4 Turkce Mod Toolu and opens it in the browser.
cd /d "%~dp0..\.."
python -B .tools\mod_studio\studio.py %*
pause
