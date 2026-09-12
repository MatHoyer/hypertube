# Hypertube

## 📸 Screenshots

<table>
  <tr>
    <td align="center"><strong>🏠 Library</strong></td>
    <td align="center"><strong>🎬 Movie Page</strong></td>
    <td align="center"><strong>📥 Download Manager</strong></td>
  </tr>
  <tr>
    <td><img src="docs/images/library.png" alt="Library" width="100%"></td>
    <td><img src="docs/images/movie-page.png" alt="Movie Page" width="100%"></td>
    <td><img src="docs/images/movie-download-manager.png" alt="Movie Download Manager" width="100%"></td>
  </tr>
</table>

## 📦 Prerequisites

- [Docker](https://www.docker.com/) 🐳
- [pnpm](https://pnpm.io/) 📦

## 🚀 Getting Started

### 1. Configure environment variables

Create the `.env` file from the example:

```bash
cp .env.example .env
```

⚠️ **Don’t forget to fill in the required values in `.env`.**

### 2. Create the Docker network

```bash
docker network create hypertube-network
```

### 3. [OPTIONAL] Start the vpn

```bash
docker compose -f docker-compose-vpn.yml -f docker-compose-vpn.override.yml up -d
```

or

```bash
make vpn
```

### 4. Start the infra

```bash
docker compose up
```

or

```bash
make infra
```

### 5. [OPTIONAL] Start infra helpers

```bash
docker compose -f docker-compose-helpers.yml up
```

or

```bash
make helpers
```

## 📂 Launch Modes

### 🔹 Option 1 — Local (development)

Install dependencies:

```bash
pnpm install
```

Initialize the database:

```bash
pnpm --filter server-core prisma:migrate
```

or

```bash
docker compose -f docker-compose-prod.yml run --rm migrate
```

to run a custom cmd use:

```bash
docker compose -f docker-compose-prod.yml run --rm migrate <custom_cmd>
```

Build packages:

```bash
pnpm build
```

Run all workers in dev mode (hot reload):

```bash
pnpm dev
```

### 🔹 Option 2 — Prod with Docker (no hot reload)

Runs `client` (nginx), `server` and `scheduler` as separate containers — scales each independently.

```bash
docker compose -f docker-compose-prod.yml up
```

or

```bash
make prod
```

### 🔹 Option 3 — Compact with Docker (single app container)

Merges `client` + `server` + `scheduler` into one `app` container (front served by the API process, cron jobs run in-process) and switches the cache to in-memory — Redis is only used for BullMQ in this mode. Good fit for smaller/single-node deployments. Requires the same infra (`make infra`) and VPN sidecars (`make vpn`) as Option 2 — `prowlarr`, `subtitle-proxy` and `downloader` are unchanged.

⚠️ Mutually exclusive with Option 2 — both define the same container names for shared services (`prowlarr`, `subtitle-proxy`, `migrate`), so don't run them at the same time.

```bash
docker compose -f docker-compose-compact.yml up
```

or

```bash
make compact
```

## 🐳 Pre-built images (GHCR)

Production images are published to [GitHub Container Registry](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry) when a version tag is pushed:

```bash
git tag v1.0.0
git push origin v1.0.0
```

Images are tagged with the git tag (e.g. `v1.0.0`):

- `ghcr.io/mathoyer/hypertube-server:<tag>`
- `ghcr.io/mathoyer/hypertube-app:<tag>` (compact mode — front + API + scheduler in one image)
- `ghcr.io/mathoyer/hypertube-downloader:<tag>`
- `ghcr.io/mathoyer/hypertube-scheduler:<tag>`
- `ghcr.io/mathoyer/hypertube-subtitle-proxy:<tag>`
- `ghcr.io/mathoyer/hypertube-migrate:<tag>`

Example:

```bash
docker pull ghcr.io/mathoyer/hypertube-server:v1.0.0
```

After the first publish, set each package to **Public** under GitHub → **Packages** → package → **Package settings** → **Change visibility**, so images can be pulled without authentication.

## 📜 Dependency Installation Rules

The project is split into **7 workspaces**:

- **client** (`apps/client`)
- **libs** (`packages/libs`)
- **server** (`apps/server`)
- **server-core** (`packages/server-core`)
- **downloader** (`apps/downloader`)
- **scheduler** (`apps/scheduler`)
- **subtitle-proxy** (`apps/subtitle-proxy`)

### Install a dependency shared across multiple workspaces:

```bash
pnpm add <package-name> -w
```

### Install a dependency only for a specific workspace:

```bash
cd apps/{workspace}
pnpm add <package-name>
```

## ℹ️ Workspace Info

### 🖥️ Client (`apps/client`)

- Developed with **Vite**
- Runs in dev on: [http://localhost:3001](http://localhost:3001)
- In prod (Option 2): served by its own nginx container
- In compact mode (Option 3): built into and served by the `server`/`app` image (`SERVE_FRONT=true`)

---

### 📚 Libs (`packages/libs`)

- Functions exported in `index.ts` can be used in other workspaces

---

### ⚙️ Server (`apps/server`)

- **Hono** server
- Runs in dev on: [http://localhost:3000](http://localhost:3000)
- Env toggles used in compact mode: `SERVE_FRONT` (serve the built client), `RUN_SCHEDULER` (run cron jobs in-process), `CACHE_DRIVER` (`redis` or `memory`, default `redis`)

---

### 📚 Server core (`packages/server-core`)

- Functions exported in `index.ts` can be used in other server side workspaces

---

### ⚙️ Downloader (`apps/downloader`)

- Worker that listen bullMQ to start and monitor movie downloads

---

### ⚙️ Scheduler (`apps/scheduler`)

- Worker to run cron jobs
- In compact mode this container is dropped — the same jobs (shared via `packages/server-core`) run inside the `server`/`app` process instead (`RUN_SCHEDULER=true`)

### ⚙️ Prowlarr (torrent provider)

- [Prowlarr](https://github.com/Prowlarr/Prowlarr) runs in the VPN network namespace and aggregates public torrent indexers (YTS, 1337x, TPB, etc.)
- **No UI setup required** — use the init scripts for config + indexers
- Prod Docker runs `prowlarr-init`, `prowlarr-indexers-init`, then the app automatically
- The server queries Prowlarr's search API directly (`PROWLARR_URL`) for movie torrent resolutions

**Headless setup:**

```bash
# 1. Optionally set PROWLARR_API_KEY in .env (or leave empty to auto-generate on first init)
# 2. Optionally set PROWLARR_INDEXERS (default: 10 public indexers — yts, thepiratebay, limetorrents, …)
#    Re-run ./scripts/prowlarr-init.sh indexers after changing this list
#    (torrentgalaxy is an alias for torrentgalaxyclone; 1337x needs FlareSolverr)

# Local scripts (stop Prowlarr first if already running)
./scripts/prowlarr-init.sh config
./scripts/prowlarr-init.sh indexers

# Docker prod — indexers init runs automatically before the app starts
docker compose -f docker-compose-prod.yml up -d
```

If `PROWLARR_API_KEY` is auto-generated, it is saved to the Prowlarr config volume (`api_key`). In prod the app reads it via `PROWLARR_API_KEY_FILE`. For local dev, copy the printed key into `.env` or point `PROWLARR_API_KEY_FILE` at your config `api_key` file.

### ⚙️ Subtitle proxy (`apps/subtitle-proxy`)

- Scrapes yifysubtitles.ch over VPN (Puppeteer) for external subtitle tracks

## 📦 Package Import Rules

Understanding how packages can import each other is key to maintaining a clean and scalable monorepo structure:

- **libs**
  - Can be imported in **any package** (client, server, server-core, downloader, scheduler).
- **server-core**
  - Can be imported in any **server-side package** (**server**, **downloader**, **scheduler**).
  - **Cannot** be imported in **libs** or **client**.

| Importing Package | Can import libs | Can import server-core |
| ----------------- | :-------------: | :--------------------: |
| libs              |        —        |           ❌           |
| server-core       |       ✅        |           —            |
| server            |       ✅        |           ✅           |
| downloader        |       ✅        |           ✅           |
| scheduler         |       ✅        |           ✅           |
| subtitle-proxy    |       ✅        |           ✅           |
| client            |       ✅        |           ❌           |

_Note: This ensures shared logic and types flow in one direction (from base to specialized packages), and frontend code never accidentally pulls in backend/server-only code._
