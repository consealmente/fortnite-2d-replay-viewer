#!/usr/bin/env bash
set -euo pipefail
if [ -z "${VERCEL:-}" ]; then echo "Skipping .NET bundle outside Vercel"; exit 0; fi
DOTNET_DIR="$PWD/.dotnet-build"
mkdir -p "$DOTNET_DIR"
curl --retry 3 --retry-all-errors --connect-timeout 20 --max-time 120 -fsSL https://dot.net/v1/dotnet-install.sh -o "$DOTNET_DIR/install.sh"
bash "$DOTNET_DIR/install.sh" --channel 10.0 --install-dir "$DOTNET_DIR" --no-path
"$DOTNET_DIR/dotnet" publish bridge/bridge.csproj -c Release -r linux-x64 --self-contained true -p:PublishSingleFile=true -p:EnableCompressionInSingleFile=true -p:DebugType=None -p:DebugSymbols=false -o bridge/published
chmod +x bridge/published/bridge
