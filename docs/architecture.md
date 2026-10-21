---
title: "DumpFire Architecture Overview"
category: Architecture
version: 1.47
status: As-Built
date: 2026-10-21
tags:
  - architecture
  - sveltekit
  - sqlite
  - kanban
  - system-design
  - migrations
  - transactions
  - deletes
  - uploads
  - hooks
  - errors
  - services
  - api-trees
  - board-page
  - card-window
  - live-updates
  - components
description: "High-level and component-level architecture of the DumpFire Kanban board system, including the gate every request passes and how an API failure is answered, how a write is made all or nothing, the one service per action both API trees call, when its effects are sent, what a delete takes, how the board page and its card window apply each change and read only their board again, how the admin page, the dashboard, All Tasks and the plan page are split into components and save the card window off the board, and how a page left open notices a new version"
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
| **Auth** | Session cookies + bcryptjs on worker threads | Cookie-based sessions for UI, API keys for external access; every password hashed and checked off the server's thread (`node:worker_threads`, card 2191), and browsers that have signed in remembered by a signed cookie (card 2194) |
| **Real-time** | Server-Sent Events | Live board updates without WebSocket complexity |
| **PDF Reports** | PDFKit | Server-side PDF generation for scheduled and on-demand reports |
| **Email** | Nodemailer | SMTP integration for notifications and report delivery |
| **Backup** | AWS S3 SDK, ssh2-sftp-client, Google/Microsoft APIs | Multi-destination scheduled backups |
| **Markdown** | marked + DOMPurify, through one renderer | A card's description and comments are drawn by `renderMarkdown` in `src/lib/markdown.ts` (cards 2202 and 2210), the only module that imports either: see [Authentication & Security](authentication-security.md#markdown-in-descriptions-and-comments) |
| **Font** | Inter 4.001, served by DumpFire | The variable font (one axis, weight 100 to 900), seven files by character set under `src/lib/fonts/inter/`, declared in `src/lib/fonts/inter.css` and imported by the root layout (card 2203). They are the files Google Fonts served, byte for byte, taken from `@fontsource-variable/inter@5.3.0`; no font package is installed. Vite fingerprints them into `/_app/immutable/assets/`, served before the gate and cached for a year. Licence: SIL Open Font License 1.1, "Copyright 2016 The Inter Project Authors", its text at `static/licences/inter-OFL.txt`, served at `/licences/inter-OFL.txt`. No page asks Google for it, or another site for anything |
| **Deployment** | Docker node:22-slim | Two-stage build, single container |

## Component Architecture

```mermaid
flowchart TB
    subgraph Client["Browser Client"]
        Dashboard["Dashboard\nand its 7 components (card 2281)"]
        BoardView["Board View + DnD"]
        AllTasks["All Tasks\nand its 6 components (card 2281)"]
        AllToDo["All To Do"]
        PlanPage["Plan Page\nits 7 components, plan-graph.ts (card 2281)"]
        ArchivedView["Archived Tasks"]
        AdminPanel["Admin Panel\nand its 14 components (card 2281)"]
        Reports["Reports"]
        CardModal["Card Modal\nand its 11 sections"]
        BoardState["Board State + Refresh Schedule\nboard-state.svelte.ts,\nrefresh-schedule.ts (card 2280)"]
        CardWindowCtl["Card-Window Controller\ncard-window.svelte.ts (card 2280)"]
        PageCardWin["Card Window off the Board\npage-card-window.svelte.ts (card 2281)"]
    end

    subgraph Server["SvelteKit Server"]
        Hooks["hooks.server.ts\nBody Guard, Auth Guard,\nRate Limiting, JSON Failures for v1"]

        subgraph InternalAPI["Internal API"]
            BoardsAPI["Boards"]
            ContentsAPI["Board Contents\nGET /api/boards/[id]/contents"]
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
            ActionServices["One Service per Action\ncards.ts, subtasks.ts, boards.ts,\ncolumns.ts, labels.ts and eight more\n(card 2012)"]
            WriteAs["Asked Again at the Write\nwriteAs, inWrite: write-as.ts"]
            Auth["Auth Service"]
            BoardAccess["Board Access Control"]
            ReportEngine["Report Engine"]
            Notifications["Notifications"]
            BackupService["Backup Scheduler"]
            Snapshots["Snapshot Scheduler"]
            ActivityLogger["Activity Logger"]
            SSE["SSE Emitter"]
            Tx["Transaction Helper\ndb/transaction.ts"]
            Deletes["Shared Delete\ndeletes.ts"]
            Uploads["Uploads + Trash\nuploads.ts"]
            Sweep["Attachment File Sweep\nuploads-sweep.ts"]
            ApiErrors["API Failures\napi-errors.ts"]
            V1Json["v1 Answers in ISO 8601\nv1-json.ts"]
            CrossBoard["Cross-Board Cards\ncross-board-cards.ts"]
            BoardContents["Board Contents Reader\nboard-contents.ts (card 2280)"]
        end

        DB[("SQLite")]
        Files[("Uploads folder\nbeside the database")]
    end

    Client --> Hooks
    Hooks --> ApiErrors
    Hooks --> InternalAPI
    Hooks --> ExternalAPI
    InternalAPI --> Services
    ExternalAPI --> Services
    InternalAPI -->|"inside writeAs"| ActionServices
    ExternalAPI -->|"inside writeAs"| ActionServices
    ActionServices -->|"inWrite()"| WriteAs
    WriteAs --> Tx
    Services --> DB
    Deletes --> Tx
    Deletes --> Uploads
    Sweep --> Uploads
    ExternalAPI --> V1Json
    Uploads --> Files
    CrossBoard --> BoardAccess
    BoardView --> BoardState
    BoardView --> CardWindowCtl
    CardWindowCtl --> BoardState
    AllTasks --> PageCardWin
    AllToDo --> PageCardWin
    PlanPage --> PageCardWin
    PageCardWin -->|"a controller per card, over the page's own list"| CardWindowCtl
    AllTasks -.->|"refresh-schedule.ts alone: one re-read per burst"| BoardState
    BoardState -->|"one coalesced read"| ContentsAPI
    ContentsAPI --> BoardContents
    BoardContents --> BoardAccess
    SSE -.->|"Server-Sent Events"| Client
    ReportEngine -.->|"SMTP"| EmailServer["Email Server"]
    BackupService -.->|"Push"| BackupDest["Backup Destinations"]
```

All Tasks and All To Do (card 2240) read their cards through one reader,
`readCrossBoardCards(user, { inColumn? })` in `src/lib/server/cross-board-cards.ts`: the boards
the caller can open, their columns, the unarchived cards on the columns `inColumn` lets through
(all of them for All Tasks; those whose title is To Do or Todo, `isTodoColumnTitle`, for All To
Do), enriched once, with the category rules of card 2128, the sub-board places of card 1990 and
the withheld blockers of card 2129. So the two pages give a caller the same boards and the same
cards, and All To Do lists exactly All Tasks' To Do bucket. All To Do's filters and sort are
worked out in the browser by `src/lib/todo-table.ts` and kept in the address with
`goto(…, { replaceState: true })`, a real navigation that re-runs no load, because neither its
load nor the layout's reads `url`; a shallow `replaceState` would leave `page.url` and the
history entry at the arrival address, so Back from a board would lose the filters.

## The Gate

Every request passes `handle` in `src/hooks.server.ts` before it reaches a page or a route
handler. It is where a caller is identified, where an API key is counted against its rate
limit, and where a failure of the external API is made JSON. The functions it uses for that
last part are in `src/lib/server/api-errors.ts`; how large a body may be is in
`src/lib/server/body-limits.ts`; and the answers it gives of its own when it sends a request
away, and the security headers it puts on every answer, are in
`src/lib/server/gate-answers.ts`.

Loading the module is also what starts the server's own work, once, before the first
request: `runMigrations()`, `cleanExpiredSessions()`, `initLogMaintenance()` and
`startSchedulers()`.

```mermaid
flowchart TD
    Req["A request"] --> Kit{"SvelteKit, before handle is called"}
    Kit -->|"a write sent as a form with no matching Origin (built server only),<br/>a trailing slash,<br/>a path that begins /_app but a remote call"| Early["403, 308 or 404.<br/>The gate never sees it"]
    Kit --> Path["routedPath(event): the path as the router sees it.<br/>Every rule below is decided on it"]
    Path -->|"null: a URL that is not validly encoded"| E400["400 Malformed URI, plain text,<br/>secured(), unlogged"]
    Path --> Remote{"Step 1: a call to a remote function,<br/>/_app/remote/...?"}
    Remote -->|"Yes"| E404r["404 message: Not found,<br/>whatever path its header names<br/>(one that cannot be decoded: the 400 above)"]
    Remote -->|"No"| Size["Step 2: refuseBody(): 413 for a body declared<br/>over what the route gives anybody"]
    Size --> Static{"Step 3: /_app/ or /favicon.ico,<br/>and no body refused?"}
    Static -->|"Yes"| Pass["handOn, unlogged, then secured()"]
    Static -->|"No"| Refused{"A body refused in step 2?"}
    Refused -->|"Yes: that is the answer"| Log
    Refused -->|"No"| V1{"Step 4: path under /api/v1/ ?"}

    V1 -->|"Yes"| Accept["Set the request's Accept header<br/>to application/json"]
    Accept --> Doc{"/api/v1/openapi.json ?"}
    Doc -->|"Yes"| DocResolve["failureAsJson(resolve)<br/>No key, no rate limit"]
    Doc -->|"No"| Find{"findApiKey(): a Bearer key,<br/>known and not expired?"}
    Find -->|"No, or no header"| Guess{"More than 60 in the minute<br/>from this address with no such key?"}
    Guess -->|"Yes"| E429a["429 message, retryAfterSecs,<br/>Retry-After"]
    Guess -->|"No"| E401["401 message"]
    Find -->|"Yes"| Limit{"More than 60 in the minute<br/>for this key's id?"}
    Limit -->|"Yes"| E429["429, as above"]
    Limit -->|"No"| Used["markApiKeyUsed()"]
    Used --> Route{"event.route.id is null ?"}
    Route -->|"Yes: no such route"| E404["404 message: Not found"]
    Route -->|"No"| Resolve["failureAsJson(resolve)"]

    V1 -->|"No"| Session["Read the session cookie,<br/>attach the user or null"]
    Session --> Setup{"Any user in the database?"}
    Setup -->|"No, and /setup"| SetupResolve["resolve"]
    Setup -->|"No, a script asking<br/>an internal route"| E401b["401 Not authenticated"]
    Setup -->|"No, anything else"| ToSetup["sendTo /setup"]
    Setup -->|"Yes, and /setup"| ToHome1["sendTo /"]
    Setup -->|"Yes"| Signed{"Signed in?"}
    Signed -->|"No, a public route"| PublicResolve["resolve"]
    Signed -->|"No, a script asking<br/>an internal route"| E401c["401 Not authenticated"]
    Signed -->|"No, anything else"| ToLogin["sendTo /login"]
    Signed -->|"Yes, and /login"| ToHome2["sendTo /"]
    Signed -->|"Yes"| AdminRoute{"/admin or /audit,<br/>and not an administrator?"}
    AdminRoute -->|"Yes"| ToHome3["sendTo /"]
    AdminRoute -->|"No"| PageResolve["handOn"]

    Log["Step 5: log the status that is sent:<br/>500 and above ERROR, 400 and above WARN, the rest INFO,<br/>a redirect with where it sends the caller,<br/>an invite's address as /invite/[token]"]
    E404r --> Log
    E404 --> Log
    Resolve --> Log
    E401 --> Log
    E429a --> Log
    E429 --> Log
    DocResolve --> Log
    E401b --> Log
    E401c --> Log
    PageResolve --> Log
    PublicResolve --> Log
    SetupResolve --> Log
    ToSetup --> Log
    ToLogin --> Log
    ToHome1 --> Log
    ToHome2 --> Log
    ToHome3 --> Log
    Log --> Secured["Step 6: secured(): every security header<br/>the answer does not already carry,<br/>a page's policy moved to report only<br/>while CSP_MODE=report-only"]
```

### The order of `handle`

