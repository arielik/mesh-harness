#!/bin/sh
# Install or update mesh-harness (the `mesh` command) for the current user, without sudo.
#
#   curl -fsSL https://github.com/arielik/mesh-harness/releases/latest/download/install.sh | sh
#
# It downloads the release package from GitHub and installs it with npm under ~/.local
# (bin/mesh). Run it again to update: an existing setup (hooks, skill, daemon service) is refreshed.
#
# Environment:
#   MESH_VERSION   a release such as 0.2.0 (default: the latest release)
#   MESH_REPO      GitHub owner/repo to download from (default: arielik/mesh-harness)
#   MESH_PREFIX    install prefix (default: ~/.local; the command lands in $MESH_PREFIX/bin)
#   MESH_PACKAGE   a local .tgz or a URL to install instead of a GitHub release
#   MESH_NO_SETUP  1: don't refresh an existing setup after updating
set -eu

REPO="${MESH_REPO:-arielik/mesh-harness}"
PREFIX="${MESH_PREFIX:-$HOME/.local}"
VERSION="${MESH_VERSION:-latest}"

say() { printf '%s\n' "$*"; }
fail() { printf 'mesh install: %s\n' "$*" >&2; exit 1; }

# ---- requirements ----
command -v node >/dev/null 2>&1 || fail "Node.js 22.13+ or 24+ is required (https://nodejs.org); install it and run this again."
command -v npm >/dev/null 2>&1 || fail "npm is required (it ships with Node.js)."
node -e '
  const [maj, min] = process.versions.node.split(".").map(Number);
  process.exit(maj >= 24 || (maj === 22 && min >= 13) ? 0 : 1);
' || fail "Node.js $(node -v) is too old: mesh needs 22.13+ or 24+."
command -v curl >/dev/null 2>&1 || fail "curl is required (the Claude Code hooks use it too)."

# ---- the package ----
TMP="$(mktemp -d 2>/dev/null || mktemp -d -t mesh)"
trap 'rm -rf "$TMP"' EXIT INT TERM
PKG="$TMP/mesh-harness.tgz"
if [ -n "${MESH_PACKAGE:-}" ]; then
  case "$MESH_PACKAGE" in
    http://*|https://*) curl -fsSL "$MESH_PACKAGE" -o "$PKG" || fail "could not download $MESH_PACKAGE" ;;
    *) [ -f "$MESH_PACKAGE" ] || fail "$MESH_PACKAGE: no such file"; cp "$MESH_PACKAGE" "$PKG" ;;
  esac
else
  if [ "$VERSION" = "latest" ]; then
    URL="https://github.com/$REPO/releases/latest/download/mesh-harness.tgz"
  else
    URL="https://github.com/$REPO/releases/download/v${VERSION#v}/mesh-harness.tgz"
  fi
  say "Downloading $URL"
  curl -fsSL "$URL" -o "$PKG" || fail "could not download $URL (is there a release?)"
fi

# ---- install ----
had_mesh=""
[ -x "$PREFIX/bin/mesh" ] && had_mesh=1
say "Installing into $PREFIX"
npm install --global --prefix "$PREFIX" --no-fund --no-audit --loglevel=error "$PKG" >/dev/null \
  || fail "npm install failed"
MESH="$PREFIX/bin/mesh"
[ -x "$MESH" ] || fail "npm did not create $MESH"
say "Installed mesh $("$MESH" --version)"

# ---- refresh an existing setup ----
CONFIG_DIR="${MESH_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/mesh}"
if [ -f "$CONFIG_DIR/daemon.json" ] && [ "${MESH_NO_SETUP:-}" != "1" ]; then
  say "Refreshing your setup (hooks, skill, MCP server)"
  "$MESH" setup >/dev/null || say "mesh setup failed; run it yourself to see why"
  if command -v systemctl >/dev/null 2>&1 && systemctl --user is-active --quiet mesh.service 2>/dev/null; then
    systemctl --user restart mesh.service && say "Restarted the mesh daemon (systemd user service)"
  elif [ "$(uname)" = "Darwin" ] && launchctl print "gui/$(id -u)/dev.mesh-harness.daemon" >/dev/null 2>&1; then
    launchctl kickstart -k "gui/$(id -u)/dev.mesh-harness.daemon" && say "Restarted the mesh daemon (launchd agent)"
  else
    say "If the daemon is running, restart it (mesh up) to use the new version."
  fi
fi

# ---- next steps ----
case ":$PATH:" in
  *":$PREFIX/bin:"*) ;;
  *) say ""; say "Add $PREFIX/bin to your PATH, for example:"; say "  echo 'export PATH=\"$PREFIX/bin:\$PATH\"' >> ~/.bashrc" ;;
esac
if [ -z "$had_mesh" ] && [ ! -f "$CONFIG_DIR/daemon.json" ]; then
  say ""
  say "Next:"
  say "  mesh setup          # hooks, MCP server and skill for Claude Code"
  say "  mesh up --install   # keep the daemon running (prints one command to run)"
  say "  mesh doctor"
fi
