# 🔥 DumpFire

A stupidly fast Kanban board that runs on your local network. No cloud, no accounts, no subscriptions — just drag, drop, and get stuff done.

Built with SvelteKit and SQLite. The whole thing fits in a single database file.

---

## What you get

- **Kanban boards** with draggable columns and cards
- **Live sync** across every browser on your network (SSE, not polling)
- **Subtasks** with their own priorities, descriptions, and due dates
- **Fireworks** when you complete a task (yes, on every connected screen)
- **Categories & labels** with colour pickers
- **Dark mode** that respects your system preference
- **Admin panel** for database management and cleanup
- **Card pinning** to keep important items at the top
- **Markdown support** in card descriptions
- **Context menus** and card duplication

---

## Getting started

### Option 1: Run locally

```bash
git clone https://github.com/gitBoon/DumpFire.git
cd dumpfire
npm install
npm run dev
```

That's it. Open [localhost:5173](http://localhost:5173) and start dumping tasks.

Other machines on your network can connect using the LAN IP shown in the terminal output.

---

### Option 2: Docker

If you'd rather not install Node on the host machine, or you want to deploy this somewhere more permanent:

**Build and run:**

```bash
git clone https://github.com/gitBoon/DumpFire.git
cd dumpfire

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

Then open [localhost:3000](http://localhost:3000).

**Breaking that down:**

| Flag | What it does |
|------|-------------|
| `-p 3000:3000` | Maps port 3000 on your machine to the container |
| `-e DB_PATH=...` | Tells the app where to put the SQLite database |
| `-e ORIGIN=...` | Required by SvelteKit for CSRF protection — set this to the URL you'll access the app from |
| `-v dumpfire-data:/app/data` | Persists your data in a Docker volume so it survives container rebuilds |
| `--restart unless-stopped` | Auto-starts the container after reboots |

> **Deploying on a server?** Change `ORIGIN` to match whatever URL or IP users will hit, e.g. `http://192.168.1.50:3000` or `https://kanban.yourdomain.com`.

**Updating to a new version:**

```bash
git pull
docker build -t dumpfire .
docker stop dumpfire && docker rm dumpfire

# Same run command as above
docker run -d \
  --name dumpfire \
  -p 3000:3000 \
  -e DB_PATH=/app/data/dumpfire.db \
  -e ORIGIN=http://localhost:3000 \
  -v dumpfire-data:/app/data \
  --restart unless-stopped \
  dumpfire
```

Migrations run automatically on startup. Only new migrations are applied — your data stays intact.

---

## Project structure

```
src/
├── lib/
│   ├── components/
│   │   ├── CardModal.svelte        # Card editor with subtask management
│   │   ├── SubtaskModal.svelte     # Subtask create/edit modal
│   │   └── ConfirmModal.svelte     # Reusable confirmation dialog
│   ├── server/
│   │   ├── db/
│   │   │   ├── schema.ts           # Drizzle schema definitions
│   │   │   ├── index.ts            # DB connection setup
│   │   │   └── migrate.ts          # Auto-migration on startup
│   │   └── events.ts               # SSE event bus
│   └── stores/
│       └── theme.ts                # Dark/light mode
├── routes/
│   ├── +page.svelte                # Dashboard
│   ├── board/[id]/+page.svelte     # Kanban board view
│   ├── admin/+page.svelte          # Admin panel
│   └── api/                        # REST endpoints
│       ├── boards/
│       ├── columns/
│       ├── cards/
│       ├── categories/
│       ├── subtasks/
│       └── admin/
└── app.css                         # Global styles
```

## Tech stack

| | |
|---|---|
| **Frontend** | SvelteKit 5 with Runes |
| **Database** | SQLite via better-sqlite3 |
| **ORM** | Drizzle |
| **Realtime** | Server-Sent Events |
| **Drag & drop** | svelte-dnd-action |

## Admin panel

Head to [/admin](/admin) to view database stats, clean up specific boards, vacuum the DB, or nuke everything and start fresh.

## License

MIT
