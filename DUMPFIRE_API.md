# DumpFire API Documentation

DumpFire provides a REST API for automation and external integrations. You can programmatically create, read, update, delete, and move tasks (cards) on your Kanban boards.

## Table of Contents

- [Authentication](#authentication)
- [Rate Limits](#rate-limits)
- [Error Handling](#error-handling)
- [Endpoints](#endpoints)
  - [Current User](#current-user)
  - [Boards](#boards)
  - [Cards](#cards)
  - [Card Assignees](#card-assignees)
  - [Card Movement](#card-movement)
  - [Subtasks](#subtasks)
  - [Dependencies](#dependencies)
  - [Milestones](#milestones)
  - [Bulk Planning](#bulk-planning)
- [Examples](#examples)

---

## Authentication

All API requests require an API key, sent via the `Authorization` header.

### Generating an API Key

1. Log in to DumpFire
2. Navigate to **My Account** (⚙️)
3. Scroll to the **🔑 API Keys** section
4. Enter a descriptive name (e.g. "CI Pipeline", "n8n Automation")
5. Click **Generate Key**
6. **Copy the key immediately** — it is only displayed once

### Using the API Key

Include the key in every request as a Bearer token:

```
Authorization: Bearer df_your_api_key_here
```

> **Important:** API keys inherit the permissions of the user who created them. A regular user can only access boards they have edit/view access to. Admin users have global access.

### Revoking a Key

Go to **My Account → API Keys** and click **Revoke** on any key. The key is immediately invalidated.

---

## Rate Limits

API requests are rate-limited to **60 requests per minute** per API key.

When you exceed the limit, you'll receive a `429 Too Many Requests` response:

```json
{
  "error": "Rate limit exceeded",
  "retryAfterSecs": 42
}
```

The `Retry-After` header is also set with the number of seconds to wait.

---

## Error Handling

All errors return JSON with an `error` field:

```json
{
  "error": "Description of what went wrong"
}
```

### Common HTTP Status Codes

| Code | Meaning |
|------|---------|
| `200` | Success |
| `201` | Resource created |
| `400` | Bad request (missing or invalid fields) |
| `401` | Unauthorized (missing or invalid API key) |
| `403` | Forbidden (no access to the requested resource) |
| `404` | Resource not found |
| `429` | Rate limit exceeded |
| `500` | Internal server error |

---

## Endpoints

All endpoints are prefixed with `/api/v1`.

### Current User

#### Get Current User

```
GET /api/v1/me
```

Returns the profile of the user associated with the API key. Useful for identifying the user ID for card assignments.

**Response:**
```json
{
  "id": 2,
  "username": "Greg Boon",
  "email": "greg@example.com",
  "emoji": "🧑‍💻",
  "role": "admin"
}
```

---

### Boards

#### List Boards

```
GET /api/v1/boards
```

Returns all boards the API key's user has access to.

**Response:**
```json
[
  {
    "id": 1,
    "name": "Sprint 42",
    "emoji": "🚀",
    "parentCardId": null,
    "categoryId": null,
    "isPublic": false,
    "createdBy": 1,
    "createdAt": "2026-04-01 12:00:00",
    "updatedAt": "2026-04-09 10:30:00"
  }
]
```

---

#### Get Board Details

```
GET /api/v1/boards/:boardId
```

Returns a single board with its columns.

**Response:**
```json
{
  "id": 1,
  "name": "Sprint 42",
  "emoji": "🚀",
  "columns": [
    { "id": 1, "title": "To Do", "position": 0, "color": "#6366f1" },
    { "id": 2, "title": "On Hold", "position": 1, "color": "#ef4444" },
    { "id": 3, "title": "In Progress", "position": 2, "color": "#f59e0b" },
    { "id": 4, "title": "Complete", "position": 3, "color": "#10b981" }
  ]
}
```

---

### Cards

Each card has a unique numeric ID (e.g. `#10`) that is displayed in the DumpFire UI. You can search for cards by their ID using `#N` syntax in the board or All Tasks search bar.

#### List Cards on a Board

```
GET /api/v1/boards/:boardId/cards
```

**Query Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `columnId` | number | Filter cards to a specific column |
| `archived` | boolean | Include archived cards (default: `false`) |

**Response:**
```json
[
  {
    "id": 10,
    "columnId": 1,
    "title": "Fix login bug",
    "description": "Users can't log in on Safari",
    "priority": "high",
    "position": 0,
    "dueDate": "2026-04-15",
    "columnTitle": "To Do",
    "createdAt": "2026-04-01 09:00:00",
    "updatedAt": "2026-04-09 10:00:00"
  }
]
```

---

#### Create a Card

```
POST /api/v1/boards/:boardId/cards
```

**Request Body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `columnId` | number | ✅ | The column to place the card in |
| `title` | string | ✅ | Card title (max 500 chars) |
| `description` | string | | Card description (max 50,000 chars) |
| `priority` | string | | `low`, `medium`, `high`, or `critical` (default: `medium`) |
| `colorTag` | string | | Hex colour for visual tagging |
| `categoryId` | number | | Category ID to assign |
| `dueDate` | string | | ISO date string (e.g. `2026-04-15`) |
| `businessValue` | string | | Business value description |
| `position` | number | | Position within the column (default: `0`) |

**Example:**
```json
{
  "columnId": 1,
  "title": "Automate deployment pipeline",
  "description": "Set up GitHub Actions for CI/CD",
  "priority": "high",
  "dueDate": "2026-04-20"
}
```

**Response:** `201 Created` with the created card object.

---

#### Get a Single Card

```
GET /api/v1/cards/:cardId
```

Returns the card with its subtasks, label IDs, and assignees.

**Response:**
```json
{
  "id": 10,
  "columnId": 1,
  "boardId": 1,
  "columnTitle": "To Do",
  "title": "Fix login bug",
  "description": "Users can't log in on Safari",
  "priority": "high",
  "subtasks": [
    {
      "id": 1,
      "cardId": 10,
      "title": "Reproduce on Safari 17",
      "completed": false,
      "position": 0
    }
  ],
  "labelIds": [1, 3],
  "assignees": [
    { "id": 1, "username": "alice", "emoji": "👩‍💻" }
  ]
}
```

---

#### Update a Card

```
PUT /api/v1/cards/:cardId
```

**Updatable Fields:**

| Field | Type | Description |
|-------|------|-------------|
| `title` | string | Card title |
| `description` | string | Card description |
| `priority` | string | `low`, `medium`, `high`, `critical` |
| `colorTag` | string | Hex colour tag |
| `categoryId` | number | Category ID |
| `dueDate` | string | Due date |
| `onHoldNote` | string | Note when card is on hold |
| `businessValue` | string | Business value description |
| `pinned` | boolean | Pin to top of column |
| `coverUrl` | string | Cover image URL |

**Example:**
```json
{
  "priority": "critical",
  "dueDate": "2026-04-12"
}
```

**Response:** `200` with the updated card object.

---

#### Delete a Card

```
DELETE /api/v1/cards/:cardId
```

By default, this **archives** the card (soft-delete). Add `?permanent=true` to permanently delete.

| Parameter | Type | Description |
|-----------|------|-------------|
| `permanent` | boolean | Permanently delete instead of archiving |

**Response:**
```json
{ "success": true }
```

---

### Card Assignees

#### List Assignees

```
GET /api/v1/cards/:cardId/assignees
```

**Response:**
```json
[
  { "id": 2, "username": "Greg Boon", "emoji": "🧑‍💻" }
]
```

---

#### Assign a User

```
POST /api/v1/cards/:cardId/assignees
```

**Request Body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `userId` | number | ✅ | ID of the user to assign |

**Response:**
```json
{ "success": true, "message": "User assigned" }
```

---

#### Remove an Assignee

```
DELETE /api/v1/cards/:cardId/assignees
```

**Request Body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `userId` | number | ✅ | ID of the user to unassign |

**Response:**
```json
{ "success": true }
```

---

### Card Movement

#### Move a Card to a Different Column

```
PUT /api/v1/cards/:cardId/move
```

This endpoint moves a card between columns on the same board. It triggers the same completion/XP logic as dragging a card in the UI — moving to the "Complete" column awards XP and fires a celebration event.

**Request Body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `columnId` | number | ✅ | Target column ID |
| `position` | number | | Position within the target column |

**Example:**
```json
{
  "columnId": 4,
  "position": 0
}
```

**Response:**
```json
{
  "id": 10,
  "columnId": 4,
  "columnTitle": "Complete",
  "boardId": 1,
  "completedAt": "2026-04-09T10:45:00.000Z"
}
```

---

### Subtasks

#### List Subtasks

```
GET /api/v1/cards/:cardId/subtasks
```

**Response:**
```json
[
  {
    "id": 1,
    "cardId": 10,
    "title": "Reproduce on Safari 17",
    "description": "",
    "priority": "medium",
    "completed": false,
    "position": 0
  }
]
```

---

#### Create a Subtask

```
POST /api/v1/cards/:cardId/subtasks
```

**Request Body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `title` | string | ✅ | Subtask title (max 500 chars) |
| `description` | string | | Description |
| `priority` | string | | `low`, `medium`, `high`, `critical` |
| `colorTag` | string | | Hex colour tag |
| `dueDate` | string | | Due date |
| `position` | number | | Position within the subtask list |

**Response:** `201 Created` with the subtask object.

---

#### Update a Subtask

```
PUT /api/v1/subtasks/:subtaskId
```

**Updatable Fields:**

| Field | Type | Description |
|-------|------|-------------|
| `title` | string | Subtask title |
| `description` | string | Description |
| `priority` | string | Priority level |
| `colorTag` | string | Colour tag |
| `dueDate` | string | Due date |
| `completed` | boolean | Mark as complete/incomplete |
| `position` | number | Position in list |

**Response:** `200` with the updated subtask.

---

#### Delete a Subtask

```
DELETE /api/v1/subtasks/:subtaskId
```

Permanently deletes the subtask.

**Response:**
```json
{ "success": true }
```

---

### Dependencies

Records which card blocks which. This is one of only two planning facts stored by hand —
everything the planning view shows (critical path, what is startable, what is blocked) is
computed from it, so it can never go stale.

Direction, stated once: **`cardId` is the card that is blocked; `dependsOnCardId` is its
blocker.** Cross-board dependencies are allowed, and require edit access to both ends.

#### List Dependencies

```http
GET /api/v1/cards/{cardId}/dependencies
```

**Query parameters:**

| Parameter | Description |
|-----------|-------------|
| `direction` | `blocked-by`, `blocks`, or `both` (default) |

**Response:**
```json
{
  "cardId": 1559,
  "isBlocked": true,
  "blockedBy": [
    {
      "id": 12,
      "cardId": 1686,
      "title": "Compose network segmentation applied on the new host",
      "boardId": 1,
      "boardName": "VectorOMS",
      "columnName": "In Progress",
      "priority": "critical",
      "resolved": false,
      "createdByUserId": 2,
      "createdAt": "2026-09-11 09:14:02"
    }
  ],
  "blocks": []
}
```

`resolved` is true once that end reaches a Complete column. `GET /api/v1/cards/{cardId}`
also returns `isBlocked`, `blockedBy` and `blocks`, so a planning client needs only one
request per card.

#### Add a Dependency

```http
POST /api/v1/cards/{cardId}/dependencies
```

**Request body** — send exactly one of:

| Field | Meaning |
|-------|---------|
| `dependsOnCardId` | This card waits on that one |
| `blocksCardId` | That card waits on this one |

Both spellings are accepted so a caller never has to work out which end of the pair owns
the stored row.

```json
{ "dependsOnCardId": 1686 }
```

**Response:** `201 Created`
```json
{ "id": 12, "blockedCardId": 1559, "blockerCardId": 1686,
  "title": "Compose network segmentation applied on the new host",
  "createdAt": "2026-09-11 09:14:02" }
```

**Errors:**

| Code | Cause |
|------|-------|
| `400` | A card cannot depend on itself; both or neither spelling supplied |
| `403` | No edit access to one of the two boards |
| `409` | That dependency already exists |
| `409` | The dependency would create a cycle |

A rejected cycle names the loop it found, because "rejected" on its own is not useful when
the loop runs through five cards on three boards:

```json
{
  "error": "That dependency would create a cycle",
  "cycle": [1559, 1686, 1198],
  "message": "Cycle: #1559 → #1686 → #1198 → #1559"
}
```

#### Remove a Dependency

```http
DELETE /api/v1/cards/{cardId}/dependencies
```

Takes the same two body spellings as `POST`.

**Response:**
```json
{ "success": true, "removed": 1 }
```

#### Unblock Behaviour

When a card reaches a Complete column, every card whose **last** open blocker it was gets a
system comment and its assignees are emailed:

```
Unblocked: #1686 "Compose network segmentation applied on the new host" completed —
nothing is blocking this card now.
```

A card that still has other blockers outstanding is left alone. This fires on all three
completion paths — drag-and-drop, the card update endpoint, and `PUT /api/v1/cards/{id}/move`.

---

### Milestones

A milestone is a goal that spans many cards — the second and last planning fact recorded by
hand. A card belongs to at most one milestone. `boardId` is nullable: omit it for a goal
that spans several projects, which is the case a Kanban board cannot express on its own.

There are deliberately no per-card dates or estimates. Sequencing comes from dependencies,
and everything else is computed.

#### List Milestones

```http
GET /api/v1/milestones
```

**Query parameters:** `boardId`, `status` (`open` | `closed`).

**Response:**
```json
[
  {
    "id": 4,
    "boardId": null,
    "name": "Azure VM migration, all environments",
    "description": "Every environment off the old host and onto Azure VMs.",
    "targetDate": "2026-12-01",
    "status": "open",
    "createdBy": 2,
    "boardName": null,
    "cardCount": 9,
    "doneCount": 1,
    "boardIds": [1, 8]
  }
]
```

#### Create a Milestone

```http
POST /api/v1/milestones
```

| Field | Required | Description |
|-------|----------|-------------|
| `name` | ✅ | Max 200 chars |
| `boardId` | | Omit or `null` for a cross-board goal |
| `description` | | Free text |
| `targetDate` | | `YYYY-MM-DD` |

**Response:** `201 Created` with the milestone.

#### Get, Update, Delete

```http
GET    /api/v1/milestones/{milestoneId}
PATCH  /api/v1/milestones/{milestoneId}
DELETE /api/v1/milestones/{milestoneId}
```

`PATCH` accepts `name`, `description`, `targetDate`, `status` and `boardId`.

`DELETE` removes the goal but **never the work** — its cards are released back to having no
milestone:

```json
{ "success": true, "cardsReleased": 9 }
```

#### Attach and Detach Cards

```http
POST   /api/v1/milestones/{milestoneId}/cards    { "cardId": 1559 }
DELETE /api/v1/milestones/{milestoneId}/cards    { "cardId": 1559 }
```

A card is in at most one milestone, so attaching replaces whatever it was in before rather
than erroring. A board-scoped milestone will not take a card from another board — make the
milestone cross-board first, or move the card.

#### Export a Plan as PDF

```http
GET /api/v1/milestones/{milestoneId}/pdf
```

Returns the plan as a PDF for a stakeholder pack — the same document the download button on
the planning view produces. Contains progress, the chain that cannot slip, what can be
started today with how much each one unblocks, what is waiting and on what, and the full
list of work in the goal.

Drawn with the same palette and helpers as the board reports, so it belongs in the same
pack. The `[Claude]` tag is stripped from every title. The dependency graph is drawn only
when it fits at a readable size; past that the document says how many items and stages
there are instead of shrinking the picture into something illegible.

`Content-Disposition` names the file after the goal and the date
(`plan-azure-vm-migration-2026-09-11.pdf`), so a saved copy is still identifiable later.

Access is governed by the same rule as reading the plan — exporting it is reading it.

```powershell
.\.agent\scripts\dumpfire-api.ps1 -Action milestone-pdf -ApiKey $KEY -MilestoneId 4 -OutFile plan.pdf
```

---

#### Milestone Summary

```http
GET /api/v1/milestones/{milestoneId}/summary
```

**This is the endpoint to call to answer "what should I work on next for milestone X".** It
returns the whole plan in one payload, so nothing has to be re-derived per session.

| Field | Description |
|-------|-------------|
| `milestone` | The milestone record |
| `progress` | `total`, `done`, `percent`, `byColumn[]`, `openSubtasks`, `boards[]` |
| `graph` | `nodes[]`, `edges[]`, `layers[][]` (topological, left to right), `unordered[]` |
| `criticalPath` | Ordered card ids — the longest chain of **open** dependencies |
| `nextActionable` | Startable today, sorted by `downstreamCount` then priority |
| `blocked` | `{ card, blockers[] }` pairs |

**Query parameters:**

| Parameter | Description |
|-----------|-------------|
| `compact` | `true` drops `graph` (only needed for drawing) and adds `cardTitles`, a card-id → title map so the ids stay readable |

**Response (abridged):**
```json
{
  "milestone": { "id": 4, "name": "Azure VM migration, all environments" },
  "progress": {
    "total": 9, "done": 1, "percent": 11,
    "byColumn": [{ "columnTitle": "To Do", "count": 7 }],
    "openSubtasks": 0,
    "boards": [{ "id": 1, "name": "VectorOMS", "cardCount": 9 }]
  },
  "criticalPath": [1686, 1559, 1444, 1201],
  "nextActionable": [
    { "id": 1686, "title": "Compose network segmentation applied on the new host",
      "priority": "critical", "downstreamCount": 3, "onCriticalPath": true,
      "boardName": "VectorOMS", "columnTitle": "To Do" }
  ],
  "blocked": [
    { "card": { "id": 1559, "title": "Backup restore drill on the new host" },
      "blockers": [{ "id": 1686, "title": "Compose network segmentation applied on the new host",
                     "columnTitle": "To Do", "boardName": "VectorOMS" }] }
  ]
}
```

**Notes on the derived fields:**

- **`criticalPath`** is the longest chain of dependencies among cards that are **not yet
  complete**. A finished prerequisite adds no risk, so it drops out of the chain. A path of
  one card is not reported — that is just the next thing to do, and it appears in
  `nextActionable`.
- **`nextActionable`** is sorted by how many cards finishing it would unblock
  (`downstreamCount`, transitive), then by priority. On a small team the card that frees
  the most downstream work is the one worth starting.
- **`graph.nodes`** includes cards from **outside** the milestone that directly block cards
  inside it, flagged `external: true`. They never appear in `nextActionable` — they are
  context, not scope — but without them a card whose only blocker sits on another board
  would appear startable when it is not.
- **`graph.unordered`** lists milestone cards with no dependencies recorded in either
  direction, so a card is never invisible just because nobody has sequenced it.

---

### Bulk Planning

Recording a goal one link at a time does not scale past a toy example. These endpoints
describe a whole plan in one call, and validate it as a whole before writing any of it.

#### Create Many Dependencies

```http
POST /api/v1/dependencies/bulk
```

Deliberately not nested under a card — a batch spans many, and pretending it belongs to one
would make the direction harder to reason about, which is already the easiest thing here to
get wrong.

**Request body**, one of:

```json
{ "links": [
    { "blocked": 1559, "blocker": 1686 },
    { "blocked": 1444, "blocker": 1559 }
]}
```

```json
{ "chain": [1686, 1559, 1444, 1201] }
```

`chain` is sugar for a linear sequence where each card waits on the one before it. A
critical path *is* a linear chain, and writing it out as pairs is where transcription
mistakes come from. `links` entries also accept the single-endpoint spelling
(`cardId` / `dependsOnCardId`) so moving from the per-card route needs no relearning.

**Response:** `201 Created`

```json
{
  "created": 4,
  "skippedAsDuplicate": 1,
  "boardsTouched": [1, 8],
  "links": [{ "blocked": 1559, "blocker": 1686 }]
}
```

#### Attach and Detach Many Cards

```http
POST   /api/v1/milestones/{milestoneId}/cards/bulk    { "cardIds": [1686, 1559, 1444] }
DELETE /api/v1/milestones/{milestoneId}/cards/bulk    { "cardIds": [1686, 1559] }
```

```json
{
  "milestoneId": 4,
  "attached": 3,
  "skippedAlreadyIn": 2,
  "movedFromOtherGoal": [{ "cardId": 1444, "title": "DNS cutover", "fromMilestoneId": 2 }],
  "boardsTouched": [1]
}
```

A card belongs to at most one milestone, so attaching one that is already in a *different*
goal moves it. `movedFromOtherGoal` names those explicitly, so it is never a silent
surprise.

#### Batch Semantics

These rules apply to all three endpoints and are the reason they exist.

| Rule | Why |
|------|-----|
| **Validated as a whole, then written** | If anything is wrong, *nothing* is written and every problem comes back at once. Fixing a fifty-line list one error per round trip is what makes bulk import not worth using. |
| **Duplicates are skipped, not errors** | Re-running the same list is safe, so a batch can be kept in a file and replayed as the plan evolves. |
| **Cycle detection covers the batch itself** | Two links can each be fine against the stored graph and still close a loop between themselves. Proposed edges are layered on the stored graph and added one at a time, so that case is caught — a per-link check would write both and strand nodes in the milestone view. |
| **Max 500 entries per call** | |
| **Edit access on both ends** | Cross-board links are allowed; each card's board is resolved once and cached, not re-checked per link. |

**Rejection response:** `409 Conflict`, nothing written.

```json
{
  "error": "Batch rejected — nothing was written",
  "written": 0,
  "rejected": [
    {
      "link": { "blocked": 1198, "blocker": 1201 },
      "reason": "cycle",
      "cycle": [1198, 1559, 1201],
      "message": "#1198 waiting on #1201 would create a cycle: #1198 → #1559 → #1201 → #1198"
    },
    {
      "link": { "blocked": 9999, "blocker": 1201 },
      "reason": "missing-blocked",
      "message": "Card #9999 does not exist or is archived"
    }
  ],
  "forbidden": [],
  "wouldSkipAsDuplicate": 2,
  "wouldCreate": 7
}
```

Rejection reasons: `self`, `missing-blocked`, `missing-blocker`, `cycle`,
`duplicate-in-batch`.

For the milestone endpoints the equivalent field is `problems`, each entry carrying a
`cardId` and a `reason` — including the board-scope rule, whose message names the two ways
out (make the milestone cross-board, or move the card).

#### Worked Example — a goal in three commands

```powershell
$KEY = "df_…"
$API = ".\.agent\scripts\dumpfire-api.ps1"

# 1. The goal. No -BoardId means cross-board.
$ms = & $API -Action create-milestone -ApiKey $KEY `
        -Name "Azure VM migration, all environments" -TargetDate "2026-12-01" | ConvertFrom-Json

# 2. Everything that belongs to it.
& $API -Action add-milestone-cards -ApiKey $KEY `
        -MilestoneId $ms.id -CardIds "1198,1686,1559,1444,1201,1320"

# 3. The order it has to happen in.
& $API -Action add-chain -ApiKey $KEY -Chain "1198,1686,1559,1444,1201"

# Branches that are not on the main chain, as blocked:blocker pairs.
& $API -Action add-dependencies -ApiKey $KEY -Links "1444:1320"

# What falls out of it.
& $API -Action milestone-summary -ApiKey $KEY -MilestoneId $ms.id -NoGraph
```

The last call returns `criticalPath` as an ordered card-id list, `nextActionable` sorted by
how much each card unblocks, and `blocked` with each card's blockers — none of it stored,
all of it derived from the two facts recorded above.

---

## Examples

### Complete Workflow with curl

```bash
# Store your API key and base URL
API_KEY="df_your_key_here"
BASE="https://your-dumpfire-instance.com"

# 1. List your boards
curl -s -H "Authorization: Bearer $API_KEY" "$BASE/api/v1/boards" | jq

# 2. Get board details (replace 1 with your board ID)
curl -s -H "Authorization: Bearer $API_KEY" "$BASE/api/v1/boards/1" | jq

# 3. Create a new card in the "To Do" column (column ID 1)
curl -s -X POST \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "columnId": 1,
    "title": "Deploy v2.1 to production",
    "description": "Run migrations, update configs, verify health checks",
    "priority": "high",
    "dueDate": "2026-04-15"
  }' \
  "$BASE/api/v1/boards/1/cards" | jq

# 4. Add a subtask to card ID 10
curl -s -X POST \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Run database migrations",
    "priority": "critical"
  }' \
  "$BASE/api/v1/cards/10/subtasks" | jq

# 5. Mark the subtask as complete (subtask ID 1)
curl -s -X PUT \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"completed": true}' \
  "$BASE/api/v1/subtasks/1" | jq

# 6. Move the card to "In Progress" (column ID 3)
curl -s -X PUT \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"columnId": 3}' \
  "$BASE/api/v1/cards/10/move" | jq

# 7. Move the card to "Complete" (column ID 4) — awards XP!
curl -s -X PUT \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"columnId": 4}' \
  "$BASE/api/v1/cards/10/move" | jq

# 8. Archive the card
curl -s -X DELETE \
  -H "Authorization: Bearer $API_KEY" \
  "$BASE/api/v1/cards/10" | jq
```

### Python Example

```python
import requests

API_KEY = "df_your_key_here"
BASE = "https://your-dumpfire-instance.com"
HEADERS = {
    "Authorization": f"Bearer {API_KEY}",
    "Content-Type": "application/json"
}

# List boards
boards = requests.get(f"{BASE}/api/v1/boards", headers=HEADERS).json()
print(f"Found {len(boards)} boards")

# Create a card
card = requests.post(
    f"{BASE}/api/v1/boards/{boards[0]['id']}/cards",
    headers=HEADERS,
    json={
        "columnId": 1,  # Replace with actual column ID
        "title": "Automated task from Python",
        "priority": "medium"
    }
).json()
print(f"Created card: {card['id']} - {card['title']}")

# Move to In Progress
requests.put(
    f"{BASE}/api/v1/cards/{card['id']}/move",
    headers=HEADERS,
    json={"columnId": 3}  # Replace with your In Progress column ID
)
print("Card moved to In Progress")
```

### PowerShell Example

```powershell
$ApiKey = "df_your_key_here"
$Base = "https://your-dumpfire-instance.com"
$Headers = @{
    "Authorization" = "Bearer $ApiKey"
    "Content-Type" = "application/json"
}

# List boards
$boards = Invoke-RestMethod -Uri "$Base/api/v1/boards" -Headers $Headers
Write-Host "Found $($boards.Count) boards"

# Create a card
$body = @{
    columnId = 1
    title = "Automated task from PowerShell"
    priority = "high"
} | ConvertTo-Json

$card = Invoke-RestMethod -Method Post -Uri "$Base/api/v1/boards/1/cards" -Headers $Headers -Body $body
Write-Host "Created card: $($card.id) - $($card.title)"
```
