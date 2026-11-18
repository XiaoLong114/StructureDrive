@echo off
chcp 65001 >nul
cd /d "%~dp0"
set MCCLOUD_PORT=5000
python -c "import flask" >nul 2>nul
if errorlevel 1 (
  echo 正在安装依赖...
  python -m pip install -r requirements.txt
  if errorlevel 1 (
    echo 依赖安装失败，请检查 Python 和网络。
    pause
    exit /b 1
  )
)
echo.
echo 方块云盘已启动：http://127.0.0.1:5000
echo 管理员账号沿用 data 中现有配置；全新安装默认为 admin / admin123
echo 按 Ctrl+C 停止。
echo.
python app.py
pause
