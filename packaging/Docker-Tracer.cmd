@echo off
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Lancer-Docker-Tracer.ps1"
if errorlevel 1 pause
