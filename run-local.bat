@echo off
setlocal
title AI Document Translator - run locally
cd /d "%~dp0"

echo ==========================================================
echo  AI Document Translator - open locally
echo ==========================================================
echo.

where npm >nul 2>nul
if errorlevel 1 goto :no_npm

if not exist "package.json" goto :wrong_folder

if exist "node_modules" goto :start

echo Installing dependencies for the first time (this can take a few minutes)...
call npm install
if errorlevel 1 goto :fail_install

:start
echo Starting the development server...
start "AI Document Translator - dev server" cmd /k npm run dev

echo Waiting for the server to be ready...
ping -n 7 127.0.0.1 >nul
start "" http://localhost:5173

echo.
echo Opened in your browser: http://localhost:5173
echo To stop the app, close the "dev server" window.
echo.
pause
exit /b 0

:fail_install
echo.
echo [ERROR] npm install failed. Check your internet connection and Node.js version.
pause
exit /b 1

:no_npm
echo [ERROR] Node.js / npm is not installed.
echo Install Node.js 20.19+ from https://nodejs.org/ then run this file again.
pause
exit /b 1

:wrong_folder
echo [ERROR] package.json not found.
echo Keep this .bat file inside the project folder and double-click it there.
pause
exit /b 1
