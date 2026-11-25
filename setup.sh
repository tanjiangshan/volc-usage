#!/usr/bin/env bash
# Linux / macOS 一键安装入口：没有 Node 24 时自动下载便携版，然后运行 install.mjs。
set -euo pipefail
cd "$(dirname "$0")"

MIN_MAJOR=24
NODE_VERSION="${VOLC_USAGE_NODE_VERSION:-24.22.2}"

node_major() {
  "$1" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0
}

if command -v node >/dev/null 2>&1; then
  if [ "$(node_major "$(command -v node)")" -ge "$MIN_MAJOR" ]; then
    exec node install.mjs "$@"
  fi
fi

if [ -x .runtime/node/bin/node ]; then
  if [ "$(node_major .runtime/node/bin/node)" -ge "$MIN_MAJOR" ]; then
    exec .runtime/node/bin/node install.mjs "$@"
  fi
fi

case "$(uname -s)" in
  Linux) OS=linux ;;
  Darwin) OS=darwin ;;
  *)
    echo "暂不支持当前系统：$(uname -s)。请手动安装 Node.js 24 后运行 node install.mjs"
    exit 1
    ;;
esac

case "$(uname -m)" in
  x86_64 | amd64) ARCH=x64 ;;
  arm64 | aarch64) ARCH=arm64 ;;
  *)
    echo "暂不支持的 CPU 架构：$(uname -m)。请手动安装 Node.js 24 后运行 node install.mjs"
    exit 1
    ;;
esac

PLATFORM="${OS}-${ARCH}"
NAME="node-v${NODE_VERSION}-${PLATFORM}"
URL="https://nodejs.org/dist/v${NODE_VERSION}/${NAME}.tar.gz"
SUMS_URL="https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt"
ARCHIVE=".runtime/${NAME}.tar.gz"

mkdir -p .runtime
echo "未找到 Node.js ${MIN_MAJOR}+，正在下载便携版 ${NODE_VERSION}（${PLATFORM}）…"

if command -v curl >/dev/null 2>&1; then
  curl -fL --retry 3 --connect-timeout 20 "$URL" -o "$ARCHIVE"
  curl -fsSL --retry 3 "$SUMS_URL" -o .runtime/SHASUMS256.txt || true
elif command -v wget >/dev/null 2>&1; then
  wget -O "$ARCHIVE" "$URL"
  wget -O .runtime/SHASUMS256.txt "$SUMS_URL" || true
else
  echo "找不到 curl 或 wget。请手动安装 Node.js 24：https://nodejs.org/"
  exit 1
fi

EXPECTED=""
if [ -s .runtime/SHASUMS256.txt ]; then
  EXPECTED="$(awk -v file="${NAME}.tar.gz" '$2 == file { print $1 }' .runtime/SHASUMS256.txt | head -n 1)"
fi

if [ -n "$EXPECTED" ]; then
  if command -v sha256sum >/dev/null 2>&1; then
    ACTUAL="$(sha256sum "$ARCHIVE" | awk '{ print $1 }')"
  elif command -v shasum >/dev/null 2>&1; then
    ACTUAL="$(shasum -a 256 "$ARCHIVE" | awk '{ print $1 }')"
  else
    ACTUAL=""
  fi
  if [ -n "$ACTUAL" ] && [ "$ACTUAL" != "$EXPECTED" ]; then
    echo "Node.js 安装包校验失败，已中止。"
    rm -f "$ARCHIVE" .runtime/SHASUMS256.txt
    exit 1
  fi
fi

tar -xzf "$ARCHIVE" -C .runtime
rm -rf .runtime/node
mv ".runtime/${NAME}" .runtime/node
rm -f "$ARCHIVE" .runtime/SHASUMS256.txt

exec .runtime/node/bin/node install.mjs "$@"
