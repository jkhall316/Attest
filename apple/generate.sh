#!/bin/sh
# Makes Attest.xcodeproj. Your signing details come from the environment, so none are committed:
#   DEVELOPMENT_TEAM=ABCDE12345 ATTEST_BUNDLE_ID=com.yourname.attest ./generate.sh
# (Or leave them unset and choose the team in Xcode under Signing & Capabilities.)
set -e
cd "$(dirname "$0")"
command -v xcodegen >/dev/null || { echo "Install XcodeGen first: brew install xcodegen" >&2; exit 1; }
export DEVELOPMENT_TEAM="${DEVELOPMENT_TEAM:-}"
export ATTEST_BUNDLE_ID="${ATTEST_BUNDLE_ID:-com.attest.app}"
xcodegen generate
echo "Bundle id: $ATTEST_BUNDLE_ID   Team: ${DEVELOPMENT_TEAM:-(choose in Xcode)}"
