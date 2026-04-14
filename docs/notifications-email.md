---
title: "Notifications & Email System"
category: Integration
version: 1.0
status: As-Built
date: 2026-04-14
tags:
  - notifications
  - email
  - smtp
  - sse
  - webhooks
  - real-time
description: "Complete guide to DumpFire's notification pipeline: SMTP email, SSE real-time events, webhooks, and user preferences"
---

# Notifications & Email System

DumpFire notifies users through three channels: email notifications via SMTP, real-time browser updates via SSE, and external webhooks. All channels are fire-and-forget — they never block API responses.

## Notification Architecture

```mermaid
flowchart TD
    subgraph Triggers["Event Triggers"]
        CardCreated["Card Created"]
        CardMoved["Card Moved"]
        CardAssigned["User Assigned"]
        CommentAdded["Comment Added"]
        Mentioned["User Mentioned"]
        BoardShared["Board Shared"]
        RequestSubmitted["Task Request"]
        RequestResolved["Request Accepted/Rejected"]
        RequestMessage["Conversation Message"]
    end

    subgraph Channels["Notification Channels"]
        Email["📧 Email\nnotifications.ts"]
        SSE["📡 SSE\nevents.ts"]
        Webhook["🔗 Webhook\nwebhooks.ts"]
    end

    subgraph Recipients["Recipient Resolution"]
        Assignees["Card Assignees"]
        BoardMembers["Board Members"]
        TeamMembers["Team Members"]
        Requester["External Requester"]
    end

    Triggers --> Recipients
    Recipients --> PrefCheck["Filter by\nuser preferences"]
    PrefCheck --> Email
    Triggers --> SSE
    Triggers --> Webhook
```

## Email Notifications

### SMTP Configuration

SMTP settings are stored in the `settings` table and configured via the Admin panel.

| Setting Key | Type | Default | Description |
|------------|------|---------|-------------|
| `smtp_host` | string | — | SMTP server hostname |
| `smtp_port` | number | 587 | Port number |
| `smtp_secure` | boolean | false | Use direct SSL |
| `smtp_user` | string | — | Auth username |
| `smtp_pass` | string | — | Auth password |
| `smtp_from_address` | string | — | Sender email address |
| `smtp_from_name` | string | DumpFire | Sender display name |

### Connection Handling

```mermaid
flowchart LR
    Request["Send Email"] --> ConfigCheck{"SMTP\nconfigured?"}
    ConfigCheck -->|"No"| NoOp["Silent no-op\nreturn false"]
    ConfigCheck -->|"Yes"| CreateTransport["Create transporter"]
    CreateTransport --> PortCheck{"Port 465?"}
    PortCheck -->|"Yes"| DirectSSL["Direct SSL"]
    PortCheck -->|"No"| STARTTLS["STARTTLS"]
    DirectSSL --> Send["Send via SMTP"]
    STARTTLS --> Send
    Send -->|"Success"| ReturnTrue["return true"]
    Send -->|"Failure"| LogError["Log error\nreturn false"]
```

Key transport settings:
- **IPv4 forced** — Prevents ETIMEDOUT on dual-stack DNS
- **EHLO name** — Set to `dumpfire.app` to avoid Google 421 errors from local hostnames
- **Timeouts** — 10s connection, 10s greeting, 15s socket

### Email Types

| Event | Recipients | Preference Key | Subject Format |
|-------|-----------|---------------|----------------|
| Card Created | Assignees | `email_assigned` | `New card: {title}` |
| Card Moved | Assignees | `email_moved` | `Card moved: {title} → {column}` |
| User Assigned | Assignee | `email_assigned` | `Assigned: {title}` |
| Comment Added | Board members | `email_comments` | `New comment on: {title}` |
| User Mentioned | Mentioned user | `email_mentions` | `{author} mentioned you: {title}` |
| Board Shared | Target user | `email_board_shared` | `Board shared: {boardName}` |
| Task Request | Target user/team | `email_requests` | `New request: {title}` |
| Request Accepted | Requester | — | `Request accepted: {title}` |
| Request Rejected | Requester | — | `Request declined: {title}` |
| Conversation Message | Requester/Admin | `email_requests` | `Message on request: {title}` |
| Request Complete | Requester | `email_request_progress` | `Your request is complete: {title}` |

