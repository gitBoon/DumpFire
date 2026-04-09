# 🔥 DumpFire

A fast, self-hosted Kanban board built for teams on a local network. No cloud dependency, no recurring costs — just a single SQLite database file behind a clean drag-and-drop interface.

Built with SvelteKit 5 (Runes), Drizzle ORM, and better-sqlite3.

---

## Features

### Boards & Cards
- Drag-and-drop columns and cards with positional persistence
- Nested sub-boards — attach child boards to any card for hierarchical project breakdowns
- Card priorities (critical, high, medium, low) with colour-coded indicators
- Due dates, colour tags, and business value fields
- Subtasks with independent priority, description, and due date tracking
- Card pinning to keep important items visible at the top
- Markdown rendering in card descriptions
- Card duplication and right-click context menus
- Labels and categories with configurable colours per board

### Multi-User & Access Control
- User registration with bcrypt-hashed passwords and session-based auth (30-day sliding window)
- Three user roles: **Superadmin**, **Admin**, and **User**
- Team management — group users into teams and assign boards to entire teams at once
- Per-board access control with **Owner**, **Editor**, and **Viewer** roles
- Public board visibility toggle for read-only access to any authenticated user
- Email-based invite system with secure, time-limited invite tokens
- Emoji avatars for users and teams

### Task Request Inbox
- External or internal users can submit task requests to a user or team
- Requests include title, description, priority, and business justification
- Built-in conversation thread — back-and-forth messaging between requester and reviewer
- Accept requests to create a card directly, or reject with a reason
- Email notifications for new requests, status changes, and conversation replies

### Real-Time Sync
- Server-Sent Events (SSE) push updates to every connected browser instantly
- No polling — board changes, card moves, and completions reflect immediately
- Fireworks animation plays across all connected screens when a task is completed

### Email Notifications (Optional)
- SMTP configuration managed entirely through the admin panel — no environment variables required
- Notifications for card creation, card moves, user assignment, comments, and board sharing
- Fully styled HTML email templates
- Silently disabled when SMTP is not configured — zero impact on operation

### Scheduled Backups
- Automated backups on a configurable schedule (hourly, every 6h, every 12h, daily, weekly)
- Four destination providers out of the box:
  - **SFTP/SCP** — any SSH-accessible server
  - **Amazon S3** (and S3-compatible: MinIO, Backblaze B2, DigitalOcean Spaces)
  - **Google Drive** — service account or OAuth
  - **OneDrive** — via Microsoft Graph API
- Configurable retention policies with automatic cleanup of old backups
- Backup history log with success/failure tracking
- Email alerts on backup failure (when SMTP is configured)
- Manual backup trigger and connection testing from the admin panel

### All Tasks View
- Consolidated view of every card across all boards in one place
- Filter and manage tasks without switching between boards

### Themes
- 17 built-in themes: Light, Dark, Solarized, Coffee, Rosé, Cappuccino, Midnight, Ocean, Forest, Lavender, Sunset, Nord, Dracula, Monokai, Cherry, Arctic, Hacker
- Live preview on hover before committing
- Stored per-browser in localStorage

### Admin Panel
- Database statistics and health overview
- Board-level cleanup tools
- Database export and import with full WAL checkpoint support
- VACUUM operation for database compaction
- SMTP configuration and test email
- Backup schedule and destination management
- User and team administration

---

## Deployment

### Option 1 — Run directly with Node

```bash
git clone https://github.com/gitBoon/DumpFire.git
cd DumpFire
npm install
npm run build
ORIGIN=http://localhost:3000 node build
```

> On Windows: `set ORIGIN=http://localhost:3000 && node build`

Set `ORIGIN` to the address users will access — e.g. `http://192.168.1.50:3000` or `https://kanban.yourdomain.com`. Other machines on your network can connect using that same address.

---

### Option 2 — Docker

#### Docker Compose (recommended)

```bash
git clone https://github.com/gitBoon/DumpFire.git
cd DumpFire
```

Create a `docker-compose.yml` in the project directory:

```yaml
services:
  dumpfire:
    build: .
    container_name: dumpfire
    ports:
      - "3000:3000"
    environment:
      - DB_PATH=/app/data/dumpfire.db
      - ORIGIN=http://localhost:3000   # ⚠️ CHANGE THIS — see note below
    volumes:
      - dumpfire-data:/app/data
    restart: unless-stopped

volumes:
  dumpfire-data:
```

> **⚠️ You MUST set `ORIGIN` to the URL users will use to access DumpFire.** If you leave it as `http://localhost:3000` on a server, all form submissions (including initial setup) will silently fail with a 403 error. Set it to your actual URL, e.g. `http://192.168.1.50:3000` or `https://kanban.yourdomain.com`.

