---
title: "Authentication & Security"
category: Identity & Security
version: 1.0
status: As-Built
date: 2026-04-14
tags:
  - authentication
  - security
  - sessions
  - api-keys
  - access-control
  - bcrypt
description: "Deep-dive into DumpFire's authentication system, session management, API key handling, and board-level access control"
---

# Authentication & Security

DumpFire uses two authentication methods: session cookies for browser users and bearer tokens for API clients. All auth logic lives in `src/lib/server/auth.ts` with board-level access control in `src/lib/server/board-access.ts`.

## Authentication Flow

```mermaid
flowchart TD
    Request["Incoming Request"]
    Request --> PathCheck{"Path starts with\n/api/v1/ ?"}

    PathCheck -->|"Yes"| APIAuth["Extract Bearer token\nfrom Authorization header"]
    PathCheck -->|"No"| CookieAuth["Read session cookie\ndumpfire_session"]

    APIAuth --> RateLimit["Rate limit check\n60 req/min per key"]
    RateLimit -->|"Exceeded"| R429["429 Too Many Requests"]
    RateLimit -->|"OK"| HashKey["SHA-256 hash the key"]
    HashKey --> LookupKey["Lookup in api_keys table"]
    LookupKey -->|"Not found / expired"| R401["401 Unauthorized"]
    LookupKey -->|"Valid"| UpdateLastUsed["Update last_used_at"]
    UpdateLastUsed --> AttachUser["Attach user to locals"]

    CookieAuth -->|"No cookie"| CheckPublic{"Public route?"}
    CookieAuth -->|"Has cookie"| ValidateSession["Lookup session\nCheck expiry"]
    ValidateSession -->|"Invalid / expired"| CheckPublic
    ValidateSession -->|"Valid"| SlideExpiry["Slide expiry forward\n+30 days"]
    SlideExpiry --> AttachUser

    CheckPublic -->|"Yes"| Allow["Allow unauthenticated"]
    CheckPublic -->|"No"| Redirect["Redirect to /login"]

    AttachUser --> AdminCheck{"Admin route?"}
    AdminCheck -->|"Yes"| RoleCheck{"admin or\nsuperadmin?"}
    AdminCheck -->|"No"| Resolve["Resolve request"]
    RoleCheck -->|"Yes"| Resolve
    RoleCheck -->|"No"| RedirectHome["Redirect to /"]
```

## Session Management

| Property | Value |
|----------|-------|
| Cookie name | `dumpfire_session` |
| Token format | `crypto.randomUUID()` |
| Duration | 30 days sliding window |
| Storage | `sessions` table in SQLite |
| Flags | `httpOnly`, `sameSite: lax`, `secure` in production |

### Sliding Window

Every valid session access extends the expiry by 30 days. This means active users never get logged out, while inactive sessions expire naturally.

```mermaid
sequenceDiagram
    participant Browser
    participant Server
    participant DB

    Browser->>Server: Request with session cookie
    Server->>DB: SELECT session WHERE id = token AND expires_at > now
    DB-->>Server: Session found
    Server->>DB: UPDATE session SET expires_at = now + 30d
    Server->>DB: SELECT user WHERE id = session.userId
    DB-->>Server: User record
    Server-->>Browser: Response with user context
```

## Password Hashing

- **Algorithm**: bcrypt via `bcryptjs`
- **Rounds**: 12
- **Functions**: `hashPassword()` and `verifyPassword()` in `auth.ts`

## API Key System

API keys provide stateless authentication for the external API (`/api/v1/*`).

### Key Generation

```mermaid
flowchart LR
    Generate["randomBytes 32"] --> Format["Prefix with df_"]
    Format --> Hash["SHA-256 hash"]
    Hash --> Store["Store hash + prefix\nin api_keys table"]
    Format --> Return["Return plaintext key\nto user once"]
```

| Property | Value |
|----------|-------|
| Format | `df_` + 64 hex chars |
| Hash algorithm | SHA-256 |
| Storage | Only the hash is stored |
| Prefix stored | First 11 chars for identification |
| Expiry | Optional per-key |
| Rate limit | 60 requests/minute per key |

### Key Lifecycle

1. User generates key via Admin panel or Account page
2. Plaintext shown **once** — user must copy it
3. Only the SHA-256 hash is stored in `api_keys` table
4. Each use updates `last_used_at` timestamp
5. Expired keys are rejected at validation time

## Board Access Control

Board access is determined by `board-access.ts` using a priority-based resolution.

### Access Resolution Order

```mermaid
flowchart TD
    User["User requests board"] --> IsAdmin{"Admin or\nsuperadmin?"}
    IsAdmin -->|"Yes"| FullAccess["Full access\nrole = admin"]
    IsAdmin -->|"No"| IsCreator{"Board creator?"}
    IsCreator -->|"Yes"| OwnerAccess["Full access\nrole = owner"]
    IsCreator -->|"No"| DirectMember{"Direct board\nmember?"}
    DirectMember -->|"Yes"| DirectRole["Use assigned role\nowner/editor/viewer"]
    DirectMember -->|"No"| TeamMember{"Team member\nwith board access?"}
    TeamMember -->|"Yes"| TeamRole["Highest team role\neditor or viewer"]
    TeamMember -->|"No"| IsPublic{"Board is public?"}
    IsPublic -->|"Yes"| ViewerAccess["Viewer access"]
    IsPublic -->|"No"| NoAccess["No access\nnull"]
```

### Permission Matrix

| Action | Owner | Editor | Viewer | Admin |
|--------|-------|--------|--------|-------|
| View board | ✅ | ✅ | ✅ | ✅ |
| Create/edit cards | ✅ | ✅ | ❌ | ✅ |
| Move cards | ✅ | ✅ | ❌ | ✅ |
| Manage columns | ✅ | ❌ | ❌ | ✅ |
| Share board | ✅ | ❌ | ❌ | ✅ |
| Delete board | ✅ | ❌ | ❌ | ✅ |

## Security Headers

Applied to all responses in `hooks.server.ts`:

| Header | Value | Purpose |
|--------|-------|---------|
| `X-Content-Type-Options` | `nosniff` | Prevents MIME sniffing |
| `X-Frame-Options` | `DENY` | Blocks iframe embedding |
| `Referrer-Policy` | `strict-origin-when-cross-origin` | Limits referrer leakage |
| `Permissions-Policy` | `camera=(), microphone=(), geolocation=()` | Disables unused browser APIs |
| `X-XSS-Protection` | `1; mode=block` | Legacy XSS protection |

## First-Run Setup Guard

```mermaid
stateDiagram-v2
    [*] --> CheckUsers : Any request
    CheckUsers --> NoUsers : users table empty
    CheckUsers --> HasUsers : users exist
    NoUsers --> SetupPage : Redirect to /setup
    SetupPage --> CreateSuperadmin : Create first account
    CreateSuperadmin --> HasUsers : User created
    HasUsers --> BlockSetup : /setup permanently blocked
    BlockSetup --> NormalAuth : Standard auth flow
```

## Key Implementation Files

| File | Purpose |
|------|---------|
| `src/lib/server/auth.ts` | Password hashing, session CRUD, API key generation and validation |
| `src/lib/server/board-access.ts` | Board-level role resolution and permission checks |
| `src/hooks.server.ts` | Request-level auth guard, rate limiting, security headers |
| `src/lib/server/rate-limit.ts` | In-memory sliding window rate limiter |
