#!/bin/sh
set -eu
platform=${1:?Usage: package-release.sh PLATFORM}
case "$platform" in darwin-arm64|darwin-x64|linux-arm64|linux-x64) ;; *) echo 'Unsupported platform' >&2; exit 1;; esac
# Recreate only this generated staging directory to avoid stale release files.
rm -rf "release/sds-$platform"
mkdir -p "release/sds-$platform"
bun run build
bun build --compile --minify --target="bun-$platform" src/cli/main.ts --outfile "release/sds-$platform/sds"
bun build --compile --minify --target="bun-$platform" scripts/dashboard.ts --outfile "release/sds-$platform/sds-dashboard"
cp -R dist "release/sds-$platform/"
cp -R skills "release/sds-$platform/"
cp README.md "release/sds-$platform/"
tar -czf "release/sds-$platform.tar.gz" -C release "sds-$platform"
