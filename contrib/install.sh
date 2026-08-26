#!/usr/bin/env bash
# Install the OpenBot standalone binary from GitHub Releases.
#   curl -fsSL https://github.com/JWilson45/openbot/releases/latest/download/install.sh | bash
set -euo pipefail

REPO="${OPENBOT_REPO:-JWilson45/openbot}"
VERSION="${OPENBOT_VERSION:-latest}"
DEST="${OPENBOT_BIN:-${HOME}/.local/bin/openbot}"

os="$(uname -s | tr '[:upper:]' '[:lower:]')"
arch="$(uname -m)"
case "$arch" in
  x86_64) arch=x64 ;;
  aarch64 | arm64) arch=arm64 ;;
  *)
    echo "unsupported arch: $arch" >&2
    exit 1
    ;;
esac
case "$os" in
  darwin | linux) ;;
  *)
    echo "unsupported OS: $os (need darwin or linux)" >&2
    exit 1
    ;;
esac

asset="openbot-${os}-${arch}"
if [ "$VERSION" = "latest" ]; then
  url="https://github.com/${REPO}/releases/latest/download/${asset}"
else
  url="https://github.com/${REPO}/releases/download/${VERSION}/${asset}"
fi

mkdir -p "$(dirname "$DEST")"
echo "Downloading ${url}"
curl -fsSL "$url" -o "$DEST"
chmod +x "$DEST"

echo "Installed ${DEST}"
echo "Requires: grok on PATH (grok login as this user). Chromium optional."
echo "Do not run as root."
dest_dir="$(dirname "$DEST")"
case ":$PATH:" in
  *":${dest_dir}:"*) ;;
  *) echo "Add ${dest_dir} to PATH if 'openbot' is not found." ;;
esac
"$DEST" version || true
