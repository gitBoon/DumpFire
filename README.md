# 🔥 DumpFire

**Blazingly fast local Kanban board with real-time collaboration.**

Built with SvelteKit + SQLite. No cloud, no accounts — just pure speed on your local network.

## Features

- **📋 Kanban Boards** — Create unlimited boards with draggable columns and cards
- **🔴 Real-Time Sync** — SSE-powered live updates across all connected clients
- **✅ Subtasks** — Break tasks down with full-detail subtasks (priority, description, due dates)
- **🎆 Celebrations** — Fireworks animation plays on every screen when a task hits Complete
- **🚫 Completion Guard** — Cards with incomplete subtasks can't be dragged to Complete
- **🏷️ Categories** — Tag cards with colour-coded categories per board
- **🎨 Infinite Colours** — Preset swatches + native colour picker for any hex value
- **📅 Optional Due Dates** — Toggle on/off for cards and subtasks with smart labels
- **🌓 Light/Dark Mode** — System-aware with manual toggle
- **🗂️ Default Columns** — New boards auto-seed with To Do, In Progress, Complete
- **🛡️ Confirmation Modals** — All destructive actions require explicit confirmation
- **⚙️ Admin Panel** — Database overview, selective cleanup, vacuum, and full reset
- **🌐 LAN Access** — Other computers on your network can connect and collaborate

## Quick Start

```bash
# Install dependencies
npm install

# Start dev server (accessible on LAN)
npm run dev
```

Open [http://localhost:5173](http://localhost:5173) or use your machine's LAN IP.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | SvelteKit 5, Svelte Runes |
| Database | SQLite via better-sqlite3 |
| ORM | Drizzle ORM |
| Realtime | Server-Sent Events (SSE) |
| Drag & Drop | svelte-dnd-action |

## Project Structure

```
src/
├── lib/
│   ├── components/
│   │   ├── CardModal.svelte      # Card editor with subtask management
│   │   ├── SubtaskModal.svelte   # Subtask create/edit modal
│   │   └── ConfirmModal.svelte   # Reusable confirmation dialog
│   ├── server/
│   │   ├── db/
│   │   │   ├── schema.ts         # Drizzle schema (boards, columns, cards, subtasks, categories)
│   │   │   ├── index.ts          # DB connection & migration runner
│   │   │   └── migrate.ts        # Auto-migration on startup
│   │   └── events.ts             # SSE event bus for live updates
│   └── stores/
│       └── theme.ts              # Theme store (dark/light)
├── routes/
│   ├── +page.svelte              # Dashboard — board list
│   ├── board/[id]/
│   │   ├── +page.server.ts       # Board data loader
│   │   └── +page.svelte          # Kanban board view
│   ├── admin/
│   │   ├── +page.server.ts       # Admin data loader
│   │   └── +page.svelte          # Admin panel
│   └── api/                      # REST API endpoints
│       ├── boards/               # CRUD + SSE events endpoint
│       ├── columns/              # CRUD + reorder
│       ├── cards/                 # CRUD + reorder (with celebration detection)
│       ├── categories/           # CRUD
│       ├── subtasks/             # CRUD
│       └── admin/                # Cleanup, vacuum, reset
└── app.css                       # Design system & global styles
```

## Admin Panel

Access at [/admin](/admin) — manage boards, clear data selectively, vacuum the database to reset auto-increment IDs, or perform a full reset.

## Collaboration

1. Start the server on one machine
2. Find your LAN IP in the terminal output (e.g. `http://192.168.x.x:5173/`)
3. Open the same board URL on other machines
4. Changes sync instantly — drag a card to Complete and everyone sees fireworks 🎉

## License

MIT