### User Notification Preferences

Stored as JSON in `users.notification_prefs`. Each user can toggle individual notification types.

```mermaid
flowchart TD
    Event["Notification Event"] --> GetPrefs["Load user prefs\nJSON from users table"]
    GetPrefs --> MasterToggle{"email_all\nenabled?"}
    MasterToggle -->|"false"| Skip["Skip notification"]
    MasterToggle -->|"true / unset"| TypeToggle{"Type-specific\ntoggle enabled?"}
    TypeToggle -->|"false"| Skip
    TypeToggle -->|"true / unset"| Send["Send email"]
```

### Requester Progress Notifications

When a task request is accepted and converted to a card, the requester receives progress emails:

```mermaid
sequenceDiagram
    participant R as Requester
    participant S as Server
    participant A as Admin

    R->>S: Submit task request
    S->>A: Email notification
    A->>S: Accept request, create card
    S->>R: Accepted email

    Note over S: Progress tracking begins

    A->>S: Move card
    S->>R: Card moved email
    A->>S: Complete subtask
    S->>R: Subtask completed email
    A->>S: Add comment
    S->>R: Comment email
    A->>S: Move to Complete
    S->>R: Completion email + PDF report
```

On card completion, a **PDF task report** is automatically generated and attached to the completion email.

## Real-Time Updates via SSE

### Architecture

```mermaid
flowchart LR
    subgraph Server
        EventEmitter["Event Emitter\nevents.ts"]
        BoardSubs["Board Subscribers\nMap of boardId to Set"]
        GlobalSubs["Global Subscribers\nAll Tasks page"]
    end

    subgraph Clients
        Board1["Board /board/1"]
        Board2["Board /board/2"]
        AllTasks["All Tasks /all"]
    end

    EventEmitter -->|"emit boardId=1"| BoardSubs
    BoardSubs --> Board1
    EventEmitter -->|"all events"| GlobalSubs
    GlobalSubs --> AllTasks
```

### Event Types

| Event | Payload | Trigger |
|-------|---------|---------|
| `update` | `{type: 'card'}` | Card created, updated, moved, deleted |
| `update` | `{type: 'column'}` | Column added, reordered, deleted |
| `celebrate` | `{cardTitle, xpGained}` | Card moved to completion column |

### Connection Lifecycle

1. Client opens `GET /api/events?boardId={id}` or `GET /api/events?global=true`
2. Server creates SSE stream with `text/event-stream` content type
3. Server calls `subscribe(boardId, listener)` or `subscribeGlobal(listener)`
4. On board mutation, server calls `emit(boardId, event, data)`
5. All subscribed listeners receive the event
6. On client disconnect, unsubscribe callback cleans up the listener set

## Webhooks

Board-level webhooks fire HTTP POST requests to configured URLs when events occur.

### Configuration

| Field | Type | Description |
|-------|------|-------------|
| `url` | string | Target HTTP endpoint |
| `secret` | string | Shared secret for signature verification |
| `events` | JSON array | Event types to subscribe to |
| `active` | boolean | Enable/disable toggle |

### Webhook Flow

```mermaid
sequenceDiagram
    participant S as DumpFire
    participant W as Webhook Endpoint

    S->>S: Card event occurs
    S->>S: Check board webhooks
    S->>W: POST with JSON payload
    Note over W: Verify signature
    W-->>S: 200 OK
```

## Key Implementation Files

| File | Purpose |
|------|---------|
| `src/lib/server/email.ts` | SMTP config, transporter creation, sendEmail |
| `src/lib/server/notifications.ts` | All email notification functions with preference filtering |
| `src/lib/server/events.ts` | SSE event emitter with board and global subscriptions |
| `src/lib/server/webhooks.ts` | Webhook dispatch on board events |
| `src/lib/server/mentions.ts` | Extract @mentions from comment text |
