---
title: "DumpFire Architecture Overview"
category: Architecture
version: 1.1
status: As-Built
date: 2026-04-14
tags:
  - architecture
  - sveltekit
  - sqlite
  - kanban
  - system-design
description: "High-level and component-level architecture of the DumpFire Kanban board system"
---

# DumpFire Architecture Overview

DumpFire is a self-hosted, real-time Kanban board application designed for speed and simplicity. It runs as a single-process Node.js application with an embedded SQLite database — no external services required.

## System Context

```mermaid
flowchart TD
    User["👤 Board User"]
    Admin["🔧 Admin"]
    Requester["📨 External Requester"]
    Automation["🤖 Automation / CI"]

    DumpFire["🔥 DumpFire\nSelf-hosted Kanban Board"]

    SMTP["📧 SMTP Server"]
    Backups["💾 Backup Destinations\nSFTP / S3 / GDrive / OneDrive"]

    User -->|"HTTPS"| DumpFire
    Admin -->|"HTTPS"| DumpFire
    Requester -->|"HTTPS"| DumpFire
    Automation -->|"REST API + Bearer Token"| DumpFire
    DumpFire -->|"SMTP/TLS"| SMTP
    DumpFire -->|"SFTP / S3 / OAuth"| Backups
```

## Container Diagram

```mermaid
flowchart TD
    User["👤 User"]

    subgraph App["DumpFire Application"]
        Frontend["🖥️ SvelteKit Frontend\nSvelte 5, SSR\nDashboard, Board Views, Admin, Reports"]
        Backend["⚙️ SvelteKit Server\nNode.js, Hooks\nAPI, Auth, SSE, Reports"]
        DB[("🗄️ SQLite Database\nbetter-sqlite3")]
    end

    SMTP["📧 SMTP Server"]
    BackupStore["💾 Backup Storage"]

    User -->|"HTTPS"| Frontend
    Frontend -->|"SSR + API"| Backend
    Backend -->|"Synchronous SQL"| DB
    Backend -.->|"SMTP"| SMTP
    Backend -.->|"SFTP / S3 / OAuth"| BackupStore
```

## Technology Stack

| Layer | Technology | Purpose |
|-------|-----------|---------|
| **Framework** | SvelteKit 2 + Svelte 5 | Full-stack SSR framework with file-based routing |
| **Language** | TypeScript 5.9 | Type-safe server and client code |
| **Database** | SQLite via better-sqlite3 | Embedded, zero-config relational database |
| **ORM** | Drizzle ORM 0.45 | Type-safe schema definition and queries |
| **Auth** | Session cookies + bcryptjs | Cookie-based sessions for UI, API keys for external access |
| **Real-time** | Server-Sent Events | Live board updates without WebSocket complexity |
| **PDF Reports** | PDFKit | Server-side PDF generation for scheduled and on-demand reports |
| **Email** | Nodemailer | SMTP integration for notifications and report delivery |
| **Backup** | AWS S3 SDK, ssh2-sftp-client, Google/Microsoft APIs | Multi-destination scheduled backups |
| **Deployment** | Docker node:22-slim | Two-stage build, single container |

## Component Architecture

```mermaid
flowchart TB
    subgraph Client["Browser Client"]
        Dashboard["Dashboard"]
        BoardView["Board View + DnD"]
        AllTasks["All Tasks"]
        ArchivedView["Archived Tasks"]
        AdminPanel["Admin Panel"]
        Reports["Reports"]
        CardModal["Card Modal"]
    end

    subgraph Server["SvelteKit Server"]
        Hooks["hooks.server.ts\nAuth Guard + Rate Limiting"]

        subgraph InternalAPI["Internal API"]
            BoardsAPI["Boards"]
            CardsAPI["Cards"]
            ColumnsAPI["Columns"]
            SubtasksAPI["Subtasks"]
            AdminAPI["Admin"]
            ReportsAPI["Reports"]
            EventsAPI["SSE Events"]
        end

        subgraph ExternalAPI["External API v1"]
            V1Boards["v1/boards"]
            V1Cards["v1/cards"]
            V1Subtasks["v1/subtasks"]
            V1Webhooks["v1/webhooks"]
        end

        subgraph Services["Server Services"]
            Auth["Auth Service"]
            BoardAccess["Board Access Control"]
            ReportEngine["Report Engine"]
            Notifications["Notifications"]
            BackupService["Backup Scheduler"]
            Snapshots["Snapshot Scheduler"]
            ActivityLogger["Activity Logger"]
            SSE["SSE Emitter"]
        end

        DB[("SQLite")]
    end

    Client --> Hooks
    Hooks --> InternalAPI
    Hooks --> ExternalAPI
    InternalAPI --> Services
    ExternalAPI --> Services
    Services --> DB
    SSE -.->|"Server-Sent Events"| Client
    ReportEngine -.->|"SMTP"| EmailServer["Email Server"]
    BackupService -.->|"Push"| BackupDest["Backup Destinations"]
```

