# ClipSeller standalone

Aplicação **independente** do ClipSeller (estúdio de imagem/vídeo com IA) rodando em VPS própria, publicada em **https://clipseller.com.br**.

- Express (Node 20) + PostgreSQL local
- Autenticação própria (e-mail + senha, esqueci minha senha) com JWT
- E-mails transacionais via **AWS SES**
- Engine de IA com proxy server-side (`/cs-proxy/*`) — chaves ficam só no servidor
- Admin padrão criado/atualizado a cada boot via `ADMIN_EMAIL` / `ADMIN_PASSWORD`

## Estrutura

```
clipseller-standalone/
├── server.js                  # entrypoint Express
├── src/
│   ├── auth/                  # JWT, login, forgot, set-password
│   ├── users/                 # CRUD interno + service
│   ├── mail/                  # AWS SES (welcome, reset)
│   ├── proxy/                 # /cs-proxy/<provider> → API externa
│   ├── clipseller/            # serve /clipseller-html com patches inline
│   └── db/                    # pool + migrate + seedAdmin
├── public/
│   ├── index.html             # SPA (login, forgot, app shell com iframe)
│   ├── set-password.html
│   ├── assets/{app.css,app.js}
│   ├── img/IMG_*.PNG          # logo/branding (de ProjetosExemplo/ClipSellerImg)
│   └── clipseller-html/index.html  # canvas v31 (motor real)
├── migrations/001_init.sql
└── deploy/
    ├── clipseller.service     # systemd unit
    ├── nginx.conf             # site clipseller.com.br
    ├── bootstrap.sh           # provisiona tudo no VPS
    └── update.sh              # git pull + restart no VPS
```

## Endpoints

| Método | Path | Descrição |
|---|---|---|
| `POST` | `/api/auth/login` | E-mail+senha → JWT |
| `POST` | `/api/auth/forgot-password` | Envia link via SES |
| `POST` | `/api/auth/set-password` | Define senha pelo token do e-mail |
| `POST` | `/api/auth/change-password` | Troca de senha autenticada |
| `GET` | `/api/auth/me` | Dados do usuário logado |
| `GET` | `/api/admin/users` | Lista de usuários (admin) |
| `POST` | `/api/admin/users` | Cria usuário (admin), envia welcome opcional |
| `PATCH` | `/api/admin/users/:id/access` | Liga/desliga acesso ao ClipSeller |
| `PATCH` | `/api/admin/users/:id/active` | Ativa/desativa conta |
| `GET` | `/clipseller-html` | HTML do editor (requer login + acesso) |
| `ALL` | `/cs-proxy/<provider>/*` | Proxy server-side para APIs de IA |
| `GET` | `/health` | Healthcheck |

## Setup local (dev)

```bash
cp .env.example .env
# edite DB_*, JWT_SECRET, AWS_*, ADMIN_*
npm install
npm run migrate
npm run seed-admin
npm start            # http://localhost:4000
```

## Deploy no VPS

A primeira instalação roda o **bootstrap**, que instala dependências (Node 20, Postgres 16, nginx, certbot), cria o usuário `clipseller`, banco, .env aleatório, systemd e nginx.

```bash
# Como root no VPS
cd /opt
git clone git@github.com:gnoronha42/clipSeller-repo.git clipseller-standalone
bash /opt/clipseller-standalone/deploy/bootstrap.sh
# Preencha as chaves AWS/IA e ADMIN_PASSWORD em /opt/clipseller-standalone/.env
systemctl restart clipseller
```

Atualizações futuras:

```bash
bash /opt/clipseller-standalone/deploy/update.sh
```

## DNS (clipseller.com.br)

No painel DNS do domínio, aponte os registros `A` de `@` e `www` para o IP da VPS (TTL baixo, ex.: 300). Remova registros antigos que apontem para outro host.

Após propagar (`dig +short clipseller.com.br` deve devolver o IP da VPS), emita o SSL:

```bash
certbot --nginx -d clipseller.com.br -d www.clipseller.com.br \
  --email SEU_EMAIL --agree-tos --redirect -n
```

## AWS SES

Configure `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` e `MAIL_FROM` no `.env`. O domínio do remetente precisa estar verificado no SES (com DKIM nos DNS, se ainda não estiver).

Se quiser usar `no-reply@clipseller.com.br` como remetente:
1. Adicione o domínio `clipseller.com.br` no SES (Identities → Create identity → Domain).
2. Cadastre os CNAMEs DKIM gerados pelo SES nos DNS do domínio.
3. Saia do sandbox SES (se ainda estiver).
4. Atualize `MAIL_FROM=no-reply@clipseller.com.br` no `.env` e reinicie.

## Fluxo de criação de usuário

O cadastro pode ser feito **manualmente pelo admin**:

```bash
# Logado como admin
curl -X POST https://clipseller.com.br/api/admin/users \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"email":"cliente@dominio.com","name":"Cliente","sendWelcome":true,"hasAccess":true}'
```

O comprador recebe um e-mail (`Bem-vindo ao ClipSeller!`) com o link de definição de senha (`/set-password.html?email=...&token=...`). Webhooks de pagamento (ex.: Hotmart) podem chamar a mesma função `createUser` + `sendWelcomeEmail`.

## Variáveis principais (`.env`)

- `PUBLIC_URL` — usada nos links dos e-mails (`https://clipseller.com.br`)
- `JWT_SECRET` — string longa e aleatória
- `AWS_REGION` / `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` — credenciais SES
- `MAIL_FROM`, `MAIL_FROM_NAME`, `SES_CONFIGURATION_SET` (opcional)
- `ADMIN_EMAIL` / `ADMIN_PASSWORD` — admin recriado/atualizado a cada boot (troque a senha no primeiro login)
- Chaves de provedores de IA — configuradas no `.env` e injetadas só pelo `/cs-proxy/*` (nunca expostas no navegador). Veja `.env.example`.

## Operação no VPS

```bash
# logs em tempo real
journalctl -u clipseller -f

# reiniciar
systemctl restart clipseller

# nginx
nginx -t && systemctl reload nginx
```
