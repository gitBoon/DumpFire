---
title: "External API Reference"
category: Integration
version: 1.1
status: As-Built
date: 2026-04-22
tags:
  - api
  - rest
  - integration
  - developer
  - automation
  - reference
description: "Complete REST API reference for DumpFire's external v1 API with authentication, endpoints, and examples"
---

# External API Reference

DumpFire exposes a RESTful API at `/api/v1/*` for automation, integrations, and external tooling. All data is JSON.

## Authentication

All requests require a **Bearer token** in the `Authorization` header:

```
Authorization: Bearer df_your_api_key_here
```

### Generating a Key

1. Log in → **My Account** (⚙️) → **API Keys** section
2. Enter a name → **Generate Key**
3. Copy the key immediately — it is shown **once only**

Keys inherit the permissions of the user who created them.

## Rate Limits

| Limit | Value |
|-------|-------|
| Requests per minute | **60** per API key |
| Exceeded response | `429 Too Many Requests` |
| Retry header | `Retry-After: <seconds>` |

## Error Format

All errors return JSON:

```json
{
  "error": "Description of what went wrong"
}
```

| Code | Meaning |
|------|---------|
| `200` | Success |
| `201` | Created |
| `400` | Bad request |
| `401` | Unauthorized |
| `403` | Forbidden |
| `404` | Not found |
| `429` | Rate limited |
| `500` | Server error |

---

## Endpoint Overview

```mermaid
flowchart TB
    subgraph Auth["Authentication"]
        Me["GET /me"]
    end

    subgraph Boards["Boards"]
        ListBoards["GET /boards"]
        GetBoard["GET /boards/:id"]
        CreateBoard["POST /boards"]
    end

    subgraph Cards["Cards"]
        ListCards["GET /boards/:id/cards"]
        CreateCard["POST /boards/:id/cards"]
        GetCard["GET /cards/:id"]
        UpdateCard["PUT /cards/:id"]
        DeleteCard["DELETE /cards/:id"]
        MoveCard["PUT /cards/:id/move"]
    end

    subgraph Assignees["Assignees"]
        ListAssignees["GET /cards/:id/assignees"]
        AddAssignee["POST /cards/:id/assignees"]
        RemoveAssignee["DELETE /cards/:id/assignees"]
    end

    subgraph Subtasks["Subtasks"]
        ListSubtasks["GET /cards/:id/subtasks"]
        CreateSubtask["POST /cards/:id/subtasks"]
        UpdateSubtask["PUT /subtasks/:id"]
        DeleteSubtask["DELETE /subtasks/:id"]
    end

    subgraph Comments["Comments"]
        ListComments["GET /cards/:id/comments"]
        AddComment["POST /cards/:id/comments"]
    end
```

---

## Endpoints

### Current User

#### `GET /api/v1/me`

Returns the authenticated user's profile.

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

#### `GET /api/v1/boards`

List all boards accessible to your API key.

#### `GET /api/v1/boards/:boardId`

Get a single board with its columns.

#### `POST /api/v1/boards`

Create a new board. Default columns (To Do, On Hold, In Progress, Complete) are created automatically.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | ✅ | Board name (max 200) |
| `emoji` | string | | Board icon (default: 📋) |
| `parentCardId` | number | | Link as sub-board to a card |

---

### Cards

Each card has a unique numeric ID shown in the UI as `#N`. You can search for cards by ID in both the board view and All Tasks view.

#### `GET /api/v1/boards/:boardId/cards`

List cards on a board.

| Parameter | Type | Description |
|-----------|------|-------------|
| `columnId` | number | Filter to specific column |
| `archived` | boolean | Include archived cards |

#### `POST /api/v1/boards/:boardId/cards`

Create a card.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `columnId` | number | ✅ | Target column |
| `title` | string | ✅ | Card title (max 500) |
| `description` | string | | Markdown description |
| `priority` | string | | `low` / `medium` / `high` / `critical` |
| `dueDate` | string | | ISO date |
| `businessValue` | string | | Business justification |
| `colorTag` | string | | Hex colour |
| `categoryId` | number | | Category ID |
| `position` | number | | Position in column |

#### `GET /api/v1/cards/:cardId`

Get a card with subtasks, labels, and assignees.

#### `PUT /api/v1/cards/:cardId`

Update card fields. Only include fields you want to change.

#### `DELETE /api/v1/cards/:cardId`

Archive a card. Add `?permanent=true` to hard-delete.

#### `PUT /api/v1/cards/:cardId/move`

Move a card to a different column. Triggers completion logic and XP if moved to a "Complete" column.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `columnId` | number | ✅ | Target column ID |
| `position` | number | | Position in target column |

---

### Assignees

#### `GET /api/v1/cards/:cardId/assignees`

List users assigned to a card.

#### `POST /api/v1/cards/:cardId/assignees`

Assign a user: `{ "userId": 2 }`

#### `DELETE /api/v1/cards/:cardId/assignees`

Remove an assignee: `{ "userId": 2 }`

---

### Subtasks

#### `GET /api/v1/cards/:cardId/subtasks`

List subtasks for a card.

#### `POST /api/v1/cards/:cardId/subtasks`

Create a subtask.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `title` | string | ✅ | Subtask title (max 500) |
| `description` | string | | Details |
| `priority` | string | | Priority level |
| `dueDate` | string | | Due date |

#### `PUT /api/v1/subtasks/:subtaskId`

Update a subtask. Set `"completed": true` to mark done.

#### `DELETE /api/v1/subtasks/:subtaskId`

Permanently delete a subtask.

---

### Comments

#### `GET /api/v1/cards/:cardId/comments`

List all comments on a card.

#### `POST /api/v1/cards/:cardId/comments`

Add a comment: `{ "content": "Your message here" }`

---

## Code Examples

### curl — Full Workflow

```bash
API="df_your_key"
URL="https://dumpfire.example.com"

# List boards
curl -s -H "Authorization: Bearer $API" "$URL/api/v1/boards" | jq

# Create a card
curl -s -X POST \
  -H "Authorization: Bearer $API" \
  -H "Content-Type: application/json" \
  -d '{"columnId":1,"title":"Deploy v3","priority":"high"}' \
  "$URL/api/v1/boards/1/cards" | jq

# Move to Complete
curl -s -X PUT \
  -H "Authorization: Bearer $API" \
  -H "Content-Type: application/json" \
  -d '{"columnId":4}' \
  "$URL/api/v1/cards/42/move" | jq
```

### PowerShell

```powershell
$h = @{
    "Authorization" = "Bearer df_your_key"
    "Content-Type" = "application/json"
}
$base = "https://dumpfire.example.com"

# List boards
Invoke-RestMethod "$base/api/v1/boards" -Headers $h

# Create card
$body = @{ columnId=1; title="Automated task"; priority="medium" } | ConvertTo-Json
Invoke-RestMethod -Method Post "$base/api/v1/boards/1/cards" -Headers $h -Body $body
```

### Python

```python
import requests

API_KEY = "df_your_key"
BASE = "https://dumpfire.example.com"
HEADERS = {"Authorization": f"Bearer {API_KEY}", "Content-Type": "application/json"}

# List boards
boards = requests.get(f"{BASE}/api/v1/boards", headers=HEADERS).json()

# Create card
card = requests.post(f"{BASE}/api/v1/boards/1/cards", headers=HEADERS,
    json={"columnId": 1, "title": "From Python", "priority": "high"}).json()

# Move to complete
requests.put(f"{BASE}/api/v1/cards/{card['id']}/move", headers=HEADERS,
    json={"columnId": 4})
```