| # | Step | What it does |
|---|------|--------------|
| 1 | A remote call | A call to a remote function, `/_app/remote/<id>`, is answered `404` `{ "message": "Not found" }`, to anybody. SvelteKit sets its `event.url` and route from the `x-sveltekit-pathname` header, which the caller writes, so no rule below can be decided on it. A header that names a path that cannot be decoded is answered `400` `Malformed URI` before this step, as SvelteKit 2.60 also answered it. DumpFire has no remote functions |
| 2 | Body size | `refuseBody()` asks every request whose body declares a length in `Content-Length` whether that is more than its route gives anybody: `413` with the limit if it is. A body with no length is let through to be counted (see `handOn`, below). The answer is kept, not thrown. See [Authentication & Security](authentication-security.md#how-large-a-request-may-be) |
| 3 | Static assets | `/_app/` and `/favicon.ico`, exactly, are handed on at once and not logged, unless step 2 refused the body, which is logged like any other answer. Every other path that begins `/_app`, but a remote call, is answered `404` by SvelteKit before the gate is called |
| 4 | `handleRequest()` | The `/api/v1/` branch, or the session branch for everything else. Each is set out below. Every refusal and every redirect in it is an answer that is returned: none is thrown. Every request it lets through is handed on by `handOn` |
| 5 | The request log | One line under the `HTTP` context with the method, the address as it was sent, the status that is sent and the time taken: `ERROR` for 500 and above, `WARN` for 400 and above, `INFO` for the rest. A redirect is logged with where it sends the caller. An invite's address is written `/invite/[token]`, and a remote call at the address it was sent to (`pathToLog()` in `src/lib/server/secret-paths.ts`). A fault in the gate itself, thrown, is logged at `ERROR` with its reason, once, and thrown on for SvelteKit to answer `500` |
| 6 | The security headers | `secured()` sets each of the five headers the answer does not already carry, `X-Frame-Options` but on the public request form's three pages. A page also carries a sixth, the `Content-Security-Policy` SvelteKit sets from `kit.csp` in `svelte.config.js` with a new nonce each time (card 2162); `secured()` never replaces it and gives no other answer one, and while `CSP_MODE=report-only` it moves a page's, unchanged, to `Content-Security-Policy-Report-Only`. See [Authentication & Security](authentication-security.md#the-content-security-policy) |

`handOn` is how every request the gate lets through reaches SvelteKit, from each of the
places `handleRequest()` hands one on and from step 3. It asks the body's size again, now
that the caller is known: the attachment upload gives 26 MB to anybody signed in, and the
import the whole of `BODY_SIZE_LIMIT` to the superadmin alone. Then it hands on a copy of the
request whose body passes through a count (`heldToLimit()`), so that a body with no length
is refused `413` once it is read past the limit, and puts `guardBody()` on that copy, which
replaces its readers so that a body that is missing or not JSON is a `400` and a body over
the limit a `413`. A request the server makes of itself is guarded and not limited.

After the gate, SvelteKit calls `handleError`, in the same file, for anything a handler or a
page's load throws, a fault in the gate, and a path that is no route. It writes a fault (a
status of 500 or more) to the system log at `ERROR` with the exception, the route and the
user, leaves one the gate has already written, answers SvelteKit's own message for the
status, and cannot throw. See
[Authentication & Security](authentication-security.md#when-something-fails).

### The path a rule is decided on

Every step above that asks about the path, `/api/`, `/api/v1/`, a public route, `/admin`,
asks about the path as the router sees it, and never about `event.url.pathname`, which is
the address as it was sent. `routedPath()` in `src/hooks.server.ts` works it out once, at
the top of `handle`.

SvelteKit decodes an address before it looks for a route, so `/%61dmin` is served by the
route `/admin`. A rule that compared the address as sent with `/admin` did not apply to it:
a signed-in user who was no administrator was shown the admin page, and `/%61pi/v1/me` was
answered with a session and no key, uncounted.

| The request | What the rules are decided on |
|-------------|-------------------------------|
| A route matched | The route's id, `/admin` or `/api/cards/[id]`: the router's own answer, so the gate and the router cannot disagree. A request for a page's data, `/admin/__data.json`, has the id of the page |
| No route matched | The address decoded as SvelteKit decodes it, `decodeURI` on each piece between one `%25` and the next. Nothing but a `404` is served for it |

- **`%2F` stays `%2F`.** It is no `/` to the router or to the gate: `/api%2Fv1%2Fme` is not
  under `/api/v1/` and is no route.
- **Nothing is decoded twice.** `/%2561dmin` is the address `/%61dmin` spelt out, and is no
  route.
- **A sequence that cannot be decoded is answered first.** `routedPath()` returns null for
  it and `handle` answers `400` "Malformed URI", in plain text with the security headers,
  before anything else and with nothing logged. SvelteKit answered it itself before calling
  the gate up to 2.60; since 2.61 it hands it to the gate, where the decode threw, a `500`,
  until card 2227.
- **The two page loads check for themselves.** `src/routes/admin/+page.server.ts` and
  `src/routes/audit/+page.server.ts` send a caller who is not signed in to `/login` and one
  who is not an administrator to `/`, as the gate does. The gate was the only thing in
  front of them.
- **No route is inside a `(group)`.** A group's name is in the route's id and not in the
  address, so a rule would not match it. `tests/gate.test.ts` fails if one is added.
- **The log keeps the address as it was sent**: `/%61dmin` is logged as `/%61dmin`.

### The body guard

A handler reads its JSON body with `readBody(request)`, which calls `request.json()` (see
[Reading a body](#reading-a-body)), and two read a file: the attachment upload with
`formData()` and the backup import with `arrayBuffer()`. The guard is what makes a body the
caller got wrong a `400` or a `413` and not a `500`, for every handler under `/api/` at
once.

| The body | What the handler's `request.json()` does |
|----------|------------------------------------------|
| Missing, empty, or not JSON (the read throws a `SyntaxError`) | Throws `error(400, 'The request body is missing or is not valid JSON')` |
| JSON that is `null`, a number, a string or a boolean | Throws `error(400, 'The request body must be a JSON object')` |
| A JSON object | Returns it |
| A JSON array, `[]` included | Throws `error(400, 'The request body must be a JSON object')`. No handler takes one, and one that gave every field a default made a board out of `[]` |
| Read with `formData()`, and not sent as `multipart/form-data` or `application/x-www-form-urlencoded` | `formData()` throws `error(400, 'The request body is not a form')` and reads nothing. undici's own refusal of a type that is a form only up to its first `;` (`application/x-www-form-urlencoded;a=b, text/plain`) is the same `400` |
| Sent with no length, and read past the route's limit | Throws `error(413, { message, limitBytes })`, as the gate's own `413` for a declared length says it. So do the other readers |
| Run past the length it declared | Throws `error(413, 'Payload Too Large')`. So do the other readers |
| Read a second time | Not caught: it stays a fault |

- **The readers are replaced on the one request object `handOn` hands on**, which is the
  object SvelteKit hands the handler: a copy of the request the gate was given, with its body
  passed through the count (`heldToLimit()`). `json`, `formData` and `arrayBuffer` are the
  three a route reads with; `text()`, `blob()` and `bytes()` are replaced as well, for the
  `413` alone, so that a body read past its limit is a `413` however it is read. A `clone()`
  of the request is not guarded, and no route reads one, but the count is on the body, so a
  clone is held to the limit all the same.
- **A body over the limit is known by its status, not its class.** The node adapter fails
  the body's stream with a `413` of its own copy of SvelteKit's error class. SvelteKit
  takes a status only from an error it knows by `instanceof`, so the adapter's `413` was
  answered `500` by a built server. The guard throws any fault whose `status` is `413`
  again as SvelteKit's own.
- **The JSON guard is on the read, not on the `Content-Type`.** A body sent as
  `application/xml` and read with `json()` is judged by what it holds. `formData()` is the
  one reader that asks the `Content-Type` first: a body not sent as a form is the `400`
  above, before any of it is read, on the attachment upload and on the three form actions
  (`/login`, `/setup`, `/invite/[token]`), which the guard reaches because it runs on every
  request. A form body that is broken, or cut off as it arrives, still fails in the read and
  is passed on as it was. A body sent with no `Content-Type` at all is not passed on by the
  server and is a body that is missing.
- **One handler catches what is thrown inside it, and passes SvelteKit's errors on.**
  `POST /api/admin/import` refuses a body that is not sent as a `.db` backup by its media
  type before reading it, and reads the rest as bytes, never as JSON, so the body guard's
  `400` never reaches it. Its outer `catch` first rethrows an error SvelteKit made, so that a
  `.db` backup sent in chunks that runs past the limit stays a `413`. A failure inside the
  restore is answered there: a `RestoreError` is `500` with its own message, a restore that
  would leave no superadmin `422`, and anything else `500` "Restore failed: …".
  Anything else thrown before the restore, the upload that could not be written down above
  all, is `500` "Import failed: …".
- **The test helper applies the same guard.** `api()` in `tests/helpers/api.ts` calls
  handlers beneath the gate and guards each request it builds, so a handler test meets what
  the wire has. See [Testing](testing.md#the-gate-harness).

### Reading a body

The guard says whether a body is a JSON object. What each field of it may hold is the
handler's to say, and every handler in both API trees says it one way, through
`src/lib/server/request-body.ts` (card 2117). Each handler used to read
`await request.json()` and use the fields as they came. A field of the wrong type then
went one of three ways: it was stored (`"top"` as a position, `"false"` as true), it was a
`500` (`.trim` called on a number), or it named something that did not exist and the
foreign key refused it with a `500`. The twins in the two trees checked what they checked in
their own words, and drifted.

```mermaid
flowchart LR
    Req["request"] --> RB["readBody(request)<br/>a JSON object, its fields unknown"]
    Params["params.id"] --> PI["pathId(params.id, 'card')<br/>a whole number of 1 or more,<br/>or 400 Invalid card ID"]
    Query["url.searchParams.get(...)"] --> QR["readQueryId, readLimit, readOffset,<br/>readQueryCount, readQueryDate"]
    RB --> FR["Field readers: readText, readNumber,<br/>readId, readBoolean, readChoice, readDate,<br/>readTime, readTimestamp, readUrl, readEmail,<br/>readEmailText, readColour, readCover, readList,<br/>readObjects, readIds, readChoices, readEmailList,<br/>and asObject for a list's entry"]
    FR -->|"the value as it is to be written,<br/>or undefined when not sent"| Write["The write"]
    FR -->|"anything else"| E400["error(400, 'title must be text')"]
```

- **`readBody(request)`** hands back the body as `Record<string, unknown>`. The type check
  then refuses a handler that uses a field as text, a number or anything else before a
  reader has looked at it. Its parameter is called `request` so that
  `tests/openapi-document.test.ts`, which follows the functions a handler calls, still sees
  `request.json()`.
- **A field reader** takes `(body, name, rule)` and hands back the value exactly as it is to
  be written, or `undefined` when the field was not sent and is not required. It refuses
  with `error(400, ...)` and a text that names the field (`title must be text`,
  `priority must be one of: low, medium, high, critical`). It looks at the type before
  anything else, so `["x".repeat(600)]` is not a list one long enough to pass a length check.
  Only the body's own fields are read.
- **Every reader's `rule`** may say `required` (not sent is `<name> is required`), `nullable`
  (`null` is read as `null`, where the column can be empty; anywhere else it is the wrong
  type), `keep` and `says`.
- **`keep`** is the value the row holds now. A value sent that is the same JSON type and
  value is handed back unchecked, so a page that sends a card's stored fields back, with a
  priority stored before the rules, still saves. A create has no `keep`.
- **`says`** replaces the reader's texts, all of them or one of `missing`, `type`, `empty`
  and `invalid`. It is how the texts that tests, documents and pages quote were kept:
  `says: { missing: 'Title is required' }`. A length limit is never reworded: since card
  2218 every one is answered in the reader's own words,
  `<name> must be at most <max> characters`, in both trees, where 40 readers in 32 route
  files had said `Title too long (max 500 chars)` and the like. `tests/request-body.test.ts`
  holds it by the code's shape, not its words: under `src/routes` and `src/lib/server`, a
  length reader (`readText`, `readUrl`, `readEmailText`, `readReportRecipients`, read from
  the module) whose rule, written in the call, has a `max` may be given only a `says`
  written out there as an object, whose `invalid`, if it has one, is a text or template
  ending `must be at most <max> characters` with the rule's own number (a path in front,
  as templates and backup destinations write it, is allowed). A constant, a shared or
  shorthand `says`, a helper's call, a spread and other words or another number each fail,
  named by file and line. What it does not prove: a route that throws its own `400`
  (`error(400, 'Title too long')`) without a reader, and a rule handed to a reader by name
  rather than written in the call (`readWebhookUrl`'s), are outside the check.
- **Nothing is turned into another type**, but for a number written as text that is exactly
  a number (`"5"`, `"-2.5"`, not `"1e3"`), which is read as that number wherever a number or
  an id is read.
- **`pathId(params.x, 'card')`** reads an id in the path: digits and nothing else, 1 or
  more, or `400` `Invalid card ID`, the guards' own words. `1.5`, `abc`, `0` and `1e3` are
  refused, where `Number()` and `isNaN` let some of them through. The query readers take
  the value and not the parameter's name (`readLimit(url.searchParams.get('limit'), ...)`),
  so the name stays written in the handler, where the OpenAPI test reads it.
- **What a field is for** lives beside the readers where more than one handler needs it:
  the four priorities and a card's category rule in `src/lib/server/card-fields.ts`, a
  colour in `src/lib/colours.ts` (`#rrggbb`, which a page can ask too), and a card's cover
  there too (`isCoverValue`: a colour or one of the eight gradients of `COVER_PRESETS`,
  which `readCover` reads and the board and the card window ask before they draw one,
  card 2010), the reporting
  fields' vocabularies in `reporting-fields.ts`, an account's username and email in
  `account-fields.ts`, a backup destination in `readDestination()` in
  `backup-destinations.ts`.

**The order of the refusals.** Each handler refuses in one order, so that a caller who would
be refused is not told about the fields first, and a field reader that needs the stored row
(`keep`) reads it after the row is found:

```mermaid
sequenceDiagram
    participant H as Handler
    participant T as writeAs (inTransaction), and a service in it
    participant G as Guard (route-guards.ts)
    participant R as Field readers
    H->>H: readBody(request), pathId(params.x)
    Note over H: 400 for the body or a path id
    H->>T: the write, and everything it depends on
    Note over T: 401 for a key or session that ended,<br/>then a service asks inWrite() and requireUser(caller)
    T->>G: requireBoard / requireCard / ...
    Note over G: 404 to everyone, then 403
    G-->>T: the row
    T->>R: every field, with keep: the row's value
    Note over R: 400 naming the field
    T->>T: what a field names (category, user, milestone)
    Note over T: 404, e.g. Category not found on this board
    T->>T: write, then commit
```

A create with no parent row to look for (`POST /api/boards`, a board grouping, a milestone of
no board) reads its fields first. Since card 2012 those reads, as every field read of a handler
that calls a service, are made inside `writeAs`, after the caller is asked for: a session that
ended while the body arrived is `401` before any field is read (see
[One Service per Action, Both Trees](#one-service-per-action-both-trees)). The token routes keep `tokens.ts`'s own order, the fields
before the card or subtask, and the three batches read every entry before they look for
what the entries name and report each problem in their `409`.

**The rule, held by a test.** `tests/request-body.test.ts` reads the source of every
`+server.ts` under `src/routes` and every module under `src/lib/server`, and fails on:

- a body read from the request (`json()`, `text()`, `arrayBuffer()`, `blob()`, `bytes()`,
  `formData()` or `.body`), on `request`, `{ request: req }`, `event.request` or a name typed
  `Request`, anywhere but `request-body.ts` and `api-errors.ts`, unless the read is on
  `NOT_JSON`: the import's `arrayBuffer()`, the upload's `formData()` and the gate's count.
  `STILL_READING`, the list of files that read their body themselves while the build moved
  them, is empty and is held empty;
- fewer than 80 calls of `readBody`, so that a parser that sees nothing cannot pass;
- a cast of what `readBody`, `readObjects` or `asObject` hands back, of a field of it, or a
  type written on the name it is kept in. `asObject(value)` hands back an entry of a list
  read with `readList` as a body when it is a JSON object (a dependency batch's `chain`),
  and the test follows what it hands back as it follows `readBody`'s; the entry was spread
  into a new object, which it could not see;
- a body, or an entry of `readObjects`, read by a key that is not written out
  (`updateData[key] = body[key]`), spread, handed to `Object.assign`, `Object.keys`,
  `Object.entries` or `Object.values`, walked with `for…in`, or with a field turned by
  `Number()`, `String()`, `Boolean()` or `!!`.

It finds a body by the names it is kept in, in the function it is kept in, so a body handed
whole to another function and used there is not followed: `normaliseReportingFields(body)`
and `recordTokenUsage(…, body)` read theirs with checks of their own. See
[Testing](testing.md#the-list-of-test-files).

### The four rules for `/api/v1/`

The external API answers every failure as JSON with one key, `message`. Four rules in the
gate make that hold for the failures no handler writes.

| Rule | What the gate does | Why |
|------|--------------------|-----|
| **The request asks for JSON** | The first statement of the branch sets the request's `Accept` header to `application/json`, on the request itself | SvelteKit answers a handler's `error(status, text)` as `{ message }` or as an HTML page by the `Accept` header, and picks the page for a caller that sends none. The header is set in place and the request is not replaced by a copy, because SvelteKit answers an error thrown out of the hook from the object it gave the hook |
| **The gate's own refusals are JSON** | The three `401`s and the `429` are returned as `json({ message, ... })`, never thrown | An error thrown by the hook is logged as an unhandled error |
| **No such route** | Once the key is accepted, a request whose `event.route.id` is `null` is answered `404 { "message": "Not found" }` by the gate, and SvelteKit is not asked | SvelteKit would render its 404 page: HTML, with the key owner's name, email and role in it, which the root layout loads for every page. It is answered only once the key is accepted, so without a key every path is a `401` |
| **A failure that is not JSON is answered again** | `failureAsJson()` looks at what `resolve` answered. A status of 400 or above whose content type is not JSON is replaced by a new `json({ message })` with the same status | What SvelteKit answers without asking a handler is plain text: above all a method the route does not have, a `405` |

`failureAsJson()` never touches a success, whatever its type, so a PDF and the OpenAPI
document pass through, and it hands back a failure that is already JSON as it is. The answer
it puts in place of another is made from nothing: only the `Allow` header is copied, because
the old answer's `Content-Length` and `Content-Type` describe the old body. Its `message` is
`<METHOD> method not allowed` for a `405`. For anything else it is what the old answer said,
if that was a plain text of 200 characters or fewer, and otherwise the standard phrase for
the status.

`/api/v1/openapi.json` returns before the key is asked for and before the rate limit. The
first and the last of the four rules cover it all the same, so a `POST` to it is a `405` in
JSON.

There are two `401`s. A request with no `Authorization` header, or one that is not a
`Bearer` header, is told so. A key that is not known, has expired or belongs to a deleted
user is answered `Invalid or expired API key`. `Bearer ` with nothing after it gets the
first: a header's value loses the spaces at its end before the gate sees it, so it arrives
as `Bearer`, which is no `Bearer` header. The gate had a third, `API key is empty`, for it,
which nothing could reach, and card 2117 took it out.

The key is looked up before anything is counted, and its requests are counted against the
key's own row (`findApiKey()`, then `checkRateLimit('apikey:' + id)`, then
`markApiKeyUsed()`), so a key over its limit is not marked as used. A request with no key
the gate accepts, a missing header included, is counted against the caller's address in a
bucket of its own, `apikey-none:`. The address is asked for guarded, because the adapter
throws when it is started with `ADDRESS_HEADER` and a request arrives without that header.

Every v1 answer carries the five security headers, the gate's own `401`s, `404` and `429`
included, set in step 6 like every other answer's.

### Everything else

Outside `/api/v1/` the gate decides who the caller is and where they may go, and leaves the
answer as SvelteKit made it.

- **The body guard still applies** to the internal routes under `/api/`.
- **A failure is JSON or a page by the `Accept` header.** A page's own `fetch` asks for
  anything and is answered `{ message }`. A browser that opens an internal route's address
  gets SvelteKit's error page, and a method the route does not have is plain text.
- **A script with no session is refused; a browser is redirected.** A request for an
  internal route (under `/api/`, outside `/api/v1/` and the public routes) with no session
  is answered `401` `{ "message": "Not authenticated" }` before its body is looked at,
  unless it is a navigation (`Sec-Fetch-Mode: navigate`, or an `Accept` that prefers
  `text/html`), which is sent to `/login`, as every page is. `isNavigation()` and
  `notSignedIn()` are in `gate-answers.ts`.
- **The public routes are a list of route ids, matched exactly:** `/login`, `/docs`,
  `/invite/[token]`, `/request`, `/request/[id]/confirm`, `/request/[id]/reply`, the five
  routes under `/api/requests`, and `/api/v1/openapi.json`. `/setup` is the set-up page,
  exactly. A path that is no route is never public. See
  [Authentication & Security](authentication-security.md#who-is-let-through-without-a-session).
- **A redirect is an answer the gate makes, not one it throws.** `sendTo()` makes it as
  SvelteKit would have made it of a thrown `redirect(303, ...)`: a `303` with `Location`;
  for a page's data request, `200` `{ "type": "redirect", "location" }`; and for a form a
  page's script posts, `200` `{ "type": "redirect", "status": 303, "location" }`.
  `tests/gate.test.ts` holds each against SvelteKit's own function for it.
- **`/api/v1` with nothing after it is not under `/api/v1/`.** It takes this branch, as a
  path under `/api/` that is no route: a script is answered `401`, a browser sent to
  `/login`.
- **The five security headers** are set on every answer, in step 6. See
  [Authentication & Security](authentication-security.md#security-headers).

### What is answered before the gate

SvelteKit answers three kinds of request without calling `handle`, so the gate cannot make
them JSON or head them. The first two are documented to callers as the exceptions, with
what to send instead, in the
[External API Reference](api-reference.md#answers-that-are-not-json), and all three, with the
static files of a built server, as the proxy's to head in
[Deployment](deployment.md#security-headers-from-the-proxy). A URL that is not validly
encoded, the third exception callers are told of, was a fourth up to SvelteKit 2.60; the
gate now answers it itself, with the same plain-text `400` `Malformed URI` and the security
headers (see [The path a rule is decided on](#the-path-a-rule-is-decided-on)).

| Request | SvelteKit's answer |
|---------|--------------------|
| A `POST`, `PUT`, `PATCH` or `DELETE` whose `Content-Type` is a form's or `text/plain`, with no `Origin` that matches the server. A built server only: the check is skipped under `vite dev` | `403`, as plain text unless the `Accept` header is exactly `application/json` |
| A path with a trailing slash that names a route | `308` to the path without it |
| A path that begins `/_app` and is no file the server has, but a call to a remote function, which the gate answers itself | `404` `Not found`, plain text |

The first is SvelteKit's protection against cross-site form posts (`csrf.checkOrigin`),
which the configuration leaves on.

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
| `admin` | All boards | All but export, import and Reset Everything (the mail and backup settings since card 2395) | Manage ordinary users |
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

    A->>S: Move a card to Complete, or create one there
    S->>S: emit xp-update (when XP was given) and celebrate
    S-->>A: SSE celebrate
    S-->>B: SSE celebrate
```

An event raised while a transaction is open is held until that transaction commits, and is dropped if it rolls back. See the next section.

A card created in a Complete column is completed as a moved one is, and celebrated the same way (card 2134; see [Data Model](data-model.md#one-completion-however-a-card-arrives)). A delete tells the pages open on every board it removes or empties with an `update` that names nothing, `{ type: 'board', action: 'deleted' }`, `{ type: 'card', action: 'purged' }` or `{ type: 'card', action: 'cleared' }`, and the board a deleted sub-board hung from, which is still there, with `{ type: 'board', action: 'sub_board_deleted' }` (card 2108; see [Notifications & Email](notifications-email.md#event-types)). The web application's routes tell what their `/api/v1/` twins tell (card 2143): an assignment, an unassignment and a comment edited send `{ type: 'card' }` to the card's board, a board updated sends `{ type: 'board' }` to that board once, and a sub-board made under a card, by either tree, sends `{ type: 'board', action: 'created' }` to the board that card is on.

**What an event carries.** An event goes, as it was emitted, to every listener of its board on the board stream and on the global one, and `emit` cannot choose a payload per listener. So an event names nothing that some reader of its board may not read; it is there to make the page read its board again, under the page's own access check (P4's rule for the events it added). A move between boards sends `moved_away` to the board the card left and `moved_in` to the board it joined, each with `type`, `action`, `cardTitle`, `fromColumn`, `toColumn`, `userName` and `userEmoji`, and neither names the other board (card 2181): they carried `toBoard` and `fromBoard`, which nothing read, and gave each board's listeners the name of a board some of them could not open. The move's two activity entries name neither board for the same reason (see [Data Model](data-model.md)).

```mermaid
sequenceDiagram
    participant M as The mover, editor of A and B
    participant S as Server
    participant RA as A reader of board A only
    participant RB as A reader of board B only
    M->>S: PUT /api/v1/cards/42/move, to a column of B
    S->>S: commit, then emit
    S-->>RA: update, moved_away, card and columns, no board name
    S-->>RB: update, moved_in, card and columns, no board name
    RA->>S: read board A again
    RB->>S: read board B again
```

### An open stream and its session

The gate looks at a request's session once, when it arrives, and a stream is one request that stays open. So each of the three streams (`/api/events`, `/api/boards/[id]/events` and `/api/logs/stream`) reads its session cookie when it is opened, and asks at each heartbeat it already sends (every 30 seconds; 25 for the log) whether that session is still open: there, not expired, and with an account. When it is not, the stream stops listening, stops its heartbeat and closes, and sends nothing more. Each asks `openSessionUser()` in `src/lib/server/auth.ts`, which gives the session's account as it is now. The two streams let in for an administrator's role end as well when the role they were let in for has changed: the log stream when the account is no longer an administrator, and `/api/events` when it has become one or stopped being one, since that decides which boards' events it sends. The board stream ends as well when its board has gone or the account can no longer open it, and says so first (card 2170, below). `openSessionUser()` and `sessionStillOpen()` share one private function with `validateSession()`, so that what counts as an open session is decided in one place. Unlike `validateSession()` they write nothing, log nothing and do not move the session's expiry on: an open tab would otherwise keep its session alive for ever.

```mermaid
sequenceDiagram
    participant P as An open page
    participant S as A stream route
    participant DB as sessions
    participant G as The gate
    P->>S: GET /api/boards/7/events (cookie: session X)
    S-->>P: : heartbeat
    Note over DB: session X deleted (a reset, a sign-out elsewhere, a password change, a restore)
    S->>DB: at the next heartbeat: is X there, unexpired, with an account?
    DB-->>S: no
    S-->>P: the stream ends, and nothing more is sent
    P->>P: keepStreamOpen waits 3 s
    P->>G: fetch the stream's address
    G-->>P: 401
    P->>P: stays closed, and signed-out.ts sends the page to /login
```

- **Only the session that opened it counts.** Another session of the same account ending does not end the stream.
- **A check that cannot be made ends the stream too.** The check runs inside the heartbeat's `try`. If it throws, the stream ends as for a session that has gone, and one `WARN` line is written under `AUTH`, "Live stream ended: its session could not be checked", with the route and the error. Nothing escapes the timer, where it would end the process.
- **What the page does.** Nothing new: `keepStreamOpen()` sees the stream drop, asks again three seconds later, is answered `401` and stays closed, and a page that holds a stream (a board, the dashboard, All Tasks, Burndown) goes to the login page by itself, about 35 seconds after the session ended at most. A page that holds none (Account, Admin, Reports) goes there at its next request. A stream that ended because its holder changed their own password opens again at once on the browser's new cookie, one that `/api/events` ended for a change of role opens again with the role as it is now, and the page re-reads its data. The audit console's own `EventSource` is refused when it tries again (`401`, or `403` for an account that is no longer an administrator), gives up, and the console shows it is disconnected.
- **What access each stream checks again** (card 2170). Each decides everything again at one moment, its heartbeat. The board stream asks, after the session, whether the board row is still there and the account as it is now can open it (`canViewBoard`); if not, it enqueues one last `update` with `{"type":"access"}` on its own stream, not emitted to anyone else, and ends, and the board page re-reads and shows its load's refusal, "You do not have access to this board" or "Board not found" (since card 2280 the access event is a read of the board's contents sent at once, never held, whose `403` or `404` empties the page and asks for the load once: see [The Board Page and the Card Window](#the-board-page-and-the-card-window)). It opens only on a board that is there and that the caller can open (`requireBoard(user, id, 'view')`: `404`, administrators included, `403`, or `400` for an id that is not one). `/api/events` keeps each board's answer until its next heartbeat, which forgets them all once the session and the role are checked; the 30-second clock it kept them by is gone. An administrator made an ordinary user stops receiving the log and every board's events at the next heartbeat, and a board's events too unless they are on it.
- **A deleted board is told first.** A delete's own event is delivered in the same synchronous run as its commit (`emit` queues it with `afterCommit`, and the outermost transaction starts the queued effects as it returns), and a heartbeat is a timer, which cannot run in between. A stream closed after an `enqueue` still hands the reader what was enqueued, so the deleted board's page always has `{ type: 'board', action: 'deleted' }` before the access event and the end. Board ids are never used again, so ending a stream on a deleted board loses nothing.

```mermaid
sequenceDiagram
    participant P as Board page (session X)
    participant S as /api/boards/7/events
    participant DB as Database
    participant R as Another request
    P->>S: GET (cookie X)
    S->>DB: requireBoard(user, 7, 'view')
    S-->>P: heartbeat comment
    alt access withdrawn (share removed, made private, role changed)
        R->>DB: the change
        Note over S: until the heartbeat, events still flow
        S->>DB: heartbeat - session X open? account now? board 7 there and openable?
        DB-->>S: no
        S-->>P: event update, data type access
        S-->>P: the stream ends
        P->>P: re-reads - You do not have access to this board
    else board deleted (card 2108)
        R->>DB: COMMIT the delete
        R-->>S: afterCommit, same run - update, type board, action deleted
        S-->>P: the deletion event, queued first
        S->>DB: next heartbeat - board 7 there?
        DB-->>S: no
        S-->>P: event update, data type access, then the end
    end
    P->>S: keepStreamOpen asks again after 3 s
    S-->>P: 403 or 404 - stays closed
```

Covered by `tests/live-streams.test.ts`.

In the browser every stream but one is opened by `keepStreamOpen()` in `src/lib/live-stream.ts`. The one is the audit console's live log, `src/routes/audit/+page.svelte`, which opens its own `EventSource` on `/api/logs/stream` and leaves reconnecting to the browser: it tries again after a dropped connection, and gives up on an answer that is not a stream, a `401` or a `403` among them, when the console says it is disconnected. On reconnecting the stream sends its last 100 entries again, and the console skips each it has shown: one whose id is at or below the last one shown and which is no later than it (the ids count from 1 again after a restart). After a failure it waits 3 seconds, then twice as long after each failure that follows, up to five minutes; it asks the stream's address with `fetch` before it opens it again, and leaves it closed after a `401`, `403` or `404`. A stream that opens again after a gap has the page re-read its data, since nothing replays the events it missed. See [Authentication & Security](authentication-security.md#who-is-let-through-without-a-session).

### The board page follows the board it shows

The board page's stream is the page's own: `connectSSE(data.board.id, ...)` (`src/lib/board/sse.ts`) is called in its `onMount` and closed in its `onDestroy`. SvelteKit keeps a page's component when only its params change, so until card 2184 a sub-board badge, a breadcrumb, a link in the card window, or Back and Forward between two boards showed the second board in the first board's page, still listening to the first board's stream, with its selection, panels, search, filters and card window carried over. `src/routes/board/[id]/+layout.svelte` now renders the page inside `{#key page.params.id}` (`page` from `$app/state`): a change of board destroys the page, which closes the first stream, and makes it afresh, which opens the second, with everything else empty. The key is the board and not the address, so a `?card=` link on the same board, `invalidateAll()` and SvelteKit's `replaceState` keep the page, its stream, its drag state and its scroll. Since card 2280 the page calls `invalidateAll()` in one place only, when a read of its board is refused, and makes its board state and its card-window controller once per page, so the key makes them afresh for each board too: see [The Board Page and the Card Window](#the-board-page-and-the-card-window).

```mermaid
sequenceDiagram
    participant U as Reader on board 1
    participant K as SvelteKit router
    participant L as board/[id]/+layout.svelte
    participant P1 as Page for board 1
    participant P2 as Page for board 2
    participant S as The board's event stream
    U->>K: a sub-board, breadcrumb or dependency link, or Back
    K->>L: new page data and page.params.id = 2, in one update
    L->>P1: key changed: destroyed
    P1->>S: onDestroy closes the stream of board 1
    L->>P2: made afresh with board 2's data
    P2->>S: onMount opens the stream of board 2
    K->>P2: afterNavigate: closes a window it calls for, opens the card a link named
    Note over L,P2: a link to a card on the same board keeps P1 and its stream
```

The page's `afterNavigate` (card 2164) opens the card `?card=` names, after every navigation, the first load included. Before it does, it closes a card window open at the time when `navigationClosesWindow(from, to, ...)` in `src/lib/board/card-actions.ts` says so (Q-F's review): on a navigation to another board, a card named or not, which the key makes certain too; and on the same board when a saved card's window is open and the new address names no card, as Back after a dependency link does. A New Task window on the same board is left open.

### A page left open across a deploy

A page keeps running the scripts it was loaded with until it is loaded again, against whatever server is now answering. Since card 2167 each open page asks once a minute whether the server is a newer version, and says so when it is. Until then `svelte.config.js` set no `kit.version`, SvelteKit's interval was 0, and a page never asked.

```mermaid
sequenceDiagram
    participant P as An open page (old scripts)
    participant F as fetch, watched by hooks.client.ts
    participant A as Node adapter (static files)
    participant G as The gate and the routes
    loop every 60 s until a new version is found
        P->>F: GET /_app/version.json (no-cache)
        F->>A: passed through: not under /api/
        A-->>F: { "version": "the time of the build" }
        F-->>P: handed back untouched
    end
    Note over P: version differs: updated.current = true
    P->>P: the bar, with Reload. Nothing reloads by itself
    alt Reload pressed
        P->>G: a full page load: the new scripts
    else a link or goto to another page
        P->>G: beforeNavigate: location.href = to.url (a full load)
    end
```

- **How it asks.** `kit.version.pollInterval` is `60_000` in `svelte.config.js`. SvelteKit's `updated` then fetches `/_app/version.json`, with `no-cache` headers, every 60 seconds, compares its `version` with the one the page was built with, and stops asking once they differ. `kit.version.name` is left as SvelteKit's default, the time of the build: every image built is a new version, a restart of the same image is not, and going back to an older image is. Under `vite dev` it never asks.
- **What answers it.** The node adapter serves `/_app/version.json` from the build, as it serves every static file, before `handle` is called, and does not mark it immutable (see [What is answered before the gate](#what-is-answered-before-the-gate)). So the check needs no session, is counted by no rate limit, writes no system-log line, and works on the login page and the public request form alike. The proxy in front caches nothing ([Deployment](deployment.md#reverse-proxy--nginx)).
- **The client hook is unchanged.** SvelteKit calls the global `fetch` when its timer fires, which `src/hooks.client.ts` has by then replaced with the watch for an ended session. The address is not under `/api/`, so `endsTheSession()` in `src/lib/signed-out.ts` hands the answer back untouched and never sends the page to sign in. A stale page that the watch does send to sign in goes there as a new page load, and so arrives on the new version.
- **What the page shows.** While `updated.current`, from `$app/state`, is true, the root layout (`src/routes/+layout.svelte`) draws a bar across the foot of the window, `role="status"`: "DumpFire has been updated. Save anything you are editing, then reload to use the new version.", with a **Reload** button that calls `location.reload()`. It cannot be closed, and the page never reloads by itself, so nothing typed in a card's window or a form is lost. While it shows, its height is set on the page's root as `--update-bar-space`, and every window (`.modal-overlay` in `src/app.css`), the toast and the user badge keep clear of it by that much. It was at the top until Q-F's review, where on a phone it covered a card window's title and its ✕.
- **Above everything.** The bar is drawn after `.app-layout`, not inside it, at `z-index: 10001`. `.app-layout` is `position: relative; z-index: 1`, which makes everything a page draws, its windows and overlays included, one layer beneath anything outside it; and the toast is at 10000. `tests/page-failures.test.ts` holds the bar above every other `z-index` under `src`. The user badge in the corner is drawn inside `.app-layout`, at `z-index: 100`, beneath the pages' windows (1000 and up): outside it, it was drawn above every window and its dimmed backdrop. It is opaque, `var(--bg-elevated)` with `var(--shadow-md)` over the global `.glass`'s background of 2 to 6% (card 2239), and `--user-badge-space` on `.app-layout` (the badge's offset, its height of 18px plus the taller of 28px and 1.8rem, about 47px at the default font size and more when the root font is larger, a gap and `--update-bar-space`) is where each page ends its last line or its scroll (the API docs' sidebar included), so nothing a page draws is left under it: the audit page's Live Console footer read through it.
- **The next move is a full load.** A `beforeNavigate` in the same layout sets `location.href = to.url.href` when `updated.current && !willUnload && to?.url`, SvelteKit's documented pattern, so a link or a `goto` once the bar has shown loads the new version.
- **The first release.** A page loaded before the release that brought this asks nothing, so for that release open tabs are reloaded by hand: see [Deployment](deployment.md#updating-a-running-installation), step 7.

## The Board Page and the Card Window

Card 2280 (part B of card 2012's plan, `docs/planning/card-2012-service-layer-and-pages.md`). Until then the board page called `invalidateAll()` 23 times: after each of its own writes, and on every live event from its board's stream, one call per event with nothing to gather a burst. Every write is told to every page open on its board, the page that made it included, so each change on the board page re-ran the whole board load twice, once after the write and once for its own echo, breadcrumbs, linkable boards and all; a bulk change of 20 cards by someone else re-ran it 20 times; and whichever re-read landed was copied over the page by an `$effect`, under a drag in hand or a field being typed in. Twenty of the page's writes also threw their answer away, so a refusal said nothing and the change stayed on screen until the next re-read put it back.

Now the page draws from one **board state**, made once from its load. A change of the page's own is shown at once and sent; its answer is taken, or, refused or unanswered, that change alone is taken back and the server's words are said. A live event asks for one **read of the board's contents**, `GET /api/boards/[id]/contents`, gathered with any others in the next quarter of a second and never sent while a drag or a write of the page's own is out. The whole load is asked again in one case only: when that read is refused, so that the load's own refusal page shows. The card window is opened, kept in step with the board, saved and archived by one **controller**. And the page and the window are split into components: eight new ones for the board, eleven for the window.

### How it fits together

```mermaid
flowchart TB
    subgraph Page["Board page: board/[id]/+page.svelte"]
        Comps["8 board components<br/>header, columns, cards, panels"]
        Fns["the page's write functions"]
        State["BoardState<br/>board-state.svelte.ts"]
        Sched["refresh schedule<br/>refresh-schedule.ts"]
        Patches["board-patches.ts<br/>a change and its undo"]
        Verdict["contents-answer.ts<br/>apply, refused or keep"]
        Window["CardWindow<br/>card-window.svelte.ts"]
        Modal["CardModal.svelte<br/>and its 11 sections"]
        Stream["connectSSE<br/>sse.ts"]
    end
    subgraph Server["Server"]
        Load["+page.server.ts load"]
        Route["GET /api/boards/[id]/contents"]
        Reader["readBoardContents<br/>board-contents.ts"]
        Writes["the write routes<br/>/api/cards, /api/columns, /api/boards"]
        Events["/api/boards/[id]/events"]
    end
    Load --> Reader
    Route --> Reader
    Load -->|"data, once per board"| State
    State -->|"draws"| Comps
    Comps -->|"callbacks"| Fns
    Fns -->|"write, writeCard, writeColumn"| State
    State -->|"the change shown, its undo kept"| Patches
    State -->|"send"| Writes
    Writes -->|"commit, then emit"| Events
    Events --> Stream
    Stream -->|"update with type access"| State
    Stream -->|"any other update, a reconnect, a return to the tab"| State
    State -->|"refresh, accessChanged"| Sched
    Sched -->|"one read at a time"| Route
    Route --> Verdict
    Verdict -->|"apply: take, the sorts put back"| State
    Verdict -->|"refused: emptied, invalidateAll once"| Refusal["the load's refusal page"]
    Modal -->|"onSave, edits"| Window
    Window -->|"the card by id, writeCard, hold, refresh"| State
```

- **One reader for the first draw and every refresh.** `readBoardContents(user, boardId)` in `src/lib/server/board-contents.ts` is the board load's body, moved whole. The page's load (`src/routes/board/[id]/+page.server.ts`) returns it, and so does the new internal route `GET /api/boards/[id]/contents`, so the first draw and a refresh cannot differ: the same access check, the same fields, each as this caller may see it. It answers the board row, the breadcrumbs, the caller's role (`canEdit`, `canManage`, `userBoardRole`) and the linkable boards beside the columns with their cards, the categories, labels, members, blocked state, token totals and goals, so a rename by someone else, or a role taken away or given, shows at the next refresh.
- **Live events still carry nothing readable** ([What an event carries](#real-time-updates-via-sse)). The page does not patch itself from an event; an event is a reason to read the board again, under the reader's own access check.
- **Holds and generations.** Every write of the page's own, and a drag from its first move to the move's answer, holds the reads. A read already out when a hold is taken, or when a write settles, was sent before that change and may answer the board as it was: its answer is dropped, by its generation number, and the board is read again once the last hold is let go.
- **Writes through the board state.** `boardState.write(change, send, words, take?)` shows the change, holds, sends, and on success puts the answer's value of each field sent on the board (`writeCard`, `writeColumn`); on a refusal or no answer it takes that change alone back, reads the board once, and gives the page the words to say. The board is not read after a write that was taken: its own live event is.
- **The card-window controller.** `new CardWindow(boardState, boardId)` opens the window on a card by its id and hands the window the board state's copy of it as each read arrives. A save sends only the fields the user changed, through `writeCard`.
- **A refused read shows the refusal page.** A `401`, `403` or `404` from the contents route empties the board state and calls `invalidateAll()` once, so the load runs, refuses in its own words ("You do not have access to this board", "Board not found") and the error page replaces the board. If that load finds the board open after all (access given back meanwhile), the page's one `$effect` that reads `data` hands it to `boardState.take()`, and the state follows the board again with a new schedule.

One write and one refresh, as they happen:

```mermaid
sequenceDiagram
    participant U as User
    participant P as Board page
    participant B as BoardState
    participant Q as Refresh schedule
    participant S as Server
    U->>P: change a card's priority from its menu
    P->>B: writeCard(card 42, priority high, send, words)
    B->>Q: hold, which moves the generation on
    B->>B: patchCard - shown at once, the undo kept
    B->>S: PUT /api/cards/42
    alt taken
        S-->>B: 200 with the row
        B->>B: patchCardStill - the answer's priority, only while it still shows high
    else refused or no answer
        S-->>B: 4xx, 5xx or nothing
        B->>B: the undo, only while it still shows high
        B->>Q: one read asked for, held for now
        B-->>P: the server's words
        P->>U: an error toast in those words
    end
    B->>Q: settled, then the release (a read that waited goes at once)
    S->>S: commit, then emit an update to board 7
    S-->>P: the update, its own echo, through sse.ts
    P->>B: refresh
    B->>Q: schedule - 250 ms after the last call, at most 1 s after the first
    Q->>S: GET /api/boards/7/contents (one at a time, none while held)
    S-->>Q: 200, the contents as this caller may see them, private, no-store
    Q->>B: applied only if the generation has not moved - take, the sorts put back
```

### The modules in `src/lib/board`

| Module | What it holds | Used by |
|---|---|---|
| `board-state.svelte.ts` (new) | `class BoardState`, a `$state` field for each key of the contents (`board`, `breadcrumbs`, `columns`, `categories`, `labels`, `linkableBoards`, `canEdit`, `canManage`, `userBoardRole`, `boardUsers`, `blockedState`, `cardTokens`, `boardTokenSummary`, `milestones`), with `columnSorts` and `refused`. `new BoardState(data, { invalidate, fetch?, ...timing })`; `take(data)`; `setSort(columnId, sort)`; `refresh()`; `refreshNow()` (no 250 ms wait, awaitable, still held; the sub-board link and delete); `accessChanged()`; `hold(options?)`, `holds`, `inFlight`; `write`, `writeCard`, `writeColumn`; `dispose()`. Types `WriteResult` (`{ ok: true, res, answer }` or `{ ok: false, failure }`), `WriteWords` (`refused`, `noAnswer`) | The board page; `bulk-actions.ts` (`BoardWriter`); `card-window.svelte.ts` (`CardWindowBoard`) |
| `refresh-schedule.ts` (new) | `refreshSchedule(run, timing?)`: `schedule()`, `now()`, `access()`, `hold(options?)` returning a `Release` (counted once, with `released`), `settled()`, `holds`, `inFlight`, `dispose()`. `REFRESH_DELAY_MS` 250, `REFRESH_MAX_WAIT_MS` 1,000, `HOLD_WATCHDOG_MS` 30,000, `BULK_HOLD_MS` five minutes; `HoldOptions` `{ watchdog?, watchdogMs? }`. Plain TypeScript on the page's own timers, so the tests run it with fake ones | `BoardState`; the page imports `BULK_HOLD_MS` and `Release` |
| `board-patches.ts` (new) | Pure functions on the columns, each `(columns, …) → { columns, undo(current) }`: `patchCard`, `moveCards` (sets `columnId` and `position`), `insertCard`, `removeCard`, `patchColumn`, `insertColumn`, `removeColumn`, `reorderColumns`. And `patchCardStill`, `patchColumnStill` (an answer put only on a field that still shows what its write set), `answeredFields(answer, fields)`, `copyColumns`, `withCurrentCards(columns, current, dragged)`, `undoDrag(current, before, dragged)`. Nothing given is changed; a column or card not touched is handed back as the same object | `BoardState`, the page, `bulk-actions.ts`, `card-window.svelte.ts` |
| `contents-answer.ts` (new) | `contentsVerdict(status)`: 2xx `apply`, `401`, `403` or `404` `refused`, anything else or no answer `keep`. `askForContents(boardId, fetch)`, which never throws, asks with `cache: 'no-store'`, and takes a success that is not the contents (a proxy's page) as `keep`. `type BoardContentsData`, the page's view of the reader's answer (the server's type is not imported into the page), `BreadcrumbType`, `BoardBlockerType` | `BoardState`, the page |
| `card-window.svelte.ts` (new) | `class CardWindow(board, boardId)`: `open`, `cardId`, `columnId`, `edits` (`$state.raw`), the getters `card` and `gone`; `openCard(card)`, `openNew(columnId)`, `close()`, `save(saved)` → `SaveResult` (`{ ok: false, failure }` or `{ ok: true, told }`), `archive(cardId)` → the words, or `null` once archived. `class WindowEdits` (`started`, `touched`, `follow(shown, now, held?)`); `WINDOW_FIELDS`, the twelve fields a save sends; `windowFields(card)`, CardModal's own initialisers; `changedFields(started, saved)`; `CARD_GONE`; types `CardWindowSave`, `CardWindowBoard`, `Told` | The board page; `CardModal.svelte` (`WindowEdits`, `windowFields`) |
| `sse.ts` | `connectSSE(boardId, callbacks)`: `onUpdate(event)` is handed what the `update` said, `boardEvent(e.data)` (the parsed object, or `null`), and `null` for a reconnect and a return to the tab, so the page can tell the access event from the rest | The board page |
| `card-actions.ts`, `board-actions.ts`, `bulk-actions.ts`, `dnd-handlers.ts` | Each write gives back its answer, or the words for a refusal. `saveCard` gives back `failure`, and makes a new card with its subtasks, labels, people and sub-boards in one request (card 2296; `assignPending` and the per-part failures are gone; `noAnswer` marks a create that got no answer, which may have made the card); `duplicateCard` sends the copy's subtasks in its one `POST /api/cards`, so the copy is made whole or not at all, a subtask refused named by its title (card 2389); `setPinned`. `bulkMove`, `bulkDelete` and `bulkPriority` take the board state (`BoardWriter`) and show every card at once; `bulkMove` sends one `reorderCards` request, and only `bulkDelete` and `bulkPriority` send card by card, each after the one before is answered; `bulkPriority` returns `{ changed, failed }`. `confirmOnHold` sends the move first and the note only once the move is taken, returning `{ failure, noteFailure }`. `board-actions.ts`'s `addCategory` and `deleteCategory`, which nothing called, are gone | The board page and the card-window controller. Since card 2281 All Tasks, All To Do and the plan page save their card window through the controller and call none of these; `saveCard`'s update path (an `editingCard` given) has no caller in `src` now, the controller using its create path alone, and is still called by the tests |

```mermaid
classDiagram
    class BoardState {
        board
        columns
        labels
        boardUsers
        columnSorts
        refused
        take(data)
        refresh()
        refreshNow()
        accessChanged()
        hold(options) Release
        write(change, send, words, take)
        writeCard(cardId, fields, send, words)
        writeColumn(columnId, fields, send, words)
        dispose()
    }
    class RefreshSchedule {
        schedule()
        now()
        access()
        hold(options) Release
        settled()
        holds
        inFlight
        dispose()
    }
    class CardWindow {
        open
        cardId
        columnId
        edits
        card
        gone
        openCard(card)
        openNew(columnId)
        close()
        save(saved) SaveResult
        archive(cardId)
    }
    class WindowEdits {
        started
        touched
        follow(shown, now, held)
    }
    BoardState *-- RefreshSchedule : reads through
    CardWindow --> BoardState : CardWindowBoard
    CardWindow *-- WindowEdits : one per window
```

### The components

The page (2,002 lines, CRLF) keeps its script whole: every `$state`, every write, the board state, the card window, the drag handlers and the windows. It keeps the kanban skeleton too, because `animate:flip` must sit on the direct child of a keyed `{#each}` and svelte-dnd-action needs a zone's direct children to be its items: each `.kanban-column` and `.kanban-card` element stays in the page, and their contents are components. Each component under `src/lib/components/board/` is handed what it shows as props, `bind:` for what is typed in it, and calls back into the page's functions:

| Component | What it draws |
|---|---|
| `BoardHeader.svelte` | The header: breadcrumbs or the back button, the emoji, the name and its edit box, the cost pill, the search, the assignee filter, Hide blocked, the view switch, Planning, All To Do, Add Column, the theme picker; snippets `xp` and `more` |
| `XpLeaderboard.svelte` | The XP bars, from a sorted copy of the page's list (card 2304: it sorted the page's state in place while drawing, which Svelte refuses) |
| `BoardMoreMenu.svelte` | The More menu and its items, one callback each |
| `KanbanColumnHeader.svelte` | A column's head: colour bar, title and rename box, count, sort badge, Add Task, colour picker, column menu with its WIP-limit box. The rename and WIP-limit state stays in the page, one for the whole board |
| `KanbanCardBody.svelte` | Everything inside a card on the board: cover strip, pin, New badge, selection tick, drag handle, category strip, title with its inline edit and priority dot, description, On Hold note, badges, labels, assignees |
| `ActivityPanel.svelte`, `ArchivePanel.svelte` | The Activity Log's and Archived Cards' bodies |
| `SidePanel.svelte` | The frame both panels share: heading, close button, scrolling body |

Four rules that style a component's element from the page's element are `:global` under the page's element (`.kanban-column:hover :global(.column-actions)`, `.kanban-card:hover :global(.drag-handle)`, `.kanban-card.card-pinned :global(.new-badge)`, `.wip-warning :global(.column-top-bar)`). Without `:global` Svelte would scope such a rule to the page's own markup, where it matches nothing. `npm run check` does not flag the four because they are `:global`: the part under `:global` is never judged against the page's markup, so `css_unused_selector` never applies to it (not because of `svelte.config.js`, which no longer filters that warning, card 2357).

The card window, `src/lib/components/CardModal.svelte` (1,273 lines, CRLF), keeps its props, every typed field's `$state` initialiser and `save()`, the header, the title, the tabs, the On Hold box, the labels, the footer and `handleKeydown`, and with them everything that must outlast a section being hidden (a section inside `{#if}` is destroyed when it hides, so state of its own would be lost on a switch of tab). Its sections are under `src/lib/components/card/`, each handed the window's state as props and `bind:`:

| Component | What it draws, and the writes it sends |
|---|---|
| `CardDescription.svelte` | The description's Write and Preview tabs |
| `CardMetaChips.svelte` | The priority, category, due date and assignee chips with their dropdowns; `assignUser`, `unassignUser` |
| `CardReportingFields.svelte` | The Reporting section's five fields |
| `CardSubtasks.svelte` | A saved card's subtasks and a new card's pending ones; `toggleSubtask`. It draws `CardTokenCost` |
| `CardTokenCost.svelte` | The cost block: summary, models, entries |
| `CardComments.svelte` | The Comments tab; `postComment`, `deleteComment`, `saveEditComment` |
| `CardAttachments.svelte` | The Files tab; `uploadFile`, `deleteAttachment` |
| `CardDependencies.svelte` | The goal and the dependency lists with the picker; `addDependency`, `removeDependency`, `saveMilestone`. Every close of the picker (Escape, ✕, a link added, the other list's picker opened) goes through the window's `closePicker` (`onClosePicker`), which clears the search's 250 ms timer and moves its number on, so a search typed just before is not sent (card 2388) |
| `CardSubBoards.svelte` | The Sub-board section, saved card and new card |
| `CardCoverPicker.svelte` | The Cover section; `setCover`, `clearCover`. Its custom colour opens on `coverPickerColour(coverUrl)` (`$lib/colours`): the cover's own colour, a gradient's first colour, or `#6366f1`, never black |
| `CardTemplates.svelte` | The Save as Template and From template dialogs; `saveAsTemplate`, `deleteTemplate` |

The window's fifteen writes of its own (now in its sections, but for the New Category form's `createCategoryInline`, which stays in the window) neither hold the board's reads nor change the board state: the board shows them at the read their live event asks for. All Tasks, All To Do and the plan page draw the same `<CardModal>` and, since card 2281, save it through the same controller over their own lists: see [The Card Window off the Board](#the-card-window-off-the-board).

### The rules

- **Timing.** A call to `schedule()` waits 250 ms for the next and sends one read for the burst, but never more than 1 s after the first call not yet served, so a stream of events still shows. One read is out at a time; a call while one is out is served by one more read after it, never one beside it.
- **Generations.** Each read is sent with the schedule's generation. `hold()` and `settled()` move it on: a write's `finally` calls `settled()` before it lets its hold go. An answer whose generation has moved is not applied; the board is read again, as urgently as that read was, for whoever waited on it.
- **Holds are a count**, each let go once, and the last let go sends the read that waited at once. Every write of the page's own holds while it is out (`write()` does it itself; the card window's `archive` and a new card's save hold too). A drag holds from its first consider (`holdDrag`) to the move's answer (`takeDragHold`, let go in the finally that follows the move); a keyboard drag stopped with Space, Enter, Escape or a click outside (`DRAG_STOPPED`, with no finalize) lets go in `stopDrag`. No hold is taken during an inline edit: the text being typed is the edit's own state, and a read cannot overwrite it.
- **Watchdogs.** A hold left open is let go after 30 s, so the board cannot stop following for good. The On Hold note window and the blocked window hold for as long as they are open with `hold({ watchdog: false })`, unwatched, since their end is a person's Confirm or Cancel; the schedule's `dispose()` spends them with the page. The three bulk changes hold with `{ watchdogMs: BULK_HOLD_MS }`, five minutes: a bulk archive or priority change sends its cards one after another, which can take longer than 30 s, and `fetch` has no time limit of its own.
- **An access read is not held, and its answer not dropped.** `accessChanged()` sends its read as soon as no read is out, held or not, and its answer is applied even when the generation has moved, so a run of drags and writes cannot keep a refusal back; when it has moved, an ordinary read is asked as well, which the last release sends.
- **The still-holds rule.** A write's answer, and its undo, are put only on a field that still shows the value that write set (`patchCardStill`, `patchColumnStill`, and the undo of `patchCard` and `patchColumn`). Two quick changes to one field then keep the later one, whichever is answered first, and a refused first change does not undo the second. Of two quick changes both refused, the screen shows the first's value until the one read the refusals ask for.
- **`answeredFields`.** A taken write puts on the card only the answer's value of the fields it sent, never the whole row: the row's other fields are as the server had them when that write was answered, and would undo a second change still out. A patch merges: nothing the answer lacks is lost (a bare row has no subtasks, labels or assignees).
- **`withCurrentCards` and `undoDrag`.** A drop's columns, and the columns kept when a drag began (`dragFrom`, `copyColumns` at the first move, and at each keyboard hop), are stale once another write is answered or taken back. A drop is drawn through `withCurrentCards(result.updatedColumns, boardState.columns, dragged)`, and a refused, blocked or cancelled move is put back with `undoDrag(boardState.columns, dragFrom, dragged)`: only the columns that held a dragged card then or hold one now are rebuilt, in their old order, with the cards as they are now; a card archived meanwhile stays off.
- **What is read again, and what is not.** A taken write is not followed by a read; its live event is. A refused or unanswered write is followed by one. A restore, a duplicate and a new card's save read the board once, since the card they add is the reader's to draw with its subtasks, labels, sub-boards and assignees, where an answer is a bare row. The sub-board link and delete `await boardState.refreshNow()`, since a sub-board's progress is worked out on the server. The share window's close reads it for the members.
- **The column sorts** are the board state's (`setSort`), put back on the columns after every read.

### The card window's save

- **It sends only what the user changed.** The controller compares what the window hands `onSave` with what each field started from (`changedFields`): empty, `null` and left out are one value, and the title, summary and customer impact are compared trimmed. A change someone else made to another field while the window was open is not sent back over theirs (the lost update card 2183 noted). A save with nothing changed sends nothing and closes the window. A field both changed is the last save's.
- **It goes through `writeCard`**: shown on the board at once, held while out; taken, the answer's value of each field sent; refused or unanswered, those fields alone put back (under the still-holds rule), the server's words handed back for the page to say, and the window left open with what was typed.
- **`WindowEdits`, and fields that follow the board.** On the board page the window is handed the controller's `edits`, and CardModal's one follow `$effect` calls `edits.follow(shown, windowFields(card), focusedField)` after each change typed and each read. A field shown with a value other than the one it started from is touched, for good, and stays as typed. Each untouched field whose value on the board has changed is brought into the window, and `started` moves to it, so it is never sent. A touched field set back to its start is still sent when the board's value has moved since, since what the window shows is the user's choice. The box that has the focus (`focusedField`, from the overlay's `focusin` and `focusout`) is not brought until it is left, so a read never moves the caret; the focus alone is no touch. All Tasks, All To Do and the plan page hand the window their controller's `edits` the same way since card 2281 (the C3a-1 review); before, they passed none, so their windows were filled once and their saves sent every field.
- **A new window is a new `edits`.** `edits` is `$state.raw`, a new `WindowEdits` at each `openCard`, `openNew` and `close`, and the page draws the window inside `{#key cardWindow.edits}`, so each open makes the window afresh from its card. The first read of `card` after opening sets `edits.started` from the card the window is made with.
- **A card the board loses** (archived, deleted or moved away by someone else) is shown as it was last found; `gone` is true, the window shows `CARD_GONE` ("This card is no longer on this board.") through its optional `notice` prop, and a save is refused with no request.
- **A new card** is made by `cardActions.saveCard` in one `POST /api/cards` that carries its pending subtasks, its template's labels, the people chosen and its sub-boards (`subtasks`, `labelIds`, `assigneeIds`, `subBoards`; card 2296). The route's `createCard` (passed `withContents`, which v1's create is not) writes each part in the card's transaction through the service its own route calls, with that route's options (`createSubtask`, `toggleCardLabel`, `assignToCard`, `createBoard`; the one `_PAGE_OPTIONS` constant of each service, which route and `createCard` both hand), so the entries, live events and mail are the separate requests' own, sent after the one commit; any refusal refuses the whole request in the part's words, its entry named by its place as sent (`subtasks[1]: title is required`). Each list holds at most 100, so one request can still hold 400 parts. A create refused keeps the New Task window open with everything typed, and `#create` names the part as the window holds it (`namePart`: `"bob" could not be assigned: User does not have access to this board`); a template label no longer the board's is not sent; with no answer the board is read, so a card made after all shows behind the window, and the words end "Check the board before creating it again."; one made says "Created" and each sub-board made, and the board is read once. Each part used to be its own request after the card, a refusal naming it with the card kept.
- **Archive** is sent from the page's confirmation alone, by `cardWindow.archive(cardId)`: the card is taken off the board and its window closed only once the server has archived it.
- **The controller says nothing itself.** It hands back what to say (`failure`, or `told` with each `failed`), and the page puts it in its toasts, with the navigation it started in.
- **The window's keys.** Ctrl+Enter (Cmd+Enter) calls `save()` once (not on a held key's repeat, and not while a template dialog is open); a box with an Enter of its own (a comment, a comment being edited, a label's name, a sub-board's name, the new category) does its own job and stops the key. `save()` sends one save at a time: `saving` is set while the page's promise is out, and Save, Enter in the title and Ctrl+Enter wait. Escape closes the innermost thing open (a template dialog, the template picker, the new category form, a chip's dropdown, the dependency picker, the sub-board link picker) and the window only when nothing is, and never while a save is out; Cancel and ✕ always close.

## The Other Large Pages, in Components

Card 2281 (part C of card 2012's plan, `docs/planning/card-2012-service-layer-and-pages.md`) split the four other pages over about 1,900 lines the way part B split the board page, and changed nothing any of them does: the admin page (3,073 lines, now 317), the dashboard (2,348, now 193), All Tasks (2,029 after slice C3a-1, now 768 with slice C3b's re-read) and the plan page (1,997, now 311). Reports, the docs page and Burndown (each under 1,500) were left. Each slice moved code line for line (every moved line unchanged but for what a component boundary forces; 97.2 to 99.7% of the lines removed from the dashboard, All Tasks and the plan page reappear unchanged), compiled the page's CSS before and after to show no rule lost and no winning rule changed, and kept every test's meaning: the tests that read a page's source now read the file that holds each piece, and look for what is said to be gone in the page and every one of its components. All To Do (890 lines) was not split; it moved its card window onto the controller with the others.

```mermaid
flowchart LR
    subgraph Admin["src/routes/admin/+page.svelte"]
        AF["isSuperadmin frame,<br/>confirm, reset notice,<br/>invite link"]
    end
    subgraph Dash["src/routes/+page.svelte"]
        DF["live refresh, Delete Board,<br/>the grid, the window flags,<br/>the clock"]
    end
    subgraph Tasks["src/routes/all/+page.svelte"]
        TF["stream listener, filters,<br/>buckets, Load more, Statistics,<br/>card window, confirm"]
    end
    subgraph Plan["src/routes/plan/[id]/+page.svelte"]
        PF["summary, mutate,<br/>card window"]
    end
    AC["src/lib/components/admin/<br/>14 components"]
    AM["src/lib/admin/<br/>send.ts, format.ts"]
    DC["src/lib/components/dashboard/<br/>7 components"]
    DM["src/lib/dashboard/format.ts"]
    TC["src/lib/components/tasks/<br/>6 components"]
    PC["src/lib/components/plan/<br/>7 components"]
    PG["src/lib/plan-graph.ts"]
    RS["src/lib/board/refresh-schedule.ts"]
    PW["src/lib/board/page-card-window.svelte.ts"]
    AF --> AC
    AC --> AM
    DF --> DC
    DC --> DM
    TF --> TC
    TF -->|"one re-read per burst"| RS
    TF --> PW
    PF --> PC
    PC --> PG
    PF --> PW
    ToDo["src/routes/todo/+page.svelte<br/>(not split)"] --> PW
```

### How a page is split

- **What stays in the page.** Its props and load, its live refresh, its re-reads after the writes it keeps, every write the page's parts share (the plan page's `mutate`, the dashboard's Delete Board), the dialogs drawn over the whole page (each page's confirm), and the card window. Each component is drawn where its markup was, so the order of windows on screen is as it was.
- **A write that moved into a component took its re-read with it.** A page that keeps writes of its own still calls `invalidateAll()` after them, as before the split (its load is cheap and its writes rare); the admin page keeps none. Eight components call it after their own writes, as the page did: `BoardContextMenu`, `MoveCardModal`, `TasksArchivePanel`, `DangerZonePanel`, `UsersPanel`, `TeamsPanel`, `BoardManagementPanel` and `ResetPasswordDialog` (which also re-reads as it opens, for the key counts). The other components that write re-read nothing, as their code did on the page: `AppUrlPanel`, `SmtpPanel`, `ScheduledBackupsPanel` and `GDriveConnectModal` keep to their own settings (re-reading those where the page did), `BoardsTable`'s star changes the row in place, `CreateBoardModal` goes to the new board, and an import in `BackupRestorePanel` reloads the whole page.
- **State two components share stays in the page and is bound in.** A component writes a flag of the page's with `bind:` (`showCreate`, `expandedBoards`, `picking`, `activityOpen`, `inviteLink`, `resetNotice`) and reads one with a plain prop. A component the page or another part has to reach is held with `bind:this` and calls an exported function (`openBoardContextMenu`, `openActiveTasksModal`, `openMoveModal`, `toggleActivity`, `fetchActivity`, `celebrate`, `loadMailStatus`, the users panel's reset dialog, the backups panel's Drive box). The page's callbacks (`confirm`, `mutate`, `openCard`) are handed down as props.
- **A component whose state must outlast it being shut is always mounted.** The dashboard's create window (a typed name survives Cancel), the plan page's card picker (what was typed is kept while Add cards shuts it), and All Tasks' Activity Log and Archived Cards (their lists are kept while shut) are drawn whether open or not, as their markup was.
- **The CSS rule.** Svelte scopes a component's styles to it, so a page's rule no longer reaches markup that moved into a component. A rule only one component uses moved with its element. A rule several components share stays in the page, written `<wrapper> :global(...)` under the page's own element (`.admin-page`, `.all-panels-area`, `.plan-body`), so it reaches every component drawn inside that element and nothing outside the page. Where a rule like that would outrank a component's own rule for the same element, or where a component is drawn outside the wrapper, the rule is copied into each component that needs it instead, with a comment at each copy naming the other copies.

### The admin page

The page keeps its props, `isSuperadmin` and `superadminName`, the `{#if isSuperadmin}` / `{:else}` frame **with the superadmin's panel inside it** (the `{:else}` draws the "🔒 The superadmin's" notice, which names the export, the import and the reset; the App URL, Scheduled Backups and Email / SMTP panels came out of the frame with card 2395 and are drawn for every administrator), the confirm dialog, the reset notice and the invite dialog in their places after `.admin-page`, and the CSS several panels share. `src/lib/admin/send.ts` holds `sent(send, fallback)` (the answer on success; on a refusal the server's words in a toast and `null`; no answer, `NO_ANSWER`), `NO_ANSWER` and `showToast`; `src/lib/admin/format.ts` holds `formatBytes`, `formatDuration`, `formatRelativeTime`, `destTypeLabels` and the `DestType` and `BackupHistoryEntry` types.

| Component (`src/lib/components/admin/`) | Drawn for | What it holds |
|---|---|---|
| `AdminOverview.svelte` | every administrator | Database Overview: the counts of boards, columns, cards, categories, users and teams, and the database's size |
| `AppUrlPanel.svelte` | every administrator (the superadmin until card 2395) | The App URL; reads its own setting when drawn (its local `data`, which hid the page's, is `settings`) |
| `BackupRestorePanel.svelte` | the superadmin | Export, the import, its dialog and its report; `importOutsideDefault` |
| `ScheduledBackupsPanel.svelte` | every administrator (the superadmin until card 2395) | The schedule, the destinations and their Test and Confirm, Run Now; reads its own settings when drawn; draws the two forms, the history and the Drive box |
| `DestinationForm.svelte` | every administrator, within the scheduled backups panel | The add and edit forms kept verbatim behind `mode`, their fields bound from the panel so Edit and Add behave as before |
| `GDriveConnectModal.svelte` | every administrator, within the scheduled backups panel | The Google Drive connect box, opened by the panel through `bind:this` |
| `BackupHistory.svelte` | every administrator, within the scheduled backups panel | The backup history, `showAllHistory` bound to the panel so "Show all" survives Run Now |
| `BoardManagementPanel.svelte` | every administrator | Clear a board's cards or categories, or delete it, each through the page's `confirm` |
| `UsersPanel.svelte` | every administrator | The accounts: create, invite, role, delete, resend; sets the page's `inviteLink` and asks the mail panel to read again after an invite (`loadMailStatus`); draws `ResetPasswordDialog` |
| `ResetPasswordDialog.svelte` | every administrator | The password reset, opened by 🔑 through `bind:this` |
| `InviteLinkDialog.svelte` | every administrator | An invite link whose mail was not sent, bound to the page's `inviteLink` (its `isSuperadmin` prop went with card 2395: it points every reader to Email / SMTP); carries its own copies of the modal rules, being drawn after `.admin-page` |
| `TeamsPanel.svelte` | every administrator | Teams and their members |
| `SmtpPanel.svelte` | every administrator (the superadmin until card 2395) | The mail settings and Send Test; reads its own settings when drawn; exports `loadMailStatus`, which the page hands the users panel as a callback; takes `currentUser` |
| `DangerZonePanel.svelte` | every administrator; Reset Everything inside its own `{#if isSuperadmin}` | Purge Archived Cards, Vacuum, Reset All XP and Reset Everything, each through the page's `confirm`; sets the page's `resetNotice` |

`tests/page-failures.test.ts` lists each component as superadmin-only, shown to every administrator, or a part of the scheduled backups panel (card 2395), and follows each of its tags up to the page: a superadmin component's tags must all be inside the page's `{#if isSuperadmin}` and not in its `{:else}`, an administrator's inside no `{#if}` at all, and a part's inside the panel alone and in no `{#if isSuperadmin}`.

**The load** (`src/routes/admin/+page.server.ts`) is seven reads whatever the installation holds (card 2297): every board; each board's columns, cards (archived ones too) and categories, counted for every board at once with one `GROUP BY board_id` each; every user, with three sub-selects counting their keys, webhooks and schedules in the same statement; every team; and every team's members in one query, ordered by team and user, so each team lists its members in the order of their ids, as its own read did. It was three reads a board and one a team. Every write on the page calls `invalidateAll()`, which runs it again (and the root layout's load, which reads nothing); it is not narrowed to keys, since the page has one load and a key would run the same load.

### The dashboard

The page keeps its props, `connectLiveRefresh(() => invalidateAll())`, `deleteBoard` with its `ConfirmModal`, the grid, the Category Manager, Velocity and Spend windows, and the clock (`clock`, set on each live refresh and on a 15-second tick), which it hands to the sidebar and Active Tasks so the due figures and words move on at midnight in both. `src/lib/dashboard/format.ts` holds `timeAgo`, which the table and the sidebar share.

| Component (`src/lib/components/dashboard/`) | What it holds |
|---|---|
| `DashboardHeader.svelte` | The header, the More menu with its window click handler, the typewriter; reads `inboxCount`, binds `showCreate` |
| `RequestToasts.svelte` | The new-request toasts and the inbox poll; binds the page's `inboxCount` |
| `BoardsTable.svelte` | The boards table: favourites, groupings, the star and its request, sub-boards, the progress bars; binds `showCreate`, `expandedBoards`, `collapsedCategories`, `showCategoryManager`; a row's right-click calls the page's `openBoardContextMenu` |
| `AnalyticsSidebar.svelte` | The analytics tiles and the due figures on `clock`; binds `showVelocityModal`, `showSpendModal`; its Active Tasks tile calls `openActiveTasksModal` |
| `BoardContextMenu.svelte` | A board's context menu and its writes (file under a grouping or a new one, make a sub-board), and Delete Board through the page's `confirmDeleteBoard`; exports `openBoardContextMenu`; binds `expandedBoards` and `collapsedCategories` |
| `CreateBoardModal.svelte` | New Board, always mounted; binds `showCreate` |
| `ActiveTasksModal.svelte` | Active Tasks, its due words on `clock`; exports `openActiveTasksModal`, which reads its list as it opens |

The page has no `:global` rule. The progress bar's rules are copied from `BoardsTable.svelte` into `AnalyticsSidebar.svelte`, since a `.dashboard :global(...)` rule in the page would outrank the table's `.fill-all`; the spinner's, with its keyframes, into `ActiveTasksModal.svelte`, which is drawn outside `.dashboard`.

**The load** (`src/routes/+page.server.ts`) makes the same number of reads however many boards, sub-board levels and assignee rows the caller sees (card 2298). The boards it reads are the top-level boards the caller can open and the sub-boards they can open (`subBoardsFor`, card 2130); their columns and their cards, archived ones too, are read once, and the board rows and the All Tasks walk take what each needs from them in memory; the leaderboard has its own single query. What was read whole and filtered here is counted in SQL over the same scope: the subtasks of the open cards on the boards walked, the caller's pending requests (every one for an administrator, else those to them or a team of theirs), the leaderboard's assignee rows of the cards that are not archived on the top-level boards (card 2391; archived ones were scored too, as done or active, where every other figure on the page leaves them out), with each card's column title, in the order the rows were made, and the names of those people alone; the token totals are asked for those boards, not every board. A board's cards are taken column by column, each column's by id, and the assignee rows by `rowid`, as the old reads gave them, so a board's sub-boards and a tie on the leaderboard come out in the same order. The columns the caller's own assigned cards are in are read once, and both which are done (the caller's completed and active cards) and which are on hold (On Hold count) are taken from that read; the same query was made for each (card 2392). The boards the caller can open (`getAccessibleBoardIds`) are read once, at the top of the load, and handed to `subBoardsFor`, `boardCategoriesFor` and `recentActivityFor` through their optional last argument, `accessible`; each read them again for itself, four reads each time (the boards the caller made, their member rows, their teams, the public boards) and a fifth for a caller in a team, so a caller who is not an administrator was 12 or 15 reads more (card 2393). Every other caller of those three leaves the argument out and reads them as before. A `null` handed to any of them (or to `boardCategoryRule`, through `boardCategoriesFor`) is taken as "every board" only from an administrator, told by the role on the caller with nothing read; from anyone else the helper reads the caller's boards for itself, as if the argument were left out (`resolveAccessible`, card 2393's review). The page still reads it all again 250 ms after a burst of live events (`connectLiveRefresh`). `tests/load-query-counts.test.ts` holds both loads' counts steady between a small installation and a large one, sets a ceiling on each (the dashboard's for each caller in its pinned scene), and pins what they answer.

```mermaid
flowchart LR
    Access["getAccessibleBoardIds,<br/>read once (card 2393)"] --> Subs["subBoardsFor"]
    Access --> Ids["top-level boards shown<br/>+ sub-boards the caller opens"]
    Subs --> Ids
    Ids --> Cols["one read: their columns"]
    Ids --> Cards["one read: their cards"]
    Cols --> Mem["in memory: board rows,<br/>the All Tasks walk"]
    Cards --> Mem
    Ids --> Counts["counted in SQL: subtasks,<br/>pending requests, assignee rows,<br/>token totals"]
    Access --> Lists["boardCategoriesFor,<br/>recentActivityFor"]
    Lists --> Data
    Mem --> Data["the page's data"]
    Counts --> Data
```

### All Tasks

The page keeps its props, the live stream (its one `keepStreamOpen`), the filters, sorting and buckets (`let buckets = $derived(data.buckets)`), Load more, Statistics, the card window through the controller, the confirm dialog and every re-read.

| Component (`src/lib/components/tasks/`) | What it holds |
|---|---|
| `AllTasksHeader.svelte` | Filters, search, Hide blocked and the More menu; binds `boardFilter`, `searchQuery`, `hideBlocked`, `showMoreMenu`. Its board filter is as it was, not `BoardFilterSelect.svelte`, which would change its width and add a label |
| `AllTaskCard.svelte` | A card's face; calls the page's `openCard` and opens the Move window |
| `TasksActivityPanel.svelte` | The Activity Log, always mounted; binds `activityOpen`; exports `toggleActivity` and `fetchActivity` |
| `TasksArchivePanel.svelte` | Archived Cards, always mounted; restore, and delete for good through the page's `showConfirm`; binds `showArchivePanel` |
| `MoveCardModal.svelte` | The Move window and its request; exports `openMoveModal` |
| `LiveToasts.svelte` | The live toasts and the fireworks queue; exports `addLiveToast` and `celebrate`, which queues each completion and plays them in turn |

The eight rules both side panels share stay in the page as `.all-panels-area :global(...)`.

**The live re-read (slice C3b).** The stream's `update` listener gives each event its own toast and sound, and hands the re-read to `liveRefresh.schedule()`. `liveRefresh` is `refreshSchedule` from `src/lib/board/refresh-schedule.ts` over a run that calls `invalidateAll()` and, while the Activity Log is open, its `fetchActivity()`, together, so a burst of events (a bulk change of 20 cards is 20) is one re-read 250 ms after the last event, no later than about a second after the first, and never two at once. The 250 ms still lets a `celebrate` event start its fireworks first. Only `schedule()` and `dispose()` (in `onDestroy`) are used: no holds, since the page's own writes re-read the page themselves; no generations, since `invalidateAll` draws its own answer; no access reads, since the global stream has no refusal of a board. The reconnect and visibility re-reads, the re-reads after the page's own writes and Load more are unchanged. Before, each event set its own 250 ms timer, and 20 events were 20 full re-reads.

### The plan page

The page keeps its props, the summary and milestone values (`milestoneId` a number, so what reads it is not re-run by every re-read), `mutate` (the one `PATCH /api/milestones/{id}` path) with `busy` and `actionError`, `picking`, the card window through the controller, and the CSS its blocks share. Each block that changes the goal is handed `mutate`; each that opens a card, `openCard`.

| Component (`src/lib/components/plan/`) | What it holds |
|---|---|
| `PlanHeader.svelte` | Rename, Close and Reopen, the target date, the late tag on a 15-second tick; binds `picking` |
| `PlanCardPicker.svelte` | Add cards, always mounted; binds `picking` |
| `PlanProgress.svelte` | The progress block |
| `PlanBurndown.svelte` | The burndown, fetched on its key and not on every new summary, with its "Against the target" and "Time to deliver" tips |
| `CriticalPathPanel.svelte` | The critical path |
| `WorkTable.svelte` | The work table: `cardGroups(nodes, summary.blocked, data.subtasks)`, the expanders, and removing a card through `mutate` |
| `DependencyGraph.svelte` | The graph, which keeps the geometry reactive by deriving each piece from `src/lib/plan-graph.ts` |

`src/lib/plan-graph.ts` holds the graph's geometry as plain functions, each body as it was in the page: `drawnKey`, `drawnNodes`, `drawnEdges`, `layers`, `nodeHeight`, `positions`, `graphWidth`, `graphHeight`, `edgePath`, `criticalSteps`, `isCriticalEdge`, `clip`, the sizes (`NODE_W`, `NODE_H`, `SUB_H`, `GAP_X`, `GAP_Y`, `PAD`), `key`, and the `Node` and `WorkRef` types. Drawn before and after the move, the node boxes and edge paths are byte-identical.

Thirteen rules several blocks share stay in the page as `.plan-body :global(...)`. `.panel`, the panel's frame, is copied into each block, since a page rule would outrank the card picker's border; and `PlanBurndown.svelte` keeps its own copy of `.muted`, since its tips open outside `.plan-body`.

### The card window off the board

All Tasks, All To Do and the plan page draw the board page's `<CardModal>` and save it through the board page's controller, `CardWindow` in `src/lib/board/card-window.svelte.ts`, unchanged (slice C3a-1). The controller works on a board state, and these pages have none: they span boards, and each draws its own list from its load. `src/lib/board/page-card-window.svelte.ts` gives the controller what it needs of a board state over that list.

```mermaid
classDiagram
    class CardWindowBoard {
        <<interface>>
        columns
        labels
        boardUsers
        writeCard(cardId, fields, send, words) WriteResult
        hold() Release
        refresh()
    }
    class BoardState
    class PageCards {
        get()
        set(next)
    }
    class PageCardBoard {
        columns
        labels empty
        boardUsers empty
        keep(card)
        writeCard(cardId, fields, send, words) WriteResult
        hold() Release
        refresh()
    }
    class PageCardWindow {
        boardId
        open
        cardId
        card
        edits
        openCard(card, boardId)
        close()
        save(saved) SaveResult
        archive(cardId)
    }
    class CardWindow {
        edits
        openCard(card)
        save(saved) SaveResult
        archive(cardId)
    }
    class BoardPage
    class AllTasks
    class AllToDo
    class PlanPage
    BoardState ..|> CardWindowBoard
    PageCardBoard ..|> CardWindowBoard
    PageCardBoard --> PageCards : the page's own list
    PageCardWindow *-- PageCardBoard : one per page
    PageCardWindow --> CardWindow : a new one per card opened
    CardWindow --> CardWindowBoard
    BoardPage --> CardWindow : over its board state
    AllTasks --> PageCardWindow : its buckets
    AllToDo --> PageCardWindow : one group of its cards
    PlanPage --> PageCardWindow : a one-card group of modalCard
```

- **`PageCards<G>`** is a page's own list, `{ get(): G[]; set(next: G[]): void }`, in groups of `{ cards }`: All Tasks hands its buckets, All To Do one group of its rows (`let cards = $derived(data.cards)`), the plan page a one-card group of the card its window opened on (`modalCard`, read with the card's context). A writable `$derived` is written by a save and replaced by each re-read.
- **A fresh controller per card.** A controller is made for one board, and these pages span boards, so `PageCardWindow.openCard(card, boardId)` makes a new `CardWindow` for that card's board each time. `open`, `cardId`, `card`, `edits`, `save`, `archive` and `close` are the open controller's; `card` is the row through `windowCard(row)`, which adds the window's fall-backs (card 2186's list, moved from the pages) and is kept per row, so the window is handed the same object until the row changes.
- **`writeCard` shows the change at once and puts it back under the still-holds rule.** It patches the page's list (`patchCard`) and sends. On a refusal or no answer it puts back those fields alone through `patchCard`'s undo, each only while the card still shows what this save set, so a newer read that replaced the card is kept, and returns the server's words or the no-answer words ("The card was not saved.", "No answer from the server. The card may not have been saved."). On success it takes the answer's value of each field sent (`answeredFields` and `patchCardStill`). It reads nothing after: the page does, as it did before.
- **The card is kept while its window is open.** While the window is open on a card the page's list no longer has (a live re-read after someone moved it out of To Do, or out of All Tasks' capped Complete bucket), `columns` hands the controller the card as last found, in an extra group marked as kept that `set` strips off. So `gone` is never true off the board, and the save goes as it did before, where the board page says `CARD_GONE`. The pages pass no `notice`.
- **`hold` holds nothing.** These pages schedule no reads; its `Release` says it is spent once called, however often. A re-read that lands while a save is out shows the card as it was until the page's own re-read after the save.
- **`refresh` is the page's re-read**, `invalidateAll()`. `labels` and `boardUsers` are empty: only a New Task window reads them, and none of these pages opens one.
- **`{#key cardWindow.edits}`, and `edits` passed.** Each page passes `edits={cardWindow.edits}` and draws the window inside `{#key cardWindow.edits}`, as the board page does. Each open is a window made afresh from its card, so a second card opened while the first's details were loading cannot show the first card's fields, and the fields the user has not touched follow the card as the page's list changes (on All Tasks and All To Do, with each live re-read), while a touched one stays as typed.

A save off the board:

```mermaid
sequenceDiagram
    participant U as User
    participant M as CardModal
    participant P as Page
    participant W as CardWindow
    participant A as PageCardBoard
    participant S as Server
    U->>M: Save
    M->>P: onSave(saved)
    P->>W: cardWindow.save(saved)
    W->>W: changedFields, against what edits says each field started from
    alt nothing changed
        W->>W: close, nothing sent
        W-->>P: ok, told empty
        Note over P: nothing said, nothing read again (the plan page too, card 2324)
    else fields changed
        W->>A: writeCard(card, the changed fields, send, words)
        A->>A: patchCard - shown on the page's list at once, the undo kept
        A->>S: PUT /api/cards/42 with the changed fields and boardId
        alt taken
            S-->>A: 200 with the row
            A->>A: patchCardStill - the answer's value of each field sent
            A-->>W: ok
            W->>W: close
            W-->>P: told - Card updated
            P->>U: Card updated, then invalidateAll
        else refused or no answer
            S-->>A: 4xx, 5xx or nothing
            A->>A: the undo, each field only while it still shows what this save set
            A-->>W: the server's words, or the no-answer words
            W-->>P: not ok, the words
            P->>U: an error toast in those words, the window open with what was typed
        end
    end
```

- **Each page's handlers.** All Tasks and All To Do lost their own `saveCard` and `deleteCard`: `saveFromWindow` and `archiveFromWindow` call `cardWindow.save` and `cardWindow.archive` and say what comes back, in the board page's words. Archive asks first with `cardArchiveWarning` in the page's confirm, and the controller takes the card off the page and closes the window only once the server has archived it; a refused archive keeps the window. The plan page's `saveCardFromPlan` saves the same way; its window has no Archive, as before. On success it closes the window (whose `closeCard` re-reads the plan, the save having marked the window as one that wrote) only when the window is still on the card saved, or shut; a save answered after its window was closed and another opened re-reads the plan alone and leaves the new window as it is.
- **What did not change.** The toasts on success, `invalidateAll()` after a save or an archive, the window's own fifteen writes, and each page's people for the window, read from `GET /api/cards/{id}/context` (All Tasks and All To Do through `loadBoardUsers`, the plan page with the card's context).
- **The plan page re-reads only after a change it draws** (card 2324, 2026-10-21; it re-read on every close). `CardModal` takes an optional `onWrote`, which `CardSubtasks` (a tick), the subtask window (added, edited, deleted, through `handleSubtaskSaved` and `handleSubtaskDeleted`) and `CardDependencies` (a link added or removed, the milestone) call once their write is answered as done. The plan page gives it and keeps `wrote`, cleared as a window opens and set by `onWrote` and by a save that told something; `closeCard` calls `invalidateAll()` only when it is set. Since card 2379 (2026-10-21) `onWrote` is also called for a write that got no answer (it may have been saved) and for one refused for any reason (a refusal can mean it was already done elsewhere: a link or a subtask someone else removed answers `404`, as does the Milestone picker taking out a card already out of its goal; a spare re-read costs one load): a tick, the subtask window's save or delete through its `onNotDone`, a link added or removed, the milestone; a success whose body cannot be read as JSON still calls it, and the window reads its links again; and `CardModal` hands it the `edits` it was opened with, read once as it is made (`openedAs`, through its own `wroteHere`). The plan page's `windowWrote(from)` sets `wrote` only while `from` is `cardWindow.edits`; for a window that has closed (closing gives the controller new `edits`) or been followed by another, `closeCard` has already run, so it calls `invalidateAll()` at once, as a late save does, and counts nothing to the window open now. An assignee, the cover, labels, a comment or a file are not drawn on a plan and call nothing. The board page, All Tasks and All To Do give no `onWrote`.

## Work Kept Off the Server's Thread

The server runs JavaScript on one thread, so whatever holds that thread holds every request. A bcrypt check at cost 12 takes about a fifth of a second, and was made there with `compareSync`: each sign-in held every other request up for that long, and a burst of them held the server for as long as it lasted. Since card 2191 every password hash and check is made on a **worker thread** by `src/lib/server/passwords.ts`, the only module that imports bcryptjs, and the route awaits the answer while the server's thread answers everyone else.

```mermaid
flowchart LR
    subgraph Server["The server's thread"]
        Known["A session's request<br/>(current password, reset, new user)<br/>a remembered browser's sign-in"] -->|"await checkPassword or<br/>makePasswordHash"| L1["First lane: known<br/>current passwords and remembered<br/>sign-ins: five in flight an account"]
        Other["Any other sign-in, a name that is<br/>no account, an invite, set-up"] -->|"await"| L2["Second lane: other<br/>at most 150 a thread waiting"]
        L1 --> Pick{"A thread free?<br/>first lane, then second,<br/>but never more than three of the<br/>first in a row while the second waits"}
        L2 --> Pick
    end
    Pick -->|"postMessage"| T1["Thread 1<br/>bcryptjs compareSync or hashSync"]
    Pick -->|"postMessage"| T2["Thread 2<br/>(3 CPUs or more)"]
    T1 -->|"the answer, to the caller awaiting it"| Pick
    T2 -->|"the answer, to the caller awaiting it"| Pick
```

- **At most two threads**, `min(2, max(1, CPUs - 1))`, or `PASSWORD_THREADS` (0 to 8, left unset in a deployment; 0 is the server's own thread a turn later, which the tests use). Each is started from a string of code, not a file of its own, because Vite carries no worker file into the server build; it loads bcryptjs from `node_modules` by an absolute path, so the image did not change.
- **One line, two lanes.** A caller the server already knows goes first, but never more than three in a row while a check of the second lane waits, and an account's current passwords and remembered sign-ins are held to five in flight, so the second lane is always served; the second lane holds at most 150 checks a thread, and a check that arrives when it is full, or whose caller has gone by the time a thread is free (`req.socket.destroyed`, in the built server), is not made and its route answers `503`.
- **A thread that stops** is replaced and the check sent once more; one that cannot start at all leaves every check on the server's thread, with one `ERROR` line, rather than keep anybody out.
- **A transaction cannot await**, so no hash or check is made inside one. A route that needs a current password checked again because the hash changed in between does it outside, through `whilePasswordHolds()` in `auth.ts`, which writes only while the stored hash is still the one checked.

The whole rule, with the lanes, the bound, the log lines and what the people using it notice, is in [Password Hashing](authentication-security.md#password-hashing).

## Writes: One Transaction, Then the Effects

A request that writes makes its writes all or none, and checks the caller where it writes. The route awaits the request body, then passes one function to `writeAs(locals, (caller) => …)` in `src/lib/server/write-as.ts`, which runs it in `inTransaction()` (`src/lib/server/db/transaction.ts`) after asking, first in that transaction, whether the key or session the gate let the request in with is still open and who its account is now (card 2253; see [Asked Again at the Write](authentication-security.md#asked-again-at-the-write-card-2253)). A route never calls `inTransaction()` itself: `tests/check-at-the-write.test.ts` refuses it in a route file. The function reads what the write depends on, checks `caller` with its guard (`route-guards.ts`), makes every write (the activity entry among them) and returns. In the 57 route files of the two API trees that card 2012 moved onto shared services, the function is one call of a service, handed `caller`, which does all of that and reads the body's fields as well, so the field reads are inside the transaction too, after the caller is asked for (see [One Service per Action, Both Trees](#one-service-per-action-both-trees)). Only then does the route set a cookie, redirect or answer. Before the body the route asks only what reads no row: the session the gate read and the id in its path. A request with one write follows the same order, so that the row checked is the row written, and a row taken away while the body was arriving is a 404; until 2026-10-14 twenty-two handlers checked the row first and then awaited the body (card 2115).

Nothing leaves the process from inside a transaction. A webhook delivery, a live event, an email and a file move are each queued with `afterCommit()` and start once the outermost transaction has committed. If it rolls back they are dropped, so nobody is told of a change that was not saved.

```mermaid
sequenceDiagram
    participant C as Caller
    participant R as Route handler
    participant T as writeAs(), in inTransaction()
    participant DB as SQLite
    participant Q as afterCommit queue
    participant L as Logger
    participant O as Webhooks, live events,<br/>mail, uploads trash

    C->>R: a request that writes
    R->>R: await the body, and a password's hash<br/>on a worker thread if there is one
    R->>T: fn (not async)
    T->>DB: BEGIN IMMEDIATE
    T->>DB: the key or session still open? the account now (stillAuthenticated)
    T->>DB: read what the write depends on, check access with caller
    T->>DB: every write, the activity entry among them
    T->>Q: emit(), logActivity(), notify...(), trashAfterCommit()
    T->>L: log lines are printed at once, their rows held
    alt fn throws, or a write fails
        T->>DB: ROLLBACK
        T->>Q: drop what this transaction queued
        T->>L: write the held rows to system_logs
        T-->>R: the error, as it was thrown
        R-->>C: 4xx or 500, with the database as it was
    else fn returns
        T->>DB: COMMIT
        T->>L: write the held rows to system_logs
        T->>O: start each queued effect, in order, not awaited
        T-->>R: what fn returned
        R-->>C: cookie, redirect or answer
    end
```

### The helper

| Function | What it does |
|----------|--------------|
| `inTransaction(fn)` | Runs `fn` in one transaction on the application's connection and returns what it returns. The outermost call is `BEGIN IMMEDIATE`, which takes the write lock at the start, so nothing `fn` reads can be changed under it before it writes. A call made inside another `inTransaction` is a savepoint: if it throws and the code around it catches the error, only that part is rolled back. A call made while a transaction the helper did not open is open on the connection throws before `fn` is run, so the request is answered 500 and writes nothing. |
| `writeAs(locals, fn)`, `stillCallerNow(locals)` | In `src/lib/server/write-as.ts` (card 2253): `inTransaction(() => fn(stillAuthenticated(locals)))`, the one way a route writes, and the same question asked in a transaction of its own by the eight handlers whose work cannot run in one (the vacuum, the import, the two report routes, the backup run, the Test, the Google Drive Connect and the test mail). See [Asked Again at the Write](authentication-security.md#asked-again-at-the-write-card-2253) |
| `inWrite()` | In `src/lib/server/write-as.ts` (card 2012): the first statement of every write a service exports. It throws a plain error, a `500` if a route reaches it, unless a `writeAs` callback is running: `writeAs` counts its callbacks (`writing`, set after `stillAuthenticated` and taken off in `finally`, so a nested `writeAs` is counted), and nothing else sets the count. A bare `inTransaction`, a job's or a scheduler's, is not a `writeAs`, so a service called from one writes nothing. See [One Service per Action, Both Trees](#one-service-per-action-both-trees) |
| `afterCommit(effect)` | Queues `effect` until the outermost transaction commits. Called with no transaction open, it runs the effect at once. Whether a transaction is open is read from the connection (`sqlite.inTransaction`), not counted by the helper. |

How the queue behaves:

- **A part that fails takes its own effects with it.** Each `inTransaction` call notes the length of the queue when it starts and cuts the queue back to that length if its function throws. What the code around it had already queued stays.
- **Effects are started, never awaited.** They run in the order they were queued. One that throws, or returns a promise that rejects, is logged at `ERROR` under the `TX` context and goes no further: the write is committed and the caller is told so.
- **Moving files is synchronous.** A delete has moved its attachment files to the trash before the request is answered.
- **An effect queued inside a transaction the helper did not open is not sent.** Nothing does that today. If something did, the helper cannot know whether that transaction committed, so the effect is dropped and an `ERROR` line says how many were.

### Rules for code inside a transaction

- **No `await`.** A transaction is over when the function returns. The part of an async function after its first `await` runs later, outside the transaction, and is not rolled back with it. The type of `inTransaction` refuses a function that returns a promise, so `npm run check` fails on one; at run time such a function is refused with a `TypeError` and what it wrote before its first `await` is rolled back.
- **No `redirect()`, cookie or answer.** Those come after `inTransaction` (in a route, `writeAs`) returns. Throwing `error(...)` or a typed error such as `CardMoveError` is fine: it rolls the transaction back and reaches the caller unchanged.
- **A database error is not caught and carried on from**, unless the part that failed is its own nested `inTransaction`.
- **No raw `sqlite.transaction` under the helper.**
- **Slow work comes first.** Hashing a password takes about a fifth of a second, on a worker thread, and is awaited, which a transaction cannot do, so the hash is made before the transaction starts. See [Work Kept Off the Server's Thread](#work-kept-off-the-servers-thread).
- **The check is made where the write is.** Every route that reads a body reads it first and calls its guard after it, and nothing is awaited between a guard and the write it allows. The handlers card 2115 moved call their guard inside the transaction that writes; a `DELETE` that reads no body checks and writes with no transaction, which is as safe, because the database calls are synchronous and nothing is awaited between the two. `tests/check-at-the-write.test.ts` reads every handler under `src/routes/api` and fails on any call before the body but those that read no row, and on a handler whose text reads a body where it cannot find the read. The attachment upload is the one handler that also looks before its body, so that a caller with no access is not sent 25 MB, and it reads the row again inside the transaction. That is also why an invite cannot be used twice and set-up cannot create two superadmins.

Two things open their own transactions and do not use the helper, because they switch foreign keys off around them: the migration runner, and the restore behind Import Backup. The import of the old JSON export was a third; it was removed on 2026-10-14 (card 2157), and Import Backup takes a `.db` backup only.

### Log lines written during a transaction

The logger writes to `system_logs` on the same connection as everything else. A row written inside a transaction that rolls back would vanish with it, and the line that explains a failure is exactly that row. So while a transaction is open the logger prints the line to the console and the live feed at once and keeps the database row in memory. `inTransaction` writes the held rows when its outermost transaction ends, whichever way it ended, with the time each was logged at. At most 2,000 rows are held; past that the oldest are dropped and a `WARN` row says how many.

A line that should be stored only if the write was committed, such as "board 12 was deleted by …", is queued with `afterCommit` instead.

### The shared delete

`src/lib/server/deletes.ts` is the one routine behind every permanent delete: a card with `?permanent=true`, a column, a board, Purge Archived Cards and Clear Cards, in both API trees. The foreign keys take most of what goes, by cascade. The routine takes what they do not:

- dependency links (`work_dependencies`) with a deleted card or subtask at either end;
- sub-boards at every depth, each by its own statement and not as a side effect of the cascade;
- for a deleted board or sub-board, the report schedules that name it, and the membership of cards on other boards in its milestones;
- the attachment files, which are moved to the trash once the delete has committed.

Archiving is not deleting: `archiveCard()` stamps the card and writes the activity entry and touches nothing else. A card that is already archived it leaves as it is, with no new stamp, no entry and no live update, so a retried archive keeps the first archive time (card 2285). `deleteUser()` is in the same module. What each delete removes and leaves is set out in [Data Model](data-model.md#what-a-delete-removes).

Each function in the module opens its own `inTransaction` and checks no access. A route calls it inside the transaction in which it read the row and checked the caller, which makes the delete a savepoint of the route's transaction.

### Sub-boards and the board tree

A board hangs under a card by `boards.parent_card_id`, and the card is on a board, so the boards make a tree: the dashboard lists the top-level boards, and the board page's breadcrumbs walk up from a sub-board. Nothing in the schema stops the tree going round. `src/lib/server/sub-boards.ts` answers the two questions about it that linking an existing board asks (card 2139):

- `wouldLoop(boardId, parentBoardId)` walks up from the parent card's board with a recursive query built with `UNION`, which keeps each board once and so ends on a loop already in the data, as the shared delete's walk down does, and says whether the board being linked is on the way. `requireSubBoardLink()` in `route-guards.ts` refuses that with 409, after asking for the board's owner or an administrator and for edit access to the card's board.
- `linkableBoards(user, boardId)` is what the board page's "Link existing board" offers: top-level boards the caller owns by `getBoardRole`'s rule (those they created and those where they are a member stored as owner, read in two queries whatever the number of boards), every one to an administrator, except the board itself and the top of its own chain of parents, and none to a caller who cannot edit the board. An owner can always open a board, so it offers only boards the caller can open, which card 2130 asks of it.

A sub-board is a board of its own and inherits no access from the board its card is on. Since card 2130 every place that shows a card's sub-boards shows only those the caller can open, as the graph already did: `subBoardsFor(user, parentCardIds?)` in `src/lib/server/list-access.ts` reads them for the board page, the card context and the dashboard, whose tiles, sub-board count, All Tasks walk, cost and spend by person all start from it. The breadcrumb walk up from a sub-board shows a board above it that the caller cannot open as "🔒 A board you cannot open", with no link, and keeps it in the chain, so that the page still knows it is a sub-board. See [Authentication & Security](authentication-security.md#what-a-list-gives).

```mermaid
flowchart TD
    Page["Board page, card context, dashboard"] --> Subs["subBoardsFor(user, cardIds)"]
    Subs --> Open{"getAccessibleBoardIds():<br/>can the caller open the sub-board?"}
    Open -->|"yes, or an administrator"| Shown["On the card, the tile and in the figures"]
    Open -->|"no"| Left["Left out: no name, no progress, not counted"]
    Crumbs["Breadcrumbs: walk up from the board"] --> Each{"canViewBoard(ancestor)?"}
    Each -->|"yes"| Named["name, emoji, link"]
    Each -->|"no"| Withheld["🔒 A board you cannot open, no link"]
```

`PUT /api/boards/:id` writes `parentCardId` in the transaction that runs those checks, with any other field the request sends, and the board, the card's board and the board it left are each sent a live update.

```mermaid
flowchart TD
    Put["PUT /api/boards/X { parentCardId: c }"] --> Edit{"requireBoard(X, 'edit')"}
    Edit -->|"no"| R1["404 or 403"]
    Edit --> Owner{"requireBoardOwner(X):<br/>owner or administrator?"}
    Owner -->|"no"| R2["403"]
    Owner --> Parent{"requireParentCard(c):<br/>edit access to P, c's board?"}
    Parent -->|"no"| R3["404 or 403"]
    Parent --> Loop{"wouldLoop(X, P):<br/>X on the walk up from P?"}
    Loop -->|"yes"| R4["409"]
    Loop -->|"no"| Write["X.parent_card_id = c,<br/>live update to X, P and X's old parent board"]
```

The breadcrumb walk on the board page and a card moved onto its own sub-board are not guarded here; each has a card of its own (the plan's found nearby a and b).

### Uploads and the trash

`src/lib/server/uploads.ts` is the one definition of where attachment files are. An attachment row holds a file name only; every path is built from the card id and that name.

```
<uploads>/<cardId>/<filename>            a card's file
<uploads>/.trash/<cardId>/<filename>     the same file, once its row is deleted
<uploads>/.trash/<cardId>/.trashed-at    when that folder was last added to
```

The uploads folder is the folder `uploads` beside the database file. The module refuses, the first time it is asked, a folder that is or contains the database's folder or the working directory.

```mermaid
stateDiagram-v2
    [*] --> CardFolder : Upload - the file is written, then its row
    CardFolder --> [*] : The row could not be written, so the file is removed again
    CardFolder --> Trash : Its row is deleted and the delete commits
    CardFolder --> Trash : The sweep - no row names it and it has not changed for 24 hours
    CardFolder --> CardFolder : The card is archived or restored - nothing moves
    Trash --> CardFolder : Import Backup brings back a row that names the file
    Trash --> Removed : In the trash for more than 30 days, ten minutes after a start or at a six-hourly tick
    Removed --> [*]
```

A row is deleted, and its file moved, by deleting the attachment itself, by a permanent delete of its card, column or board, by Purge Archived Cards, by Clear Cards and by Reset.

- **A file is never deleted with its row.** Backups hold the database and not the files, so a file whose row has gone is moved to the trash, where an import of an earlier backup can find it.
- **Only the files named by the deleted rows are moved.** The card's folder is then removed if it is empty, and never recursively. A file that is not there is passed over: a working copy restored from a backup has none.
- **A stored file name is treated as data.** A name with a separator, a drive letter or `..` in it, which a restored backup could hold, is refused before it is joined into a path.
- **The trash is emptied by the log maintenance timer**, ten minutes after the server starts and then every six hours, of every folder last added to more than 30 days before. The timer starts with the server, and its first look at the trash is ten minutes later: nothing is removed from the disk as the server starts. It looks only at numbered folders directly inside `.trash`, removes the files in one that is due and then the folder, follows no link and never goes into a folder inside one, so it cannot reach anything outside the trash.
- **Serving.** `attachmentHeaders()` answers every attachment as a download (`Content-Disposition: attachment`, `application/octet-stream`) except PNG, JPEG, GIF, WebP and `.txt` files, which are shown in the browser, and only when the stored type and the file's extension agree. A PDF, an HTML file and an SVG file are downloads. Every answer carries `X-Content-Type-Options: nosniff` and `Content-Security-Policy: sandbox`. On a card, those four image types have a thumbnail that opens the image, and the name of every attachment is a link that saves the file. See [Authentication & Security](authentication-security.md#attachments).

- **Files no row names are swept** (card 2107). `src/lib/server/uploads-sweep.ts` is one of the schedulers, started by `startSchedulers()` in `schedulers.ts`, so it runs only where they run (never under `vite dev`, in a rehearsal or with `SCHEDULERS=off`): 15 minutes after the start, then every six hours. `sweepUploads()` does nothing while the connection has a transaction open; otherwise it reads every `card_attachments` row as `<card id>/<file name>` (`uploadKey()`) and the highest card id issued (the larger of `sqlite_sequence` and `MAX(cards.id)`), and hands both to `sweepUnnamed()` in `uploads.ts`, which touches no database and no logger. That walks the folders named exactly by a card id (`/^[1-9][0-9]*$/`, read with `lstat`, so a link is never followed) and moves, through `moveToTrash`, each plain file no row names that has not changed for 24 hours. The rows, the listing and the moves are one synchronous pass, so no request of this process writes a row in between; against another process on the same volume the 24-hour margin is what protects. A folder numbered above the highest card id belongs to another database and is left alone; so is a folder the sweep finds already empty, and every name that is not a card's folder. A read that fails moves nothing.

```mermaid
flowchart TD
    Tick["Sweep: 15 minutes after start, then six-hourly"] --> Tx{"Transaction open?"}
    Tx -->|"yes"| Skip["Skip this run"]
    Tx -->|"no"| Read{"Rows and the highest card id read?"}
    Read -->|"no"| Warn["One WARN line, nothing moved"]
    Read -->|"yes"| Walk["Each folder named exactly by a card id,<br/>never a link, never .trash"]
    Walk --> Other{"Above the highest card id?"}
    Other -->|"yes"| Leave["Left alone, named in a WARN line"]
    Other -->|"no"| File{"A plain file no row names,<br/>unchanged for 24 hours?"}
    File -->|"no"| Keep["Left where it is"]
    File -->|"yes"| Move["moveToTrash, the folder removed if this left it empty"]
    Move --> Info["One INFO line with the counts"]
```

How an operator backs the folder up, and what a restore does with the trash, is in [Deployment](deployment.md#attachment-files).

## One Service per Action, Both Trees

The API has two trees for the reason it always has: the pages call `src/routes/api/**` on a
session, and other programs call `src/routes/api/v1/**` with a key. The plan's thirty rows
cover 42 pairs of handlers, one in each tree, that did the same thing, and 15 handlers one tree
has alone; each pair had the same middle written twice: the
guard, the field reads, the insert or update, the change check, the activity entry and the live
event. Two copies drift. Card 2143 found six internal handlers that recorded and told nothing
their v1 twins did, and the twins refused in different words through copied guards. Since card
2012 (part A) each pair calls one function, a **service**, in a module of `src/lib/server/`:
99 handlers (48 internal, 51 v1; 20 of them `GET`s) in 57 route files (27 internal, 30 v1),
on 13 modules. The move changed nothing either tree answers, records or tells: every status,
field, answer shape, refusal text, entry text, webhook detail, live event and mail order is as
it was (R2 of the plan), with one kind of exception, accepted, where a read moved inside
`writeAs`: a session that ended while its body arrived is now `401` where an empty or
malformed body was answered `200` or `400` first (see
[Asked Again at the Write](authentication-security.md#asked-again-at-the-write-card-2253)).

```mermaid
flowchart LR
    subgraph Internal["src/routes/api/** handler (session)"]
        I1["requireUser(locals.user)<br/>pathId, readBody,<br/>linkBaseUrl"] --> I2["writeAs(locals, (caller) =><br/>service(caller, at, body,<br/>{ source: 'ui', ...its options }))"] --> I3["kit json<br/>(stored timestamps)"]
    end
    subgraph V1["src/routes/api/v1/** handler (key)"]
        V11["requireUser(locals.user)<br/>pathId, readBody,<br/>linkBaseUrl"] --> V12["writeAs(locals, (caller) =><br/>service(caller, at, body,<br/>{ source: 'api', says?, ...its options }))"] --> V13["v1-json json<br/>(ISO 8601)"]
    end
    subgraph Service["src/lib/server/&lt;area&gt;.ts"]
        S0["inWrite(): refused unless<br/>a writeAs callback is running"] --> S1["requireUser(caller): 401<br/>require* guard with caller:<br/>404, then 403 in opts.says"]
        S1 --> S2["request-body readers on body:<br/>400, keep"]
        S2 --> S3["insert, update, or a shared helper<br/>(applyCardMove, deleteCard,<br/>addDependencyLink, recordTokenUsage, ...)"]
        S3 --> S4["logActivity (its webhook queued),<br/>emit (queued), notify... (queued)"]
    end
    I2 --> S0
    V12 --> S0
    S4 -->|"the row or result,<br/>returned through writeAs"| Commit["COMMIT, then each queued<br/>effect starts (afterCommit)"]
    Commit --> I3
    Commit --> V13
```

A handler that calls a service keeps its quick check (`requireUser(locals.user);`, binding no
name), `pathId`, `readBody`, `linkBaseUrl` where it sends mail, its one `writeAs` and its
answer. The callback is the service call, and whatever shapes the answer from what the
transaction holds: v1's board create adds the board's columns, v1's comment edit its author
(`withAuthor`), and the four dependency adds (`POST`) answer a link that would close a loop with
`cycleAnswer`, a `Response` the callback returns and the handler answers as it is. A read
service is called in a `GET`, with `locals.user`, after the same quick check, with no
`writeAs`. In what order a service refuses, and why, is in [Reading a body](#reading-a-body);
when its effects leave, in [Writes: One Transaction, Then the Effects](#writes-one-transaction-then-the-effects).

```mermaid
sequenceDiagram
    participant H as Handler (either tree)
    participant W as writeAs (write-as.ts)
    participant S as Service
    participant G as Guards and readers
    participant DB as SQLite
    participant Q as afterCommit queue
    H->>H: quick check, pathId, await readBody
    H->>W: writeAs(locals, (caller) => service(caller, at, body, opts))
    W->>DB: BEGIN IMMEDIATE, stillAuthenticated(locals)
    Note over W: 401 if the key or session ended,<br/>and the service is never called
    W->>S: service(caller, at, body, opts), with writing counted up
    S->>S: inWrite(), then requireUser(caller)
    S->>G: requireCard(user, id, 'edit', opts.says)
    Note over G: 404, then 403 in the tree's words
    S->>G: readText(body, ...), readId(body, ...)
    Note over G: 400 naming the field
    S->>DB: the writes
    S->>Q: logActivity, emit, notify...
    S-->>W: the row, or what the answer needs
    W->>W: writing counted down (finally)
    W->>DB: COMMIT
    W->>Q: start each effect, in order
    W-->>H: what the callback returned
    H->>H: answer: kit json, or v1-json json
```

### The shape of a service

Every write a service exports has one shape, and every read another:

```ts
write(caller: SessionUser | null, at: { …the path's ids }, body: RequestBody | null, opts: ServiceOptions & { …the tree's options })
read(user: SessionUser | null | undefined, at: { …the path's ids }, opts: { says?: string; …the tree's options })
```

Both are schematic: some reads take `user: SessionUser` (`readCardTokens`, `readMilestone`,
`readMilestoneSummary`), and some take no options at all (`opts: Record<string, never>`).

`at` holds the ids of the request's path (`{ cardId }`, `{ kind: 'subtask', id }`, `{}` for
none), `body` is what `readBody` handed back, `null` for a request with none, and `opts` is an
object written out at the call, or the write's own module's `<NAME>_PAGE_OPTIONS` constant,
whole or spread, where a page route and a new card's nested write share it (card 2296:
`CREATE_SUBTASK_PAGE_OPTIONS`, `TOGGLE_LABEL_PAGE_OPTIONS`, `ASSIGN_PAGE_OPTIONS`,
`CREATE_BOARD_PAGE_OPTIONS`, each written out of texts and booleans). A write:

1. **starts with `inWrite()`**, and is handed its writeAs callback's own `caller`, as it is or
   through `requireUser(caller)`, never `locals` or a name taken from it;
2. asks **`requireUser(caller)`** (401), then **its guard with the account** (404 to everyone,
   then 403, in `opts.says` where the tree has its own words);
3. reads **every field from `body`** through the readers of `request-body.ts` (400), the ids
   the body names among them, so a session that ended while the body arrived is refused
   before any of them is looked for. Where a route names the guarded row in its body and not
   its path, that id is read first, as the row the guard is asked of: from the page, a new
   card's column, a new column's, label's or category's board, a new subtask's card, the label
   changed, deleted or toggled, and the card restored from the board's archive; in both trees,
   a new milestone's board. The card reorder reads its drop's ids and caps, which read no row,
   before any card;
4. **writes**, through the helpers that already exist (`applyCardMove`, `archiveCard`,
   `deleteCard`, `restoreCard`, `recordCardCreated`, `addDependencyLink`,
   `removeDependencyLink`, `recordTokenUsage`, `createMilestone`, `setCardMilestone`,
   `deleteBoard`, `deleteColumn`, …);
5. **records and tells** itself: `logActivity` and its webhook, `emit` and the `notify…` mail
   all wait for the commit;
6. **throws kit `error()`**, as the guards do, so a handler has nothing to catch. A helper's
   typed error is turned into `error(e.status, e.message)` in one private function of the
   service: `moved` for `CardMoveError` in `cards.ts`, `refused` for `TokenError` in
   `token-service.ts` and for `MilestoneError` in `milestone-service.ts`. The one turn written
   in place is in `cards.ts`: `updateCard` turns the `MilestoneError` of a v1 `milestoneId`
   change where it catches it.

A read is listed on its module's `READS`, writes nothing, and asks no `inWrite()`.

**Where the contract lives.** `writeAs`, `inWrite` and `ServiceOptions` are all in
`src/lib/server/write-as.ts`, the module every service already imports. `inWrite` asks the
count `writeAs` keeps of its running callbacks (`writing`), not merely whether a transaction is
open, so a job's or a scheduler's bare `inTransaction` cannot call a service; only `writeAs`
sets the count. It is not in `db/transaction.ts`: that module cannot import `write-as.ts`,
which imports it, and a setter exported from it would let anything set the count.

| `ServiceOptions` | What it is |
|---|---|
| `source` | `'ui'` from the internal tree, `'api'` from v1: the `source` of every entry and webhook the write records, and v1's actions stored with `api:` |
| `baseUrl?` | `linkBaseUrl(url)`, read before `writeAs` (a setting, no row): the address the mail the write sends links to |
| `says?` | The tree's own words for a refusal where it has them (`No edit access to this card's board` against `No edit access to this board`), handed to the guard |

**`says` is words written out, never words made.** At the call it is a text literal, or a
constant of the route file holding one (for example `NO_EDIT`, `NO_ACCESS`, `NO_EDIT_TO_ASSIGN`,
`NO_EDIT_TO_UNASSIGN`), and a
service hands it on only as `opts.says`. `tests/check-at-the-write.test.ts` refuses a `says`
built from data, a computed key and a spread in a service write's options; and
`tests/openapi-document.test.ts` reads each v1 handler's refusal texts there.

### The tree's options, and why they exist

Part A was a pure move. Where the two trees did something differently, each kept what it did,
through an option its handler passes, so that the unchanged existing suites prove the move and
no answer a caller sees changed. An option that changes an entry's words is a boolean named for
what it says; one that changes an order is named for that order, never a test of `source`; and
a branch only one tree reaches sits behind that tree's option, so the OpenAPI test, which reads
a v1 handler through the service with the options it passes, does not count it for v1.

| Option | Service | Passed by | What it keeps |
|---|---|---|---|
| `allowMove` | `updateCard` | internal | `columnId` and `position` in a card update move it (with the move's `409`s) |
| `refuseMove` | `updateCard` | v1 | `columnId` taken only as the card's own, any other `400` naming the move route; `position` not read (card 2287; never combined with `allowMove`) |
| `allowMilestone`, `allowRestore` | `updateCard` | v1 | `milestoneId`; `archivedAt: null` restores |
| `refuseEmpty` | `updateCard`, `updateBoard` | v1 | `400 No valid fields to update` for a body that changes nothing; the internal tree answers it `200` |
| `tellBeforeEntry` | `updateCard`, `createSubtask`, `updateBoard` (v1); `updateSubtask` (internal) | as listed | the live event before the entry (and so before its webhook); on `updateSubtask` before the completion's notices too |
| `permanent` | `removeCard` | both | `?permanent=true`: delete, not archive |
| `commentedOn`, `mailBeforeEntry` | `addComment` | v1 | `Commented on "<card>"` against `on "<card>"`; the mail before the entry |
| `namesCard`, `allowPosition` | `createSubtask` | v1 | `Created subtask "<x>" on "<card>"` against the bare title; `position` read |
| `eventType` | every subtask write | both, required | the live event's `type`: `subtask` internal, `card` v1 |
| `nothingToLink` | `addWorkDependency`, `removeWorkDependency` | internal card route | `Nothing to link`, `Provide only one end` |
| `withLinkDetails` | `readWorkDependencies` | v1 card route | each link's id, maker and time |
| `allowCard` | `changeMilestone` | internal | `cardId` (and `attach`) in a milestone `PATCH` puts a card in or takes it out |
| `withCards` | `readMilestone` | v1 | the milestone's cards, withheld where the caller cannot open their board |
| `allowCategory` | `createBoard` | both (v1 since card 2287) | `categoryId`, the dashboard grouping |
| `allowParent` | `updateBoard` | internal | `parentCardId`: a board moved under a card or back (not combined with `refuseEmpty`) |
| `refuseParent` | `updateBoard` | v1 | `parentCardId` taken only as the board's own, any other `400`, `null` on a sub-board included (card 2287; never combined with `allowParent`) |
| `placeAfterLast`, `colorBeforePosition` | `createColumn` | v1 | a column with no position after the last (internally at 0); `color` read before `position` |
| `sendNameOrColor` | `updateLabel` | internal | `400 Send name or color to change` against `No valid fields to update` |

Where a body id stands for a path id the difference is in `at`, not an option: the internal
comment edit passes `at.cardId` so the comment must be on the path's card, and a create from
the page passes `{}` and its body names the parent. What v1 ignored without a word is now taken
or refused (card 2287): a new board's `categoryId` is taken, as the page takes it
(`allowCategory`); a card update's `columnId` other than the card's own, and a board update's
`parentCardId` other than the board's own, are refused with a `400` (`refuseMove`,
`refuseParent`), because a move and a link are acts with routes of their own. A card update's
`position` is still not read on v1, and is documented as ignored: a drag renumbers the columns
it touches, so a stale one is common.

### The modules

| Module | Reads (`READS`) | Writes | Called by |
|---|---|---|---|
| `cards.ts` | none | `createCard`, `updateCard`, `removeCard`, `moveCard`, `moveCards`, `restoreCardFor` | internal `cards` POST, `cards/[id]` PUT and DELETE, `cards/reorder` PUT (`moveCards`), `cards/[id]/restore` POST and `boards/[id]/archive` POST (`restoreCardFor`); v1 `boards/[boardId]/cards` POST, `cards/[cardId]` PUT and DELETE, `cards/[cardId]/move` PUT (`moveCard`) |
| `card-assignees.ts` | none | `assignToCard` (answers `{ already }`), `unassignFromCard` | `cards/[id]/assignees` POST and DELETE in both trees |
| `card-comments.ts` | `listComments` | `addComment`, `editComment`, `deleteComment` | `cards/[id]/comments` GET and POST in both trees; internal `cards/[id]/comments/[commentId]` PUT and DELETE (the delete is the internal tree's alone); v1 `comments/[commentId]` PUT |
| `card-labels.ts` | none | `toggleCardLabel`, `addCardLabel`, `removeCardLabel` | internal `labels` PUT (the toggle); v1 `cards/[cardId]/labels` POST and DELETE |
| `subtasks.ts` | `listSubtasks` | `createSubtask`, `updateSubtask`, `deleteSubtask` | internal `subtasks` GET and POST, `subtasks/[id]` PUT and DELETE; v1 `cards/[cardId]/subtasks` GET and POST, `subtasks/[subtaskId]` PUT and DELETE |
| `work-dependencies.ts` | `readWorkDependencies` | `addWorkDependency`, `removeWorkDependency` (`at: { kind: 'card' \| 'subtask', id }`) | the GET, POST and DELETE of `cards/[id]/dependencies` and `subtasks/[id]/dependencies` in both trees (it replaced `subtask-dependencies.ts`) |
| `token-service.ts` | `readCardTokens` | `recordTokens` (`at` a card or subtask), `removeTokenEntry`, `recordTokenBatch` | `cards/[id]/tokens` GET in both trees; v1 `cards/[cardId]/tokens` POST, `subtasks/[subtaskId]/tokens` POST, `tokens/[entryId]` DELETE, `tokens/bulk` POST (the internal tree writes no tokens) |
| `milestone-service.ts` | `readMilestone`, `readMilestoneSummary` | `createMilestoneFor`, `changeMilestone`, `deleteMilestoneFor`, `attachCardToMilestone`, `detachCardFromMilestone` | `milestones` POST, `milestones/[id]` GET, PATCH and DELETE, `.../summary` and `.../pdf` GET, in both trees; v1 `milestones/[milestoneId]/cards` POST and DELETE |
| `boards.ts` | `listBoardsFor` | `createBoard`, `updateBoard`, `deleteBoardFor` | `boards` GET and POST, `boards/[id]` PUT and DELETE, in both trees |
| `board-groupings.ts` | none | `createBoardGrouping`, `updateBoardGrouping`, `deleteBoardGrouping` | `board-categories` POST, `board-categories/[id]` PUT and DELETE, in both trees |
| `columns.ts` | none | `createColumn`, `updateColumn`, `deleteColumnFor`, `reorderColumns` | internal `columns` POST, `columns/[id]` PUT and DELETE, `columns/reorder` PUT (the internal tree's alone); v1 `boards/[boardId]/columns` POST, `columns/[columnId]` PUT and DELETE |
| `card-categories.ts` | none | `createCardCategory`, `updateCardCategory`, `deleteCardCategory` | internal `categories` POST, `categories/[id]` PUT and DELETE; v1 `boards/[boardId]/categories` POST, `categories/[categoryId]` PUT and DELETE |
| `labels.ts` | `labelsOfBoard` | `createLabel`, `updateLabel`, `deleteLabel` | internal `labels` GET, POST, PATCH and DELETE; v1 `boards/[boardId]/labels` GET and POST, `labels/[labelId]` PUT and DELETE |

Paths are under `src/routes/api/` (internal) and `src/routes/api/v1/`. Each module's header
says what its trees do differently and why.

**What is not a service.** `milestones.ts` and `tokens.ts` keep their rules
(`requireMilestone`, `createMilestone`, `recordTokenUsage`, the totals) as helpers other callers
use, the bulk routes among them; the services call them, and they stay off the service rule,
which would otherwise make each of their exports a write needing `inWrite()`. Left in their
route files, as no pairs: `POST /api/v1/dependencies/bulk` and
`POST`/`DELETE /api/v1/milestones/{id}/cards/bulk` (v1's alone; the second sends its
plan-created mail after the commit, which a service would pull inside the transaction); the
audit-log, activity and personal-stats reads, which answer different questions in each tree;
the board-cards reads (a picker and a full listing); both trees' grouping lists and the
internal category list, which call `boardCategoriesFor` and `cardCategoriesFor` in
`list-access.ts`; the two milestone lists (`GET /api/milestones`, `GET /api/v1/milestones`),
which call `listMilestones` as before; `GET /api/boards/:id/archive`; and v1's single-row and
per-board reads (one board, column, category, grouping, label or comment, and the `GET`s of
`boards/:boardId/columns`, `boards/:boardId/categories`, `cards/:cardId/assignees` and
`cards/:cardId/labels`), with the other reads of those files.

**How it is held.** `tests/check-at-the-write.test.ts` reads every route file and every module
of `src/lib/server/` for the service rule (see
[Asked Again at the Write](authentication-security.md#asked-again-at-the-write-card-2253));
`tests/activity-twins.test.ts` runs each pair's two requests on the same fixture and compares
what each tree wrote, recorded and told, and pins every service call's options as read from
the source; `tests/write-as.test.ts` holds `inWrite`. See
[Testing](testing.md#tests-that-read-the-source).

## One Timestamp Form

Every moment DumpFire stores is `YYYY-MM-DD HH:MM:SS`, in UTC, to the whole second (card 2095): what SQLite's `datetime('now')` writes, which 22 columns take as their default. Stored values are compared as text, and text orders moments only within one form, so one form is what makes every date filter right.

| Module | What it does |
|---|---|
| `src/lib/timestamps.ts` | Plain functions with no imports, used by the server and the pages alike. `stamp(date)` gives the stored form, and every write from JavaScript goes through it. `toStamp(input, edge)` reads what a caller sends: the stored form, ISO 8601 with or without a fraction, `Z` or an offset, or a date, 00:00:00 as a lower bound and 23:59:59 as an upper one; anything else is `null`, which a route answers `400` naming the parameter. `parseStamp(value)` gives the `Date` a stored value names, read as UTC: every page, report and metric parses through it, never with `new Date()`, which reads the stored form as local time. `toIso(value)` gives ISO 8601 with `Z`. `isStamp(value)` says whether a value is a real moment in the stored form, which a pattern cannot: `2026-02-30 08:00:00` has the shape |
| `src/lib/server/db/timestamps.ts` | `timestampColumns(database)`: every TEXT column whose name ends in `_at`, and `system_logs.timestamp`. `normaliseTimestamps(database)`: converts every value in a shape it reads to the stored form, where SQLite's `strftime` and `toStamp` read it as the same moment, in one immediate transaction, and reports every value that is not a real moment in the stored form. `registerStampFunctions(database)` gives the connection `is_stamp` and `stamp_of` from `src/lib/timestamps.ts` for that SQL, so SQL and code read a moment by one rule; the suite's check after every test calls it too. The runner calls it at every start after the backfills, and the restore after every import |
| `src/lib/server/v1-json.ts` | `json(data, init)`, which every `/api/v1/` handler answers with, and `onTheWire(data)`, which `dispatchWebhook` applies to a webhook's `data`, a copy built with `Object.fromEntries` so that a key named `__proto__` stays a key: a string under a key ending `At` or `_at`, or named `timestamp`, `from` or `to`, that is exactly in the stored form goes out as ISO 8601 with `Z`. A date and a user's text are never touched |

```mermaid
flowchart LR
    Caller["A bound or a time a caller sends"] -->|"toStamp, else 400"| Store[("Every *_at column")]
    Code["A write from code"] -->|"stamp()"| Store
    Default["SQL default datetime('now')"] --> Store
    Restore["A restore, copied verbatim"] --> Store
    Start["Every start, every restore"] -->|"normaliseTimestamps"| Store
    Store -->|"as stored"| Internal["Internal routes, page data,<br/>live stream, CSV exports"]
    Internal -->|"parseStamp, as UTC"| Pages["Pages"]
    Store -->|"onTheWire"| V1["v1 answers, ISO 8601 with Z"]
```

The test suite holds the form: `tests/setup.ts` checks after every test that every timestamp column holds the stored form or NULL, and fails the test that left anything else. See [Data Model](data-model.md#key-schema-notes) and [Testing](testing.md).

## Request Lifecycle

External users can submit task requests without authentication:

```mermaid
stateDiagram-v2
    [*] --> Pending : Signed-in user submits
    [*] --> Unverified : Someone without an account submits
    Unverified --> Pending : Requester confirms from the emailed link
    Unverified --> [*] : Not confirmed within 7 days, deleted
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
| Snapshot Scheduler | Hourly check, once a day | Card counts per column for the CFD (burndowns are rebuilt from card timestamps — see [Burndown Charts](burndown-charts.md)) |
| Session Cleanup | On startup | Remove expired session tokens |
| Log Maintenance | On startup, then every six hours | Prune `system_logs` past its retention |
| Uploads Trash | Ten minutes after startup, then every six hours, on the log maintenance timer; never on startup itself | Remove attachment files that have been in the trash for more than 30 days |
| Attachment File Sweep | 15 minutes after startup, then every six hours; only where the schedulers run (`SCHEDULERS`) | Move attachment files that no row names, unchanged for 24 hours, to the trash (card 2107) |

## Key Design Decisions

1. **SQLite over Postgres/MySQL** — Zero-config, file-based, perfect for self-hosted single-tenant deployments. Synchronous queries via better-sqlite3 are faster than async alternatives for this workload.

2. **SSE over WebSockets** — Simpler server implementation, automatic reconnection built into the browser API, works through HTTP/2 proxies without special config.

3. **Single-process architecture** — No external message queues, no separate worker processes. All schedulers run in-process with `setInterval`. Suitable for the target scale (team-sized deployments).

4. **Drizzle ORM** — Type-safe schema (`src/lib/server/db/schema.ts`) that serves as the source of truth: queries are written against it, and every database is checked against it. Migrations are numbered SQL files checked into `drizzle/`. They are applied at start-up by the application's own runner (`src/lib/server/db/migrate.ts`), one transaction per file, and a file that fails stops the server before it listens. `drizzle-kit` does not apply them and is not in the production image. It is used only in development, to export the model's DDL into the expected schema that the runner compares each database with (`npm run schema:expected`). See [Data Model](data-model.md#migrations-and-schema-reconciliation) and [Deployment](deployment.md#start-up-sequence).

5. **Soft-delete (archive)** — Cards are soft-deleted by setting `archivedAt`, which touches nothing but the card, so a restore brings it back whole. Hard delete available via `?permanent=true` query parameter. Admin purge endpoint for bulk cleanup. Every hard delete goes through one routine, `deletes.ts`.

6. **Commit first, then tell** — A webhook, a live event, an email or a file move is an effect of a write and is sent only once the write is committed. The cost is that an effect can fail after the write succeeded; that is logged and the caller is still told the write succeeded, because it did. The alternative, sending from inside the transaction, announces changes that are then rolled back.

7. **Attachment files are moved, not deleted** — Backups hold the database only. A deleted card's files go to a trash folder for 30 days, so that restoring an earlier backup can have them back.

8. **One way to read a body, and no schema library** — Every handler reads its body, its path ids and its query through the small readers of `request-body.ts`, which refuse what a field cannot hold with a `400` that names it. A schema library would have been the first validation dependency in the project; checks written into each handler are how the two API trees drifted apart. A value the row already holds is accepted as it is, so rows stored before the rules still save. See [Reading a body](#reading-a-body).

9. **One service per action, both API trees** — The internal tree and `/api/v1/` keep their own paths, bodies, words and answers, and call one function for the work between them, so the two cannot drift apart again. A service writes only inside the `writeAs` callback that hands it the caller, which `inWrite()` checks when it runs and a source test checks on every route. See [One Service per Action, Both Trees](#one-service-per-action-both-trees).

10. **The board page applies each answer and reads only its board** — It draws from one board state, shows a change at once and takes the answer, or takes that change alone back and says the server's words, and follows other people's changes by reading `GET /api/boards/[id]/contents`, one read for a burst and none under a drag or a write in flight, from the same reader as its load. Not chosen: patching from live events, which by rule carry nothing a reader may not read; and `invalidate('board:<id>')`, which re-runs the same whole load. See [The Board Page and the Card Window](#the-board-page-and-the-card-window).
