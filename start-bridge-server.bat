@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul

echo ============================================================
echo   Aether Engine (AE) - Web Search Bridge Server 启动器
echo ============================================================
echo.

set "SKILL_DIR=%~dp0skills\web-search"
set "SERVER_PORT=8923"
set "GIT_BASH=C:\Program Files\Git\bin\bash.exe"

:: 检查 Node.js
where node >nul 2>&1
if errorlevel 1 (
  echo [错误] 未找到 Node.js，请先安装 Node.js
  pause & exit /b 1
)
for /f "tokens=*" %%v in ('node --version') do set NODE_VER=%%v
echo [✓] Node.js %NODE_VER%

:: 检查 Git Bash
if exist "%GIT_BASH%" (
  echo [✓] Git Bash 已找到
) else (
  echo [警告] Git Bash 未找到，web-search bash 脚本可能无法执行
)

:: 检查并安装 web-search 依赖
echo.
echo [步骤 1/3] 检查 web-search 依赖...
if not exist "%SKILL_DIR%\node_modules" (
  echo   正在安装依赖（首次运行需要几分钟）...
  cd /d "%SKILL_DIR%"
  call npm install --prefer-offline 2>&1
  if errorlevel 1 (
    echo [错误] npm install 失败
    pause & exit /b 1
  )
  echo [✓] 依赖安装完成
) else (
  echo [✓] 依赖已存在，跳过安装
)

:: 安装 Playwright 浏览器
echo.
echo [步骤 2/3] 检查 Playwright 浏览器...
cd /d "%SKILL_DIR%"
node -e "require('@playwright/test')" >nul 2>&1
if errorlevel 1 (
  echo   正在安装 Playwright chromium（首次约 200MB）...
  call npx playwright install chromium 2>&1
  if errorlevel 1 (
    echo [警告] Playwright 安装失败，搜索功能可能受限
  ) else (
    echo [✓] Playwright chromium 已安装
  )
) else (
  echo [✓] Playwright 已就绪
)

:: 启动 Bridge Server
echo.
echo [步骤 3/3] 启动 Bridge Server（端口 %SERVER_PORT%）...
cd /d "%SKILL_DIR%"

:: 检查端口是否已占用
netstat -ano | findstr ":%SERVER_PORT% " | findstr "LISTENING" >nul 2>&1
if not errorlevel 1 (
  echo [✓] Bridge Server 已在运行（端口 %SERVER_PORT%）
  goto :done
)

echo   启动中...
start "Web Search Bridge Server" /min cmd /c "cd /d "%SKILL_DIR%" && npx tsx server/index.ts 2>&1 | tee bridge-server.log"

:: 等待服务就绪（最多 15 秒）
set /a attempts=0
:wait_loop
timeout /t 1 /nobreak >nul
set /a attempts+=1
netstat -ano | findstr ":%SERVER_PORT% " | findstr "LISTENING" >nul 2>&1
if not errorlevel 1 goto :server_ready
if %attempts% geq 15 (
  echo [警告] Bridge Server 启动超时，请检查 skills\web-search\bridge-server.log
  goto :done
)
echo   等待中... (%attempts%/15)
goto :wait_loop

:server_ready
echo [✓] Bridge Server 已就绪！

:done
echo.
echo ============================================================
echo   Web Search Bridge Server 运行在 http://localhost:%SERVER_PORT%
echo   日志文件: skills\web-search\bridge-server.log
echo.
echo   现在可以使用 web-search skill 搜索了！
echo ============================================================
echo.
pause
