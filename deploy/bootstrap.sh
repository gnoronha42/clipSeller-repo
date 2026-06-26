#!/usr/bin/env bash
# Provisionamento idempotente do VPS para o ClipSeller standalone.
# Roda como root no VPS:
#   curl -fsSL https://raw.githubusercontent.com/gnoronha42/clipSeller-repo/main/deploy/bootstrap.sh | bash
# Ou, se o repo já está clonado em /opt/clipseller-standalone:
#   bash /opt/clipseller-standalone/deploy/bootstrap.sh

set -euo pipefail

APP_DIR="/opt/clipseller-standalone"
APP_USER="clipseller"
DB_NAME="${DB_NAME:-clipseller}"
DB_USER="${DB_USER:-clipseller}"
DB_PASS_DEFAULT="$(openssl rand -hex 16)"
DOMAIN_PRIMARY="${DOMAIN_PRIMARY:-clipseller.com.br}"
DOMAIN_WWW="${DOMAIN_WWW:-www.clipseller.com.br}"

echo "=== [1/7] Garantindo dependências de sistema ==="
apt-get update -y
apt-get install -y --no-install-recommends \
  curl ca-certificates gnupg lsb-release \
  nginx postgresql postgresql-contrib certbot python3-certbot-nginx \
  git build-essential

if ! command -v node >/dev/null 2>&1; then
  echo "Instalando Node.js 20.x..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi

echo "=== [2/7] Usuário de sistema ==="
if ! id -u "$APP_USER" >/dev/null 2>&1; then
  useradd --system --create-home --shell /usr/sbin/nologin "$APP_USER"
fi
mkdir -p "$APP_DIR"
chown -R "$APP_USER:$APP_USER" "$APP_DIR"

echo "=== [3/7] PostgreSQL ==="
sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='$DB_USER'" | grep -q 1 || \
  sudo -u postgres psql -c "CREATE ROLE $DB_USER LOGIN PASSWORD '$DB_PASS_DEFAULT'"
sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='$DB_NAME'" | grep -q 1 || \
  sudo -u postgres psql -c "CREATE DATABASE $DB_NAME OWNER $DB_USER"
sudo -u postgres psql -d "$DB_NAME" -c "CREATE EXTENSION IF NOT EXISTS pgcrypto;" >/dev/null

echo "=== [4/7] .env ==="
if [ ! -f "$APP_DIR/.env" ]; then
  cp "$APP_DIR/.env.example" "$APP_DIR/.env"
  JWT_SECRET=$(openssl rand -hex 48)
  sed -i "s|^DB_PASSWORD=.*|DB_PASSWORD=$DB_PASS_DEFAULT|" "$APP_DIR/.env"
  sed -i "s|^JWT_SECRET=.*|JWT_SECRET=$JWT_SECRET|" "$APP_DIR/.env"
  sed -i "s|^PUBLIC_URL=.*|PUBLIC_URL=https://$DOMAIN_PRIMARY|" "$APP_DIR/.env"
  echo
  echo ">>> .env criado em $APP_DIR/.env"
  echo ">>> Preencha as chaves AWS/IA e ADMIN_PASSWORD antes de iniciar o serviço."
fi
chown "$APP_USER:$APP_USER" "$APP_DIR/.env"
chmod 600 "$APP_DIR/.env"

echo "=== [5/7] npm install (production) ==="
cd "$APP_DIR"
sudo -u "$APP_USER" npm install --omit=dev --no-audit --no-fund

echo "=== [6/7] systemd ==="
cp "$APP_DIR/deploy/clipseller.service" /etc/systemd/system/clipseller.service
systemctl daemon-reload
systemctl enable clipseller.service
systemctl restart clipseller.service

echo "=== [7/7] nginx ==="
cp "$APP_DIR/deploy/nginx.conf" /etc/nginx/sites-available/clipseller
ln -sf /etc/nginx/sites-available/clipseller /etc/nginx/sites-enabled/clipseller
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl reload nginx

cat <<INSTR

✅ Bootstrap concluído.

Próximos passos:
1) Aponte o DNS de $DOMAIN_PRIMARY (e $DOMAIN_WWW) para este servidor (registro A apontando para o IP público).
2) Depois que o DNS propagar, emita o certificado SSL:
     certbot --nginx -d $DOMAIN_PRIMARY -d $DOMAIN_WWW --email <seu-email> --agree-tos --redirect -n
3) Verifique:
     systemctl status clipseller --no-pager | head -5
     journalctl -u clipseller -n 30 --no-pager
4) Senha do Postgres ficou em $APP_DIR/.env (DB_PASSWORD)

INSTR
