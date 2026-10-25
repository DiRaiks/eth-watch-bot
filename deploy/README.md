# Deployment

One VPS runs the bot with Docker Compose:

| Service                       | Image                           | Role                                                                                           |
| ----------------------------- | ------------------------------- | ---------------------------------------------------------------------------------------------- |
| `bot`                         | `ghcr.io/<owner>/eth-watch-bot` | The bot and its HTTP API, plain HTTP inside the network, runs as `node`                        |
| `caddy`                       | `caddy:2.11.7-alpine`           | Optional (`COMPOSE_PROFILES=web`): TLS for `DOMAIN`, proxies `/telegram/*`, `/v1/*`, `/health` |
| `postgres`, `postgres-backup` | `postgres:18.6-alpine`          | Optional (`COMPOSE_PROFILES=postgres`): local Postgres with daily `pg_dump` to `./backups`     |

A polling bot needs neither Caddy nor an open port. Add the `web` profile for webhook mode or to publish `GET /v1/messages`.

After CI passes on `main`, the deploy workflow builds the image, tags it with the commit SHA and `latest`, and pushes it to GHCR. When the server is configured, the workflow uploads `compose.yml` and `Caddyfile`, pulls the new image, restarts the stack and waits for the health check. A failed CI run deploys nothing, and the deploy builds the exact commit CI tested. Until the server is configured the deploy job is skipped, so pushes stay green.

## First deployment

### 1. Server

A Linux VPS with 1 vCPU and 1 GB RAM is enough, also with the local Postgres, and Docker Engine with the compose plugin. Postgres runs on any x86-64 CPU; MongoDB 5+ needed AVX, which many VPS CPUs do not expose.

```bash
sudo usermod -aG docker <deploy-user>
sudo mkdir -p /opt/eth-watch-bot && sudo chown <deploy-user> /opt/eth-watch-bot
# only with the web profile:
sudo ufw allow 80,443/tcp
```

Create `/opt/eth-watch-bot/.env` from [`.env.example`](.env.example): at least one `RPC_URL_*`, `BOT_TOKEN` and `DATABASE_URL`. `PORT` is ignored there: compose runs the bot on 3000. For the local database set `COMPOSE_PROFILES=postgres`, `POSTGRES_PASSWORD` (`openssl rand -hex 24`) and `DATABASE_URL=postgres://eth_watch:<POSTGRES_PASSWORD>@postgres:5432/eth_watch`; the bot creates its tables on start. For the `web` profile add `DOMAIN` (an A record pointing to the server) and `TRUST_PROXY=1`; for webhook mode `BOT_MODE=webhook`, `BOT_WEBHOOK_URL=https://<DOMAIN>` and `BOT_WEBHOOK_SECRET` (`openssl rand -hex 32`).

Make sure the old bots are stopped: two processes polling one token steal each other's updates.

A deploy key, created on your machine:

```bash
ssh-keygen -t ed25519 -f ~/.ssh/eth-watch-bot-deploy -C eth-watch-bot-deploy
ssh-copy-id -i ~/.ssh/eth-watch-bot-deploy.pub <deploy-user>@<vps>
```

### 2. GitHub

Settings → Environments → **production**, the secrets:

| Name          | Value                                     |
| ------------- | ----------------------------------------- |
| `VPS_HOST`    | Server IP or host name                    |
| `VPS_USER`    | `<deploy-user>`                           |
| `VPS_SSH_KEY` | Private key `~/.ssh/eth-watch-bot-deploy` |
| `VPS_PORT`    | Only if SSH is not on port 22             |

Settings → Secrets and variables → Actions → **Variables**, a repository variable: `DEPLOY_PATH` = `/opt/eth-watch-bot`. Setting it enables the deploy job. It must be a repository variable, not one of the `production` environment: the job's `if` is evaluated before the environment is attached, so an environment variable leaves the job skipped forever.

The server logs in to GHCR with the workflow's short-lived token; nothing else to register.

### 3. Run and check

```bash
gh workflow run deploy.yml --ref main
gh run watch
```

- The run reaches "bot is healthy". Docker's "healthy" only means the process is up: `/health` always answers 200 so an RPC outage does not restart the container, and `status` in its body (`ok` or `degraded`) tells whether the chains and Telegram are fine.
- `docker compose logs bot` shows "scanner starts at the current block" for each chain, then "telegram polling started" (or "telegram webhook set").
- `$compose exec bot wget -qO- http://127.0.0.1:3000/metrics | grep eth_watch_lag_blocks` shows a small lag per chain. To collect metrics, run Prometheus in the same Docker network; `/metrics` is not public.
- `/status` in a chat lists every chain in green.
- With the web profile: `https://<DOMAIN>/health` returns `"status": "ok"`, and `https://<DOMAIN>/` returns 404.

## Operations

```bash
cd /opt/eth-watch-bot
compose="docker compose --env-file .env --env-file images.env"
$compose ps
$compose logs -f bot
```

**Rollback:** set `IMAGE_TAG=<sha of an earlier commit>` in `images.env`, then `$compose up -d`.

**Restore a backup** (local Postgres profile):

```bash
$compose stop bot
$compose exec -T postgres pg_restore -U eth_watch -d eth_watch --clean --if-exists < backups/eth-watch-<timestamp>.dump
$compose start bot
```

**Rescan from a block:** stop the bot, set the checkpoint, start it again. Notifications for those blocks are sent again; messages are not, they are stored once.

```bash
$compose stop bot
$compose exec postgres psql -U eth_watch -d eth_watch -c "UPDATE checkpoints SET block = 21000000 WHERE chain = 'ethereum'"
$compose start bot
```
