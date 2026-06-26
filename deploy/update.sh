#!/usr/bin/env bash
# Atualiza a aplicação a partir do git (uso recorrente no VPS).
set -euo pipefail
APP_DIR="/opt/clipseller-standalone"
cd "$APP_DIR"
git fetch --all --prune
git reset --hard origin/main
sudo -u clipseller npm install --omit=dev --no-audit --no-fund
systemctl restart clipseller.service
echo "✓ ClipSeller atualizado e reiniciado."
systemctl status clipseller.service --no-pager | head -8
