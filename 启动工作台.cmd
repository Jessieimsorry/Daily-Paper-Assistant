@echo off
setlocal
chcp 65001 >nul
pushd "%~dp0"
if errorlevel 1 (
  echo Cannot open the application folder. Extract the ZIP first.
  pause
  exit /b 1
)
where node >nul 2>nul
if errorlevel 1 (
  echo 请先安装 Node.js 24 LTS：https://nodejs.org/
  echo 安装后重新打开此窗口。请先解压 ZIP，不要在压缩包内运行。
  popd
  pause
  exit /b 1
)
node scripts\launch.js
set "DPA_EXIT=%errorlevel%"
popd
if not "%DPA_EXIT%"=="0" pause
exit /b %DPA_EXIT%
