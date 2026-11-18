@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

set "DEPLOY_HOST=192.168.10.1"
set "DEPLOY_USER=root"
set "DEPLOY_PORT=8000
set "PYTHONUTF8=1"

echo ============================================================
echo   方块云盘 - 一键部署到 Docker 服务器
echo   目标: %DEPLOY_USER%@%DEPLOY_HOST%
echo   应用端口: %DEPLOY_PORT%
echo ============================================================
echo.

where python >nul 2>nul
if errorlevel 1 (
  echo [错误] 找不到 python，请先安装 Python 3.10+ 并加入 PATH。
  pause
  exit /b 1
)

python -c "import paramiko" >nul 2>nul
if errorlevel 1 (
  echo [1/2] 安装部署依赖 paramiko...
  python -m pip install paramiko
  if errorlevel 1 (
    echo [错误] paramiko 安装失败，请检查网络或 pip。
    pause
    exit /b 1
  )
)

echo [2/2] 开始部署。接下来会提示输入服务器 root 密码。
echo.
python tools\deploy_server.py %*
set "RC=%ERRORLEVEL%"
echo.
if "%RC%"=="0" (
  echo 部署成功：https://%DEPLOY_HOST%:%DEPLOY_PORT%
  echo 管理员账号沿用 data 中现有配置；全新安装默认为 admin / admin123
) else (
  echo 部署失败，退出码：%RC%
  echo 请查看上方日志，或运行 python tools\deploy_server.py 获取详细信息。
)
pause
exit /b %RC%