Then run:

```bash
docker compose up -d
```

Open [localhost:3000](http://localhost:3000).

#### Docker Run (manual)

```bash
git clone https://github.com/gitBoon/DumpFire.git
cd DumpFire

docker build -t dumpfire .

docker run -d \
  --name dumpfire \
  -p 3000:3000 \
  -e DB_PATH=/app/data/dumpfire.db \
  -e ORIGIN=http://localhost:3000 \
  -v dumpfire-data:/app/data \
  --restart unless-stopped \
  dumpfire
```

> **⚠️ Remember to replace `ORIGIN`** with your actual access URL. See [Environment Variables](#environment-variables) below.

#### Environment Variables

| Variable | Purpose | Default |
|----------|---------|---------|
| `DB_PATH` | Path to the SQLite database file inside the container | `/app/data/dumpfire.db` |
| **`ORIGIN`** | **Public URL for CSRF protection — must exactly match how users access the app (including protocol and port).** If this is wrong, all form submissions will fail with 403. | `http://localhost:3000` |
| `PORT` | Port the server listens on | `3000` |
| `COOKIE_SECURE` | Set to `false` to allow session cookies over plain HTTP (see [HTTPS & Reverse Proxies](#https--reverse-proxies)) | `true` in production |

---

### HTTPS & Reverse Proxies

In production the session cookie is set with the `secure` flag, which means browsers will only send it over HTTPS connections. If you put DumpFire behind a reverse proxy that terminates SSL — **which is the recommended approach** — everything works automatically as long as `ORIGIN` is set to your `https://` URL.

DumpFire's Dockerfile already includes `PROTOCOL_HEADER=X-Forwarded-Proto` and `HOST_HEADER=X-Forwarded-Host` so that SvelteKit trusts the forwarded headers from your proxy.

#### Cloudflare Tunnels (easiest)

Cloudflare Tunnels handle HTTPS, DNS, and DDoS protection with zero server configuration. No ports to open, no certificates to manage.

1. Install `cloudflared` on your server
2. Create a tunnel pointed at `http://localhost:3000`
3. Set `ORIGIN=https://kanban.yourdomain.com` in your container

That's it — Cloudflare handles the TLS certificate automatically.

```bash
cloudflared tunnel --url http://localhost:3000
```

#### Caddy (automatic HTTPS)

Caddy obtains and renews Let's Encrypt certificates automatically. A single-line `Caddyfile` is all you need:

```caddyfile
kanban.yourdomain.com {
    reverse_proxy dumpfire:3000
}
```

Add Caddy as a service in your `docker-compose.yml`:

```yaml
services:
  dumpfire:
    build: .
    environment:
      - ORIGIN=https://kanban.yourdomain.com
    volumes:
      - dumpfire-data:/app/data
    expose:
      - "3000"
    restart: unless-stopped

  caddy:
    image: caddy:alpine
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile
      - caddy-data:/data
    depends_on:
      - dumpfire
    restart: unless-stopped

volumes:
  dumpfire-data:
  caddy-data:
```

#### Nginx + Let's Encrypt

A more traditional setup with full control over TLS configuration.

Example `nginx.conf`:

```nginx
server {
    listen 80;
    server_name kanban.yourdomain.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name kanban.yourdomain.com;

    ssl_certificate     /etc/letsencrypt/live/kanban.yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/kanban.yourdomain.com/privkey.pem;

    location / {
        proxy_pass http://dumpfire:3000;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host  $host;
    }
}
```

Use Certbot to obtain the initial certificate:

```bash
certbot certonly --standalone -d kanban.yourdomain.com
```

#### Running without HTTPS

If you're running on a **trusted local network** and don't need HTTPS (e.g. home lab, LAN-only access), set `COOKIE_SECURE=false` so the session cookie works over plain HTTP:

```yaml
# docker-compose.yml
environment:
  - ORIGIN=http://192.168.1.50:3000
  - COOKIE_SECURE=false
```

Or with `docker run`:

```bash
docker run -e ORIGIN=http://192.168.1.50:3000 -e COOKIE_SECURE=false ...
```

> **⚠️ Warning:** With `COOKIE_SECURE=false`, session cookies are sent in the clear. Only use this on networks you trust.

## Updating to a New Version

Your data lives in a Docker volume (`dumpfire-data`) that is independent of the container image. Updating is a matter of rebuilding the image and replacing the container — the volume stays untouched.

Database migrations run automatically on every startup. Only new migrations are applied; existing data is preserved.

### With Docker Compose

```bash
cd DumpFire
git pull
docker compose down --remove-orphans
docker compose build
docker compose up -d
```

> **Why `--remove-orphans`?** If you've ever changed your `docker-compose.yml` (e.g. added or removed a reverse proxy service), Docker may leave old containers behind that it no longer recognises. The `--remove-orphans` flag cleans those up, preventing "container name already in use" errors on the next `up`.

That's it. The new container starts, detects any pending migrations, applies them against your existing database, and serves the updated app. Named volumes (`dumpfire-data`) are **never** removed by `docker compose down` — your data is always preserved.

### With Docker Run

```bash
cd DumpFire
git pull

# Rebuild the image
docker build -t dumpfire .

# Stop and remove the old container (the volume is NOT removed)
docker stop dumpfire && docker rm dumpfire

# Start a new container with the same volume
docker run -d \
  --name dumpfire \
  -p 3000:3000 \
  -e DB_PATH=/app/data/dumpfire.db \
  -e ORIGIN=http://localhost:3000 \
  -v dumpfire-data:/app/data \
  --restart unless-stopped \
  dumpfire
```

> **Why does this preserve my data?**
> The `-v dumpfire-data:/app/data` flag mounts a named Docker volume. Removing the container with `docker rm` does **not** remove its volumes. As long as you re-use the same volume name when starting the new container, your database file carries over exactly as it was.

> **What about migrations?**
> Migrations are tracked in a `__drizzle_migrations` table inside your database. On startup, the app reads every `.sql` file in the `drizzle/` directory, checks which ones have already been applied, and runs only the new ones. Statements that would conflict (e.g. adding a column that already exists) are caught and skipped gracefully, so re-running a migration is always safe.

---

## Project Structure

```
src/
├── lib/
│   ├── components/
│   │   ├── board/                  # Board-specific UI components
│   │   ├── CardModal.svelte        # Card editor with subtasks, labels, comments
│   │   ├── SubtaskModal.svelte     # Subtask create/edit
│   │   ├── ConfirmModal.svelte     # Reusable confirmation dialog
│   │   ├── ShareModal.svelte       # Board sharing and permissions
│   │   ├── CategoryManager.svelte  # Board category CRUD
│   │   ├── ThemePicker.svelte      # Theme selection dropdown
│   │   ├── EmojiPicker.svelte      # Emoji avatar picker
│   │   ├── Toast.svelte            # Toast notifications
│   │   └── UserSetup.svelte        # First-run user creation
│   ├── server/
│   │   ├── db/
│   │   │   ├── schema.ts           # Drizzle schema (all tables)
│   │   │   ├── index.ts            # DB connection and WAL setup
│   │   │   └── migrate.ts          # Auto-migration runner
│   │   ├── auth.ts                 # Session and password management
│   │   ├── board-access.ts         # Role-based board access control
│   │   ├── backup.ts               # Scheduled backup orchestrator
│   │   ├── backup-destinations.ts  # SFTP, S3, Google Drive, OneDrive providers
│   │   ├── email.ts                # SMTP transport and configuration
│   │   ├── notifications.ts        # Email notification templates
│   │   └── events.ts               # SSE event bus
│   └── stores/
│       └── theme.ts                # Theme state (17 themes)
├── routes/
│   ├── +page.svelte                # Dashboard
│   ├── board/[id]/+page.svelte     # Kanban board view
│   ├── all/+page.svelte            # All Tasks view
│   ├── inbox/+page.svelte          # Task request inbox
│   ├── request/+page.svelte        # Submit a task request
│   ├── admin/+page.svelte          # Admin panel
│   ├── login/                      # Login page
│   ├── setup/                      # First-run setup
│   ├── invite/                     # Invite token acceptance
│   ├── account/                    # User account settings
│   ├── teams/                      # Team management
│   └── api/                        # REST endpoints
│       ├── boards/
│       ├── columns/
│       ├── cards/
│       ├── categories/
│       ├── subtasks/
│       ├── labels/
│       ├── requests/
│       ├── teams/
│       ├── users/
│       ├── admin/
│       ├── account/
│       ├── activity/
│       └── xp/
└── app.css                         # Global styles and theme definitions
```

## Tech Stack

| | |
|---|---|
| **Frontend** | SvelteKit 5 with Runes |
| **Database** | SQLite via better-sqlite3 |
| **ORM** | Drizzle |
| **Realtime** | Server-Sent Events |
| **Auth** | bcryptjs + session cookies |
| **Email** | Nodemailer (SMTP) |
| **Drag & drop** | svelte-dnd-action |
| **Backups** | SFTP · S3 · Google Drive · OneDrive |

## License

MIT
