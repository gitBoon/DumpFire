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

Create a `docker-compose.yml`:

```yaml
services:
  dumpfire:
    build: .
    container_name: dumpfire
    ports:
      - "3000:3000"
    environment:
      - DB_PATH=/app/data/dumpfire.db
      - ORIGIN=http://localhost:3000
    volumes:
      - dumpfire-data:/app/data
    restart: unless-stopped

volumes:
  dumpfire-data:
```

> **Deploying on a server?** Change `ORIGIN` to the URL users will access, e.g. `http://192.168.1.50:3000` or `https://kanban.yourdomain.com`.

Then run:

```bash
git clone https://github.com/gitBoon/DumpFire.git
cd DumpFire
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

#### Environment Variables

| Variable | Purpose | Default |
|----------|---------|---------|
| `DB_PATH` | Path to the SQLite database file inside the container | `/app/data/dumpfire.db` |
| `ORIGIN` | Public URL for CSRF protection (must match how users access the app) | `http://localhost:3000` |
| `PORT` | Port the server listens on | `3000` |

---

## Updating to a New Version

Your data lives in a Docker volume (`dumpfire-data`) that is independent of the container image. Updating is a matter of rebuilding the image and replacing the container — the volume stays untouched.

Database migrations run automatically on every startup. Only new migrations are applied; existing data is preserved.

### With Docker Compose

```bash
cd DumpFire
git pull
docker compose down
docker compose build
docker compose up -d
```

That's it. The new container starts, detects any pending migrations, applies them against your existing database, and serves the updated app.

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
