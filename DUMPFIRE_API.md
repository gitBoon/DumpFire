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
