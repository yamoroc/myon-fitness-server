# myon-fitness-server

The data server for **米亚健身 / Myon Fitness** (iOS). With the one-time purchase or the subscription, the app can keep
your schedules, plans and workout logs on your own server instead of the iPhone: **我的 › 数据存储 › 自己的服务器**
(Me › Data Storage › My Server). Then scripts, or an AI assistant of your own, can plan your training through the API
while the app plays it.

Bun + Hono + SQLite, one process, one data directory. The in-app AI coach is not part of this server; it keeps working
through Myon's own service wherever your data is.

中文说明：https://www.miaclass.cn/fitness/self-host.html

## Run with Docker (HTTPS included)

The app only connects over `https://`. The compose example puts Caddy in front, which gets a certificate for your
domain automatically (ports 80 and 443 must reach the machine).

```bash
git clone https://github.com/yamoroc/myon-fitness-server.git && cd myon-fitness-server
cp docker-compose.example.yml docker-compose.yml
echo "FITNESS_DOMAIN=fit.example.com" > .env
echo "FITNESS_APP_TOKEN=$(openssl rand -hex 24)" >> .env
docker compose up -d
```

In the app: 我的 › 数据存储 › 自己的服务器, address `https://fit.example.com`, token `FITNESS_APP_TOKEN`, then
保存并测试连接 (Save & Test Connection). What was on the phone stays there; switch back to 本机 (On This iPhone) at any
time.

## Run without Docker

Needs [Bun](https://bun.sh) 1.3.9.

```bash
bun install --frozen-lockfile
FITNESS_APP_TOKEN=... FITNESS_DATA_DIR=./data bun src/selfhost.ts   # 127.0.0.1:8720
```

Put an HTTPS reverse proxy in front, e.g. a Caddyfile:

```
fit.example.com {
    reverse_proxy 127.0.0.1:8720
}
```

Tunnels such as Cloudflare Tunnel or Tailscale Funnel work too.

## Settings

| Variable | Default | |
| --- | --- | --- |
| `FITNESS_APP_TOKEN` | required | The app's Bearer token, 16+ characters |
| `FITNESS_COACH_TOKEN` | empty | Optional second token for your own planning scripts or AI agent; its changes are recorded as `coach` |
| `FITNESS_DATA_DIR` | `~/data/fitness` (`/data` in Docker) | `fitness.db`, `media/`, `snapshots/` |
| `HOST` / `PORT` | `127.0.0.1` / `8720` (`0.0.0.0` in Docker) | |

## Data

- A new server starts with an empty exercise library. Connect the app first (**我的 › 数据存储 › 自己的服务器 › 保存并测试连接**): the app automatically syncs its bundled exercise library to your server (images and videos stay inside the app), and registers any built-in plan you schedule on demand. Existing or edited exercises on your server are never overwritten.
- A clean copy of the database is written to `snapshots/` daily from 04:00 (14 kept). Back up the data directory
  yourself.
- Updates: `git pull && docker compose up -d --build`. Database migrations run on start.

## API

`GET /openapi.json` describes every endpoint (`/v1/exercises`, `/v1/plans`, `/v1/sessions`, `/v1/workouts`,
`/v1/changes`, `/v1/media`). Every `/v1/*` call needs `Authorization: Bearer <token>`. The app only deals with explicit
numbers (sets, reps or seconds, tempo, rest); deciding what to train is up to you or your agent.

## Development

```bash
bun test        # API tests
bunx tsc -p .   # typecheck
```

## License

MIT (`LICENSE`).
