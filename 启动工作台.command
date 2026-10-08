#!/bin/bash
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null; then
  echo "请先安装 Node.js：https://nodejs.org/"
  read -r -p "按回车退出"
  exit 1
fi
node scripts/launch.js
if [ $? -ne 0 ]; then read -r -p "按回车退出"; fi
