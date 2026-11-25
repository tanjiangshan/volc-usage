#!/bin/bash
# macOS 双击入口。如果双击没反应，先在终端执行：chmod +x setup.command
cd "$(dirname "$0")" || exit 1
bash setup.sh "$@"
status=$?
if [ $status -ne 0 ]; then
  echo
  read -n 1 -s -r -p "安装失败，按任意键关闭窗口…"
  echo
fi
exit $status
