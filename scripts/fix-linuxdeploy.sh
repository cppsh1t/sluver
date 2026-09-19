#!/usr/bin/env bash
# fix-linuxdeploy.sh — fix Tauri AppImage bundling on RELR-default Linux distros.
#
# Symptom this fixes:
#   pnpm tauri build dies at the AppImage step with
#     "failed to bundle project: `failed to run linuxdeploy`"
#   and a verbose build (`pnpm tauri build --verbose`) shows linuxdeploy's strip
#   failing on every library: "unknown type [0x13] section `.relr.dyn'".
#
# Cause:
#   Tauri pins a 2024-07 linuxdeploy build whose bundled static strip
#   (binutils 2.35) cannot parse SHT_RELR sections. RELR-default distros
#   (Arch/CachyOS and derivatives, Fedora 40+, Gentoo 23.0 profiles) compile
#   their system libraries with -z pack-relative-relocs, so every lib
#   linuxdeploy tries to strip triggers a fatal error.
#   Fixed upstream on 2026-08-01 (linuxdeploy PR #337: binutils 2.35 -> 2.47,
#   commit 07333c6). Tauri has not bumped its pin (tauri-apps/binary-releases
#   still serves the 2024-07 build), but tauri-bundler only downloads linuxdeploy
#   when the cache file is missing — so dropping the fixed continuous build into
#   the cache is the maintainer-suggested upgrade channel.
#
# Usage:
#   bash scripts/fix-linuxdeploy.sh           # detect & fix if needed
#   bash scripts/fix-linuxdeploy.sh --force   # replace linuxdeploy even if no RELR detected
#
# Machine-level fix only (per-developer cache); nothing in the repo changes.
# Offline fallback if the download fails: prefix builds with NO_STRIP=1
# (linuxdeploy then skips its strip pass entirely).

set -euo pipefail

LINUXDEPLOY_URL="https://github.com/linuxdeploy/linuxdeploy/releases/download/continuous"
FIXED_SINCE="2026-08-01" # date of linuxdeploy PR #337 (bundled binutils 2.35 -> 2.47)

say() { printf '%s\n' "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

FORCE=0
[ "${1:-}" = "--force" ] && FORCE=1

# --- Locate tauri's bundler-tools cache (mirrors tauri-bundler: dirs::cache_dir) ---
CACHE_DIR="${XDG_CACHE_HOME:-$HOME/.cache}/tauri"
case "$(uname -m)" in
  x86_64) LD_ARCH="x86_64" ;;
  aarch64) LD_ARCH="aarch64" ;;
  *) die "unsupported architecture: $(uname -m) (this fix only ships x86_64/aarch64 builds)" ;;
esac
LD_PATH="$CACHE_DIR/linuxdeploy-$LD_ARCH.AppImage"

# NOTE: detection never pipes readelf/grep directly — under `set -o pipefail`,
# `grep -q` can exit first and SIGPIPE its producer (a flaky false negative).
# Command substitution + bash pattern matching has no such race.

# --- Do this machine's distro-built libraries carry SHT_RELR sections? ---
has_relr() {
  command -v readelf >/dev/null 2>&1 || return 1
  local lib sections
  for lib in \
    /usr/lib/libglib-2.0.so.0 \
    /usr/lib64/libglib-2.0.so.0 \
    /usr/lib/x86_64-linux-gnu/libglib-2.0.so.0
  do
    if [ -f "$lib" ]; then
      sections="$(readelf -S "$lib" 2>/dev/null)" || true
      [[ $sections == *".relr.dyn"* ]] && return 0
      return 1 # first inspectable lib decides (all distro libs share the same LDFLAGS policy)
    fi
  done
  return 1
}

# --- Run a linuxdeploy AppImage's --version (via extraction; needs no FUSE) ---
linuxdeploy_version() { # $1 = path  (linuxdeploy logs to stderr — merge streams)
  local out
  out="$(APPIMAGE_EXTRACT_AND_RUN=1 "$1" --version 2>&1)" || return 1
  printf '%s' "$out"
}
linuxdeploy_date() { # $1 = version string from linuxdeploy_version
  [[ $1 =~ built\ on\ ([0-9]{4}-[0-9]{2}-[0-9]{2}) ]] || return 1
  printf '%s' "${BASH_REMATCH[1]}"
}
linuxdeploy_commit() { # $1 = version string from linuxdeploy_version
  [[ $1 =~ git\ commit\ ID\ ([a-f0-9]+) ]] || return 1
  printf '%s' "${BASH_REMATCH[1]}"
}

say "== tauri linuxdeploy RELR fix =="
say "checking distro libraries for SHT_RELR (.relr.dyn) ..."
if has_relr; then
  say "  -> RELR present: this distro's default toolchain packs relative relocations."
  say "     linuxdeploy builds older than $FIXED_SINCE fail to strip them."
else
  if [ "$FORCE" -ne 1 ]; then
    say "  -> no RELR found: this machine is NOT affected (typical for Ubuntu/Debian)."
    say "     Nothing to do. Re-run with --force to replace linuxdeploy anyway."
    exit 0
  fi
  say "  -> no RELR found, but --force given: replacing linuxdeploy anyway."
fi

say "cached linuxdeploy: $LD_PATH"
if VER="$(linuxdeploy_version "$LD_PATH" 2>/dev/null)" && DATE="$(linuxdeploy_date "$VER")"; then
  say "  -> installed: commit $(linuxdeploy_commit "$VER" || echo '?'), built $DATE"
  if [[ ! "$DATE" < "$FIXED_SINCE" ]]; then
    say "  -> already fixed (>= $FIXED_SINCE, bundled binutils 2.47). Nothing to do."
    exit 0
  fi
  say "  -> stale build (pre-$FIXED_SINCE, bundled strip = binutils 2.35): replacing."
else
  say "  -> not present or unreadable (tauri would download its broken 2024-07 pin"
  say "     on first build): pre-seeding the cache with the fixed build."
fi

say "downloading fixed linuxdeploy (continuous build) ..."
mkdir -p "$CACHE_DIR"
TMP="$(mktemp "$LD_PATH.new.XXXXXX")"
trap 'rm -f "$TMP"' EXIT
if ! curl -fL --progress-bar -o "$TMP" "$LINUXDEPLOY_URL/linuxdeploy-$LD_ARCH.AppImage"; then
  say ""
  say "Download failed. Workaround until you have network access to github.com:"
  say "    NO_STRIP=1 pnpm tauri build"
  die "could not download $LINUXDEPLOY_URL/linuxdeploy-$LD_ARCH.AppImage"
fi
chmod 755 "$TMP"

say "verifying downloaded build ..."
VER="$(linuxdeploy_version "$TMP")" || die "downloaded file does not run — cache left untouched"
DATE="$(linuxdeploy_date "$VER")" || die "cannot parse build date from: $VER — cache left untouched"
say "  -> downloaded: commit $(linuxdeploy_commit "$VER" || echo '?'), built $DATE"
if [[ "$DATE" < "$FIXED_SINCE" ]]; then
  die "downloaded build is still older than $FIXED_SINCE — cache left untouched; use NO_STRIP=1 workaround"
fi

mv -f "$TMP" "$LD_PATH"
trap - EXIT
say "installed: $LD_PATH"
say ""
say "Done. Build normally now:   pnpm tauri build"
say "(Tauri reuses the cached file instead of downloading its broken 2024-07 pin."
say " If you previously worked around this with NO_STRIP=1, you can drop it.)"