## Authentication and Authorisation

```mermaid
flowchart LR
    subgraph Auth["Authentication"]
        Cookie["Session Cookie\nUI Users"]
        APIKey["Bearer Token\nAPI v1 Clients"]
    end

    subgraph Guard["hooks.server.ts"]
        SessionCheck["Validate Session"]
        KeyCheck["Validate API Key\n+ Rate Limit"]
    end

    subgraph Access["Access Control"]
        RoleCheck["Role Check"]
        BoardCheck["Board Access"]
        TeamCheck["Team Membership"]
    end

    Cookie --> SessionCheck --> RoleCheck
    APIKey --> KeyCheck --> RoleCheck
    RoleCheck --> BoardCheck
    BoardCheck --> TeamCheck
```

### Role Hierarchy

| Role | Boards | Admin | Users |
|------|--------|-------|-------|
| `superadmin` | All boards | Full access | Manage all |
| `admin` | All boards | Full access | Manage all |
| `user` | Only shared boards | No access | Self only |

### Board Access Levels

| Level | View | Edit Cards | Manage Board |
|-------|------|-----------|--------------|
| `owner` | ✅ | ✅ | ✅ |
| `editor` | ✅ | ✅ | ❌ |
| `viewer` | ✅ | ❌ | ❌ |

## Real-Time Updates via SSE

```mermaid
sequenceDiagram
    participant A as User A
    participant S as Server
    participant B as User B

    A->>S: GET /api/events
    B->>S: GET /api/events

    A->>S: PUT /api/cards/42
    S->>S: emit boardId update
    S-->>A: SSE update event
    S-->>B: SSE update event

    A->>S: Move card to Complete
    S->>S: emit celebrate event
    S-->>A: SSE celebrate
    S-->>B: SSE celebrate
```

## Request Lifecycle

External users can submit task requests without authentication:

```mermaid
stateDiagram-v2
    [*] --> Pending : Requester submits form
    Pending --> Accepted : Admin accepts
    Pending --> Rejected : Admin rejects
    Accepted --> CardCreated : Card created on board
    CardCreated --> InProgress : Assigned to member
    InProgress --> Complete : Task completed
    Complete --> EmailSent : Completion email sent
    EmailSent --> [*]
    Rejected --> EmailSent : Rejection email sent
```

## Scheduled Background Tasks

| Scheduler | Interval | Purpose |
|-----------|----------|---------|
| Backup Scheduler | Configurable | Push DB backup to SFTP/S3/GDrive/OneDrive |
| Report Scheduler | Weekly/Monthly | Generate and email PDF reports |
| Snapshot Scheduler | Daily midnight | Card counts per column for CFD/burndown |
| Session Cleanup | On startup | Remove expired session tokens |

## Key Design Decisions

1. **SQLite over Postgres/MySQL** — Zero-config, file-based, perfect for self-hosted single-tenant deployments. Synchronous queries via better-sqlite3 are faster than async alternatives for this workload.

2. **SSE over WebSockets** — Simpler server implementation, automatic reconnection built into the browser API, works through HTTP/2 proxies without special config.

3. **Single-process architecture** — No external message queues, no separate worker processes. All schedulers run in-process with `setInterval`. Suitable for the target scale (team-sized deployments).

4. **Drizzle ORM** — Type-safe schema that serves as the source of truth. Migrations managed via `drizzle-kit` with SQL files checked into `drizzle/`.

5. **Soft-delete (archive)** — Cards are soft-deleted by setting `archivedAt`. Hard delete available via `?permanent=true` query parameter. Admin purge endpoint for bulk cleanup.
