# Deployment

One VPS runs the bot with Docker Compose:

| Service                 | Image                           | Role                                                                                           |
| ----------------------- | ------------------------------- | ---------------------------------------------------------------------------------------------- |
| `bot`                   | `ghcr.io/<owner>/eth-watch-bot` | The bot and its HTTP API, plain HTTP inside the network, runs as `node`                        |
| `caddy`                 | `caddy:2.11.7-alpine`           | Optional (`COMPOSE_PROFILES=web`): TLS for `DOMAIN`, proxies `/telegram/*`, `/v1/*`, `/health` |
| `mongo`, `mongo-backup` | `mongo:8.0`                     | Optional (`COMPOSE_PROFILES=mongo`): local MongoDB with daily gzip dumps to `./backups`        |

A polling bot needs neither Caddy nor an open port. Add the `web` profile for webhook mode or to publish `GET /v1/messages`.

After CI passes on `main`, the deploy workflow builds the image, tags it with the commit SHA and `latest`, and pushes it to GHCR. When the server is configured, the workflow uploads `compose.yml` and `Caddyfile`, pulls the new image, restarts the stack and waits for the health check. Until then the deploy job is skipped, so pushes stay green.

## First deployment

### 1. Server

A Linux VPS with 1 vCPU and 1 GB RAM is enough (2 GB with local MongoDB), and Docker Engine with the compose plugin.

```bash
sudo usermod -aG docker <deploy-user>
sudo mkdir -p /opt/eth-watch-bot && sudo chown <deploy-user> /opt/eth-watch-bot
# only with the web profile:
sudo ufw allow 80,443/tcp
```

Create `/opt/eth-watch-bot/.env` from [`.env.example`](.env.example): at least one `RPC_URL_*`, `BOT_TOKEN` and `MONGO_URI`. For the `web` profile add `DOMAIN` (an A record pointing to the server) and `TRUST_PROXY=1`; for webhook mode `BOT_MODE=webhook`, `BOT_WEBHOOK_URL=https://<DOMAIN>` and `BOT_WEBHOOK_SECRET` (`openssl rand -hex 32`).

Make sure the old bots are stopped: two processes polling one token steal each other's updates.

A deploy key, created on your machine:

```bash
ssh-keygen -t ed25519 -f ~/.ssh/eth-watch-bot-deploy -C eth-watch-bot-deploy
ssh-copy-id -i ~/.ssh/eth-watch-bot-deploy.pub <deploy-user>@<vps>
```

### 2. GitHub

Settings → Environments → **production**:

| Type     | Name          | Value                                                    |
| -------- | ------------- | -------------------------------------------------------- |
| secret   | `VPS_HOST`    | Server IP or host name                                   |
| secret   | `VPS_USER`    | `<deploy-user>`                                          |
| secret   | `VPS_SSH_KEY` | Private key `~/.ssh/eth-watch-bot-deploy`                |
| secret   | `VPS_PORT`    | Only if SSH is not on port 22                            |
| variable | `DEPLOY_PATH` | `/opt/eth-watch-bot` (setting it enables the deploy job) |

The server logs in to GHCR with the workflow's short-lived token; nothing else to register.

### 3. Run and check

```bash
gh workflow run deploy.yml --ref main
gh run watch
```

- The run reaches "bot is healthy".
- `docker compose logs bot` shows "scanner starts at the current block" for each chain, then "telegram polling started" (or "telegram webhook set").
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

**Restore a backup** (local MongoDB profile):

```bash
$compose exec -T mongo mongorestore --gzip --archive --drop < backups/eth-watch-<timestamp>.archive.gz
```

**Rescan from a block:** stop the bot, set the checkpoint, start it again. Notifications for those blocks are sent again; messages are not, they are stored once.

```bash
$compose stop bot
$compose exec mongo mongosh eth-watch --eval 'db.checkpoints.updateOne({chain: "ethereum"}, {$set: {block: 21000000}})'
$compose start bot
```
