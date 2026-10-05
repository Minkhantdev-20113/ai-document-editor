@echo off
setlocal
title Push project to GitHub
cd /d "%~dp0"

echo ==========================================================
echo  Push project changes to GitHub
echo  Repository : https://github.com/Minkhantdev-20113/ai-document-editor
echo ==========================================================
echo.

REM --- Usage: push-github.bat "your commit message" ---------------
set "MSG=%~1"
if "%MSG%"=="" set "MSG=Update project %date%"

where git >nul 2>nul
if errorlevel 1 goto :no_git

if not exist ".git" goto :no_repo

echo [1/3] Adding all changes...
git add -A

git diff --cached --quiet
if not errorlevel 1 goto :skip_commit

echo [2/3] Committing: %MSG%
git commit -m "%MSG%"
if errorlevel 1 goto :fail_commit
goto :do_push

:skip_commit
echo [2/3] Nothing new to commit.

:do_push
echo [3/3] Pushing to origin main...
git push -u origin main
if errorlevel 1 goto :fail_push

echo.
echo Done - your changes are on GitHub.
pause
exit /b 0

:fail_commit
echo.
echo [ERROR] Commit failed. Read the message above, fix it and run again.
pause
exit /b 1

:fail_push
echo.
echo [ERROR] Push failed. Common fixes:
echo   - GitHub no longer accepts passwords. Create a Personal Access Token
echo     (GitHub ^> Settings ^> Developer settings ^> Personal access tokens)
echo     and use it as the password when Git asks, or install GitHub Desktop.
echo   - If the remote has commits you do not have, run once:
echo       git pull --rebase origin main
echo     then run this file again.
pause
exit /b 1

:no_git
echo [ERROR] Git is not installed. Install it from https://git-scm.com/download/win
pause
exit /b 1

:no_repo
echo [ERROR] This is not a Git repository yet.
echo Run the first-time setup once:
echo     git init -b main
echo     git remote add origin https://github.com/Minkhantdev-20113/ai-document-editor.git
pause
exit /b 1
