#!/bin/bash
# Initial deployment of Upseller — единый Express-сервер всего сайта.
# Idempotent: safe to re-run.
#
# Layout на VPS (повторяет структуру git-репо):
#   /opt/upseller/
#     ├── package.json  package-lock.json   ← deps
#     ├── node_modules/                     ← npm ci сюда
#     ├── .env                              ← секреты, AUTH_DISABLED не выставлен (или =false)
#     ├── server/
#     │   ├── server.js
#     │   └── setup.sh                      ← этот файл, для самообновления
#     └── web/                              ← статика + API (rsync --delete)
#
# Expects:
# - Ubuntu 22.04+ с Node 20, nginx, certbot, git, pm2 установлены.
# - /opt/upseller/.env существует (chmod 600), без AUTH_DISABLED (или =false).
# - /etc/upseller/sheets-bot-sa.json — JSON-ключ сервис-аккаунта (chmod 600, owner = pm2-user).
#   В .env должно быть GOOGLE_SERVICE_ACCOUNT_KEY_PATH=/etc/upseller/sheets-bot-sa.json.

set -euo pipefail

APP_DIR=/opt/upseller          # корень развёртки
DATA_DIR=/var/lib/upseller     # whitelist users.json — отдельный volume, redeploy не трогает
SRC_DIR=/opt/upseller-src      # git checkout
REPO_URL=https://github.com/ArtemFay/upseller-app-netlify.git
DOMAIN="${DOMAIN:-82-97-249-207.sslip.io}"

step() { echo; echo "=== $* ==="; }

step "[1/7] Clone or update source repo"
if [ ! -d "$SRC_DIR/.git" ]; then
  rm -rf "$SRC_DIR"
  git clone --depth 1 "$REPO_URL" "$SRC_DIR"
else
  git -C "$SRC_DIR" remote set-url origin "$REPO_URL"
  git -C "$SRC_DIR" fetch --depth 1 origin main
  git -C "$SRC_DIR" reset --hard origin/main
fi

step "[2/7] Layout app dir"
mkdir -p "$APP_DIR/server" "$APP_DIR/web" "$DATA_DIR"

# === Backwards-compat миграция .env ===
# Раньше .env лежал в $APP_DIR/server/.env. После реструктуризации он в корне $APP_DIR/.env.
# При первом запуске нового setup.sh — переносим, если нашли по старому пути.
if [ -f "$APP_DIR/server/.env" ] && [ ! -f "$APP_DIR/.env" ]; then
  echo "  ↪ Migrating .env from server/ to project root"
  mv "$APP_DIR/server/.env" "$APP_DIR/.env"
fi

# === Корень: package.json + setup.sh ===
cp "$SRC_DIR/package.json"       "$APP_DIR/package.json"
cp "$SRC_DIR/package-lock.json"  "$APP_DIR/package-lock.json" 2>/dev/null || true

# === server/ — все .js + setup.sh (для самообновления) ===
# Раньше копировали по одному файлу (server.js, setup.sh) — при добавлении
# нового модуля в server/ деплой ломался ERR_MODULE_NOT_FOUND, пока вручную
# не копировали файл (инцидент 2026-05-15 с env-validator.js).
# rsync с include='*.js'/'*.sh' и без --delete: подтягивает все исходники
# server/, не трогает server/.env (уже мигрированный в корень) и node_modules.
rsync -a \
  --include='*.js' --include='*.sh' --exclude='*' \
  "$SRC_DIR/server/" "$APP_DIR/server/"
chmod +x "$APP_DIR/server/setup.sh"

# === web/ — статика + API (источник правды) через rsync с --delete ===
rsync -a --delete \
  --exclude 'node_modules' \
  --exclude '*.log' \
  "$SRC_DIR/web/" "$APP_DIR/web/"

step "[3/7] npm ci в корне $APP_DIR"
cd "$APP_DIR"
if [ -f package-lock.json ]; then
  npm ci --omit=dev
else
  npm install --omit=dev --no-audit --no-fund
fi

step "[4/7] Проверка обязательных файлов"
[ -f "$APP_DIR/.env" ] || { echo "FATAL: $APP_DIR/.env не найден — создай по шаблону .env.example"; exit 1; }
sa_path="$(grep -E '^GOOGLE_SERVICE_ACCOUNT_KEY_PATH=' "$APP_DIR/.env" | cut -d= -f2- | tr -d '\r"')"
if [ -n "$sa_path" ] && [ ! -f "$sa_path" ]; then
  echo "WARNING: GOOGLE_SERVICE_ACCOUNT_KEY_PATH=$sa_path указан в .env, но файла нет."
  echo "         Sheets API будет падать пока не положишь ключ туда."
fi

step "[5/7] pm2 — restart upseller process"
# Старая инсталляция могла иметь pm2-процесс с cwd=/opt/upseller/server. Теперь cwd=/opt/upseller.
# Удаляем старый, создаём новый — это безопасно, persistent данные в /var/lib/upseller.
if pm2 describe upseller >/dev/null 2>&1; then
  pm2 delete upseller || true
fi
cd "$APP_DIR"
pm2 start "node --env-file=.env server/server.js" --name upseller --cwd "$APP_DIR"
pm2 save
sleep 1
pm2 status

step "[6/7] Configure nginx as reverse proxy"
NGINX_PORT="$(grep -E '^PORT=' "$APP_DIR/.env" | cut -d= -f2 | tr -d '\r' || echo 3000)"
NGINX_PORT="${NGINX_PORT:-3000}"
cat > /etc/nginx/sites-available/upseller <<NGX
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN;
    return 301 https://\$host\$request_uri;
}
server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name $DOMAIN;

    ssl_certificate     /etc/letsencrypt/live/$DOMAIN/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/$DOMAIN/privkey.pem;
    include             /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam         /etc/letsencrypt/ssl-dhparams.pem;

    client_max_body_size 6m;

    location /.well-known/acme-challenge/ { root /var/www/html; }

    location / {
        proxy_pass http://127.0.0.1:${NGINX_PORT};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header X-Forwarded-Host \$host;
        proxy_read_timeout 60s;
    }
}
NGX
ln -sf /etc/nginx/sites-available/upseller /etc/nginx/sites-enabled/upseller
nginx -t && systemctl reload nginx

step "[7/7] smoke check"
sleep 2
echo -n "https://$DOMAIN/ -> "; curl -sk -o /dev/null -w "%{http_code}\n" "https://$DOMAIN/"
echo -n "https://$DOMAIN/api/auth/me -> "; curl -sk -o /dev/null -w "%{http_code}\n" "https://$DOMAIN/api/auth/me"
echo
echo "=== DONE. Open https://$DOMAIN/ ==="
echo
echo "Whitelist persistence: $DATA_DIR/users.json (НЕ трогается setup.sh — redeploy безопасен)."
echo "Если впервые — нужен ADMIN_EMAIL в .env, он будет seed'нут при первом /api/auth/me."
