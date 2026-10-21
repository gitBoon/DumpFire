# DumpFire API Documentation

DumpFire provides a REST API for automation and external integrations. You can programmatically create, read, update, delete, and move tasks (cards) on your Kanban boards.

This document does not list every route. The complete list, with every field, status and body, is the OpenAPI document: read it as a page at `/docs`, or as JSON at `/api/v1/openapi.json`.

## Table of Contents

- [Authentication](#authentication)
- [Rate Limits](#rate-limits)
- [Error Handling](#error-handling)
  - [Common HTTP Status Codes](#common-http-status-codes)
  - [The Request Body](#the-request-body)
  - [What a Field May Hold](#what-a-field-may-hold)
  - [Answers That Are Not JSON](#answers-that-are-not-json)
  - [Changes on 2026-10-14](#changes-on-2026-10-14)
  - [Changes on 2026-10-13](#changes-on-2026-10-13)
- [Writes, Failures and Retries](#writes-failures-and-retries)
- [What a Delete Removes](#what-a-delete-removes)
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
  - [Token Cost](#token-cost)
  - [Burndown](#burndown)
  - [Webhooks](#webhooks)
- [Examples](#examples)

---

## Authentication

All API requests require an API key, sent via the `Authorization` header.

### Generating an API Key

1. Log in to DumpFire
2. Navigate to **My Account** (⚙️)
3. Scroll to the **🔑 API Keys** section
4. Enter a descriptive name (e.g. "CI Pipeline", "n8n Automation")
5. Enter your current password. Generate Key stays off until there is a name and a password, and a wrong password is refused with "Password is incorrect". After ten wrong passwords in 15 minutes from one signed-in browser, at Generate Key or at the Account page's email and password forms, that browser is refused for up to 15 minutes, the right password included: "Too many wrong passwords. Try again in N minute(s)."
6. Click **Generate Key**
7. **Copy the key immediately** — it is only displayed once

A key is made only there, by the account's holder, with the password: the API itself has no route that makes a key. An account has at most ten.

### Using the API Key

Include the key in every request as a Bearer token:

```
Authorization: Bearer df_your_api_key_here
```

> **Important:** API keys inherit the permissions of the user who created them. A regular user can only access boards they have edit/view access to. Admin users have global access.

The one request that needs no key is `GET /api/v1/openapi.json`. It is not counted against the rate limit either.

### Revoking a Key

Go to **My Account → API Keys** and click **Revoke** on any key. The key is immediately invalidated.

### When a Key Ends Without Being Revoked

Setting the account's password can end every key it has, at once:

| How the password is set | The account's keys |
|-------------------------|--------------------|
| You change your own on **My Account** | Kept, unless you tick **End my API keys too** (not ticked by default) |
| You change your own on your row of the admin page | Kept |
| An administrator resets your password | All end |
| An invite link is used to set your password | All end |

A key that has ended is answered `401` with `Invalid or expired API key` from then on, the same as one that was revoked, and whatever uses it stops until it is given a new key. So before an administrator resets the password of an account a script runs on, the reset dialog says how many keys the account has. The webhooks the account set up go with its keys, switched off (see [Webhooks](#webhooks)); a reset and an invite also pause its report schedules. See [What Setting a Password Ends](docs/authentication-security.md#what-setting-a-password-ends).

---

## Rate Limits

API requests are rate-limited to **60 requests per minute** per API key, counted against the key once it has been checked. A request with no key DumpFire accepts, a missing `Authorization` header included, is counted against the address it came from instead, **60 a minute**, in a count of its own: a wrong key, even one that begins as a real key does, never spends a real key's allowance. An IPv6 address is counted by its /64 network, so every address of one network shares the one count, as callers behind one IPv4 address do; an IPv4 address written as IPv6 (`::ffff:198.51.100.7`) is counted as the IPv4 address, and a port is taken off.

When you exceed the limit, you'll receive a `429 Too Many Requests` response:

```json
{
  "message": "Rate limit exceeded",
  "retryAfterSecs": 42
}
```

The `Retry-After` header is also set, with the same number of seconds. The minute starts with the first request it counts. A request that is turned away has written nothing: send it again, unchanged, once the seconds have passed. A key that is over its limit is not recorded as used.

Behind a reverse proxy that has not been set up to say who its callers are, every caller has the proxy's address, so the count for requests with no key is one for everybody: a mistyped key may be answered `429` while somebody else is guessing. A valid key is never held up by it. See [The Caller's Address Behind a Proxy](docs/deployment.md#the-callers-address-behind-a-proxy).

---

## Error Handling

Every failure DumpFire answers under `/api/v1/` is JSON with one key, `message`, which says why. That holds whatever `Accept` header the request sent, and whether a handler refused the request or it never reached one:

```json
{
  "message": "Card not found"
}
```

Six failures carry more beside `message`:

| Answer | Beside `message` |
|--------|------------------|
| `429` | `retryAfterSecs`: seconds to wait |
| `409` for one dependency that would close a loop, from `POST` on `/cards/:cardId/dependencies` or `/subtasks/:subtaskId/dependencies` | `cycle`: the chain the link would close, in order, each entry `{ "kind": "card" or "subtask", "id": N }` |
| `409` for a rejected `POST /dependencies/bulk` | `written` (always 0), `rejected[]` (each `link`, `reason`, `message`, and `cycle` when the reason is `cycle`), `forbidden[]` (each `link`, `message`), `wouldSkipAsDuplicate`, `wouldCreate` |
| `409` for a rejected `POST /milestones/:milestoneId/cards/bulk` | `attached` (always 0), `problems[]` (each `cardId`, `reason`), `wouldAttach`, `wouldSkipAlreadyIn` |
| `409` for a rejected `DELETE /milestones/:milestoneId/cards/bulk` | `detached` (always 0), `problems[]` (each `cardId`, `reason`) |
| `409` for a rejected `POST /tokens/bulk` | `written` (always 0), `problems[]` (each `index`, `reason`) |

The `message` of every rejected batch is `Batch rejected — nothing was written`. A dependency that is already recorded is a `409` too, with `message` alone: a cycle is the `409` that has `cycle` in it. So is a board's 11th webhook (`This board has 10 webhooks, and a board may have at most 10: delete 1 before adding another.`).

```mermaid
flowchart TD
    Req["A request to /api/v1/..."] --> Kit{"Before DumpFire<br/>is given the request"}
    Kit -->|"a write sent as a form with no matching Origin,<br/>a trailing slash, a URL that is not validly encoded"| NotJson["403, 308 or 400.<br/>See: answers that are not JSON"]
    Kit --> Size{"Declares more than 512 KB<br/>in Content-Length?"}
    Size -->|"Yes"| E413a["413 message, limitBytes.<br/>The key is not looked at"]
    Size -->|"No"| Doc{"/api/v1/openapi.json ?"}
    Doc -->|"Yes"| Public["No key asked for, not counted.<br/>200 and the document"]
    Doc -->|"No"| Key{"Authorization: Bearer ...<br/>with a key that is known<br/>and not expired?"}
    Key -->|"No"| Guess{"More than 60 requests this minute<br/>from this address with no such key?"}
    Guess -->|"Yes"| E429a["429 message, retryAfterSecs,<br/>Retry-After header"]
    Guess -->|"No"| E401["401 message"]
    Key -->|"Yes"| Limit{"More than 60 requests<br/>this minute with this key?"}
    Limit -->|"Yes"| E429["429, as above"]
    Limit -->|"No"| Route{"Is the path a route?"}
    Route -->|"No"| E404["404 message: Not found"]
    Route -->|"Yes"| Method{"Does the route<br/>have this method?"}
    Method -->|"No"| E405["405 message, Allow header"]
    Method -->|"Yes"| Handler["The handler"]
    Handler -->|"body missing, not JSON<br/>or not an object"| E400["400 message"]
    Handler -->|"body read past 512 KB, sent with no length,<br/>or past the length it declared"| E413["413 message,<br/>and limitBytes for the first"]
    Handler -->|"refused: 404 then 403 for what the path names,<br/>400 for a field, 404 for what a field names"| E4xx["400, 403, 404 or 409 message"]
    Handler -->|"rejected batch,<br/>dependency cycle"| E409["409 message, and what was at fault"]
    Handler -->|"DumpFire fails"| E500["500 message: Internal Error"]
    Handler -->|"done"| Ok["200 or 201"]
```

The key is checked before the path is looked at, so without a key every path under `/api/v1/` answers `401`, a path that is no route included, or `429` once the address has sent sixty such requests in the minute. What a handler refuses, and in which order, is under [What a Field May Hold](#what-a-field-may-hold).

Every answer DumpFire's gate gives carries `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy: camera=(), microphone=(), geolocation=()` and `X-XSS-Protection: 0`, its own `401`, `413` and `429` included, unless the handler set the header itself. The last switches off the filter old browsers ran over a page, which could itself be used to make a page leak; current browsers have dropped it. No answer of the API carries a `Content-Security-Policy`: the web application's pages carry one, and an attachment keeps its own `sandbox`.

### Common HTTP Status Codes

| Code | Meaning |
|------|---------|
| `200` | Success |
| `201` | Resource created |
| `400` | Bad request: a field is missing, is of the wrong type or holds what it may not (see [What a Field May Hold](#what-a-field-may-hold)), an id in the path or the query string is not a whole number of 1 or more, or the body is missing, is not valid JSON or is not a JSON object |
| `401` | Unauthorized: no `Authorization: Bearer <key>` header, or a key that is unknown or expired |
| `403` | Forbidden: the key's user may not do this |
| `404` | The resource in the path does not exist, whoever asks; an id in the body names nothing (a category, a user, a milestone); something to be removed is not there (an assignee, a label on a card, a card in the milestone named); or the path is no route: `{ "message": "Not found" }` |
| `405` | The route does not have this method: `{ "message": "PATCH method not allowed" }`. The `Allow` header names the methods it has |
| `409` | Conflict: a card moved to a Complete column while it has open subtasks or sub-boards, a card moved onto a board beneath it, at any depth, a sub-board that would be more than 20 levels deep (made under a card, or carried by a card moved to another board), a column renamed into or out of Complete or Done while it holds a card, a dependency that already exists or would close a loop, a board's 11th webhook, or a rejected batch |
| `413` | The request body is over the size limit, 512 KB: `{ "message", "limitBytes" }`. See [The Request Body](#the-request-body) |
| `429` | Rate limit exceeded: 60 requests in the minute with one key, or 60 from one address with no key DumpFire accepts |
| `500` | DumpFire failed: `{ "message": "Internal Error" }`. Nothing of the fault is in the answer; it is written to DumpFire's system log |

### The Request Body

What a route that takes a body answers to one it cannot use:

| The body sent | Answer |
|---------------|--------|
| No body, an empty one, or text that is not JSON | `400` `{ "message": "The request body is missing or is not valid JSON" }` |
| JSON that is `null`, a number, a string or a boolean | `400` `{ "message": "The request body must be a JSON object" }` |
| A JSON array, `[]` included | `400` `{ "message": "The request body must be a JSON object" }`. No route takes one |
| More than the size limit, which is 512 KB on every route of this API, declared in `Content-Length` | `413` `{ "message": "The request is larger than this server accepts here: it is 600 KB, and the limit is 512 KB", "limitBytes": 524288 }`, before the body is read and before the key is looked at |
| A body with no `Content-Length`, one sent in chunks, that runs past 512 KB | `413` `{ "message": "The request is larger than this server accepts here: the limit is 512 KB", "limitBytes": 524288 }`, when the route reads it. It is read up to the limit and no further |
| A body that runs past the `Content-Length` it declared | `413` `{ "message": "Payload Too Large" }`, when the route reads it |

The body is judged by what it holds, not by the `Content-Type` it is sent with. Send `Content-Type: application/json` all the same: see the first row of the next table. A body sent with no `Content-Type` at all does not reach the handler, and is answered as a body that is missing.

A body does not have to say how long it is. One sent in chunks, with no `Content-Length`, is read and held to the same limit as it is read. Every ordinary client sends the length all the same (`curl`, PowerShell's `Invoke-RestMethod` and a browser's `fetch` with a string or a form all do), and a body that says it is too large is refused before any of it is read.

The limit is 512 KB here whatever `BODY_SIZE_LIMIT` the deployment sets: that variable is the most the server accepts on any route, and it is raised for the web application's attachment upload and its backup import, which are not part of this API.

### What a Field May Hold

Every operation reads each field it uses by the field's type and range, and refuses one it cannot use with `400` and a `message` that names the field. A field it does not use is left alone. Nothing is turned into another type: a number is never stored as text, text is never a boolean, and `"false"` is not false. The one exception is a number written as text that is exactly a number (`"5"`, `"-2.5"`, not `"1e3"`), which is read as that number wherever a number or an id is read.

| A field | Holds | Refused with, for example |
|---------|-------|---------------------------|
| A name: of a board, a label, a category, a board category or a milestone | Text, trimmed, of 1 to 200 characters | `name must be text`, `name is required`, `name cannot be empty`, `name must be at most 200 characters` |
| A column's `title` | Text, trimmed, of 1 to 200 characters | `title is required`, `title must be at most 200 characters` |
| A card's or a subtask's `title` | Text, trimmed, of 1 to 500 characters | `title must be text`, `title is required`, `title cannot be empty`, `title must be at most 500 characters` |
| `description`, `onHoldNote` | Text of at most 50,000 characters | `description must be text`, `description must be at most 50000 characters` |
| A comment's `content` | Text, trimmed, of 1 to 50,000 characters | `content must be text`, `Comment cannot be empty`, `content must be at most 50000 characters` |
| `businessValue` | Text of at most 10,000 characters | `businessValue must be at most 10000 characters` |
| `emoji` | Text of 1 to 32 characters | `emoji cannot be empty` |
| `priority` | `low`, `medium`, `high` or `critical`, in any case. It is stored in lower case | `priority must be one of: low, medium, high, critical` |
| `dueDate`, `targetDate` | A day of the calendar written `YYYY-MM-DD`: not `2026-02-30`, not a timestamp. `null` or `''` clears it | `dueDate must be a date written YYYY-MM-DD` |
| `colorTag` | A colour written `#rrggbb`, or `''` for none | `colorTag must be a colour written #rrggbb, or empty` |
| `color` | A colour written `#rrggbb`: `#` and six hex digits, in either case, trimmed, on a column, a label, a category and a board category, created or changed. `red`, `#fff` and `''` are refused | `color must be a colour written #rrggbb` |
| `position` | A finite number | `position must be a number` |
| `pinned`, a subtask's `completed`, `isPublic`, `showAddCard`, a webhook's `active` | `true` or `false` | `pinned must be true or false` |
| An id in the body: `columnId`, `categoryId`, `userId`, `cardId`, `milestoneId`, `parentCardId`, `labelId`, a milestone's `boardId` | A whole number of 1 or more, or one written as text (`"7"`, `"1.0"`) | `columnId must be an id` |
| `coverUrl` | A colour written `#rrggbb`, or one of the eight preset gradients exactly as the card window offers them and [Update a Card](#update-a-card) lists them, or `null`; `''` is read as `null` | `coverUrl must be a colour written #rrggbb, one of the preset gradients, or null` |
| A milestone's `status` | `open` or `closed` | `status must be open or closed` |
| `archivedAt` on `PUT /cards/:cardId` | `null`, which restores the card, and nothing else | `archivedAt may only be null, which restores the card. Archive a card with DELETE /cards/{cardId}` |
| A webhook's `url`, `secret`, `events` | An `http` or `https` address of at most 2,048 characters, trimmed, not inside the network as written and with no user name or password (see [Webhooks](#webhooks)); text of at most 256; a list of the six event names, each trimmed, where `[]` is every event | `url must be an http or https address`, `Webhook url points inside the network: 127.0.0.1 is a loopback address`, `Webhook url must not carry a user name or password`, `events must be a list` |
| The reporting fields (`summary`, `theme`, `customerImpact`, `closeReason`, `releaseState`) | Each in its own vocabulary, as before, or `null` to clear it | `theme must be one of: ...` |

`null` clears a field only where the field can be empty: a due or target date, a category, the cover, a milestone, a milestone's board, a parent card, the reporting fields. Anywhere else `null` is a value of the wrong type, and a `400`.

**A value the row already holds, sent back unchanged, is accepted as it is**, whatever these rules say of it. "Unchanged" is the same JSON type and value as the row is read. So a card stored before these rules with a priority they do not allow, or with a due date that is not a date, can still be saved by a client that sends its stored fields back with the one it changed. Any other value of that field is held to the rules. A create is held to them always, even one that copies another card's fields.

**The order a request is refused in.** One request is answered for the first thing wrong with it, in this order:

1. The body is missing, is not JSON or is not an object (`400`), or an id in the path is not a whole number of 1 or more written in digits (`400` `Invalid card ID`, `Invalid board ID` and so on).
2. What the path names is looked for (`404`), and then the caller is checked (`403`).
3. Each field is read (`400`).
4. What a field names is looked for: a column, a category, a user, a milestone (`404`). A card's `columnId` on `POST /boards/:boardId/cards` is the exception: a column that is not there, like one of another board, is `400` `Column does not belong to this board`.

So a caller who would be refused is answered `404` or `403` whatever the body holds. An operation with nothing in its path to look for (`POST /boards`, `POST /board-categories`, `POST /milestones` with no `boardId`) reads its fields first; `POST /milestones` with a `boardId` looks for that board, and checks the caller, before it reads the rest. The token routes and the three batches check their fields before they look for what the entries name, as [Token Cost](#token-cost) and [Bulk Planning](#bulk-planning) say.

### Answers That Are Not JSON

Three answers are not JSON. Each is made by SvelteKit before DumpFire's gate is given the request, so the gate cannot make it JSON, and none carries the headers above:

| Request | Answer | Send instead |
|---------|--------|--------------|
| A `POST`, `PUT`, `PATCH` or `DELETE` whose `Content-Type` is that of a form (`application/x-www-form-urlencoded`, `multipart/form-data`) or `text/plain`, with no `Origin` header that matches the server. Only a deployed server makes this check; a development server does not. `curl -d` with no `Content-Type` header sends exactly this | `403` in plain text. It is JSON, `{ "message": "Cross-site POST form submissions are forbidden" }`, only when the request's `Accept` header is exactly `application/json` | `Content-Type: application/json` |
| A trailing slash on a route's path | `308` to the same path without it | The path without the slash |
| A URL that is not validly encoded | `400` in plain text | A valid URL |

`/api/v1` with nothing after it is not under `/api/v1/`. DumpFire's gate takes it for a path of the web application's own, which a key does not open: it is answered `401` `{ "message": "Not authenticated" }`, or, to a browser, with a redirect to the login page. Send `/api/v1/` and a route.

A `502`, `503` or `504` is not DumpFire's either: see [Writes, Failures and Retries](#writes-failures-and-retries).

### Changes on 2026-10-14

The OpenAPI document's version went from `1.1.0` to `1.2.0` with these. One operation is new, `DELETE /comments/:commentId` (card 2283); these operations, answers and fields are:

- **A `413` carries `limitBytes`**, the limit as a number of bytes, beside a `message` that says the limit. It was `{ "message": "Payload Too Large" }` alone, which it still is for a body that runs past the `Content-Length` it declared.
- **A `413` can come before the key is looked at.** A body that declares more than 512 KB is refused before anything else, so a request with no key, or a wrong one, is answered `413` where it was `401`.
- **A request with no key DumpFire accepts can be answered `429`.** It is counted against its address, 60 a minute, and the 61st is `429` with `retryAfterSecs` and `Retry-After` where it was `401`.
- **A body sent in chunks, with no `Content-Length`, is held to the limit as it is read**, and answered `413` with `limitBytes` once it passes it. A deployed server read such a body to its end, however large.
- **The rate limit is counted after the key is checked**, against the key itself. It was counted first, against the first 11 characters of whatever key was sent, so a request with a wrong key that began as a real one did spend that key's allowance.
- **A request with no key DumpFire accepts is counted against its address**, 60 a minute, apart from every key's count. One with no `Authorization` header was not counted at all, and one with a wrong key was counted against the first 11 characters of that key.
- **`last_used_at` is not touched by a request refused for the rate limit.**
- **Every answer carries the five security headers**, listed under [Error Handling](#error-handling). An answer carried `nosniff` alone, and the `401` and `429` none. `X-XSS-Protection` is `0`.
- **`/api/v1` with nothing after it is answered `401` in JSON**, where it was a `303` to the login page.
- **A body that is a JSON array is answered `400` `{ "message": "The request body must be a JSON object" }`** on every route, before the route reads a field of it. It was passed to the route, which refused it in its own words as a body without the fields it needs (`400` `name is required` on `POST /boards`).
- **A board that does not exist is `404` `Board not found` to everyone**, on `GET`, `PUT` and `DELETE /boards/:boardId`, on `GET` and `POST` of its `/cards`, `/columns`, `/labels` and `/categories`. Everyone but an administrator was answered `403`, and an administrator an empty list from the four lists and a `500` from the three creates of a column, a label and a category. A board that is there and that the caller cannot open is still `403`.
- **Every operation that takes a body reads it before it looks for the resource**, so a body that cannot be read is `400` to a caller who would be refused, where eleven operations answered `403` or `404`: see [Writes, Failures and Retries](#writes-failures-and-retries). What a field holds is still looked at after the `404` and the `403`.
- **Fields are read by their type and range** on the operations that create or change a column, a label, a category or a webhook, that change a board category, and that put a label on a card or take it off. A field of the wrong type, or one it may not hold, is `400` naming the field, where it was stored as sent or was a `500`. A value the row already holds, sent back unchanged, is accepted as it is.
  - A name or a title is text, trimmed, of 1 to 200 characters. One that was not text was turned into text, or was a `500`.
  - A `color` is a colour written `#rrggbb` (`color must be a colour written #rrggbb`): see **Every colour is a colour written `#rrggbb`** below. Any text was stored; `''` gave the default on create and is now `400` in those words.
  - A column's `position` is a number, or a number written as text: text was stored, and `null` gave the default. `showAddCard` and a webhook's `active` are `true` or `false`: `"false"` was stored as true. `wipLimit` is read as before.
  - A webhook's `url` is an `http` or `https` address of at most 2,048 characters, trimmed (`url must be an http or https address`); any text was stored, and `''` was accepted on an update. Its `secret` is text of at most 256 characters. Its `events` are a list of the six names, each trimmed (`events must be a list`, `events[n] must be one of: ...`): text and `null` were stored, and `null` stopped the board's deliveries.
  - `labelId` on `POST /cards/:cardId/labels` is an id, `400` `labelId must be an id`: `0`, `''` and `false` were `labelId is required`, and `true` and a list went on.
- **Taking a label off a card that does not have it is `404` `Label not found on this card`**, where it was `200`.
- **A label, column, category, board category or webhook deleted while its update was arriving is `404`**, where it was `200` with no body, or for a webhook `500`.
- **The four dependency operations read their ids as ids**, `POST` and `DELETE` on `/cards/:cardId/dependencies` and `/subtasks/:subtaskId/dependencies`. An id in the path of `0`, `1.5` or `-1` is `400` `Invalid card ID` or `Invalid subtask ID`, where it was `404`, and so is `1e3`, which was read as the id 1000. An id in the body of `0`, `-1`, `1.5`, `''` or `false` is `400` `<field> must be an id`, where it was `404` `#0 not found`; `true`, which was read as card 1, and a list, which was read as the id in it, are `400` as well. Two ends sent, one of them no id, is answered `<field> must be an id`, where it was the refusal for sending two.
- **A subtask's dependencies are recorded in the activity log**, as a card's are: `POST /subtasks/:subtaskId/dependencies` writes `api:dependency_added` on the board of the subtask's card, and `DELETE` writes `api:dependency_removed` on the board of the end that waits. They wrote none. See [Subtask Dependencies](#subtask-dependencies).
- **A new comment is read as an edit is.** `POST /cards/:cardId/comments` answers `400` `content must be text` for content that is not text, where it was a `500` (and `null` was `Comment cannot be empty`), and `400` `content must be at most 50000 characters` for content over 50,000 characters once trimmed, where any length was stored. `PUT /comments/:commentId` already held an edit to 50,000. It looks for the card, and checks the caller, before it reads the content: a card that is not there is `404` and a key whose user may not edit its board `403`, whatever the content, where an empty or missing one was answered `400` `Comment cannot be empty` first.
- **The activity report does not count a dependency added or removed as work on a card.** `GET /reports/activity` leaves out a card whose only activity in the window is a `dependency_added`, `dependency_removed` or `dependencies_bulk_added` entry, in either spelling, and a report on one user does not take a card to be theirs for one. The API's own entries for a dependency counted until this date, and the web application now writes them too. `dependencies_bulk_added` is written by older versions only (card 2291). Nor does a card put in a milestone or taken out, `milestone_card_added` or `milestone_card_removed` (card 2289): planning, as a link is. The card's `updatedAt` still moves, so the card can still be in the window.
- **A board member stored with a role other than `owner`, `editor` or `viewer` has a viewer's access.** The web application's sharing stored any text as a role until this date; a member stored as `admin` had an administrator's access to that board, by either API tree.
- **Every id in a path is read as an id**, on every operation: one that is not a whole number of 1 or more written in digits (`1.5`, `abc`, `0`, `1e3`) is `400` `Invalid <thing> ID`. Some were read as another id (`1e3` as 1000) or as none, and answered `404` or `403`; `GET /cards/:cardId/comments` answered `404`. An id in a query string is read the same way: `columnId` on `GET /boards/:boardId/cards`, `boardId` on `GET /milestones` (`Invalid boardId`), `boardId`, `userId` and `cardId` on `GET /audit-log`, and each of `boardIds` on `GET /reports/activity`. One that was not an id matched nothing, or was left out.
- **Fields are read by their type and range** on the operations that create or change a board, a board category, a card, a subtask or a milestone, that move a card, that assign and remove an assignee, that edit a comment, and that put a card into a milestone or take it out. A field of the wrong type, or one it may not hold, is `400` naming the field, where it was stored as sent or was a `500`. A value the row already holds, sent back unchanged, is accepted as it is, even one these rules would refuse.
  - A name is text, trimmed, of 1 to 200 characters, and a card's or a subtask's title of 1 to 500: an empty title was stored on an update, and a name that was not text was a `500` (`name must be text`). An emoji is 1 to 32 characters: `''` gave the default on `POST /boards` and is `emoji cannot be empty`.
  - A `description` and an `onHoldNote` are text of at most 50,000 characters, and a `businessValue` of at most 10,000. A `coverUrl` is a colour or one of the preset gradients, or `null` (card 2010, below).
  - A `priority` is `low`, `medium`, `high` or `critical`, in any case, and is stored in lower case (`priority must be one of: low, medium, high, critical`). Any text was stored.
  - A `dueDate` or a `targetDate` is a day of the calendar written `YYYY-MM-DD` (`dueDate must be a date written YYYY-MM-DD`), and `null` or `''` clears it. Any text was stored.
  - A `colorTag` is a colour written `#rrggbb`, or `''` for none, and a board category's `color` a colour written `#rrggbb`: see **Every colour is a colour written `#rrggbb`** below. Any text was stored.
  - A `position` is a number, or a number written as text: `"top"` was stored, and on `PUT /cards/:cardId/move` a position that was not a number was ignored. `pinned` and a subtask's `completed` are `true` or `false`: `"false"` was stored as true.
  - An id in the body (`columnId`, `categoryId`, `parentCardId`, `userId`, `cardId`, `milestoneId`, a milestone's `boardId`) is a whole number of 1 or more, `<field> must be an id`. A milestone's `status` is `open` or `closed`.
- **Those operations look for what the path names, and check the caller, before they read a field**, so a caller who would be refused is answered `404` or `403` whatever the body holds. `PUT /comments/:commentId` and `POST` and `DELETE /milestones/:milestoneId/cards` looked at a field first, and answered `400`. A board, a board category and a milestone of no board have nothing to look for, and read their fields first; `POST /milestones` with a `boardId` looks for the board, and checks the caller, before it reads the other fields.
- **`archivedAt` on `PUT /cards/:cardId` may only be `null`**, which restores the card, as the tracking workflow restores one. Another value, which was stored, is `400` `archivedAt may only be null, which restores the card. Archive a card with DELETE /cards/{cardId}`. The stamp the card already holds, sent back, changes nothing. `archivedAt: null` sent with a `milestoneId` restores the card and then puts it in the milestone, where the card was refused as archived; a milestone that is refused leaves the card archived.
- **A card's `categoryId` is one of its board's categories, or one that belongs to no board**, on `POST /boards/:boardId/cards` and `PUT /cards/:cardId`. Another board's, which was stored, and one that does not exist, which was a `500`, are `404` `Category not found on this board`. A card already filed under another board's keeps it while it is sent back unchanged. `PUT /boards/:boardId` answers a board category that does not exist `404` `Board category not found`, where it was stored.
- **Removing an assignee who is not on the card is `404` `User is not assigned to this card`** on `DELETE /cards/:cardId/assignees`, where it was `200`, with an activity entry that said they had been removed. It writes no entry and sends no live update.
- **Taking a card out of a milestone is one rule on every operation.** `DELETE /milestones/:milestoneId/cards` answers `404` `Card is not in this milestone` for a card that is not in it, where a card in another milestone was taken out of that one and a card in none was a success. Taking a card out, there or with `milestoneId: null` on `PUT /cards/:cardId`, needs the right to change the milestone it is in: someone who may edit the card's board, and neither made a cross-board milestone nor is an administrator, is answered `403` `No edit access to this milestone`, as they already were for putting a card in, or `403` `No access to this milestone` when the milestone has cards on a board they cannot open. Putting a card in another milestone takes it out of the one it is in, so it needs the right to change that one too: `POST /milestones/:milestoneId/cards` and `milestoneId` on `PUT /cards/:cardId` answer the same `403`, and `POST /milestones/:milestoneId/cards/bulk` lists the card under `problems` (`No edit access to milestone #<id>, which holds card #<n>`) and writes nothing. Each moved the card. The milestone the card is already in, sent back on `PUT /cards/:cardId`, changes nothing.
- **An archived card is not put into a milestone**, by `POST /milestones/:milestoneId/cards` or by `milestoneId` on `PUT /cards/:cardId`: `400` `Card does not exist or is archived`, the words the bulk operation refuses one in. It was put in.
- **A batch names an entry that is not what it holds.** An entry of `links` on `POST /dependencies/bulk`, or of `entries` on `POST /tokens/bulk`, that is not an object is `400` `links[<n>] must be an object`, where it was a `500`. An entry of `cardIds` on the two milestone batches that is not an id is `400` `cardIds[<n>] must be an id`, where `null` was read as card 0 and reported in a `409`. A `blockedType` or `blockerType` other than `card` or `subtask` is `400` `links[<n>].blockedType must be one of: card, subtask`, where it was reported in a `409`. The batches still report a link already recorded, and a card not in the milestone, and carry on.
- **`GET /audit-log` reads `limit` and `offset` as whole numbers.** `limit` is rounded down and held between 1 and 500, `offset` rounded down and 0 or more, and text that is not a number is the default, as `limit=0` is, as it was. `limit=-1` answered every entry, `limit=2.5` was a `500`, and a negative `offset` was echoed.
- **`GET /reports/activity` reads its window as dates.** A `from` or `to` that is neither a date nor a timestamp is `400` `from is not a date`, where it was taken as the window; a timestamp with an offset, or with no zone, is read in UTC, where `09:00+02:00` was compared as 09:00. A bare-date `to` is read as the end of that day when it is checked that `from` is not after it, as the report itself reads it: `from=2026-10-14T09:00:00Z&to=2026-10-14`, the rest of that day, was `400` `` `from` is after `to` ``. `commentLimit=0` gives each card an empty `comments` list, where it was read as 3, and a negative `commentLimit`, or one that is not whole, is `400`, where a negative one left the key out.
- **`GET /me/stats` answers an average cycle time of 0 as `0`**, where it was `null`.
- **The compact milestone summary keeps its titles apart.** `GET /milestones/:milestoneId/summary?compact=true` has the cards' titles in `cardTitles` and the subtasks' in a new `subtaskTitles`, each by its id. Both were in `cardTitles` by the bare id, and a card and a subtask with the same id took one key between them.
- **`POST /dependencies/bulk` reads each end as an id.** An end of a link, or an entry of `chain`, whose id is not a whole number of 1 or more (`1.5`, `"1e3"`, `0`, `-1`, `"subtask:abc"`), a list, or an object whose `kind` is not `card` or `subtask`, is `400` `<entry> must be a card id, "subtask:<id>", or {kind, id}`, naming the entry (`links[0].blocker`, `chain[1]`). `1.5` and `"1e3"` were taken as ids and reported in the `409` as links to nothing, a list was read as the id in it, and another `kind` as a card.
- **A webhook's `url` goes with its secret** (card 2133). It is answered only to the board's owner and an administrator, and in the answer to the `POST` that created the webhook. `GET /boards/:boardId/webhooks`, `GET /webhooks/:webhookId` and the answer to `PUT /webhooks/:webhookId` leave the key out for anyone else, an editor's own update included, where every caller who could view the board was given it. Since card 2154 (item 57, below) an editor can no longer set a new address either.
- **`recentActivity` on `GET /me/stats` lists only entries on boards the key's user can open** (card 2126), the 20 counted after that, where an entry on a board they had been taken off was listed, with the card title in its `detail`. The completed count and streak beside it are as they were; `activeCards` and `avgCycleTimeDays` count only boards the key's user can open since card 2292, below.
- **A board category is given only to a key whose user may be told of it** (card 2128). `GET /board-categories` lists the board categories that hold a board the key's user can open, and those that hold no board yet, where every one was listed; an administrator's key is given every one. `GET /board-categories/:categoryId` answers `403` `No access to this board category` for any other, where it was given. `GET /burndown` with the `boardCategoryId` of one answers `403` `No access to board category <id>`, where it was charted empty under the category's name. `PUT /boards/:boardId` answers `403` `No access to this board category` for a `categoryId` that names one, and saves nothing, where the board was filed under it.
- **`GET /categories/:categoryId` answers `403` `No access to this category`** for a card category of a board the key's user cannot open (card 2128), where any key was given any category. One that belongs to no board is given to every key.
- **Work on a board the key's user cannot open is withheld** (card 2129) where it is the other end of a dependency or in a milestone's plan: by `GET /cards/:cardId`, `GET /cards/:cardId/dependencies`, the three operations on `/subtasks/:subtaskId/dependencies`, and `GET /milestones/:milestoneId/summary`, whole and compact, and its PDF. It is still listed, so that what waits on it is still blocked, with its `id`, `kind` and whether it is finished, and the link's own id, author and date. Its `title` is `A card on a board you cannot open` or `A subtask on a board you cannot open`, its `boardName` `A board you cannot open`, its column title `""`, and its `boardId`, `columnId`, `priority` and `milestoneId` `null`; a withheld subtask in a plan has no `parentCardId`. Every end and every node carries a new boolean, `withheld`, `false` where nothing is withheld. Its title, board, column and priority were given. The summary's `progress` counts cards on such boards under one entry of `boards`, `{ "id": null, "name": "A board you cannot open" }`, and under `""` in `byColumn`, where it named each board. Its `criticalPath` is worked out from the real work and is the same whoever asks: where the chain runs through a withheld subtask, the id of the subtask's card is given there, as for any subtask, though the node itself has no `parentCardId`; that id is all that is given of the card. An administrator's key is given everything as before. See [Dependencies](#dependencies) and [Milestone Summary](#milestone-summary).
- **`GET /milestones/:milestoneId` lists a card on a board the key's user cannot open withheld** (card 2129's review), as the summary does: its `id`, `withheld: true`, `A card on a board you cannot open` for its `title`, `columnTitle` `""`, and `priority`, `columnId` and `boardId` `null`. Every card carries `withheld`. A card moved off a board kept that board's milestone, and its title and board were given to every viewer of the first board, until card 2155 (below) took it out.
- **`GET /milestones` gives in `boardIds` only the boards the key's user can open** (card 2206), where a card of a milestone on another board gave that board's id. `cardCount` and `doneCount` still count such a card, as `GET /milestones/:milestoneId` lists it withheld. An administrator's key is given every id as before. See [List Milestones](#list-milestones).
- **`GET /burndown?milestoneId=` charts only the milestone's cards on boards the key's user can open** (card 2129's review), and says in `meta.notes` how many it leaves out, where a card moved to a board they cannot open was charted and its board named in `scope.boards`. An administrator's key is charted every card as before.
- **Deleting a board deletes its card categories** (card 2128's review), on `DELETE /boards/:boardId`, with those of every sub-board deleted with it; a card on another board that carried one has none. They were kept as categories of no board, which every key is given.
- **Renaming a column into or out of Complete or Done is `409` while it holds a card** (card 2134), on `PUT /columns/:columnId`, archived cards included, and nothing is written. A card is finished because of the title of the column it is in, so such a rename made finished work open again, or made cards finished that nobody finished, with no completion date, no XP and no entry. An empty column is renamed freely, and so is one whose new title keeps what it means: Complete to Done, To Do to Backlog. The message says how many cards the column holds and, when any are, how many of them are archived. Out of a Complete column: `This column holds 3 cards, 1 of them archived. They count as finished because the column is called Complete or Done, and renaming it to "Shipped" would turn them back into open work. Keep it called Complete or Done.` Into one: `This column holds 1 card. Renaming it to "Done" would mark it finished without anyone finishing it. Move each finished card to a Complete column and the rest out of this one first, or choose another name.` A Complete or Done column that holds any card can be renamed only to Complete or Done.
- **A card created in a Complete or Done column is completed** (card 2134), on `POST /boards/:boardId/cards`, as a card moved into one is: `completedAt` and `firstCompletedAt` are the moment it was created, the key's user gets the XP for its priority, `api:card_created` and then `api:card_completed` (`"<title>": created in <column>`) are written, and the board's webhooks get `card.created` and `card.completed`. The answer is the card as written, with its `completedAt`. It was created with no completion date, no XP and no `api:card_completed`. See [Create a Card](#create-a-card).
- **A move that completes a card mails its assignees** (card 2134), on `PUT /cards/:cardId/move`: `Card moved: <title> → <column>`, each as their own "Card moved" setting says, and only those who can open the board the card is on (card 2180, on every route). No move through the API mailed them. A move through the API that does not complete the card still mails nobody, and **nobody is mailed about a move they made themselves**, on any route: an assignee who moves their own card was mailed about it. See [Move a Card](#move-a-card-to-a-different-column).
- **A restore through `PUT /cards/:cardId` is recorded as a restore** (card 2108). `archivedAt: null` on an archived card writes `api:card_restored`, with the card's title, where it wrote `api:card_updated` naming `archivedAt`. `api:card_updated` is written only for the other fields sent, so a restore alone no longer delivers a `card.updated` webhook. An `archivedAt` that changes nothing, `null` on a card that is not archived or the stamp the card holds, is not a change and is not named (card 2183, below).
- **A subtask ticked or deleted through the API is recorded** (card 2108). Completing a subtask with `PUT /subtasks/:subtaskId` writes `api:subtask_completed`, `<subtask> (on <card>)`, and mails whoever asked for the card when it came from a task request, as ticking it in the web application does. `DELETE /subtasks/:subtaskId` writes `api:subtask_deleted`. Neither wrote an entry, so the activity report and the audit log did not show them.
- **In `GET /audit-log`, only a trailing `*` is a wildcard** (card 2127). `action=card_*` finds `card_moved`, `card_completed` and the rest, and no longer `cards_purged` or `cards_cleared`: the `_` of the prefix was read as any one character. A `%` or a `_` in the action is matched as itself.
- **A card's cover is a colour or one of the preset gradients** (card 2010), on `PUT /cards/:cardId`: `coverUrl` is a colour written `#rrggbb`, one of the eight gradients the card window offers, written exactly as [Update a Card](#update-a-card) lists them, or `null`, `''` being read as `null`. Anything else is `400` `coverUrl must be a colour written #rrggbb, one of the preset gradients, or null`, and nothing in the request is written, where any value was stored, an address or a style included. A cover is drawn for everyone who views the board, as a strip across the top of the card, so a value written there would have made each viewer's browser fetch an address of the writer's choosing. A cover the card already holds, sent back unchanged, is accepted as it is, and a page does not draw one that is not a colour or a preset. `recurrenceRule` and `nextRecurrence` stay in every card answer, and the OpenAPI document now says they are not used: nothing sets or acts on them.
- **A card is not moved onto one of its own sub-boards** (card 2141), on `PUT /cards/:cardId/move`: a move onto one, or onto a board beneath one at any depth, is `409` `Card "<title>" cannot go onto "<board>", which hangs beneath it`, and nothing moves. It was `200`, and the sub-board then hung beneath itself, on no dashboard, and its card could never be completed. A move within one board is not asked, and the card such a loop already hangs from can still be moved onto a board outside it. See [Move a Card](#move-a-card-to-a-different-column).
- **What is done in the web application is recorded as it is through the API** (card 2143). Assigning someone to a card, taking them off, editing a comment, creating a board, updating one and creating a milestone on a board write the entry their operation here writes, in the same words, stored without `api:` and with `source` `ui`: `assignee_added`, `assignee_removed`, `comment_edited`, `board_created`, `board_updated` (naming the fields sent, in this API's order; since card 2345 only those that change) and `milestone_created`. Accepting a task request with an assignee writes `assignee_added`, by whoever accepted it. So `GET /audit-log`, `GET /reports/activity` and `recentActivity` on `GET /me/stats` hold them, and the activity report counts a card as touched by, and attributes it to, whoever assigned someone to it or edited a comment on it on a page, as it did for the same actions through the API. They wrote nothing. None of them starts a webhook.
- **`POST /boards` with a `parentCardId` tells the board that card is on** (card 2143): the pages open on it are sent a live update, `{ "type": "board", "action": "created" }`, so the sub-board shows on its card without a reload, as the web application's own create now does too. It sent nothing. A board made at the top level sends nothing, and the answer is unchanged.
- **A card update records only what it changed** (card 2183), on `PUT /cards/:cardId` and on the web application's `PUT /api/cards/{id}`. A field sent with the value the card already holds is not a change, and `null` and `''` are the same value when comparing (`description`, `onHoldNote` and `businessValue` still take text only, and `''` clears them): a request that changes nothing writes nothing, so `updatedAt` stays, records no activity entry, sends no `card.updated` and no live update, and answers `200` with the card as it is. One that changes some fields writes, names in `api:card_updated` (or `card_updated`) and announces those alone. Every field sent was written and named, so the card window's save of an unchanged card wrote "Updated fields: title, description, priority, …", delivered `card.updated`, and counted the card as worked on in the activity report. The milestone the card is in, sent back, is not a change, and `{}` is still `400` `No valid fields to update`. See [Update a Card](#update-a-card).
- **A move out of an On Hold column clears the card's `onHoldNote`** (card 2208), on `PUT /cards/:cardId/move` and on every move in the web application: a move from a column titled On Hold, Hold, Blocked, Parked or Waiting to one that is not. The note was kept by every route, and only a drag on the board page cleared it, with a second request that wrote `card_updated` naming `onHoldNote` and delivered `card.updated`. The move's own entry and events are the record now. On the web application's `PUT /api/cards/{id}`, which takes a `columnId` with other fields, an `onHoldNote` sent back equal to the note the move cleared is not written back; a different note sent with the move is written. See [Move a Card](#move-a-card-to-a-different-column).
- **An archived card on a sub-board holds nothing back** (card 2205). A move to Complete, by `PUT /cards/:cardId/move`, `PUT /api/cards/{id}` or `PUT /api/cards/reorder`, is no longer refused `409` for archived cards on the card's sub-boards: only cards that are not archived and not in a Complete column count, and the refusal's count is of those alone, in the same words. A card held back only by archived cards now completes. The board page's sub-board figures (`subBoards[].done` and `total` on each card) leave archived cards out, as the card context and the dashboard already did, and so does `hiddenOpenCount`. A card already complete stays complete when an archived card under it is restored.
- **A cost is priced at the Claude 5.5 models' own rates** (card 2014). `costUsd` on the token answers prices `claude-opus-5-5` at $4 / $20 per million, cache reads at $0.20, where it was priced as `claude-opus-5` at about twice that, and prices `claude-sonnet-5-5` and `claude-haiku-5-5`, the last at its rate for prompts of 100K tokens or fewer, where Haiku 5.5 was unpriced. A listed id followed by a version DumpFire does not list (`claude-opus-5-6`) is unpriced and counted in `unpricedTokens`, where it was priced as the shorter id. Cost is worked out when it is read, so past entries are re-priced: see [Token Usage](#get-what-a-card-has-cost). The totals `POST /api/v1/tokens/bulk` answers for each card price each entry as the card's own `GET` does, where a model with a measured entry and an entry with no breakdown was priced as a whole at the 90/10 blend, several times its cost.
- **`GET /api/v1/burndown` says when its forecast spans several boards** (card 1968). `forecast.spansBoards` is `true` when the cards that pass the filters sit on more than one board, and each row of `groups` carries its own, judged on that row's cards alone; it is the test `delivery` splits by board on. The forecast's `projectedDate` and `projectedDateNoNewScope` are then pooled across boards, as if a card finished on one board cleared another's, and are not when the work finishes: `delivery` dates it board by board, as before. Every other field and value is as it was, `target.onTrack` and `daysLate` included, which still compare the pooled date. Across several boards the burndown page, its chart and the milestone panel now show no forecast date, and the target's verdict comes from `delivery`: see [Burndown](#burndown).
- **`GET /api/v1/milestones/{milestoneId}/summary` counts every subtask beside the open ones** (card 2225). `progress.totalSubtasks` is every subtask, ticked or not, of the cards `progress.openSubtasks` counts, so the open figure has a total to be read against. Every other field is as it was. The milestone page's progress panel reads `open/all`, and the milestone PDF's "Open steps" reads `<open> of <all>`.
- **Sub-boards nest at most 20 levels deep** (card 2172), below a board that is not a sub-board. `POST /boards` with a `parentCardId` on a board already 20 levels deep, or in or below a loop, is `409` `Sub-boards can be nested at most 20 levels deep, and a board under this card would be deeper.`, and nothing is created. `PUT /cards/:cardId/move` to another board is `409` `Card "<title>" cannot go onto "<board>": its sub-boards would then be nested more than 20 levels deep.`, and nothing moves, when the card's sub-boards would end up deeper than that and deeper than they are now; a card with no sub-board is never refused. Both were accepted at any depth. A tree already deeper keeps working, and a move that lifts it, or leaves it no deeper, is allowed. Archived cards count. See [Move a Card](#move-a-card-to-a-different-column).
- **A request with no key DumpFire accepts is counted by its network** (card 2195). The address it came from is counted by its /64 network when it is IPv6, as the IPv4 address when it is an IPv4 address written as IPv6, and without a port, so the 61st request in a minute from any address of one IPv6 network is answered `429`, where each address had its own sixty. A key's own count is unchanged.
- **Every colour is a colour written `#rrggbb`** (card 2162). Every operation that takes a `color` or a `colorTag` reads it as `#` and six hex digits, in either case, trimmed, and answers `400` for anything else, `red` and `#fff` included, and for a value that is not text: `color must be a colour written #rrggbb` on `POST /boards/:boardId/columns`, `/labels` and `/categories`, `POST /board-categories`, and `PUT /columns/:columnId`, `/labels/:labelId`, `/categories/:categoryId` and `/board-categories/:categoryId`; `colorTag must be a colour written #rrggbb, or empty` on `POST /boards/:boardId/cards`, `PUT /cards/:cardId`, `POST /cards/:cardId/subtasks` and `PUT /subtasks/:subtaskId`, where `''` clears the tag. Nothing is written. Until then any text was stored, up to 32 characters where a length was checked, a style such as `red;background:url(//x.io)` included, and a colour is drawn into the page of everyone who opens the board. A colour the row already holds, sent back unchanged, is accepted as it is, and one stored before this rule is answered as stored; the pages draw it as it is when it is a colour and nothing more (`red`, `#fff`), and grey otherwise. **Through the tracking wrapper, quote a colour: `-Color '#ef4444'`, `-ColorTag '#ef4444'`.** In PowerShell an unquoted `#` begins a comment, so `-Color #ef4444` sends no value and the call stops with "Missing an argument for parameter 'Color'". The web application's routes take a colour by the same rule (below).
- **Every timestamp DumpFire stores is answered in ISO 8601 with `Z`** (card 2095), as `2026-10-14T08:00:00.000Z`, in every answer under `/api/v1/`. Fields that were `YYYY-MM-DD HH:MM:SS`, which names no zone and which most languages read in their own zone, now come back in ISO 8601: `createdAt` everywhere, `updatedAt` on a row never edited, an audit-log entry's `createdAt`, and the `from` and `to` of the activity report's `period` and of `GET /cards/:cardId/board-history`. Fields that were ISO 8601 (`completedAt`, `firstCompletedAt`, `archivedAt`, `updatedAt` after an edit) keep their shape, but the fraction of a second is always `.000`, because every stored moment is now kept to the whole second (`generatedAt` and a webhook's own `timestamp`, which are not stored, carry real milliseconds). Dates (`dueDate`, `targetDate`, `asOf`) are unchanged, and the OpenAPI document declares every timestamp field `format: date-time` (item 53). A webhook body's own `timestamp` was ISO 8601 already; its `data` holds no stored time, and would hold one in the same form.
- **`from` and `to` on `GET /audit-log` and `GET /reports/activity` take ISO 8601, `YYYY-MM-DD HH:MM:SS` or a date** (card 2095): ISO 8601 with or without a fraction, with `Z` or an offset, which is read in UTC; `YYYY-MM-DD HH:MM:SS` in UTC; or a date alone. Anything else is `400` `from is not a date` or `to is not a date`. The audit log compared what it was sent with the stored time as text, unchecked, so a bound written in the other form gained or lost the day at its end, and a date alone as `to` left that whole day out; the activity report refused `YYYY-MM-DD HH:MM:SS`. A date alone as `to` is now the whole of that day, to 23:59:59 UTC, in both (item 54). A `from` after its `to` is `400` `` `from` is after `to` `` in both (card 2217, item 74).
- **An `archivedAt` that is text, on `PUT /cards/:cardId`, is read as the moment it names** (card 2095), so the `archivedAt` a `GET` answered, sent back in ISO 8601 with any fraction or offset, or as `YYYY-MM-DD HH:MM:SS`, is the stamp the card holds and changes nothing. `null` still restores the card, and any other value, `true` and a number included, is still `400` (item 55).
- **A webhook's `url` may not point inside the network** (card 2161), on `POST /boards/:boardId/webhooks` and `PUT /webhooks/:webhookId`: one that does, as written, is `400` `Webhook url points inside the network: <why>`, where it was stored. Inside is a loopback, private, shared (carrier NAT), link-local (the cloud metadata service at `169.254.169.254` among them), reserved, documentation or multicast address, in IPv4 or IPv6, an IPv4 address written another way (`2130706433`, `127.1`) or inside an IPv6 form (`::ffff:127.0.0.1`), and the names `localhost`, any name ending `.localhost`, a name with no dot, and any name ending `.local`, `.internal` or `.home.arpa`. One that carries a user name or password is `400` `Webhook url must not carry a user name or password`. No name is looked up then: a name is judged at each delivery by every address it resolves to, and a delivery to one that resolves inside is not made. Redirects are not followed. The server's operator may let named receivers inside the network be sent to. A stored `url` sent back unchanged is accepted, and is refused at each delivery until it is changed or let in (item 56).
- **Only the board's owner or an administrator changes a webhook's address or secret, or switches one on** (card 2154), on `PUT /webhooks/:webhookId`: an editor who sends `url` or `secret` at all, whatever the value, the stored one and `null` included, is `403` `Only the board's owner or an administrator can change a webhook's address or secret. Ask the board's owner.`, and one who sends `active: true` for a webhook that is off `403` `Only the board's owner or an administrator can switch a webhook on. Ask the board's owner.`, with nothing written, where an editor could change both and switch one on. An editor still changes `events`, switches a webhook off, and may send `active: true` for one already on. A script that sends back a webhook's whole answer with a changed `events` is refused for an editor: send only the fields that change (item 57). Whoever creates a webhook, changes its `url` or `secret`, or switches it on is the one
  whose password reset switches it off, and a `POST` or `PUT` whose key such a reset ends while
  its body is still arriving is `401` `Invalid or expired API key`, with nothing written.
- **A board has at most 10 webhooks** (card 2201), switched-off ones counted: `POST /boards/:boardId/webhooks` answers `409` `This board has 10 webhooks, and a board may have at most 10: delete 1 before adding another.` after every other check, and creates nothing, where any number could be made. A board that already has more keeps them all, and every active one is still sent; the `409` gives its own count (`This board has 14 webhooks, … delete 5 before adding another.`) (item 58).
- **A webhook's answer says what its last delivery came to** (card 2178), as `lastDelivery`, to the board's owner and an administrator, on `GET /boards/:boardId/webhooks`, `GET /webhooks/:webhookId` and the answer to `PUT /webhooks/:webhookId`: `{ "at": "2026-10-14T10:02:11.481Z", "event": "card.moved", "outcome": "answered", "status": 500, "reason": "The receiver answered 500" }`. `at` is the moment the event was dispatched, the body's `timestamp`; `outcome` is `delivered` (a 2xx), `answered` (any other status, a redirect included, which is not followed), `no-answer` or `not-sent` (refused before any request); `status` is the receiver's or `null`; `reason` is one of a fixed set of sentences that never holds the address, its path or query, the secret or an address a name resolved to, and a closed port, a filtered one and a receiver that does not answer read alike (`The receiver could not be reached, or did not answer within 10 seconds`), in their words and in their timing: such a result is recorded no sooner than the timeout after the delivery was given its connection. The 10 seconds count from that connection, so a delivery queued behind the 20 already open to one receiver is not timed while it waits. It is the latest attempt only, not a history: a failure followed by a success is not shown, and the system log keeps each failure. It is `null` until the webhook's first delivery since the server last started, and after its `url` changes until the next delivery or until the address is changed back; it is `null` in the answer to the `POST` that made the webhook, and anyone else is given no `lastDelivery` key, as no `url`. A result is kept in the server's memory, never stored, so a restart, a deploy included, forgets it. It is read through the API only: no page shows webhooks, and nothing tells anyone that a delivery failed. Until then a delivery's result was in the system log only, which administrators read (item 59).
- **A move to another board takes the card out of a milestone of the board it left** (card 2155), on `PUT /cards/:cardId/move`: when the card's milestone belongs to a board other than the one it arrives on, `milestoneId` is set to `null` in the same write as the move, and the answer has `milestoneId: null` and `leftMilestone` `{ "id", "name" }`, the milestone it left; `leftMilestone` is `null` for any other move, and for a milestone of a third board, which is not named. Moving the card back does not put it back in. A milestone across boards (`boardId` `null`) keeps the card, and so does one of the board it arrives on. The `api:card_moved_away` entry on the board it left ends ` and out of milestone "<name>"`, or ` and out of a milestone of another board` for a third board's; no other entry or webhook delivery is added. The card kept the milestone, and its title was listed to every reader of the board it left (item 60). Cards already in that state were taken out once, at the deploy, by a migration.
- **The completion refusal names only a sub-board the key's user can open** (card 2151), on `PUT /cards/:cardId/move` into a Complete column: when the only unfinished sub-boards are ones they cannot open, `409` `A sub-board you cannot open still has incomplete cards that must be completed first. Ask this board's owner.`, with no name and no count, where the sub-board was named with its count of open cards. One they can open is named as before (item 61).
- **The "Unblocked" comment names work on another board by its number only** (card 2152), as `GET /cards/:cardId/comments` reads it: `Unblocked: #12, a card on another board, completed — nothing is blocking this card now.`, or `Unblocked: a subtask on another board completed — …`, where it gave the other board's title. Work on the same board is named by its title as before; comments written before are unchanged (item 62). A card moved to another board takes its notices in this form too (card 2256, item 71). See [Unblock Behaviour](#unblock-behaviour).
- **A milestone is given to a board only when every card in it is on that board** (card 2179), on `PATCH /milestones/:milestoneId` with `boardId`: archived cards count too, and otherwise it is `400` `Some cards in this milestone are not on that board (archived cards count too). Take those cards out of it first, or make the milestone cross-board instead; only its creator or an administrator can change a cross-board milestone afterwards.`, with nothing changed. The milestone went to the board with its cards, and every reader of that board was given the titles of cards of other boards. `boardId: null`, a goal across boards, is accepted as before, and the milestone's own board, sent back, is no change. `GET /boards/:boardId/cards?archived=true` lists archived cards with their `milestoneId`. A `boardId` that names no board is `404` `Board not found`, where an administrator was answered `500` and anyone else `403` `No edit access to that board`. See [Get, Update, Delete](#get-update-delete).
- **A comment mails the people it names only when they can open the card's board** (card 2198), on `POST /cards/:cardId/comments`: an account named as `@username` is mailed "mentioned you" only when it is the board's owner, a member, a member of a team the board is shared with, anyone for a public board, or an administrator, and then as its Mentions setting says. Anyone named was mailed the card's title, the board's name and the start of the comment. The comment is saved and answered as before, and the author is not told who was not mailed.
- **A mention reaches every username, as it is spelled, in any case** (card 2207). A name is the longest username that the text after an `@` begins with, ignoring case, and it must end there: not followed by a letter, a digit or `_`, nor by `.` or `-` and then one of those. So `@Greg`, `@jane.doe`, `@Jane-Doe`, `@Jane Doe` and `@zoë` reach those accounts, where a name was the letters, digits and `_` after the `@`, lower-cased: `@Greg` reached nobody and `@jane.doe` mailed `jane`. An `@` inside a word, as in `bob@example.com`, is not a mention, where it mailed an account called `example`. Where two usernames differ only in case, the one typed exactly is mailed, and neither when the name is typed in neither spelling. Only the first 200 `@` of a comment that could start a name are read, so a mention after them mails nobody. The card window chips a name by the same rule.
- **`GET /cards/:cardId/board-history` begins with the board a card started on** (card 2199), for a card with no recorded creation (made before entries were written) that has moved: the first span is that board, from the card's `createdAt` to its departure. A move writes its departure and its arrival in the same second, so that board was left out. The entries are read in the order they were written, and no time is compared. A card whose creation was recorded is answered as before.
- **A move to another board names neither board in its activity entries** (card 2181), as `GET /audit-log` reads them: `"<title>" moved to another board (<from column> → <to column>)` on the board it left and `"<title>" moved from another board (<from column> → <to column>)` on the board it arrived on, where each named the other board to every reader of its own. The first still ends ` and out of milestone "<name>"` when the move took the card out of one (card 2155). Entries written before are unchanged.
- **A token correction takes back no more than was recorded** (card 2220), on `POST /cards/:cardId/tokens`, `POST /subtasks/:subtaskId/tokens` and `POST /tokens/bulk`: on the same card's own entries or the same subtask's, of the same `model`, a correction with no breakdown takes back at most the tokens recorded without one, and one with a breakdown no part beyond what is recorded of it; otherwise `400` (a line of the `409` in a batch), naming what may be taken back, with nothing written. A correction of measured work sent as a bare total was priced at full input rates and took the card's cost below zero. `DELETE /tokens/:entryId` refuses, `400`, to remove an entry only when that would take what is recorded of its model on its card or subtask below zero, as removing it before the negative entries that correct it would. Entries already stored are unchanged. See [Token Cost](#token-cost).
- **A card moved to another board takes its "Unblocked" comments without the names of the board it left** (card 2256), on `PUT /cards/:cardId/move`, as `GET /cards/:cardId/comments` reads them: `Unblocked: #12 "<title>" completed — …` becomes `Unblocked: #12, a card on another board, completed — …`, unless card 12 is on the board the card arrives on, and `Unblocked: subtask "<title>" completed — …` becomes `Unblocked: a subtask on another board completed — …` unless every subtask it names (the finished one, and the waiting one) has the title of one of the card's own subtasks, which go with it, the rest of each kept and its `updatedAt` unchanged. They went on naming the work to readers of the board the card arrived on. Comments of cards moved before are unchanged (item 71). See [Unblock Behaviour](#unblock-behaviour).
- **`GET /reports/activity` names a milestone only to a reader who can open it** (card 2257): a card's `milestoneName` is `null` when the key's user cannot open its milestone (`GET /milestones/:milestoneId` would be `403`), with `milestoneId` as before, and `milestones` leaves such a milestone out. A goal across boards was named to anyone who could open one of its boards (item 72).
- **A subtask made with no `position` goes after the card's last one** (card 2223), on `POST /cards/:cardId/subtasks`: one more than the largest position on the card, or 0 for its first, as the web application places it. Every subtask sent with no `position` was put at 0, so a card filled by a script had them all there. Subtasks already at 0 keep it. `GET /cards/:cardId/subtasks` and the `subtasks` of `GET /cards/:cardId` are ordered by position, then id, so subtasks at one position read in the order they were made; they had no order (item 73).
- **`GET /audit-log` refuses a `from` after its `to`** (card 2217): `400` `` `from` is after `to` ``, as `GET /reports/activity` answers, where it was `200` with an empty page. Equal bounds name one second and are allowed. Its entries are newest first, and by id, newest first, within one second, so paging with `offset` neither repeats nor skips an entry of the second a page ends in (item 74).
- **A text field past its length limit is refused in one wording, in both trees** (card 2218): `400` `<field> must be at most <max> characters`, the field's own name as sent and the limit written as a plain number, which is what every route with no wording of its own already answered. On the API, `Title too long (max 500 chars)` becomes `title must be at most 500 characters` on `POST /boards/:boardId/cards`, `PUT /cards/:cardId`, `POST /cards/:cardId/subtasks` and `PUT /subtasks/:subtaskId`; `Description too long (max 50000 chars)` becomes `description must be at most 50000 characters` on `POST /boards/:boardId/cards` and `PUT /cards/:cardId`; `Board name too long (max 200 chars)` (`POST /boards`, `PUT /boards/:boardId`), `Name too long (max 200 chars)` (`POST /board-categories`, `PUT /board-categories/:categoryId`, `POST /boards/:boardId/categories`, `PUT /categories/:categoryId`), `Label name too long (max 200 chars)` (`POST /boards/:boardId/labels`, `PUT /labels/:labelId`) and `name too long (max 200 chars)` (`POST /milestones`, `PATCH /milestones/:milestoneId`) become `name must be at most 200 characters`; `Column title too long (max 200 chars)` becomes `title must be at most 200 characters` on `POST /boards/:boardId/columns` and `PUT /columns/:columnId`; and `Comment too long (max 50000 chars)` becomes `content must be at most 50000 characters` on `PUT /comments/:commentId`, as `POST /cards/:cardId/comments` answered. The web application's routes under `/api/` change in the same way: the title, description, name and column title texts above on `POST /api/cards`, `PUT /api/cards/{id}`, `POST /api/subtasks`, `PUT /api/subtasks/{id}`, `POST /api/boards`, `POST /api/board-categories`, `POST /api/categories`, `POST` and `PATCH /api/labels`, `POST /api/columns`, `PUT /api/columns/{id}`, `POST /api/milestones` and `PATCH /api/milestones/{id}`, the milestone service behind the last two included; `Business value too long (max 10000 chars)` becomes `businessValue must be at most 10000 characters` on `POST /api/cards` and `PUT /api/cards/{id}`; on `POST /api/requests`, `Title too long (max 500 chars)`, `Description too long (max 10000 chars)` and `Business value too long (max 5000 chars)` become `title must be at most 500 characters`, `description must be at most 10000 characters` and `businessValue must be at most 5000 characters`; `Key name too long (max 100 chars)` becomes `name must be at most 100 characters` on `POST /api/account/api-keys`; and `Message too long (max 5000 characters)` becomes `message must be at most 5000 characters` on `POST /api/requests/{id}/messages`. Every limit is as it was, and the texts for a field that is missing or empty are unchanged. A script that matched one of the old texts no longer matches it (item 75).
- **A card moved to another board is no longer named in other cards' "Unblocked" comments** (card 2261), on `PUT /cards/:cardId/move`, as `GET /cards/:cardId/comments` reads them, on every card not on the board it arrives on: `Unblocked: #12 "<title>" completed — …` naming it becomes `Unblocked: #12, a card on another board, completed — …`, and `Unblocked: subtask "<title>" completed — …` naming one of its subtasks, on a card that waited on that subtask as its dependencies still record, becomes `Unblocked: a subtask on another board completed — …`, the rest of each kept and its `updatedAt` unchanged; unless that card also waits on a subtask of the same title that is not the moved card's, which may have written it, and the notice keeps its name. They went on naming the card to readers who may not open the board it moved to. Card 2256 above is the other direction. Comments naming cards moved before are unchanged (item 76). See [Unblock Behaviour](#unblock-behaviour).
- **A write is asked again at the write** (card 2253), every `POST`, `PUT`, `PATCH` and `DELETE` of both trees, as the webhook writes alone were (item 57): a write whose key or session ended (revoked, expired, a sign-out, or a password reset), or whose account's role or access changed, while its body was arriving is refused with nothing written, no webhook fired and no mail sent. An ended key is `401` `Invalid or expired API key`, an ended session `401` `Not authenticated`, the gate's own words; a role or access lowered is refused as the account now is, `403` or `404` in the operation's own words, and `POST /dependencies/bulk`, `POST /tokens/bulk`, and `POST` and `DELETE /milestones/:milestoneId/cards/bulk` with their `409`, listing every item. In the web application, `DELETE /api/report-schedules/{id}`, which asked nothing, asks too: a session a reset had ended could still delete a schedule, and is now `401`. Nothing changes for a key or session that still holds and an account whose role is as it was (item 77).
- **A reopening and a move to another board send `card.moved`** (card 2278), whichever route made them, `PUT /cards/:cardId/move` among them: a card moved out of a Complete column sends its board's webhooks `card.moved` with `data.action` `card_reopened`, and a card moved to another board sends the board it left `card.moved` with `card_moved_away` and the board it joined `card.moved` with `card_moved_in`, each with that board's own entry as `detail`, which names neither board. Both sent nothing, so a receiver of `card.moved` missed them. A move into a Complete column still sends `card.completed` instead of `card.moved` (item 78).
- **`GET /me/stats` counts `activeCards` and averages `avgCycleTimeDays` only on boards the key's user can open** (card 2292), the same boards the web application's dashboard and My Tasks count (an open card is still one with no `completedAt` here, where those two go by its column). Both counted the cards the user is assigned to on every board, so someone taken off a board saw the two figures move as cards there were completed, archived or unassigned. A user who can open no board is answered `activeCards` `0` and `avgCycleTimeDays` `null`. The shape is unchanged, and `cardsCompleted` and `streak`, which count the user's own completions, are as they were. In the web application the dashboard's Velocity window counts the same way (item 79).
- **`GET /reports/activity` reads only the boards the key's user can open** (card 2326), and `meta.boardsExcludedForAccess` is always `0`, still in every answer and marked deprecated. It counted the boards with activity in the window that the key's user could not open, so polling a narrow window told them when such a board was worked on, and naming one in `boardIds` whether it had. A board named in `boardIds` is now checked in the order given, as `GET /burndown` checks one, administrators included: one that does not exist is `404` `Board 7 not found`, and one the key's user cannot open is `403` `No access to board 7`, where both were `200` with nothing of the board. A saved list that holds a deleted board now fails. A milestone in `milestones` counts `totalCards`, `completedAtStart` and `completedAtEnd` over its cards on boards the key's user can open, as its burndown does (an administrator's over every board): a card moved onto a board they could not open was counted, so moving `from` across its completion told them the second it was completed. Every other figure is as it was for the boards the key's user can open (item 80).
- **A webhook is sent only while the account that set it up can open its board** (card 2325), asked at each event with that account's role as it is then, as mail is sent only to assignees who can open the board. One set up by an editor went on sending every event of the board to its address after they were taken off the board, out of the team it is shared with, or the board was made private, and one an administrator set up went on after they were made an ordinary user. **A webhook whose setter cannot open the board, and one nobody is recorded as having set up (made before setters were recorded on 2026-10-18/19), is held from the deploy on**: nothing is sent, `active` is left as it is, and `lastDelivery` says `Not sent: the account that set it up can no longer open this board` or `Not sent: nobody is recorded as having set it up`. A webhook answered to the board's owner or an administrator, and the answer to the create, carry a new field, `pausedBecause`: `null` unless the webhook is on and held, then one of two sentences saying why and what to do. A held webhook is sent again when its setter can open the board again. The board's owner or an administrator takes one over by switching it off, then on (which makes them its setter), with a new secret, and updates the receiver; `{"active": true}` for one already on takes nothing over. See [Webhooks](#webhooks) (item 81).
- **`GET /cards/:cardId/comments` lists comments made in the same second the later first** (card 2301), by id, in a list that is still newest first. A comment's `createdAt` is kept to the second, and comments of one second came back in no set order, in practice the earlier first: a request's discussion copied onto its card when it is accepted, and several comments posted in a row, read upside down. The discussion is now copied in the order it was sent, by id within one second, so its copies list newest first (item 82).
- **`GET /cards/:cardId/comments` answers `userEmoji` `"👤"` for an author with no emoji** (card 2302), as `POST /cards/:cardId/comments` and `GET` and `PUT /comments/:commentId` already did, where it was `null` against the `Comment` schema, whose `userEmoji` is a required string. Only an account restored from an old backup, or changed directly in the database, has no emoji; no stored data changes (item 83).
- **`PUT /comments/:commentId` with the comment's own text writes nothing** (card 2284), as an update to a card that changes nothing writes nothing (card 2183). Text that is the comment's own once both are trimmed keeps its `updatedAt`, logs no `api:comment_edited` and sends no live update, and is answered `200` with the comment as it is stored, with its author. It wrote the comment again with a new `updatedAt`, which the web application shows as "(edited)", and recorded an edit nobody made. A caller who may not edit the comment is still refused `403` first, whatever text it sends (item 84). The web application's `PUT /api/cards/{id}/comments/{commentId}` does the same, and its card window sends nothing for a save with the text unchanged.
- **`DELETE /comments/:commentId` is new** (card 2283), where the route answered `405`. Who may delete a comment is who may in the web application: its author while they can still edit the board it is on, or an administrator; a board's owner may not delete a comment somebody else wrote. No body; `200` `{ "success": true }`; `400` `Invalid comment ID`, `404` `Comment not found`, `403` `No edit access to this board` and `403` `You can only delete your own comments`, the web application's words. It logs `api:comment_deleted`, `Deleted a comment on "<card>"`, or `Deleted a comment by <author> on "<card>"` when the caller is not the author, never the comment's text, and sends a live update. A delete made in the web application, `DELETE /api/cards/{id}/comments/{commentId}`, now logs `comment_deleted` in the same words and sends the same update; neither was recorded, so `GET /audit-log` and `GET /reports/activity` had no trace of a delete, an administrator's included. **No webhook is sent for a delete**: there is no `comment.deleted` event, so re-reading `GET /cards/:cardId/comments` is the only way to learn that a comment has gone (item 85). See [Comments](#comments).
- **`DELETE /cards/:cardId` on a card already archived writes nothing** (card 2285). It is still answered `200` `{ "success": true }`, so a retried archive does not fail, but `archivedAt` keeps its first value, `updatedAt` is not moved, no second `api:card_archived` is logged and no live update is sent. Both stamps were set again to the time of the second request, which lost the time the card was archived, and a second "Archived card" was recorded. An archive made in the web application, `DELETE /api/cards/{id}`, is the same. A restore of a card that is not archived already answered so (item 86). See [Delete a Card](#delete-a-card).
- **Unticking or editing a subtask is recorded, and a save that changes nothing writes nothing** (card 2299), on `PUT /subtasks/:subtaskId`. An untick logs `api:subtask_updated`, `Reopened <subtask> (on <card>)`, and mails nobody; a change of `title`, `description`, `priority`, `colorTag` or `dueDate` logs `api:subtask_updated` naming the fields changed, `Updated <subtask> (on <card>): title, dueDate`, after the tick's or untick's entry when one request does both. A change of `position` alone is written and still not recorded. Neither an untick nor an edit was recorded, so `GET /audit-log` showed only ticks. A request whose every field is the value the subtask holds keeps it as it is, logs nothing and sends no live update, and is answered `200` with the subtask; it was written again and the board told. The web application's `PUT /api/subtasks/{id}` is the same, so a Save in the subtask window that changed nothing records nothing. `api:subtask_updated` is work on the card in `GET /reports/activity`, as `api:subtask_completed` is (item 87). See [Update a Subtask](#update-a-subtask).
- **`POST /dependencies/bulk` records each link it creates** (card 2291), as `POST /cards/:cardId/dependencies` records one: an `api:dependency_added` entry on the board of the card that waits (a subtask's card), with that card's id, `#1559 now waits on #1686`. It wrote one `api:dependencies_bulk_added` entry for the whole batch, with no card, on the first board it touched alone, so a card's history never showed the links a batch made and the other boards' logs said nothing. A link skipped as already recorded writes none, and a batch that writes nothing tells no board, as before. **`dependencies_bulk_added` is no longer written**: `GET /audit-log?action=dependencies_bulk_added` finds older entries only, and `action=dependency_added` now finds the links of a batch too. Neither sends a webhook (item 88). See [Create Many Dependencies](#create-many-dependencies).
- **The web application's card update no longer sends `card.updated` for a change of position within the card's column** (card 2288). `PUT /api/cards/{id}` with a `position` and no change of column wrote the card with a new `updatedAt`, logged `card_updated` "Updated fields: position" and so sent `card.updated` to the board's webhooks; a drag and `PUT /cards/:cardId/move` to the same column never did. It now goes through the drag's path: the position alone is written, nothing is logged and no webhook is sent. Sent with other fields, it still sends one `card.updated`, whose `detail` names those fields alone. That route takes no key and no page sends it a position, so only a request made by hand from a signed-in browser saw the delivery. Nothing `PUT /cards/:cardId` accepts or answers changes (item 89).
- **Goal changes are recorded, and goal membership sends no `card.updated`** (card 2289). `PATCH /milestones/:milestoneId` logs `api:milestone_updated` (`Updated milestone "Launch": name, targetDate`, naming the fields changed among `name`, `description`, `targetDate` and `boardId`), and a change of `status` `api:milestone_closed` or `api:milestone_reopened`; `DELETE` logs `api:milestone_deleted` (`Deleted milestone "Launch"; 2 cards on this board released`). Each has no card, and goes on the milestone's board, or for one across boards on each board holding its cards; a change of board goes on the boards before and after. A milestone is named as each board's readers knew it before the change (as it is after, on a board it joins), and one across boards as `milestone #<id>`, since a reader of one of its boards may not be able to open it. Every operation that puts a card in or takes it out logs `api:milestone_card_added` (`Added "First" to milestone "Launch"`, with `(from milestone "Pilot")` when it left another) or `api:milestone_card_removed` on the card's board, with its id: `POST` and `DELETE /milestones/:milestoneId/cards`, the bulk pair (one entry per card attached or detached, none for a card skipped), and **`milestoneId` on `PUT /cards/:cardId`, which logs these in place of naming `milestoneId` in `api:card_updated`, so `card.updated` is no longer sent when `milestoneId` is the only change**. A card moved from one milestone to another logs one `api:milestone_card_added` naming the milestone it left, and no `api:milestone_card_removed` for that one. A change that changes nothing, every field as stored or a card put into the milestone it is in, writes, logs and tells nothing and answers `200` as before, after every refusal. No webhook is sent for any goal entry: read `GET /milestones/{milestoneId}` or the audit log (a `milestone.*` event is card 2343). The two card entries are not work on the card in `GET /reports/activity`. The plan-created mail is still sent by the bulk attach alone (item 90). See [Milestones](#milestones).
- **`PUT /cards/:cardId` refuses another column, `POST /boards` files a new board under its category, and `PUT /boards/:boardId` refuses another parent card** (card 2287). Each was ignored without a word. **`PUT /cards/:cardId`** answers `400` `columnId 12 is not this card's column (14): the card has moved since it was read, or a move was meant. Move a card with PUT /cards/{cardId}/move` for a `columnId` other than the card's own, and `400` `columnId must be an id` for `null` or a value that is not an id, where it saved the other fields sent and left the card where it was. The card's own column, sent back, is accepted, so a card read with `GET` can still be sent back whole. `position` is still ignored here, whatever is sent, now said so: reorder with `PUT /cards/:cardId/move`. **`POST /boards`** takes `categoryId`, the board category to file the new board under, as the web application's create does: one that does not exist is `404` `Board category not found`, one that holds boards, none of which the key's user can open, `403` `No access to this board category`, and one that is not an id `400` `categoryId must be an id`, where each made the board unfiled with `201`. A new board is still private: its owner sets `isPublic` with `PUT /boards/:boardId`. **`PUT /boards/:boardId`** answers `400` `parentCardId 12 is not this board's parent card (none): the board has been moved since it was read, or a link was meant. A board is put under a card, or taken out from under one, on the board page` for a `parentCardId` other than the board's own, `null` on a sub-board included, and `400` `parentCardId must be an id` for one that is not an id, where it saved the other fields and ignored it. The board's own, sent back, is accepted. The tracking workflow sends none of these (item 91). See [Update a Card](#update-a-card).
- **`DELETE /milestones/:milestoneId/cards/bulk` takes an archived card out** (card 2290), logging `api:milestone_card_removed`, as `DELETE /milestones/:milestoneId/cards` and `milestoneId: null` on `PUT /cards/:cardId` do, where it refused the whole batch with a `409`. An archived card that is not in the milestone is skipped and counted, and a card that does not exist is listed in the `409` as `Card not found` (it was `Card does not exist or is archived`), so an archived card on a board the key's user cannot edit is listed as one they cannot edit, with its id and no title, as the single detach answers `403`. `POST …/cards/bulk` still refuses an archived card. **A milestone whose only cards were archived can now be emptied, and the plan-created mail**, which counts archived cards when it decides a milestone was empty, **is then sent by the next bulk attach to it.** The tracking workflow's `remove-milestone-cards` uses this route (item 92). See [Bulk Planning](#bulk-planning).
- **`GET /boards/:boardId/cards` lists the cards in the board's order** (card 2295): by column, in order of column position, ties by column id, and within a column in order of card position, ties by card id. It listed the columns in the order they were made in, so a column moved or added between two others came in the wrong place, and a client that read the list in its old order sees a new one on such a board. The cards are read in one query, and an answer's fields are unchanged (item 93). See [List Cards on a Board](#list-cards-on-a-board).
- **`DELETE /board-categories/:categoryId` takes its boards out of the category** (card 2293). Every board filed under it, sub-boards included, has `categoryId` `null` once the category is deleted, in the same request, where each kept the deleted category's id: every board read (`GET /boards`, `GET /boards/:boardId`) answered that id, and a category later given the same id would have had those boards filed under it. Their `updatedAt` is left as it is and nothing is logged, as for every board category change. The web application's `DELETE /api/board-categories/{id}`, Manage Categories on the dashboard, is the same, as its confirm already said ("Boards using it will become uncategorised"). Boards already holding the id of a category that no longer exists were cleared once, at the first start after the deploy, and are cleared again after every restore of a backup. Who may delete a category is unchanged: the key's user must be able to edit every board filed under it (item 94).
- **`PUT /boards/:boardId` writes, logs and tells only the fields whose value changes** (card 2345). A body whose every field is as the board holds it (`name`, `emoji`, `categoryId` and `isPublic` sent back, or a name that trims to the stored one) is answered `200` with the board as it is: `updatedAt` is not moved, no `api:board_updated` is logged and no live update is sent. It was written again with a new `updatedAt`, logged `Updated board "<name>" (fields: name, emoji, categoryId, isPublic)` naming every field sent, and the board's open pages told to re-read; and the dashboard's last activity moved. A request that changes some fields writes and names only those: `Updated board "Renamed" (fields: name)`. `{}` is still `400` `No valid fields to update`, and a request that would be refused is still refused first, so an editor who sends `isPublic`, even the value the board holds, is still `403`. A board read with `GET` can be sent back whole, as card 2287 made possible, without leaving a trace. The web application's `PUT /api/boards/{id}` is the same, and its `{}`, still `200`, no longer writes the row either. Neither sends a webhook, as before (item 95).

Three more on the same day touch no route of the API, and so not the OpenAPI document, but reach the keys every caller uses:

- **Making a key asks for the account's password**, on My Account: see [Generating an API Key](#generating-an-api-key). Keys made before are kept.
- **Setting a password can end the account's keys.** An administrator's reset and an invite used end every key of the account; your own change ends them only if you ask. A key that has ended is answered `401` `Invalid or expired API key`: see [When a Key Ends Without Being Revoked](#when-a-key-ends-without-being-revoked). Since card 2168 the webhooks the account set up go with its keys, switched off, and a reset or an invite pauses its report schedules; the board's owner or an administrator switches a webhook on again with `PUT /webhooks/:webhookId` and `{"active": true}`.
- **Wrong passwords at Generate Key are counted.** Ten in 15 minutes from one signed-in browser, counted with the Account page's email and password forms, and that browser is refused for up to 15 minutes, the right password included: see [Generating an API Key](#generating-an-api-key).

These touch only the web application, whose routes under `/api/` the pages use, and not the API:

- **A report is its reader's** (card 2150). `POST /api/reports` and `POST /api/reports/email`, and every scheduled report, take in only the sub-boards beneath their boards that the reader can open, and do not walk through one they cannot; a board whose parent the reader cannot open is drawn as a board of its own, the parent not named. The reader is the caller, the sender, or the schedule's owner as their account stands at the run; every recipient gets that report. The Reports page lists, for an ordinary user, each board they can open whose parent board they cannot.
- **The inbox gives a request's desired board only to a reader who can open it** (card 2153). `GET /api/requests` answers `desiredBoardId`, `desiredBoardName` and `desiredBoardEmoji` all `null` for a board the reader cannot open, each member of an addressed team judged for themselves; the accept dialog then preselects no board. The answer to an accept or a reject, `PATCH /api/requests/{id}`, gives `desiredBoardId` `null` likewise.
- **Moving a card to another board says when it left its milestone** (card 2155). `PUT /api/cards/{id}` answers the card with `leftMilestone`, `{ "id", "name" }` of the milestone of the board it left that the move took it out of, and `null` otherwise; All Tasks says `Moved. It left milestone "M"; moving it back does not put it back in.`
- **An open board stream ends when its reader can no longer open the board** (card 2170). `GET /api/boards/{id}/events` asks at each heartbeat, every 30 seconds, whether the board is still there and the account as it is now can open it, and if not sends one last `update` with `{"type":"access"}` and ends; the board page re-reads and shows its refusal. It opens only on a board that is there: `404` `Board not found` for one that is not, administrators included, where an administrator was answered `200` for any id. `GET /api/events` keeps each board's answer until its next heartbeat, where it kept it 30 seconds by the clock.
- **A move to another board names neither board on the pages either** (card 2181). The two entries above are what `GET /api/activity` gives, on a board's Activity panel and in All Tasks, which lists each under its own board's name. The live `update` events `moved_away` and `moved_in`, on `GET /api/boards/{id}/events` and `GET /api/events`, no longer carry `toBoard` and `fromBoard`; they keep `type`, `action`, `cardTitle`, `fromColumn`, `toColumn`, `userName` and `userEmoji`. Nothing on any page read the two fields.
- **The "Unblocked" and "Plan created" mails are each drawn for their recipient** (card 2152): finished work on a board the recipient cannot open is "A card on a board you cannot open", and the plan mail goes only to those who can open the plan.

- **A body that is not a form, sent where a form is read** (the attachment upload, and the sign-in, set-up and invitation pages), is answered `400` `The request body is not a form` where it was `500`. A form is a body sent as `multipart/form-data` or `application/x-www-form-urlencoded`.
- **Eleven handlers that checked access before reading the body read it first**: `PUT /api/teams/{id}`, `POST /api/teams/{id}/members/{userId}`, `PUT /api/boards/{id}`, `POST`, `PATCH` and `DELETE /api/boards/{id}/share`, `PUT /api/categories/{id}`, `PUT /api/board-categories/{id}`, `PUT /api/cards/{id}/comments/{commentId}`, `PUT /api/report-schedules/{id}`, and `POST /api/cards/{id}/dependencies`. A body that is missing, is not JSON or is not an object, sent by a caller who would be refused, is `400` where it was `403` or `404`. An id in their path, and in the path of `DELETE /api/cards/{id}/dependencies` and of both methods of `/api/subtasks/{id}/dependencies`, that is not a whole number of 1 or more (`1.5`, `0`, `-1`, `abc`) is `400` `Invalid <thing> ID`, where it was `403`, `404` or `500`; so is `1e3`, which was read as the id 1000.
- **A team or a board that is not there is `404`.** `PUT` and `DELETE /api/teams/{id}`, and `POST` and `DELETE /api/teams/{id}/members/{userId}`: a non-administrator was answered `403`, and an administrator `404`, `200` doing nothing, or `500`. `PUT /api/boards/{id}`: `403` to all but an administrator. `POST`, `PATCH` and `DELETE /api/boards/{id}/share`: `403`, and an administrator `500` or `200` doing nothing. A share that is not there is `404` on `DELETE`, after the owner's check: `This board is not shared with that user`, or `This board is not shared with that team`, where it was `200` doing nothing (the review of group Q-F, 2026-10-15).
- **Fields are read by their type and range**, `400` naming the field, where each was stored as sent or was a `500`. A value the row already holds, sent back unchanged, is kept.
  - `PUT /api/teams/{id}`: a body with no name or emoji is `No valid fields to update`, where it was `500`; `name` is text, trimmed, of 1 to 200 characters, and `emoji` text of 1 to 32 (`''` was ignored).
  - `POST /api/teams/{id}/members/{userId}` adds the user in the path, where it added the body's. The body's `userId` may be left out; another user's is `userId must be the user in the path, or be left out`, and one that is no id `userId must be an id`. `{}` adds the user in the path, where it was `400` `userId is required`. `role` is `member` or `owner`, `role must be one of: member, owner`: any text was stored, and `''` and `null` were `member`.
  - `PUT /api/boards/{id}`: `name` text, trimmed, of 1 to 200 characters, `emoji` of 1 to 32; `categoryId` an id or `null`, and a grouping that is not there `404` `Board category not found` (it was stored).
  - `POST /api/boards/{id}/share`: `type` `user` or `team`, `type must be "user" or "team"`, where any other `type` was taken as a team share; `targetId` a required id (`targetId is required`, `targetId must be an id`); `role` `viewer` or `editor`, `role must be one of: viewer, editor`: any text was stored, and `''` and `null` were `viewer`. Someone already stored as owner and sent back as owner keeps it.
  - `PATCH /api/boards/{id}/share`: `isPublic` a required boolean. `{}` made the board private and is `isPublic is required`; `"false"` made it public and is `isPublic must be true or false`.
  - `DELETE /api/boards/{id}/share`: `type` `user` or `team`, `type must be "user" or "team"`, where another was `200` doing nothing; `targetId` a required id.
  - `PUT /api/categories/{id}` and `PUT /api/board-categories/{id}`: `name` text, trimmed, of 1 to 200 characters, `color` a colour written `#rrggbb` (card 2162, below).
  - `PUT /api/cards/{id}/comments/{commentId}`: `content` is text of at most 50,000 characters, `content must be text` where it was a `500`. There was no limit.
  - `POST /api/cards/{id}/comments`, a new comment, the same: text of 1 to 50,000 characters once trimmed, `content must be text` where it was a `500`, and `content must be at most 50000 characters` where any length was stored.
  - `PUT /api/report-schedules/{id}`: `enabled` a boolean; `name` 1 to 200 characters; `frequency` `weekly` or `monthly`, where another was ignored; `dayOfWeek` 0 to 6 and `dayOfMonth` 1 to 28, whole numbers (31 was stored as 28); `timeOfDay` `HH:MM`, `''` being 09:00, where any text was stored; `timeZone` a time zone name this server knows, such as `Europe/London`, stored as the server names it (`europe/london` is `Europe/London`), where an unknown name, an offset (`+01:00`, `−01:00`) or more than 64 characters is `400` `timeZone must be a time zone name, such as Europe/London` (card 2159); `recipients` addresses separated by commas, semicolons or lines, as the reports page takes them, and stored separated by commas, at most 2,000 characters; `statusFilter` one of its values, where another was stored as `all`. The answer is the schedule as it was written. Turning the schedule on, or a new `frequency`, `dayOfWeek`, `dayOfMonth`, `timeOfDay` or `timeZone`, works its next run out again from now, in its zone (cards 2144 and 2159); any other change leaves it. A timing the scheduler cannot date is `400` `The schedule was not changed: its time of day "9" is not a time from 00:00 to 23:59`, or, turning it on, `400` `This schedule cannot be turned on: its time of day "9" is not a time from 00:00 to 23:59. Turn it on with a time, day and zone that can be read, or delete it and make it again.`
- **The share window offers Owner only on a row already stored as owner.** No share makes anyone an owner now (`role` above), so the choice it offered on every person's row was always refused, and the window threw the answer away: the role snapped back with nothing said. A refused change of role is now said, in the server's words, and the row shows the role that is stored. A person already shared as Owner keeps it and is shown so; the board's creator is its owner.
- **The card window's dependencies are recorded.** `POST` and `DELETE` on `/api/cards/{id}/dependencies` and `/api/subtasks/{id}/dependencies` write `dependency_added` and `dependency_removed`, as the API's card operations write theirs: the board's activity panel and the Audit page show them. They wrote none. Their ids in the body are read as the API's dependency operations read them, above.
- **`PUT /api/boards/{id}` puts a board under a card with `parentCardId`, or takes it out from under one with `null`.** It ignored the field and answered `200` with nothing saved, which the board page's "Link existing board" then called a success. It is now the board's owner's or an administrator's to do (the owner by the board's role: its creator, or a member shared as Owner), with edit access to the board the card is on, and the board's, the new card's board's and the old card's board's pages are sent a live update. Refused, nothing in the request is saved: `403` `Only the board's owner or an administrator can put it under a card or take it out from under one`; `403` `No edit access to the parent card's board`; `404` `Parent card not found`; `409` `Board "<name>" cannot go under a card on itself or on one of its own sub-boards`; `400` `parentCardId must be an id`. The card the board already hangs under, sent back, changes nothing. The API's `PUT /boards/:boardId` takes no `parentCardId`: it refuses one other than the board's own with `400` (card 2287, above).
- **`POST /api/cards` answers `400` for a reporting field outside its vocabulary**, where it was `500`. The reporting fields answer their own `400` on every route that takes them.
- **The card window takes a card out of a milestone by the API's rule.** `PATCH /api/milestones/{id}` with `attach: false` needs the right to change the milestone the card is in, so someone who may edit a board, and neither made a cross-board milestone nor is an administrator, can no longer take a card out of that milestone from the card window: `403` `No edit access to this milestone`, or `No access to this milestone` when it has cards on a board they cannot open, where it was `200`. Nor can they by choosing another milestone, which takes the card out of the one it is in: `attach: true` needs the right to change that one too. Choosing another milestone and then None was the way round the rule. With `attach: true` it refuses an archived card, `400` `Card does not exist or is archived`.
- **`PATCH /api/milestones/{id}` looks at the milestone in its path, first.** One that is not there is `404` `Milestone not found` to everyone, and one the caller may not change `403`, before a field is read. With `attach: false`, a card that is not in that milestone is `404` `Card is not in this milestone`. The milestone in the path was not looked at: a card was taken out of its own through any id, a milestone of another board or none at all, and answered `200`. `attach` is `true` or `false`: `"false"` put the card in.
- **The web application's work routes read every field by its type and range**, `400` naming the field, as the API's twins read them, where each was stored as sent, given a default, or was a `500`. A value the row already holds, sent back unchanged, is kept, whatever these rules say of it. An id in the body that names the row the route checks keeps the words of the check: `Invalid column ID`, `Invalid board ID`, `Invalid card ID`, `Invalid label ID`.
  - `POST /api/boards`: `name` text, trimmed, of 1 to 200 characters, `name is required` (`{}` made "Untitled Board"); `emoji` 1 to 32; `parentCardId` an id or `null`, `parentCardId must be an id`, where one that was no id was `404` `Parent card not found` and `"1e3"` was looked for as card 1000; `categoryId` an id or `null`, and a dashboard grouping that is not there `404` `Board category not found`, where it was stored.
  - `POST /api/board-categories`, `POST /api/categories` and `POST /api/labels`: `name` text, trimmed, of 1 to 200 characters, where a missing name gave "New Category" and a label with none was a `500`; `color` a colour written `#rrggbb`, where any text was stored. `POST /api/categories` reads `boardId` as an id or `null`: `''` and `0` were taken for no board.
  - `POST /api/columns`: `title` text, trimmed, of 1 to 200 characters, where a missing one gave "New Column"; `position` a number; `color` a colour written `#rrggbb`. `PUT /api/columns/{id}`: the same `title`, `color` and `position`, and `showAddCard` `true` or `false`, which was left out, so the board page's "Show Add Task" was a `500` on every press and was never saved; a body with none of them, or only a `boardId`, is `400` `No valid fields to update`, where it was a `500`. The WIP limit is read as before.
  - `PUT /api/columns/reorder` and `PUT /api/cards/reorder`: `updates` a list of objects (`updates[<n>] must be an object`, where it was a `500`), each `id` and `columnId` an id (`updates[<n>].id must be an id`), and each `position` a number (`updates[<n>].position must be a number`): text was stored, and a column's missing position was a `500`.
  - `POST /api/cards`, `PUT /api/cards/{id}`, `POST /api/subtasks` and `PUT /api/subtasks/{id}`: as the API's card and subtask operations read them. `title` text, trimmed, of 1 to 500 characters, required on a create, where a missing one gave "Untitled" or "New subtask" and an empty one was stored on an update; `description` and `onHoldNote` at most 50,000 characters, `businessValue` at most 10,000 (`title must be at most 500 characters`, `description must be at most 50000 characters` and `businessValue must be at most 10000 characters`, card 2218); `priority` `low`, `medium`, `high` or `critical` in any case, stored in lower case; `dueDate` a date written `YYYY-MM-DD`, `''` or `null` clearing it; `colorTag` a colour written `#rrggbb`, or `''`; `position` a number; `pinned` and `completed` `true` or `false`, where `"false"` was stored as true, and a subtask so ticked wrote no entry and sent no notice; `coverUrl` a colour written `#rrggbb`, one of the preset gradients or `null` (card 2010, below); `recurrenceRule` is not read at all (card 2010).
  - A card's `categoryId` is one of the board's categories, or one that belongs to no board, on `POST /api/cards` and `PUT /api/cards/{id}`: another board's, which was stored, and one that is not there, which was a `500`, are `404` `Category not found on this board`. A card moved to another board on `PUT /api/cards/{id}`, as All Tasks moves one, takes a new category of the board it ends on. One the card already holds, sent back, is kept, but not on a move to another board: there the move decides, and clears one of the old board's, which the card window's save wrote back over the clearing.
  - `POST` and `DELETE /api/cards/{id}/assignees`: `userId` an id. Removing someone who is not assigned to the card is `404` `User is not assigned to this card`, where it was `200`.
  - `PUT /api/labels`, which puts a label on a card or takes it off, and `DELETE /api/labels`: their ids are ids, `Invalid card ID` and `Invalid label ID`, where one that was not was looked for. `PATCH /api/labels`, which renames and recolours a label, is new (card 2010, below), and reads `name` and `color` as `POST /api/labels` does.
  - `POST /api/milestones` and `PATCH /api/milestones/{id}`: as the API's: `name`, `description`, `targetDate`, `status`, `boardId`, and `cardId` an id.
  - `POST /api/templates`: `name` text, trimmed, of 1 to 200 characters, where a template with no name was a `500`; the card it holds, `title` at most 500 characters and `description` at most 50,000; `priority` one of the four, so a template saved from a card whose stored priority no rule allows is refused; `subtasks` a list of objects, each a `title`, `description` and `priority` read by the same rules and stored as those three alone, where whatever was sent was stored; `labels` a list of ids.
  - `POST /api/boards/{id}/archive`: `cardId` an id.
- **Those routes look for what the path or the body names, and check the caller, before they read a field**, so a caller who would be refused is `404` or `403` whatever the body holds. `POST /api/cards` refused a title over 500 characters before it looked for the column, `400` to a caller who could not touch it and for a column that was not there; `POST /api/cards/{id}/comments` an empty comment, likewise. A board, a board category, and a category, milestone or template of no board have nothing to look for, and read their fields first.
- **Every id in the path or the query string of those routes is read as an id**: one that is not a whole number of 1 or more written in digits (`1.5`, `abc`, `0`, `1e3`) is `400` `Invalid <thing> ID`, or for a query string `Invalid boardId`, `Invalid cardId`, `Invalid columnId` or `Invalid forBoard`, but `Invalid board ID` on `GET /api/templates` and `Invalid card ID` for the `exclude` of `GET /api/cards/search`. That is every method under `/api/boards/{id}`, `/api/cards/{id}` and `/api/subtasks/{id}`, `/api/columns/{id}`, `/api/categories/{id}`, `/api/board-categories/{id}`, `/api/milestones/{id}` with its PDF and summary, and `/api/templates/{id}`, and the `boardId`, `cardId`, `columnId` and `forBoard` of `GET /api/labels`, `/api/subtasks`, `/api/activity`, `/api/graph`, `/api/milestones`, `/api/templates` and `/api/cards/export/csv`, and the `exclude` of `GET /api/cards/search`. Some were read as another id, `1e3` as 1000, and answered `404` or `403`, and `0` was an empty list.
- **Four routes answer `401` to a caller who is not signed in**: `GET /api/boards/{id}/cfd`, `/export/csv` and `/metrics`, and `GET /api/cards/export/csv`. They read the caller unchecked and threw, a `500`; the gate stands in front of them, so no request reached one that way.
- **The graph draws the superadmin among the administrators**, a member of every board. It was left out, and drawn with fewer boards than any administrator.
- **The card window offers the board's own categories and the shared ones**, of no board, and not every board's: the server files a card under nothing else. A card already filed under another board's category keeps it, and its chip still names it.
- **The accounts, administration, teams, reports and requests read every field by its type and range** (card 2117's fourth slice), as the work routes above do: `400` naming the field, where each was stored as sent, dropped without a word, read as another, or was a `500`. Every route that takes a JSON body now reads it one way. A value the account or the settings already hold, sent back unchanged, is kept.
  - `PUT /api/users/{id}`: **nobody changes their own role here**, the superadmin included, and the role they have sent back included: `403` `Your own role is not changed here: the superadmin can change it`, or to the superadmin `The superadmin's role cannot be changed`, and nothing else sent with it is saved. An administrator's request to make themselves a user was answered `200` and done, and the superadmin's to change theirs `200` and ignored. `username` and `email` are read by the rules of `POST /api/users`: trimmed, a username of at least 2 characters (`Username must be at least 2 characters`), an email address (`Valid email required`), and one another account has `409` `Username already taken` or `Email already in use`, where each was stored as it came and a duplicate was a `500`. `emoji` is 1 to 32 characters, where `''` was ignored. The fields are read once the account is found and the caller may manage it, so a field of the wrong type for an account they may not manage is `403`, where it was `400`.
  - `POST /api/users`: `email` is an address by the readers' rule, with no space and none of `, ; < > " ( )`, where any text with an `@` was taken; `emoji` 1 to 32 characters, where `''` gave the default.
  - `PUT /api/users/{id}/password`: `password` is text, `password must be text`, where a number was a `500` from bcrypt. The account is looked for, and the caller checked, before it is read: an account that is not there is `404`, where a short password was `400`.
  - `POST /api/account/api-keys`: `name` is text, where a number was a `500`; `expiresAt` a timestamp in the future, or `null`, stored in UTC (`expiresAt must be a timestamp, such as 2027-01-01T09:00:00Z`, `expiresAt must be in the future`), where any text was stored, `"banana"` never expired, and one written with an offset was compared wrongly. `PUT /api/account/email`: `newEmail` is text, where a number was a `500`, and an address holding `, ; < > " ( )` is `Invalid email address`. `PUT /api/account/password`: `newPassword` is text, where a number was a `500`. `PUT /api/account/emoji`: at most 32 characters.
  - `PUT /api/account/notifications`: a preference it knows that is not `true` or `false` is `400` `<key> must be true or false`, where it was left out without a word. One it does not know is still left alone.
  - `POST /api/teams`: as `PUT /api/teams/{id}` reads a team, `name` of 1 to 200 characters (`name must be text`, where a number was a `500`) and `emoji` of 1 to 32, where `''` gave the default.
  - `POST /api/xp` is gone (card 2010, below). It added `amount` written as text as text: `"10"` on 5 XP stored 510.
  - `POST /api/report-schedules`: as `PUT /api/report-schedules/{id}` reads them, and `periodDays` a whole number from 1 to 366, `detailLevel` `summary` or `detailed`, and `statusFilter` one of its values, where another was stored as `detailed` or `all`; `scopeId` an id; no `timeZone` is `UTC`, and a timing that cannot be dated is `400` `The schedule was not saved: …`. The board or the grouping is looked for, and the caller checked, before the other fields are read: a board that is not there is `404` `Board not found`, where an administrator's schedule of it was made, and a board the caller cannot see is `403` whatever else the body holds.
  - `POST /api/reports` and `POST /api/reports/email`: `scope` `board`, `category` or `all` (`Invalid scope. Must be: board, category, or all`; the mail's route read another as every board the caller can see); `periodStart` and `periodEnd` a date or a timestamp (`periodStart is not a date`), where one that was not text was a `500`, and `periodStart` not after `periodEnd` (`periodStart is after periodEnd`, a bare date being the whole day), where a period that ended before it began was drawn as a report of nothing; `scopeId` an id; `detailLevel` and `statusFilter` from their values, where another was read as `detailed` or `all`; `assigneeUserId` an id or `null` (`assigneeUserId must be a user id`), where `"all"` and `''` were taken for everyone; `timeZone`, optional, a time zone name (`timeZone must be a time zone name, such as Europe/London`; card 2258, below). Each of the mail's `recipients` is an address, `recipients[<n>] must be an email address`: one that was not was dropped and the report sent to the rest, and with none left it was `No valid email addresses provided`.
  - `POST /api/requests`: `title`, `description`, `businessValue` and `requesterName` are text, where a number was a `500`, and `requesterName` at most 200 characters; `priority` `low`, `medium`, `high` or `critical` in any case, stored in lower case, where another was `medium`; `targetType` `user` or `team`; `targetId` and `desiredBoardId` ids. A requester's address holding `, ; < > " ( )` is `A valid email address is required`. `PATCH /api/requests/{id}`: `action` `accept` or `reject`; `boardId`, `columnId` and `assigneeId` ids, where one that was not was looked for as it came; `rejectReason` text of at most 10,000 characters, or `null`. `DELETE /api/requests/{id}` answers a request that is not there `404` `Request not found`, where it was answered as deleted.
  - `POST /api/requests/{id}/messages`: `message` is text, where a number was a `500`; `senderType` `requester` or `admin`, where another was taken for a reply from the team; a `token` that is not text is answered as a wrong one, where it was a `500`. The request is looked for, and the sender checked, before the message is read: a request that is not there is `404`, and a sender who may not reply `401`, `403` or, with no session, `404` (card 2132, below), where an empty message was `400` first.
  - `POST /api/requests/{id}/confirm`: a body that is missing, is not JSON or is not an object is `400`, where it was read as no token and answered `404`. A `token` that is not text gets the `404` a wrong one gets, where it was a `500` for a request that is there and a `404` for one that is not, which told the ids of real requests from the rest.
  - `PUT /api/admin/backup` **keeps what it is not sent.** A save of part of the settings wrote the defaults over the rest: `{}` switched the schedule off and deleted every destination, and is `400` `No valid fields to update` now. `schedule` is one of `disabled`, `hourly`, `every6h`, `every12h`, `daily` and `weekly`; `scheduleTime` `HH:MM`, `''` being 02:00 as before; `scheduleDay` 0 to 6; `retention` a whole number from 1 to 100; `notifyOnFailure` `true` or `false`; `notifyEmail` one address or more, read as a schedule's `recipients` are and stored separated by commas, or `''`; `destinations` a list of destinations, each a text `name`, a `type` of `sftp`, `s3`, `gdrive` or `onedrive`, and the fields of its type, each text but an SFTP `port` (a whole number from 1 to 65535, or `null` for 22, as a Port box cleared sends it) and Google Drive's `authMethod` (`service_account` or `oauth`), named by their place (`destinations[0].port must be a whole number`). Text, the `name` included, is at most 2,048 characters, but an SFTP `privateKey` and Google Drive's `serviceAccountJson`, which hold a file pasted in, at most 20,000. Any other field of a destination is not kept, where each was stored as sent. `POST /api/admin/backup/test` reads its destination the same way, and `POST /api/admin/backup/gdrive/auth` its `code` and `destName` as text. Card 2251 adds `state`, read as text the same way (`state must be text`): the state of the consent address the same session's `GET` built, sent back from the whole address Google's page leads to. A missing, unknown, expired (ten minutes) or used one, or one another session, account or destination started, is `400` `This connection was not started from this session, or has expired or been used. Press Connect again, and paste the whole address Google's page leads to.`, with nothing sent to Google; the `GET` puts a PKCE `code_challenge` (S256) in the consent address and answers `Cache-Control: no-store`, and the code is exchanged with its verifier. Card 2250 adds an SFTP destination's `hostKey`, its server's confirmed host key: text, either `<type> SHA256:<43 characters>` (the type `ssh-ed25519`, `ecdsa-sha2-nistp256`, `ecdsa-sha2-nistp384`, `ecdsa-sha2-nistp521` or `ssh-rsa`) or the line `ssh-keygen -l` prints, pasted whole (`256 SHA256:… root@nas (ED25519)`; an RSA key of 1,024 bits or more), stored as `<type> SHA256:<43>`, and `''` for none; anything else is `400` `destinations[0].hostKey must be an SSH host key fingerprint with its type: the line ssh-keygen -l prints (256 SHA256:… root@nas (ED25519)), or the type and fingerprint (ssh-ed25519 SHA256:…), the fingerprint being SHA256: and 43 characters` (with no `destinations[0].` on the test route). The `GET` shows it as stored. Not a secret, but a save or a test that keeps a masked password or private key is refused `400` when it changes, empties or leaves out a stored key (`… this changes its host key.`); a save that adds one where none was stored keeps it, but a test keeps a masked secret only with exactly the stored key, none for none, so a test cannot send the stored secret to a key it names. A field not sent is not kept, so send it with every save of an SFTP destination. Without one, no backup is sent to an SFTP destination and nothing secret reaches it: a Test's first look connects only as far as the key the server presents, and sends nothing. `POST /api/admin/backup/test` of an SFTP destination answers `{ success, message }` as before, plus `hostKey`, the key the server presented as `<type> SHA256:<43>`, when none is confirmed (nothing secret is sent: the Test only looks at the key) or it did not match, and `confirmedHostKey`, the stored key, when a key was refused: both for a key that did not match, `confirmedHostKey` alone for a server that no longer offers a key of the confirmed type, or that shows the confirmed key but cannot sign with it. A refusal writes one `[ERROR] [BACKUP]` line. Every host key failure's message begins `SFTP host key not confirmed: ` or `SFTP host key refused: `.
  - `POST /api/admin/backup`: a body that is missing, is not JSON or is not an object is `400`, where it was read as `{}` and a backup run to every destination. `destination` is text.
  - `PUT /api/admin/smtp`: only `host` and `user` (text of at most 2,048 characters), `pass` (text), `fromName` (text of at most 200), `port` (a whole number from 1 to 65535), `secure` (`true` or `false`), `fromAddress` (an address) and `appUrl` (an `http` or `https` address, or `''`) are read, each by its rule, where a port of `"abc"` or a host of `5` was stored as sent. An App URL with no scheme, `kanban.example.com`, was stored as typed and read as `http://`; it is stored with `http://`, as it is read, and one that is no host after that (`/kanban`, `ftp://kanban.example.com`) is refused. A body with none of them is `400` `No valid fields to update`, as the backup settings answer one, where `{}` was `200` with nothing saved. `POST /api/admin/smtp`: `to` is an address, or `''` for the caller's own.
  - **Refused now, where it was taken, and left so:** a recipient of an emailed report written with a name, `John Smith <john@example.com>`, is `400` `recipients[<n>] must be an email address`, where it was dropped and the report sent to the rest without a word; the first save of the mail settings with no From address is `400` `fromAddress must be an email address`; and a name past the new limits, a board's or a column's renamed past 200 characters among them, is `400` (`name must be at most 200 characters`, `title must be at most 200 characters`). The board page says that a column's rename was refused, in the server's words, and keeps the old title (card 2134); it showed the new title until the next load.
- **Every id in the path or the query string of those routes is read as an id**: `1.5`, `abc`, `0` and `1e3` are `400` `Invalid <thing> ID`, or `Invalid boardId` and `Invalid userId` on `GET /api/audit`. That is `DELETE /api/account/api-keys/{id}`, where `1.5` and `0` were looked for; both `POST /api/admin/boards/{id}/...`; `DELETE /api/report-schedules/{id}`; every method under `/api/requests/{id}`, with its confirmation and messages; `DELETE /api/teams/{id}` and `DELETE /api/teams/{id}/members/{userId}`; and every method under `/api/users/{id}`, with its password and invite. Some were read as another id, `1e3` as 1000.
- **`GET /api/audit` and `GET /api/logs` read `limit` and `offset` as whole numbers**, as `GET /audit-log` reads them: `limit` rounded down and held between 1 and 500, or 1000 for the system log, `offset` rounded down and 0 or more, and text the default, as `limit=0` is, as it was. `limit=-1` answered every entry, and `limit=2.5` was a `500`.
- **A board that is not there is `404` `Board not found` to everyone** on `GET /api/boards/{id}/cards` and `GET /api/activity?boardId=`, and only then is one the caller cannot open `403`. Everyone but an administrator was answered `403`, and an administrator an empty list.
- **`GET /api/milestones` reads `status` as `open` or `closed`**, as `GET /milestones` reads it: another is `400` `status must be open or closed`, where it was an empty list.
- **The public request routes tell a caller with no session nothing of a request they hold no link to** (card 2132). `GET /api/requests/{id}`, `GET /api/requests/{id}/messages` and a reply as the requester on `POST /api/requests/{id}/messages`, with no link or a wrong one, are `404` `Request not found` whatever the request's state, as for one that is not there, where a request that is there was `403` and a reply to a resolved or unconfirmed one `400`. A reply from the team with no session is `401` for every id, before the request is looked for, where it was `404`, `400` or `401` by the request. The holder of the link is told the state as before, and a signed-in caller is still answered `403` for a request that is not theirs.
- **The link of a request nobody confirmed within seven days opens nothing** (card 2243). `POST /api/requests/{id}/confirm` with the right token is `404` `This confirmation link is not valid.` for an unconfirmed request made more than seven days ago, as for a wrong token, where it confirmed it, mailed the team and put it in the inbox. `GET /api/requests/{id}`, `GET /api/requests/{id}/messages` and a reply as the requester answer its link from a caller with no session `404` `Request not found`, as for a request that is not there, so the thread page shows the link as gone where it offered "Confirm it"; a signed-in account is answered `404` `Request not found` too, as for any unconfirmed request since card 2260 (below), where one the request is not addressed to was answered `403`. The request is still deleted by the form when it takes the next anonymous request.
- **A request nobody has confirmed is not there for the team** (card 2260). An anonymous request waiting for its requester to confirm it is answered `404` `Request not found` to every signed-in caller without its link, the user or team it is addressed to and administrators included, on `GET /api/requests/{id}` and `GET /api/requests/{id}/messages`, where they read it with the requester's address (the inbox never listed it), on `PATCH /api/requests/{id}` (accept and reject) and on a reply from the team (`POST /api/requests/{id}/messages`), where both were `400` `… already resolved`, and to a signed-in account it is not addressed to, where it was `403`. Its own link opens it as before, without the address, and once confirmed it is read and answered as any pending request. `DELETE /api/requests/{id}` (administrators) still deletes one.
- **A card moved to another board in the web application rewrites other cards' "Unblocked" notices too** (card 2261), as `PUT /cards/:cardId/move` does: `PUT /api/cards/{id}` with a `columnId` on another board makes the move through the same code, so on every card not on the board it arrives on a notice naming the card by its title becomes `Unblocked: #12, a card on another board, completed — …`, and one naming one of its subtasks `Unblocked: a subtask on another board completed — …`, with `updatedAt` unchanged, as the card's own notices are since card 2256. A subtask notice on a card that also waits on a subtask of the same title that is not the moved card's keeps its name, since that one may have written it. See [Unblock Behaviour](#unblock-behaviour).
- **The lists the pages read give what the caller may be told** (card 2128). `GET /api/users` gives every user's `id`, `username` and `emoji`, and `email`, `role` and `createdAt` to an administrator alone, where every signed-in caller was given every colleague's address and role. `GET /api/teams` gives every team, and its `members` only on the teams the caller is in, or on every one to an administrator, where every team's members were given. `GET /api/board-categories` lists as `GET /board-categories` does above, and `POST /api/boards` and `PUT /api/boards/{id}` refuse a `categoryId` of a board category outside that list, `403` `No access to this board category`. `GET /api/categories` lists the card categories of no board and of the boards the caller can open, where every board's was listed. `GET /api/burndown?boardCategoryId=` answers as `GET /burndown` does above. `GET /api/cards/{id}/context` gives the card categories by the same rule, with one the card itself carries from a board the caller cannot open marked `carried: true`; one of another board they can open is listed unmarked. It gives each person who can be assigned the card by name and emoji, with no `email`. `GET /api/boards/{id}/share` gives each member's `email` to the board's owner and an administrator only.
- **The public request form names no board to someone without an account** (card 2128). `GET /api/requests/targets` gives a holder of the form token every user and team as before and `boards: []`, and a signed-in caller the boards they can open, where it gave everyone every board, sub-boards included. `POST /api/requests` does not read `desiredBoardId` from a caller with no session: it is not checked, not looked up and not stored. From a signed-in caller it is optional, and must be a board they can open: `404` `Board not found`, or `403` `No access to this board`, before anything is written. A request with no board is accepted onto a board chosen when it is accepted, which the inbox already asks for.
- **The card window and the plan withhold work on a board the caller cannot open** (card 2129), as the API's operations above do: the answers of `GET`, `POST` and `DELETE /api/cards/{id}/dependencies` and `/api/subtasks/{id}/dependencies`, `GET /api/milestones/{id}/summary` and its PDF.
- **A sub-board the caller cannot open is left out** (card 2130). `GET /api/cards/{id}/context` lists only the sub-boards under the card that the caller can open, where it listed every one with its name and progress. The board page, the dashboard and the breadcrumbs do the same: see [Authentication & Security](docs/authentication-security.md#what-a-list-gives).
- **`GET /api/boards/{id}/share` answers a board that is not there `404` `Board not found`**, to everyone, before access is asked. It was `403` to everyone but an administrator, and an empty list to an administrator.
- **The board page stops a drop onto Complete that the server would refuse, and says so when the server refuses one** (card 2130's review). Each card of the board page carries `hiddenOpenCount`, the number of cards not complete and not archived (card 2205) on sub-boards under it that the caller cannot open, with no name, and the page counts them before the drop as it counts the ones it shows; when only those hold the card back it offers no sub-board to open. A move that `PUT /api/cards/reorder` refuses is put back, with the server's words in a toast, where the card stayed in Complete, with its sound, until the next reload.
- **A card's request origin gives the requester's name and not their address** (card 2128's review). The board page and All Tasks gave `requestOrigin.requesterEmail`, the address of someone who often has no account, to every viewer of the board; no screen read it.
- **`GET /api/burndown?milestoneId=`** answers as `GET /burndown?milestoneId=` does above, and **`DELETE /api/boards/{id}`** as `DELETE /boards/:boardId` does: it deletes the board's card categories with it (card 2128's review), and a board that is not there is `404` `Board not found` to everyone, before who is asking is looked at (card 2211, below).
- **A card created in a Complete or Done column is completed** (card 2134), by `POST /api/cards`, which the card window and Duplicate use, and by accepting a task request into such a column (`PATCH /api/requests/{id}`), as `POST /boards/:boardId/cards` does above: the stamp, the creator's XP, `card_created` and then `card_completed`, both webhooks, and the fireworks on the board. A request accepted into one mails its requester "Your request is complete" with its report, after "Request accepted". The answer of `POST /api/cards` is the card as written, with its `completedAt`.
- **Accepting a task request records the card it makes** (card 2108): a `card_created` entry by the accepter, which delivers `card.created` to the board's webhooks, a live update to the board, and the accepter as the card's `createdBy`. It recorded none of them.
- **Duplicate on a card in a Complete or Done column puts the copy in the board's first column that is not one** (card 2134), at its end, open. A copy is new work: made beside the original, it would have been completed as it was created, with XP for whoever clicked. A board with no other column keeps the copy beside the original, where it is completed. A copy of a card in any other column is made beside it, as before.
- **`PUT /api/columns/{id}` refuses a rename into or out of Complete or Done while the column holds a card**, `409`, as `PUT /columns/:columnId` does above. The board page says so in the server's words, and the column keeps its title.
- **The page moves mail nobody about a move they made themselves** (card 2134). A drag, the card window and All Tasks mail the card's assignees for every move, as before, but not the assignee who made it, who was mailed about their own move.
- **Restoring a card is recorded** (card 2108). `POST /api/cards/{id}/restore` and `POST /api/boards/{id}/archive` write `card_restored`, with the card's title, on its board, as archiving writes `card_archived`. They wrote no entry. A card that is not archived is answered `200` as it is, with nothing written and no live update, where its `updated_at` was set.
- **The pages open on a board that a delete removes or empties are told** (card 2108). A live update goes, once the delete is committed, to a deleted board, to every sub-board deleted with it and to the board of the card it hung from; to every board a purge of the archive took cards from, and every sub-board it removed; to a board whose cards are cleared, and every sub-board it removed; and to every sub-board removed with a card or a column deleted for good. The update is `{ "type": "board", "action": "deleted" }`, `{ "type": "card", "action": "purged" }` or `{ "type": "card", "action": "cleared" }`, and for the board a deleted sub-board hung from, which is still there, `{ "type": "board", "action": "sub_board_deleted" }`; a board a purge or a clear took cards from that went with them, as a board beneath one of its own cards does, is told `{ "type": "board", "action": "deleted" }`, and the system log has an `INFO` line naming it. Nothing more is sent: no board name, card title or user, because the board of a sub-board's card can be read by people who could not open the sub-board. A page open on a deleted board shows "Board not found"; one on a board emptied re-reads it. A member's dashboard is not told of a deleted board, which no one but an administrator can be told of once it is gone, and catches up when it is next brought to the front. None of these sent anything.
- **`GET /api/audit`, the Audit page's log, finds an action however it was done** (card 2127). `action=card_completed` finds the page's `card_completed` and the API's `api:card_completed`, where it found the page's alone. Written with `api:` in front, the action means done through the API, so `api:*` and `api:card_completed` answer as they did. A new `source`, `ui` or `api`, asks where each entry was made, read from the stored spelling as `GET /audit-log` reads it; another is `400` `source must be "ui" or "api"`, and `source=` empty is every source. Only a trailing `*` is a wildcard, as on `GET /audit-log` above. The Audit page has a Source filter: All, Web application, API.
- **`POST /api/reports/email` says what was sent** (card 2113). With no mail set up it is `503` `Mail is not set up on this server, so the report was not sent. The superadmin sets it up on the admin page.`, after the caller is checked and before the PDF is built, and nothing is sent. Sent to every recipient, it is `200` `Report sent to <n> recipient(s)`. Sent to some, `200` `Report sent to <s> of <n> recipients. Not sent to <addresses>. The mail server did not accept it. An administrator can see the reason in the system log.` Sent to none, `502` `The report was not sent. The mail server did not accept it. An administrator can see the reason in the system log.` Each answer but the `503` carries `results`, one `{ email, success, message? }` for each recipient, `success` being whether the mail server took it. It was `200` `Report sent to <n> recipient(s)` with every `success` true whatever the mail server answered, and with no mail set up. The Reports page shows a report sent to some as a failure, keeps the dialog open and leaves only the addresses not reached in the box, so that sending again does not send it a second time to the rest.
- **The card window makes, renames, recolours and deletes labels** (card 2010). A board's labels were made only through the API, and a board with none showed no Labels section in the card window. The section is now on every saved card, with "+ New label" and "Edit labels"; a label made there is put on the card at once, and a delete asks first, since it takes the label off every card on the board. For it, **`PATCH /api/labels` is new**: `{ id, name?, color? }`, by someone with edit access to the label's board. `id` is read first (`400` `Invalid label ID`), the label looked for (`404` `Label not found`) and the caller checked (`403` `No edit access to this board`), then `name` and `color` as `POST /api/labels` reads them (text, trimmed, of 1 to 200 characters, `name cannot be empty`; `color must be a colour written #rrggbb`), and a body with neither is `400` `Send name or color to change`. A colour the label already holds, sent back unchanged with a new name, is kept, a label made through the API with another colour among them. The answer is the label as it is now, and the pages open on its board are told once it is saved. Like the other label routes, it writes no activity entry. The New Task window no longer shows Labels or Cover: neither did anything there before the card was saved.
- **A card's cover is a colour or one of the preset gradients on `PUT /api/cards/{id}` too** (card 2010), by the rule `PUT /cards/:cardId` has above, and the board draws a card's cover as a strip across its top, which only the card window showed. **`recurrenceRule` is not read**: a body that names it changes nothing, and one that names it alone is `200` with the card as it was. No page set it and nothing acted on it.
- **`POST /api/xp` is gone** (card 2010). It let an administrator add any amount of XP to any name, nothing in DumpFire called it, and it added an amount written as text as text. A request to it is `405`. XP is still awarded when a card is completed, `GET /api/xp` still gives the board's XP display what it shows, and Reset XP on the admin page still clears it.
- **`PUT /api/cards/{id}` refuses a move onto one of the card's own sub-boards** (card 2141), as `PUT /cards/:cardId/move` does above: `409` with the same message, and nothing in the request is saved, a title sent beside the `columnId` included. All Tasks' Move window shows the message in a toast and stays open, and the card stays where it was. A board that was already beneath one of its own cards no longer stops the server when it is opened, and the server names such boards in the system log, the first 20 and then how many more, at each start and as soon as an imported backup brings one (card 2142): see [Admin Operations Guide](docs/admin-guide.md#a-board-beneath-one-of-its-own-cards).
- **The web application's routes record and tell what their API twins do** (card 2143). `POST` and `DELETE /api/cards/{id}/assignees`, `PUT /api/cards/{id}/comments/{commentId}`, `POST /api/boards`, `PUT /api/boards/{id}` and `POST /api/milestones` write the entry their operation above writes, with `source` `ui`, in the transaction of the write, and send the live update it sends, once that is committed: `{ "type": "card" }` to the card's board for an assignment (of someone already assigned too, with no entry and no mail) and a removal; `{ "type": "comment", "cardId": <the card> }` for a comment edited (card 2282; it was `{ "type": "card" }`), as for a comment added on either route, which sent none, for a comment deleted on either route, which sent none either (card 2283), and for an "Unblocked" notice, beside its `{ "type": "card" }`: a card window open on the card reads its comments again; `{ "type": "board" }` to the board, once, for an update that sent a field, beside the updates to the boards a `parentCardId` left and joined; and `{ "type": "board", "action": "created" }` to the board a new sub-board's card is on. An update that sends no field writes nothing and sends nothing, and is still `200`. A milestone of no board writes no entry, and a new milestone sends no update. Accepting a task request with an assignee, `PATCH /api/requests/{id}`, writes `assignee_added` by the accepter after `card_created`. The answers are unchanged. So the Audit page and a board's Activity Log show these actions done on a page, and other open pages refresh after them.
- **Clearing or deleting a board that is not there is `404` `Board not found`** (card 2211), and nothing is changed, recorded or sent. `POST /api/admin/boards/{id}/clear-cards` and `POST /api/admin/boards/{id}/clear-categories` answer so to an administrator; anyone else is still refused `403` `Forbidden` first, whether the board is there or not. `DELETE /api/boards/{id}` answers so to everyone, before who is asking is looked at, as `DELETE /boards/:boardId` does. Each was `200` for a board that was not there, the session delete `403` to anyone but an administrator, and the admin page said the cards were cleared, or the board deleted, for a board deleted in another tab.
- **`GET` and `PUT /api/account/notifications` answer and save `email_request_progress` and `email_mentions`** (card 2146), each `true` or `false` as the other keys are. Neither was answered or saved, so neither could be switched off: My Account's Request Progress went back on at every reload, and the mention mail could be stopped only by switching all mail off. My Account now has a Mentions switch. The keys are listed in [Notifications & Email](docs/notifications-email.md#user-notification-preferences).
- **The card window sends no `colorTag`** (card 2147), on `PUT /api/cards/{id}` and `POST /api/cards`. It sent `''` with every save from a board or the plan page, which cleared a tag set through the API; such a tag now survives a save there, and the save's `card_updated` entry no longer names `colorTag`. Duplicate still copies a card's tag, and the field is read on both routes as before.
- **The subtask window offers no colour tag, and sends none** (card 2185), on `POST /api/subtasks` and `PUT /api/subtasks/{id}`. The colour it offered was stored and drawn nowhere; a colour set through the API now survives a save there, and a subtask it creates is stored with `''`. A subtask's `colorTag` is still accepted and returned by both trees, and Duplicate still copies it; no screen sets or shows it.
- **The web application's routes read a colour as the API's do** (card 2162): `color` on `POST /api/board-categories`, `PUT /api/board-categories/{id}`, `POST /api/categories`, `PUT /api/categories/{id}`, `POST /api/columns`, `PUT /api/columns/{id}`, and `POST` and `PATCH /api/labels`, and `colorTag` on `POST /api/cards`, `PUT /api/cards/{id}`, `POST /api/subtasks` and `PUT /api/subtasks/{id}`, each a colour written `#rrggbb` (a colour tag may be `''`), with the same refusals, where `PUT /api/categories/{id}` and `PUT /api/board-categories/{id}` took any text of 1 to 32 characters. Duplicate, and the card window's subtasks made with a new card, copy a colour tag only when it is one, and `''` otherwise, so a copy is never refused over a tag stored before the rule.
- **A report's recipients are read as the mailer reads them, and bounded** (card 2182). Any address may still be one. `POST /api/reports/email`, `POST /api/report-schedules`, `PUT /api/report-schedules/{id}`, the scheduler and the Reports page read a list one way: split on commas, semicolons and white space (spaces, tabs, new lines), each part lower-cased, a repeat dropped, and a part written `<address>` read as the address inside; an address has one `@` with a dot after it, none of `< > ( ) [ ] \ , ; : "`, and no control or format character (a right-to-left override, U+202E, would make the address shown differ from the one mailed). Each address is sent one mail, once.
  - `POST /api/reports/email`: more than 10 distinct addresses is `400` `A report can be emailed to at most 10 addresses at a time, and this names 12. Nothing was sent.`, before the board or the caller's access is looked at, administrators included. An entry the mailer would send to someone other than it shows (`a@b.c<x>` goes to `x`), or with no dot after its `@`, is `400` `recipients[<n>] must be an email address`, as any entry that is not an address is. `results` carry each address lower-cased.
  - One account's report mail reaches at most 100 addresses a day: `429` `Reports can be emailed to at most 100 addresses a day from one account, and this would make 104. Try again in 5 hour(s).` (minutes under an hour), with nothing built or sent, taken after the `503` and before the PDF. A schedule made (`POST`), turned on, or given a new `frequency`, `dayOfWeek`, `dayOfMonth`, `timeOfDay` or `timeZone` while it is on after the change (`PUT`) takes its addresses from the same 100, since each can bring a send forward to any time: `429` `Report mail can reach at most 100 addresses a day from one account, and this schedule's 10 would make 104. The schedule was not saved. Try again in 5 hour(s).` (`… was not changed.` on the `PUT`), nothing saved. Otherwise a `PUT` that changes `recipients` takes the addresses the new list adds, those not in the stored list (one address changed to ten takes nine), refused in the same way with `this schedule's 9 new addresses would make 109`; the stored list sent back in another order or case, or cut down, a change of name or filter, re-timing one that stays off, and turning one off take nothing; a delete gives nothing back; a scheduled run takes nothing. The day is 24 hours from the account's first take, in memory, so up to 200 can go across one day's end and the next's start.
  - `POST` and `PUT /api/report-schedules`: more than 10 addresses is `400` `A schedule can be sent to at most 10 addresses, and this names 12. The schedule was not saved.` (`… was not changed.`); a part that is not an address is `400` `recipients holds "smith", which is not an email address`, or `recipients holds "alice", "smith", which are not email addresses`, up to five named, then `and 3 more`. `recipients` is stored as the addresses it is sent to, lower-cased, each once, separated by `, `. A list sent back as it is stored is kept unchecked.
  - `POST /api/report-schedules`: an account's 21st schedule is `409` `You have 20 report schedules, the most one account may have. Delete one first.`; an account that already has more keeps them all and is told `You have 25 report schedules, and the most one account may have is 20. Delete 6 first.`
  - A schedule kept from before with more than 10 addresses is switched off at its next run, sends nothing, and writes one `ERROR` line under `REPORTS`, with its owner as the line's user: `Report schedule 12 "Weekly sales", owner "pat" (user 7), was switched off: it is sent to 15 addresses, and the most is 10. Nothing was sent. Its owner can delete it and make it again with at most 10.` `PUT` with `enabled: true` on it while it is off is `400` `This schedule cannot be turned on: it is sent to 15 addresses, and the most is 10. Delete it and make it again with at most 10.`; with a list of 10 or fewer in the same `PUT`, it is accepted. On one still on, `enabled: true` sent back with the row is not a turning on, and is accepted. The Reports page shows such a schedule's addresses to copy, with "Copy the ones to keep into a new schedule of at most 10, then delete this one."
  - A stored part that is not an address is never sent to, and the run's line ends `Left out, as not email addresses: "alice", "smith".` Every scheduled mail says "Set up by `<username>`", as the one sent by hand says "Sent by". See [Notifications & Email](docs/notifications-email.md#who-a-report-can-be-mailed-to).
- **Sign-in waits after five wrong passwords at one account** (card 2177), on the login form, from any number of addresses: every sign-in at the account from a browser not remembered for it, the right password included, waits 1, 2, then 4 seconds before its password is checked, until 15 minutes pass with no wrong password or the right one is given. The wait itself refuses nothing, and the answer's status and words do not change; card 2194, below, adds a refusal while it lasts. Ten attempts from one address in 15 minutes are still refused `429` "Too many login attempts", at once and not counted at the account. The Sign In button reads "Signing in…" while it waits. See [Authentication & Security](docs/authentication-security.md#guessing-a-password-at-sign-in).
- **A browser that has signed in is remembered, and other browsers are let in one at a time while an account is being guessed at** (card 2194), on the login form. A sign-in that succeeds, a password changed on the Account page, an invite used, set-up and a sign-out with an open session set a cookie, `dumpfire_known_<user id>` (`Path=/login`, `HttpOnly`, `SameSite=Strict`, a year), that lets that browser past the account's wait, the one-at-a-time rule and the per-address limit, until the account's password is set again. While an account (or a name that is no account) has had five wrong passwords within 15 minutes of each other, a browser not remembered for it is let in only while fewer such sign-ins are in flight there than the free guesses left, and never fewer than one: the rest are answered at once `429` "A sign-in with this name is already under way from another browser. Wait a few seconds and try again, or sign in from a browser you have used here before.", counted at their address and not at the account. Nothing was refused for the account before. A remembered browser is refused in the same words, counting nothing, only while five of the account's sign-ins from remembered browsers and current-password checks are already in flight. See [Authentication & Security](docs/authentication-security.md#browsers-that-have-signed-in-before).
- **The login form, an invite's form and set-up can answer `503`** (card 2191) when 150 password checks for each thread are already waiting (about thirty seconds of them on a fast host, a minute or more on a small one), or the caller has gone before a thread was free for theirs: "Sign-in is very busy right now. Wait a minute and try again, or sign in from a browser you have used here before.", and on the other two "The server is very busy checking passwords right now. Wait a minute and try again." Passwords are hashed and checked on worker threads, never on the server's own. A name that is no account is now checked as slowly as a wrong password at an account (card 2192), so the time taken no longer tells which names are accounts.
- **The two password answers say what was switched off and paused** (card 2168). `PUT /api/users/{id}/password`, an administrator's reset, answers `{ success, sessionsEnded, apiKeysEnded, webhooksSwitchedOff, reportSchedulesPaused }`, where it answered the first three: every webhook the account set that was on is switched off, and every report schedule of it that was on is paused, in the transaction that sets the password. `PUT /api/account/password`, your own change, answers `{ success, apiKeysEnded, webhooksSwitchedOff }`: with `endApiKeys: true` the webhooks you set are switched off with your keys, and your report schedules are left on. Both counts are `0` where there was nothing to switch off. An invite used switches off and pauses as a reset does.
- **`PUT /api/account/password`, `PUT /api/account/email` and `POST /api/account/api-keys` can answer `409`** "Your password was changed while this was being saved. Nothing was changed. Try again." (card 2191) when the account's password was changed twice while the request was being saved; once, and the current password is checked against the new one, as before. Nothing is written. Each can also answer `429` "The server is very busy checking passwords right now. Wait a minute and try again." when five of the account's current-password checks and sign-ins from remembered browsers are already in flight, with nothing counted or checked. So one account keeps at most five password checks in the first lane, which goes ahead of the rest, plus the new hash of each password change it completes (`PUT /api/account/password` makes its hash after giving its place back). That cannot starve the second lane (sign-ins from browsers not remembered, invites and set-up), which is served at least every fourth job the threads take. See [Authentication & Security](docs/authentication-security.md#off-the-servers-thread-card-2191).
- **A sign-in that succeeds gives back only the attempts its address made at that account** (card 2226): attempts at another account, at a name that is no account, and refusals stay counted to the end of the 15 minutes, where the whole count was cleared. Sign-in and the public request form (`POST /api/requests`, `GET /api/requests/targets`, `POST /api/requests/{id}/confirm`) count an IPv6 address by its /64 network, an IPv4 address written as IPv6 as the IPv4 address, and no port (card 2195).
- **A failed sign-in's log line holds nothing that was typed** (card 2193), in `GET /api/logs` and on the Audit page: `Failed login attempt at "alice" (user 12) from IP … (bad password)` with the account as the line's user, or `Failed login attempt for a name that is no account (17 characters) from IP …`, each with the address as its `ip`. The lines already stored for names that were no account are rewritten that way at the first start, and in every backup.
- **Sub-boards nest at most 20 levels deep in the web application too** (card 2172), as `POST /boards` and `PUT /cards/:cardId/move` above: `POST /api/boards` with a `parentCardId` is `409` in the same words, and so is `PUT /api/cards/{id}` with a `columnId` on another board, with nothing in the request saved. `PUT /api/boards/{id}` with a `parentCardId` is `409` `Board "<name>" cannot go under this card: it and its sub-boards would then be nested more than 20 levels deep.` when the board, or one beneath it, would be deeper than 20 and deeper than it is now. A board in or below a loop counts as past the limit. The board page says each refusal: the card menu's Create Sub-board in an error toast (`No answer from the server. The sub-board may not have been made.` when there is none), and the new-card window for each sub-board refused, `Sub-board "<name>" was not made.` and the server's words, the card kept. Its breadcrumbs show the nearest 20 boards above, and a "…" titled "More boards above", with no link, when there are more; its Link existing board list is empty on a board 20 deep.
- **`PUT /api/cards/reorder` names at most 5,000 cards, each once, and moves at most 100 to another column** (card 2209). More entries is `400` `A reorder can name at most 5,000 cards, and this names 5,001. Nothing was moved.`, and a card named twice `400` `updates names card 12 more than once`, each checked before any card is read (a card named over and over, to and fro between two columns, was a real move for every entry, past the cap below); more cards moved is `400` `At most 100 cards can be moved to another column at once, and this moves 101. Nothing was moved: move them in groups of 100 or fewer.`, checked once every card and column has been read and the caller found able to edit the board. Nothing moves and nothing is sent. The board page's drop sends every card that is not archived of the column dropped into and of the column the card came from, and moves one (card 2213: it sent every card of the board, twice); only a bulk move of more than 100 selected cards meets the cap, and the page now says so in an error toast and keeps the selection (`No answer from the server. The cards may not have been moved.` when there is none), where it read no answer. So one request sends at most 100 deliveries to each webhook of the board.
- **`GET /api/audit` and `GET /api/logs` read `from` and `to` as `GET /audit-log` does** (card 2095): ISO 8601, `YYYY-MM-DD HH:MM:SS` in UTC, or a date, a date alone as `to` being the whole of that day, and anything else `400` `from is not a date` or `to is not a date`, where each was compared as text, unchecked. The Audit page sends the last day of its range as the date chosen.
- **`GET /api/audit` and `GET /api/logs` refuse a `from` after its `to`** (card 2262), as `GET /audit-log` does: `400` `` `from` is after `to` ``, where each answered `200` with an empty page. Equal bounds name one second and are allowed. The Audit page says the refusal, and any other failure, under its filters in the server's words (`No answer from the server. The audit log was not read.` when there is none). A failed Apply empties the list, where it said "No audit entries match these filters." or kept the rows of the search before; a failed Load more keeps the rows already shown. An answer to an earlier Apply that comes after a newer one's is not shown.
- **`POST /api/account/api-keys` reads `expiresAt` in the same forms** (card 2095), `YYYY-MM-DD HH:MM:SS` included, and stores and answers it as `YYYY-MM-DD HH:MM:SS` in UTC, where it answered ISO 8601. A date is 00:00 UTC that day, as before; `null` is no expiry; anything that is not text is `400`.
- **`POST /api/reports` and `POST /api/reports/email` read `periodStart` and `periodEnd` in the same forms** (card 2095), a date alone as `periodEnd` being the whole of that day. The Reports page sends a custom range as the dates chosen, so a report from 1 to 14 October includes the 14th, where the page sent the end as midnight at its start and the 14th was left out.
- **The web application's routes, its pages and the two CSV exports keep `YYYY-MM-DD HH:MM:SS` in UTC** (card 2095), the form every timestamp is stored in. Fields they answered in ISO 8601 (`completedAt`, `archivedAt`, `updatedAt` after an edit, `resolvedAt`, a key's `lastUsedAt` and `expiresAt`, a schedule's `lastRunAt` and `nextRunAt`, a log line's `timestamp`) are in that form now, and so is the CSVs' "Completed" column, which a spreadsheet opens as a date and time. The pages read every one as UTC.
- **`POST /api/reports` and `POST /api/reports/email` take an optional `timeZone`** (card 2258): an IANA name, read as a report schedule's `timeZone` is (`europe/london` is `Europe/London`) and refused in its words, `400` `timeZone must be a time zone name, such as Europe/London`. It is the zone whose day the report's Overdue figure counts from: an open card due before that day. Without one the day is UTC, so a call that sends none gets the report it got before. The Reports page sends the browser's zone. The PDF of a report made by hand prints its period, generated date and completion dates in UTC whatever is sent; a scheduled report's PDF prints them in its schedule's zone, as its mail writes its period, and counts Overdue from that zone's day. A Due Date is printed as the day stored. The dashboard counts its overdue, due-soon and Upcoming Deadlines figures in the browser, in the viewer's own day; its page data carries the cards due from yesterday (on the UTC day) onward, a count (`longOverdue`) of those due earlier (overdue in every zone), and the moment it was read, where it carried the three figures, counted on the UTC day. No `/api/v1` operation changes.
- **`GET /api/boards/{id}/contents` is new** (card 2280): everything the board page draws, for the page to refresh itself with instead of re-running its whole load. It is the page load's own reader, so it answers what the load answers, for the caller as they may see it: the board row, the breadcrumbs, the caller's `canEdit`, `canManage` and `userBoardRole`, the linkable boards, the columns with their cards, the categories, labels, members, blocked state, token totals and goals. It refuses as the load does: `401` `Not authenticated`, `400` for an id that is not one, `404` `Board not found` for a board that is not there (administrators included), then `403` `You do not have access to this board`. A `200` carries `cache-control: private, no-store`. It is the pages' route, not under `/api/v1/` and not in the OpenAPI document; a script reads a board with `GET /boards/:boardId` and `GET /boards/:boardId/cards`.

### Changes on 2026-10-13

The OpenAPI document's version went from `1.0.0` to `1.1.0` with these. The path is still `/api/v1/`.

- **The key is `message` on every failure.** Until this date the `401`, the `429` and the `409` of each rejected batch carried their text as `error`, and the `409` of a dependency cycle on a card carried a fixed text as `error` beside its `message`. A caller that read `error` on those reads `message` now. Their other fields are unchanged.
- **A dependency cycle is told by `cycle`, not by its text.** The cycle's `message` holds the chain in words, as it did before. What is gone is the `error` key, which held the fixed text "That dependency would create a cycle" beside it, and only on the card route. The subtask route never had an `error` key: its `409` for a cycle was the `message` alone, and now has `cycle` as well.
- **A body that is missing, is not valid JSON or is not a JSON object is answered `400`.** It was answered `500`.
- **A body over the size limit is answered `413`.** A deployed server answered it `500`: see [The Request Body](#the-request-body).
- **A path that is no route is answered `404` as JSON**, where it was an HTML page, and **a method the route does not have is answered `405` as JSON**, where it was plain text. The `405` keeps its `Allow` header.
- **A failure is JSON whatever the `Accept` header.** A handler's refusal of a request sent with no `Accept` header, or with a browser's, used to be an HTML page.
- **Subtask dependencies answer as card dependencies do.** A subtask that depends on itself or on archived work is answered `400`, where it was `409`. Removing a subtask dependency that is not there is answered `404`, where it was `200`.
- **A comment answer says what was not found.** On `GET` and `POST` `/cards/:cardId/comments`, the `404` for a card whose column cannot be found says `Column not found`, where it said `Error: 404`.

Later the same day five operations began to refuse callers they used to let through, with no change to the document's version:

- **`GET /cards/:cardId/assignees` needs view access to the card's board.** It answered any key. It now answers `403` with `No access to this card's board`, as `GET /cards/:cardId` does.
- **`isPublic` on `PUT /boards/:boardId` is accepted only from the board's owner or an administrator.** An editor who sends it is answered `403` with `Only board owners and admins can change visibility`, and none of the request's fields is saved, the name that came with it included. An editor's `name`, `emoji` and `categoryId` are saved as before when `isPublic` is left out.
- **A dependency is removed by whoever may edit the board of the end that waits**, on the card route and the subtask route alike: see [Remove a Dependency](#remove-a-dependency).
- **`PUT /comments/:commentId` needs edit access to the comment's board as well as authorship**, which is what posting a comment needs. Someone taken off a board, or left on it as a viewer, is answered `403` with `No edit access to this board` for a comment they wrote there. An administrator edits any comment, as before.

And two answers to the board's owner or an administrator changed, on an operation that already answered the status:

- **`isPublic` on `PUT /boards/:boardId` is `true` or `false`, or the answer is `400`** with `isPublic must be true or false`. `null` was a `500`, and `1`, `"1"` and `[true]` were saved as true. An editor who sends it is still answered `403`, whatever its value.
- **Removing a dependency writes its activity entry on the board of the end that waits**, where it was written on the board of the card in the path: see [Remove a Dependency](#remove-a-dependency). Both ends' boards are sent the live update.

---

## Writes, Failures and Retries

Every write is all or nothing. One request often changes several things: a move changes the
card, awards XP, writes an activity entry and may write an "Unblocked" notice on another
card. All of them are saved, or none is.

| Answer to a `POST`, `PUT`, `PATCH` or `DELETE` | What it means | What to do |
|---|---|---|
| `2xx` | The change is committed | Carry on. It stays committed even if a webhook or an email that follows it fails |
| `429` | Turned away before it reached a handler. Nothing was written | Send it again, unchanged, after the number of seconds in `Retry-After` |
| Any other `4xx` | Refused. Nothing was written | Fix the request. Sending it again unchanged gets the same answer |
| `500` from DumpFire itself | Failed. Nothing was written, and no webhook, live update or email was sent for it. The request was not at fault | Send the same request again |
| `502`, `503` or `504` | Not an answer from DumpFire, which sends none of them. A proxy in front of it got no answer or did not wait for one. Not known | Read the resource to find out before sending again |
| No answer (a timeout, a dropped connection) | Not known | Read the resource to find out before sending again |

Four things about a `500`, a body that cannot be read and a field that cannot be used:

- **Whose a `500` is.** A request that DumpFire fails is answered `500` with the JSON body
  `{ "message": "Internal Error" }`, whatever `Accept` header it was sent with.
- **A body that is missing, is not valid JSON or is not a JSON object is answered `400`,
  never `500`.** The same body gets the same answer every time: fix it before sending it
  again. See [The Request Body](#the-request-body).
- **Every handler that takes a body reads it before it looks for the resource or checks
  access to it.** Sent a body that cannot be read, it answers `400` even for a resource that
  does not exist or one the caller may not edit. With a body that is a JSON object, the
  resource is looked for and the caller checked first, `404` then `403`, and what the fields
  hold after that. Nothing is awaited between the check and the write, so access taken away
  while the body was arriving is seen. Until 2026-10-14
  eleven operations looked first: those that create a column, a label, a category or a
  webhook on a board, that put a label on a card or take it off, and that change a label, a
  column, a category, a board category or a webhook. And some read a field before they
  looked: a comment's content, a milestone's card. The exceptions, an operation with nothing
  in its path and the token and batch routes, are under
  [What a Field May Hold](#what-a-field-may-hold).
- **A field DumpFire cannot use is a `400`, never a `500`.** Every field is read by its type
  and range before anything is written, so a `500` is DumpFire's own failure and not the
  request's: send it again unchanged.

After a `502`, `503`, `504` or no answer, be most careful with a `POST`: a second `POST` of
a write that did happen makes a second card, comment or subtask.

Webhooks, live board updates and emails are sent **after** the change is committed, and are
not waited for. One that fails is logged on the server and does not change the answer. A
webhook receiver is therefore only ever told of a change that was saved, and a `2xx` is
never followed by a rollback.

---

## What a Delete Removes

| Request | Removes | Leaves |
|---|---|---|
| `DELETE /api/v1/cards/:cardId` | Nothing: the card is **archived**. `archivedAt` is set and a `card_archived` entry is written. A card already archived is left as it is, with no entry | Everything. Its subtasks, comments, attachments, dependency links and sub-boards are untouched, and restoring the card brings it back whole |
| `DELETE /api/v1/cards/:cardId?permanent=true` | The card, its subtasks, comments, assignees and attachments; every sub-board under it, at every depth, with everything on it; every dependency link with a deleted card or subtask at either end | Cards that were waiting on a deleted card. They are no longer waiting on it |
| `DELETE /api/v1/columns/:columnId` | The column and **every card in it**, archived or not. Each card goes as a permanent delete does | The board and its other columns |
| `DELETE /api/v1/boards/:boardId` | The board with its columns, cards, labels, milestones, webhooks and card categories (since 2026-10-14: the categories were kept, as categories of no board); every sub-board under it, with its categories; the report schedules that name it | Cards on other boards that were in one of its milestones, now in no milestone, and any that carried one of its categories, now in none |
| `DELETE /api/v1/subtasks/:subtaskId` | The subtask, and every dependency link with it at either end | Its card |
| `DELETE /api/v1/milestones/:milestoneId` | The milestone | Its cards, now in no milestone |

Three things hold for all of them:

- **Each delete is one transaction.** If it fails it answers `500` and nothing was deleted.
- **Attachment files are kept for 30 days.** A deleted card's files are moved to a trash on
  the server and removed after 30 days, so an administrator who restores an earlier backup
  has them back.
- **Ids are never reused.** A card created after a delete does not get a deleted card's id.

What each delete records:

| Delete | Activity and audit log | Webhook |
|---|---|---|
| Archive | `card_archived`, with the card's id, only when the card was not already archived (since 2026-10-14) | None |
| Restore (`PUT /cards/:cardId` with `archivedAt: null`) | `card_restored`, with the card's id and title, only when the card was archived (since 2026-10-14) | None |
| Card, permanent | `card_deleted`, with a null `cardId`: the card is gone | One `card.deleted`, carrying the id of the card asked for. Cards on sub-boards under it go with it and get no `card.deleted` of their own |
| Column | One `column_deleted` on its board, naming the column and how many cards went with it | None, for the column or for any card in it |
| Board | None: the board's log is deleted with it | None |
| Subtask (`DELETE /subtasks/:subtaskId`) | `subtask_deleted`, on its card, naming the subtask (since 2026-10-14: there was none) | None |

`GET /api/v1/audit-log?action=column_deleted` finds column deletes whether they were made in
the web UI or through the API.

Pages open in the web application are told of each of these once it is committed: the
board of the card, subtask or column, and every board a delete removed, a deleted board
itself among them, and the board of the card a deleted sub-board hung from (since
2026-10-14: a deleted board's pages, and its sub-boards', were told nothing). The update
names nothing that went, and the page reads the board again.

### Attachments

Attachments are not part of this API: the web application uploads and serves them through
its own routes, with a session and not an API key. An attachment opened by its address is
shown in the browser only if it is a PNG, JPEG, GIF, WebP or `.txt` file whose stored type
and file extension agree. Every other attachment, a PDF, an HTML or an SVG file among them,
is answered as a download. Every answer carries `Content-Security-Policy: sandbox` and
`X-Content-Type-Options: nosniff`. On a card, the four image types have a thumbnail that
opens the image, and every other attachment is saved to disk.

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

#### Get Personal Stats

```
GET /api/v1/me/stats
```

How the user associated with the API key is doing. Takes no parameters.

**Response:**
```json
{
  "cardsCompleted": { "total": 41, "last7Days": 3, "last30Days": 12 },
  "avgCycleTimeDays": 4.2,
  "streak": 2,
  "activeCards": 5,
  "recentActivity": [
    {
      "id": 9120,
      "action": "api:card_updated",
      "detail": "Updated fields: priority on \"Deploy v2.1\"",
      "boardId": 1,
      "createdAt": "2026-10-13T09:41:07.000Z"
    }
  ]
}
```

| Field | Meaning |
|-------|---------|
| `cardsCompleted` | Completions the activity log records as this user's, made in the web UI or through the API: in all, in the last 7 days and in the last 30 |
| `avgCycleTimeDays` | Mean days from a card's creation to its completion, to one decimal place, over the completed cards the user is assigned to on boards they can open. `null` when there is none, and `0` when they were completed as they were made |
| `streak` | Consecutive UTC days with at least one completion, counted back from today, or from yesterday if there is none today |
| `activeCards` | Cards the user is assigned to that are neither completed nor archived, on boards they can open |
| `recentActivity` | The user's last 20 activity entries on boards they can open, newest first: an entry on a board they have been taken off is left out. `action` is as stored: one made through the API has the prefix `api:` |

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
    "createdAt": "2026-04-01T12:00:00.000Z",
    "updatedAt": "2026-04-09T10:30:00.000Z"
  }
]
```

---

#### Get Board Details

```
GET /api/v1/boards/:boardId
```

Returns a single board with its columns. A board that does not exist is `404` `Board not found` to everyone; one that is there and the key's user cannot open is `403`. Every operation under `/boards/:boardId` answers in that order.

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

The cards come in the board's order (card 2295): column by column in order of column position,
ties by column id, and within a column in order of card position, ties by card id. With
`archived=true` an archived card takes its place by position among the rest. A pinned card is
not put first: that is how the board page shows a column, not the stored order. `columnId`
narrows the list to that column of this board; a column of another board gives `[]`. Each card
carries `columnTitle`, `subtaskCount` and `subtaskCompleted`. Until 2026-10-14 the columns came
in the order they were made in, so a column moved or added between two others was listed in
the wrong place.

**Query Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `columnId` | number | Filter cards to a specific column. A whole number of 1 or more, or `400` `Invalid column ID` |
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
    "createdAt": "2026-04-01T09:00:00.000Z",
    "updatedAt": "2026-04-09T10:00:00.000Z"
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
| `columnId` | number | ✅ | The column to place the card in, one of this board's: `400` `Column does not belong to this board` otherwise |
| `title` | string | ✅ | Card title, trimmed, 1 to 500 characters |
| `description` | string | | Card description, at most 50,000 characters |
| `priority` | string | | `low`, `medium`, `high`, or `critical`, in any case, stored in lower case (default: `medium`) |
| `colorTag` | string | | A colour written `#rrggbb`, or `''` for none |
| `categoryId` | number or null | | A category of this board, or one that belongs to no board: `404` `Category not found on this board` otherwise |
| `dueDate` | string or null | | A day of the calendar written `YYYY-MM-DD` (e.g. `2026-04-15`); `''` is none |
| `businessValue` | string | | Business value description, at most 10,000 characters |
| `position` | number | | Position within the column (default: `0`) |
| `summary`, `theme`, `customerImpact`, `closeReason`, `releaseState` | string or null | | The reporting fields, each in its own vocabulary |

The board is looked for and the caller checked first (`404`, then `403`), then every field is read (`400`, see [What a Field May Hold](#what-a-field-may-hold)), and then the column and the category the body names are looked for.

**Into a Complete or Done column**, the card is completed as it is created, by the same rule as a move into one: `completedAt` and `firstCompletedAt` are the moment it was created, the key's user is given the XP for its priority, `api:card_created` and then `api:card_completed` are logged (the second with `"<title>": created in <column>`), the board's webhooks get `card.created` and `card.completed`, and open pages get the celebration. The check for open subtasks and sub-boards is not made: a new card has neither. Subtasks added to it afterwards are open on a finished card, as a subtask added to any finished card is. Until 2026-10-14 such a card sat in the column with no completion date, no XP and no `api:card_completed` entry, so velocity and the completion figures missed it.

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

**Response:** `201 Created` with the created card object, as it was written: with its `completedAt` and `firstCompletedAt` for a card created in a Complete column.

---

#### Get a Single Card

```
GET /api/v1/cards/:cardId
```

Returns the card with its subtasks (ordered by position, then id), label IDs, and assignees.

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
| `title` | string | Card title, trimmed, 1 to 500 characters |
| `description` | string | Card description, at most 50,000 characters |
| `priority` | string | `low`, `medium`, `high`, `critical`, in any case, stored in lower case |
| `colorTag` | string | A colour written `#rrggbb`, or `''` for none |
| `categoryId` | number or null | A category of the card's board, or one that belongs to no board; `null` for none |
| `dueDate` | string or null | A day of the calendar written `YYYY-MM-DD`; `null` or `''` clears it |
| `onHoldNote` | string | Note when card is on hold, at most 50,000 characters |
| `businessValue` | string | Business value description, at most 10,000 characters |
| `pinned` | boolean | Pin to top of column: `true` or `false` |
| `coverUrl` | string or null | The card's cover, drawn as a strip across the top of the card on the board: a colour written `#rrggbb`, or one of the eight preset gradients below. `null` or `''` clears it. Anything else is `400` |
| `milestoneId` | number or null | Put the card in that milestone, or take it out of its own with `null` |
| `archivedAt` | null | `null` restores an archived card. Nothing else is taken: archive a card with `DELETE /cards/:cardId` |
| `summary`, `theme`, `customerImpact`, `closeReason`, `releaseState` | string or null | The reporting fields, each in its own vocabulary |
| `columnId` | number | Not updatable: accepted only as the column the card is in, so a card read with `GET /cards/:cardId` can be sent back whole. Any other is `400` (below) |
| `position` | number | Not updatable: ignored here, whatever is sent; reorder with `PUT /cards/:cardId/move` |

A body with none of the updatable fields is `400` `No valid fields to update`; `columnId` and
`position` do not count.

**This operation does not move a card** (card 2287). A `columnId` other than the card's own is
`400` `columnId 12 is not this card's column (14): the card has moved since it was read, or a
move was meant. Move a card with PUT /cards/{cardId}/move`, naming the value sent and the
column the card is in, and nothing in the request is saved; `null`, or a value that is not an
id, is `400` `columnId must be an id`. The column it names is not looked for. The card's own
column, sent back, is accepted, written as a number or as text (`"14"`). `position` is ignored,
whatever is sent: a drag renumbers every card in the columns it touches, so a card read a
minute ago is often sent back with an old position, and taking it would undo the drag. Move or
reorder a card with [`PUT /cards/:cardId/move`](#move-a-card-to-a-different-column). Until
2026-10-14 another `columnId` was ignored too, and the other fields in the request saved.

**A cover** is a colour written `#rrggbb`, or one of these eight gradients, written exactly
so, which are what the card window offers beside eight colours:

```
linear-gradient(135deg, #667eea 0%, #764ba2 100%)
linear-gradient(135deg, #f093fb 0%, #f5576c 100%)
linear-gradient(135deg, #4facfe 0%, #00f2fe 100%)
linear-gradient(135deg, #43e97b 0%, #38f9d7 100%)
linear-gradient(135deg, #fa709a 0%, #fee140 100%)
linear-gradient(135deg, #a18cd1 0%, #fbc2eb 100%)
linear-gradient(135deg, #fccb90 0%, #d57eeb 100%)
linear-gradient(135deg, #e0c3fc 0%, #8ec5fc 100%)
```

Anything else is `400` `coverUrl must be a colour written #rrggbb, one of the preset
gradients, or null`. The field's name is older than the rule: it holds a colour, not an
address. A cover stored before the rule, sent back unchanged, is kept, and is not drawn.
`recurrenceRule` is not an updatable field: a card answer carries it and `nextRecurrence`,
and nothing sets or acts on either.

**Example:**
```json
{
  "priority": "critical",
  "dueDate": "2026-04-12"
}
```

**Response:** `200` with the updated card object.

The card is looked for and the caller checked first (`404`, then `403`), then every field
is read (`400`, see [What a Field May Hold](#what-a-field-may-hold)), and then what the body
names: the category (`404` `Category not found on this board`) and the milestone. A value
the card already holds, sent back unchanged, is accepted as it is, whatever the rules say
of it: a card filed under another board's category keeps it while it is sent back, and a
card's stored `archivedAt`, sent back, changes nothing.

`milestoneId` follows the milestone routes' rules: putting a card in needs edit access to
that milestone, a milestone of one board takes only that board's cards, and an archived
card is refused with `400` `Card does not exist or is archived`. Taking a card out with
`null`, or putting it in another milestone, needs edit access to the milestone it is in,
as putting it in did (`403` `No edit access to this milestone`). `archivedAt: null` sent
with a `milestoneId` restores the card first. See [Attach and Detach Cards](#attach-and-detach-cards).
A changed `milestoneId` logs `api:milestone_card_added` or `api:milestone_card_removed`, as
the milestone routes do, and is not named in `api:card_updated`: a milestone alone sends no
`card.updated` webhook. Until 2026-10-14 it was logged as "Updated fields: milestoneId" and
sent `card.updated` (card 2289).

A restore is recorded as one: `archivedAt: null` on an archived card writes
`api:card_restored`, with the card's title, as restoring it in the web application writes
`card_restored`. The `api:card_updated` entry is written only for the other fields sent, so
a restore alone delivers no `card.updated` webhook; a restore with a new title writes both.
An `archivedAt` that changes nothing, `null` on a card that is not archived or the stamp
the card holds, is not a change and is not named. Until 2026-10-14 a restore was
recorded as `api:card_updated` naming `archivedAt`.

**Only what changed is recorded.** A field sent with the value the card already holds is
not a change, and `null` and `''` are the same value when comparing (`description`, `onHoldNote` and `businessValue` still take text only, and `''` clears them); a reporting value is compared in the
spelling it is stored in, so `"Maintenance"` sent to a card holding `maintenance` is none.
A request that changes nothing writes nothing, so `updatedAt` stays, records no activity
entry, sends no `card.updated` webhook and no live update, and answers `200` with the card
as it is. A request that changes some fields writes, names in `api:card_updated` and
announces those alone. The milestone the card is in, sent back, is not a change and is not
checked. Until 2026-10-14 every field sent was written and named, changed or not
(card 2183).

The update is one transaction. A request that is refused changes nothing: a `400` for any
field leaves every field as it was, and so does the refusal of a `milestoneId` the card
cannot join. A title that is too long sent together with a new milestone used to answer
`400` and change the milestone all the same.

---

#### Delete a Card

```
DELETE /api/v1/cards/:cardId
```

By default, this **archives** the card (soft-delete). Add `?permanent=true` to permanently delete.

| Parameter | Type | Description |
|-----------|------|-------------|
| `permanent` | boolean | Permanently delete instead of archiving |

**Response:** `200`, for an archive and for a permanent delete alike.
```json
{ "success": true }
```

**Archive.** `archivedAt` is set and a `card_archived` activity entry is written. Nothing
else is touched: no subtask, comment, attachment, dependency link or sub-board. No webhook
is sent. A card already archived is answered `200` as it is, with nothing written and no
live update: `archivedAt` keeps its first value and no second entry is logged (card 2285).

**Permanent delete.** The card goes with its subtasks, comments, assignees and attachments,
with every sub-board under it and everything on those, and with every dependency link that
has a deleted card or subtask at either end. One `card_deleted` activity entry is written,
and the board's webhook receivers get one `card.deleted`:

```json
{
  "event": "card.deleted",
  "timestamp": "2026-10-13T09:14:03.512Z",
  "boardId": 3,
  "data": {
    "cardId": 1686,
    "action": "card_deleted",
    "source": "api",
    "detail": "\"Compose network segmentation applied on the new host\"",
    "user": "greg"
  }
}
```

`data.cardId` is the id of the card that was deleted. The activity entry for the delete has
a null `cardId`, because the card it would point to is gone.

See [What a Delete Removes](#what-a-delete-removes) for columns and boards.

---

### Card Assignees

#### List Assignees

```
GET /api/v1/cards/:cardId/assignees
```

Needs view access to the card's board, as reading the card does. A caller without it is
answered `403` with `{ "message": "No access to this card's board" }`.

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
| `userId` | number | ✅ | ID of the user to assign: a whole number of 1 or more, `400` `userId must be an id` otherwise |

**Response:**
```json
{ "success": true, "message": "User assigned" }
```

The card is looked for and the caller checked first (`404`, then `403`), then `userId` is
read. A user who does not exist is `404` `User not found`, and one who cannot open the
card's board `400` `User does not have access to this board`. Assigning someone already
assigned is answered `200` with `User already assigned`.

---

#### Remove an Assignee

```
DELETE /api/v1/cards/:cardId/assignees
```

**Request Body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `userId` | number | ✅ | ID of the user to unassign: a whole number of 1 or more |

**Response:**
```json
{ "success": true }
```

Removing someone who is not assigned to the card is `404` `User is not assigned to this
card`, writes nothing and sends no live update. Until 2026-10-14 it was `200`, with an
activity entry that said they had been removed.

---

### Card Movement

#### Move a Card to a Different Column

```
PUT /api/v1/cards/:cardId/move
```

This endpoint moves a card to another column, on the same board or a different one (you need edit access to both). It goes through the same service as dragging a card in the UI:

- **Into a Complete/Done column** — `completedAt` is stamped, `firstCompletedAt` is set if it was not already, XP is awarded the first time the card is ever completed, a celebration event fires and `card_completed` is logged. Returns **409** while the card has open subtasks or sub-boards; an archived card on a sub-board is not counted (card 2205).
- **Out of a Complete/Done column** — `completedAt` is cleared and `card_reopened` is logged. `firstCompletedAt` is kept, which is why completing the card again earns no XP.
- **Out of an On Hold column** — a move from a column titled On Hold, Hold, Blocked, Parked or Waiting to one that is not clears the card's `onHoldNote` to `''`, in the same write as the move: a note is the reason a card is paused. The note stays on a move into such a column, between two of them, and between two working columns. Nothing beside the move's own entry is logged for it. Until 2026-10-14 only a drag on the board page cleared the note (card 2208).
- **To another board** — the source board's labels are removed from the card, and so is a category that belongs to another board (a category with no board stays), and so is a milestone that belongs to a board other than the one it arrives on: the answer has `milestoneId: null` and names the milestone it left as `leftMilestone` (`{ "id", "name" }`, otherwise `null`) (card 2155). A milestone across boards keeps the card. `card_moved_away` and `card_moved_in` are logged, one on each board, and neither names the other board (card 2181): `"<title>" moved to another board (<from column> → <to column>)` on the board it left and `"<title>" moved from another board (<from column> → <to column>)` on the board it arrived on. Each entry is read by everyone who can open its board, and some of them cannot open the other. `card_moved_away` ends ` and out of milestone "<name>"` when the move took the card out of one of that board's milestones. The card's "Unblocked" comments that name work of the board it left by its title are rewritten to name it by its number, or as "a subtask on another board", with `updatedAt` unchanged (card 2256; see [Unblock Behaviour](#unblock-behaviour)), and so are other cards' notices naming it or one of its subtasks, on every card not on the board it arrives on (card 2261).
- **Onto one of its own sub-boards** — a card's sub-boards go with it, so a move onto one, or onto a board beneath one at any depth, is refused with **409** and nothing moves: `Card "<title>" cannot go onto "<board>", which hangs beneath it`. The sub-boards would hang beneath themselves, a loop with no top that is on no dashboard (card 2141). It is asked only of a move to another board, before the check for open subtasks and sub-boards, and an archived card in the chain counts. A move of the card such a loop already hangs from, made before this check, onto a board outside the loop is allowed, and is how the loop is put right.
- **Where its sub-boards would be too deep** — sub-boards nest at most 20 levels below a board that is not a sub-board, so a move to another board that would carry the card's sub-boards deeper than that, and deeper than they are now, is refused with **409** and nothing moves: `Card "<title>" cannot go onto "<board>": its sub-boards would then be nested more than 20 levels deep.` (card 2172). Asked after the loop check above. A card with no sub-board is never refused, and a move that lifts a tree already too deep is allowed.
- **Mail** — a move that completes the card mails its assignees who can open the board it is now on `Card moved: <title> → <column>`, each as their own "Card moved" setting says, as every move made in the web application does. A move through the API that does not complete the card mails nobody: a script works a board all day, and a mail for each move would bury the people on it. Whoever made the move is never mailed about it, so a key that moves its own user's card to Complete does not mail that user. Until 2026-10-14 no move through the API mailed an assignee.

**Request Body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `columnId` | number | ✅ | Target column ID: a whole number of 1 or more |
| `position` | number | | Position within the target column: a number, or one written as text. Left out, the card keeps the position it had |

**Example:**
```json
{
  "columnId": 4,
  "position": 0
}
```

The card is looked for and the caller checked first, then the two fields are read, then the
target column is looked for and the caller checked on its board. Until 2026-10-14 a
`position` that was not a number was ignored, as if it had been left out.

**Response:**
```json
{
  "id": 10,
  "columnId": 4,
  "columnTitle": "Complete",
  "boardId": 1,
  "completedAt": "2026-04-09T10:45:00.000Z",
  "firstCompletedAt": "2026-04-09T10:45:00.000Z"
}
```

---

### Subtasks

#### List Subtasks

```
GET /api/v1/cards/:cardId/subtasks
```

The card's subtasks, ordered by position, then id: subtasks at one position in the order
they were made (card 2223).

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
| `title` | string | ✅ | Subtask title, trimmed, 1 to 500 characters |
| `description` | string | | Description, at most 50,000 characters |
| `priority` | string | | `low`, `medium`, `high`, `critical`, in any case, stored in lower case |
| `colorTag` | string | | A colour written `#rrggbb`, or `''` for none |
| `dueDate` | string or null | | A day of the calendar written `YYYY-MM-DD`; `''` is none |
| `position` | number | | Position within the subtask list, lowest first. Not sent: after the card's last one (one more than the largest position, or 0 for its first), as the web application places it. Until 2026-10-14 it was 0 (card 2223) |

**Response:** `201 Created` with the subtask object.

The card is looked for and the caller checked first (`404`, then `403`), and then the fields
are read: see [What a Field May Hold](#what-a-field-may-hold).

---

#### Update a Subtask

```
PUT /api/v1/subtasks/:subtaskId
```

**Updatable Fields:**

| Field | Type | Description |
|-------|------|-------------|
| `title` | string | Subtask title, trimmed, 1 to 500 characters |
| `description` | string | Description, at most 50,000 characters |
| `priority` | string | `low`, `medium`, `high`, `critical`, in any case, stored in lower case |
| `colorTag` | string | A colour written `#rrggbb`, or `''` for none |
| `dueDate` | string or null | A day of the calendar written `YYYY-MM-DD`; `null` or `''` clears it |
| `completed` | boolean | Mark as complete/incomplete: `true` or `false`, and `"false"` is not false |
| `position` | number | Position in list |

**Response:** `200` with the updated subtask.

The subtask is looked for and the caller checked first (`404`, then `403`), then every field
is read. A value the subtask already holds, sent back unchanged, is accepted as it is. A
body with none of these fields is `400` `No valid fields to update`.

Completing a subtask writes an `api:subtask_completed` entry, `<subtask> (on <card>)`, then
the "Unblocked" notices for any work it was the last thing holding up, and mails whoever
asked for the card when it came from a task request ("Subtask completed on your request"),
as ticking it in the web application does. A subtask already complete, sent `completed: true`
again, writes none of it. Until 2026-10-14 this operation wrote no entry and mailed nobody.

Unticking a subtask (`completed: false` on one that is complete) writes an
`api:subtask_updated` entry, `Reopened <subtask> (on <card>)`, and mails nobody. A change of
`title`, `description`, `priority`, `colorTag` or `dueDate` writes an `api:subtask_updated`
entry naming the fields changed, `Updated <subtask> (on <card>): title, dueDate`, after the
tick or untick when one request does both. A change of `position` alone is written and not
recorded. A request that changes nothing (every field sent is the value the subtask holds)
writes nothing, records nothing and sends no live update, and is answered `200` with the
subtask as it is (card 2299; until 2026-10-14 neither an untick nor an edit was recorded).

---

#### Delete a Subtask

```
DELETE /api/v1/subtasks/:subtaskId
```

Permanently deletes the subtask, and every dependency link that has it at either end. The
subtask and its links go together or not at all, with an `api:subtask_deleted` entry that
names the subtask. Until 2026-10-14 no entry was written.

**Response:**
```json
{ "success": true }
```

---

### Comments

| Route | Does | Needs | Answers |
|-------|------|-------|---------|
| `GET /api/v1/cards/:cardId/comments` | Lists the card's comments, newest first, those of one second the later first | View access | `200`, `400`, `403`, `404` |
| `POST /api/v1/cards/:cardId/comments` | Adds one: `content`, 1 to 50,000 characters once trimmed. Logs `api:comment_added`, fires `comment.added` | Edit access | `201`, `400`, `403`, `404` |
| `GET /api/v1/comments/:commentId` | Reads one, with its author | View access | `200`, `400`, `403`, `404` |
| `PUT /api/v1/comments/:commentId` | Replaces its `content`; the same text, once trimmed, writes nothing. Logs `api:comment_edited` | Its author with edit access, or an administrator | `200`, `400`, `403`, `404` |
| `DELETE /api/v1/comments/:commentId` | Deletes it. No body. Logs `api:comment_deleted` | Its author with edit access, or an administrator | `200` `{ "success": true }`, `400`, `403`, `404` |

The answers listed are each operation's own, plus `401` and `429` as for every operation, and
`413` where there is a body.

A board's owner may not edit or delete a comment somebody else wrote. A delete is recorded as
`Deleted a comment on "<card>"`, or `Deleted a comment by <author> on "<card>"` when the caller
is not the author, never with the comment's text. **No webhook is sent for an edit or a
delete**: only `comment.added` exists, so a receiver that mirrors a card's comments learns that
one has been changed or has gone only by reading the list again (card 2283).

---

### Dependencies

Records which piece of work waits on which. Either end of a link is a card or a subtask.
This is one of only two planning facts stored by hand —
everything the planning view shows (critical path, what is startable, what is blocked) is
computed from it, so it can never go stale.

Direction, stated once: **`cardId` is the card that is blocked; `dependsOnCardId` is its
blocker.** Cross-board dependencies are allowed. Adding one requires edit access to both
ends; removing one requires edit access to the board of the end that waits.

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
      "kind": "card",
      "cardId": 1686,
      "parentCardId": null,
      "title": "Compose network segmentation applied on the new host",
      "boardId": 1,
      "boardName": "VectorOMS",
      "columnName": "In Progress",
      "priority": "critical",
      "resolved": false,
      "withheld": false,
      "createdByUserId": 2,
      "createdAt": "2026-09-11T09:14:02.000Z"
    }
  ],
  "blocks": []
}
```

`id` is the id of the link. `kind` is `card` or `subtask` and says what `cardId` is the id
of: for a subtask it is the subtask's id, and `parentCardId` is the card it belongs to.
`resolved` is true once that end is finished: a card when it reaches a Complete column, a
subtask when it is ticked. With `direction=blocked-by` the answer has no `blocks`, and with
`direction=blocks` no `blockedBy`; any other value is a `400`. Work that has been archived or
deleted is not listed. `GET /api/v1/cards/{cardId}`
also returns `isBlocked`, `blockedBy` and `blocks`, so a planning client needs only one
request per card.

**An end on a board the key's user cannot open is withheld** (since 2026-10-14). It is
still listed, so that a card waiting on it is still blocked, and the link can still be
removed by its id. What is kept: `kind`, `cardId`, `resolved`, and the link's `id`,
`createdByUserId` and `createdAt`. What is withheld: `title` reads
`A card on a board you cannot open` (or `A subtask on a board you cannot open`),
`boardName` reads `A board you cannot open`, `columnName` is `""`, and `boardId`,
`priority` and `parentCardId` are `null`.
`withheld` says which: `true` for such an end, `false` for every other. An administrator's
key is never given one. Until 2026-10-14 the title, board, column and priority of the other
end were given to anyone who could open this card's board.

#### Add a Dependency

```http
POST /api/v1/cards/{cardId}/dependencies
```

**Request body** — send exactly one of:

| Field | Meaning |
|-------|---------|
| `dependsOnCardId` | This card waits on that card |
| `dependsOnSubtaskId` | This card waits on that subtask |
| `blocksCardId` | That card waits on this card |
| `blocksSubtaskId` | That subtask waits on this card |

Both directions are accepted so a caller never has to work out which end of the pair owns
the stored row.

```json
{ "dependsOnCardId": 1686 }
```

**Response:** `201 Created`. `blocked` is the end that waits, `blocker` the end it waits on,
and `isBlocked` is whether the card in the path is blocked now.
```json
{
  "blocked": { "kind": "card", "id": 1559 },
  "blocker": { "kind": "card", "id": 1686 },
  "isBlocked": true
}
```

**Errors.** A request that is refused writes nothing.

| Code | Cause | Body |
|------|-------|------|
| `400` | None of the four fields, or more than one of them | `{ message }` |
| `400` | An id in the body that is not a whole number of 1 or more, or a number written as one | `{ "message": "dependsOnCardId must be an id" }` |
| `400` | The card id in the path is not a whole number of 1 or more | `{ "message": "Invalid card ID" }` |
| `400` | An end waits on itself | `{ "message": "#1559 cannot depend on itself" }` |
| `400` | An end is archived | `{ "message": "#1686 does not exist or is archived" }` |
| `403` | No edit access to one of the two boards | `{ message }` |
| `404` | The card in the path, or the card or subtask named in the body, does not exist | `{ "message": "#1686 not found" }` |
| `409` | That dependency already exists | `{ "message": "That dependency already exists" }` |
| `409` | The dependency would create a cycle | `{ message, cycle }` |

A duplicate and a cycle are both `409`. The cycle is the one with `cycle` in its body: the
chain the link would close, in order, each entry a `kind` and an `id`. `message` says the
same in words, because "rejected" on its own is not useful when the loop runs through five
cards on three boards:

```json
{
  "message": "#1559 waiting on #1198 would create a cycle: #1559 → #1686 → #1198 → #1559",
  "cycle": [
    { "kind": "card", "id": 1559 },
    { "kind": "card", "id": 1686 },
    { "kind": "card", "id": 1198 }
  ]
}
```

In a message, `#1686` is card 1686 and `subtask #42` is subtask 42.

#### Remove a Dependency

```http
DELETE /api/v1/cards/{cardId}/dependencies
```

Takes the same four body fields as `POST`.

**Who may remove a link.** Whoever may edit the board of **the end that waits** (the
blocked end), whichever end the request is addressed to. An administrator always. Edit
access to the board of the end that is waited on is not asked for, and is not enough:

| The caller can edit | Answer |
|---------------------|--------|
| The board of the end that waits | Removed, from either end's address. The card in the path must be one the caller can view, so a caller who cannot open the blocking end's board removes the link at the address of their own card |
| Only the board of the end it waits on | `403`, from either end's address |
| Both boards, or is an administrator | Removed |

So a card can stop waiting on work its owner can no longer see, and an editor of the
blocking end alone cannot unblock another board's work.

**Where it is recorded.** The `api:dependency_removed` activity entry is written on the
board of the end that waits, whichever end the request is addressed to: that is the board
whose work changed, and the one the caller was shown to edit. It names the card in the
path where that card is on that board, and otherwise the card that waits (a waiting
subtask's card). Both ends' boards are sent the live update, once where they are one board.

**Response:**
```json
{ "success": true, "removed": 1 }
```

**Refusals, in the order they are decided.** `404` if the card in the path does not exist;
`403` if the caller cannot view its board; `404` if the end that waits does not exist;
`403` with `{ "message": "No edit access to the board holding #1559, the end that waits" }`
if the caller cannot edit that end's board; and only then `404` with
`{ "message": "Dependency not found" }` for a link that is not there. The `403` is decided
before the link is looked for, so a refused caller is answered the same whether the link
exists or not.

#### Subtask Dependencies

```http
GET    /api/v1/subtasks/{subtaskId}/dependencies
POST   /api/v1/subtasks/{subtaskId}/dependencies
DELETE /api/v1/subtasks/{subtaskId}/dependencies
```

The same three operations from a subtask. `POST` and `DELETE` take the same four body
fields, which mean what they mean on a card with "this subtask" for "this card". The
refusals are those of the card route, status for status: `400` for an end that waits on
itself or is archived, `409` for a link that already exists, `409` with `cycle` for a loop,
and `404` for removing a link that is not there.

Three things differ from the card route:

| | Card route | Subtask route |
|---|---|---|
| `GET` | Takes `direction`. Each entry carries the link's `id`, `createdByUserId` and `createdAt` | No `direction`: both lists are always there. An entry has no link id |
| `POST` answers `201` with | `{ blocked, blocker, isBlocked }` | The subtask's dependencies as they then are |
| `DELETE` answers `200` with | `{ success, removed }` | The subtask's dependencies as they then are |

**Response**, from all three:
```json
{
  "subtaskId": 3471,
  "cardId": 1559,
  "isBlocked": true,
  "blockedBy": [
    {
      "kind": "card",
      "cardId": 1686,
      "parentCardId": null,
      "title": "Compose network segmentation applied on the new host",
      "boardId": 1,
      "boardName": "VectorOMS",
      "columnName": "In Progress",
      "priority": "critical",
      "resolved": false,
      "withheld": false
    }
  ],
  "blocks": []
}
```

`cardId` at the top is the card the subtask belongs to. An end on a board the key's user
cannot open is withheld, as it is on a card's list. Adding a link needs edit access to
the boards at both ends. Removing one is decided as it is on a card, by the same rule: edit
access to the board of the end that waits, with the subtask in the path one the caller can
view.

Each is recorded as it is on a card. `POST` writes `api:dependency_added` on the board of
the subtask's card, naming that card: "subtask #3471 now waits on #1686". `DELETE` writes
`api:dependency_removed` on the board of the end that waits, naming the subtask's card where
it is on that board, and otherwise the card that waits. Until 2026-10-14 the subtask route
wrote no entry. The link and its entry are written in one transaction, with the check.

#### Unblock Behaviour

When a card reaches a Complete column, every card whose **last** open blocker it was gets a
system comment and its assignees are emailed:

```
Unblocked: #1686 "Compose network segmentation applied on the new host" completed —
nothing is blocking this card now.
```

A card that still has other blockers outstanding is left alone. This fires on all three
completion paths — drag-and-drop, the card update endpoint, and `PUT /api/v1/cards/{id}/move`.
Ticking a subtask does the same for whatever was waiting on that subtask.

The comment is read by everyone who can open the waiting card's board, so it names the
finished work by its title only when that work is on the same board (card 2152). Work on
another board is named by its number, or as a subtask:

```
Unblocked: #1686, a card on another board, completed — nothing is blocking this card now.
Unblocked: a subtask on another board completed — nothing is blocking this card now.
```

The comment goes with its card. A card moved to another board has its notices rewritten to
the forms above in the move itself (card 2256): a card by its number, unless that card is on
the board the card arrives on, and a subtask as one unless every subtask the notice names
(the finished one, and the waiting one) has the title of one of the card's own subtasks:
those go with the card and can be read on it, so that notice stays as it was. The rest of
the sentence is kept, the comment is not marked edited, and a card moved back keeps the
withheld form.

The same move takes the moved card's own name out of other cards' notices (card 2261): on
every card not on the board it arrives on, a notice naming it is rewritten to its number
alone, and one naming one of its subtasks, on a card that waited on that subtask as the
dependencies still record, to "a subtask on another board". A notice on a card of the board
it arrives on is left as it is, and so is a subtask notice on a card that also waits on a
subtask of the same title that is not the moved card's: that one may have written it.

The email is each assignee's own: it gives the finished work's title to an assignee who can
open the board it is on, and "A card on a board you cannot open" (or "A subtask on a board
you cannot open") to one who cannot. Only assignees who can open the waiting card's board
are mailed.

The comment is written in the same transaction as the completion, so a completion is never
saved without it. The email is sent after the commit; one that fails does not undo the
completion or change the answer.

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

**Query parameters:** `boardId`, a whole number of 1 or more (`400` `Invalid boardId`
otherwise), and `status` (`open` | `closed`; another is `400` `status must be open or closed`).

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

`boardIds` are the boards its cards are on, archived cards left out, that the key's user can
open (card 2206). A card on a board they cannot open is still counted in `cardCount` and
`doneCount`, as `GET /milestones/{milestoneId}` lists it withheld. An administrator's key
is given every board.

#### Create a Milestone

```http
POST /api/v1/milestones
```

| Field | Required | Description |
|-------|----------|-------------|
| `name` | ✅ | Text, trimmed, 1 to 200 characters |
| `boardId` | | A board id; omit it or send `null` for a cross-board goal |
| `description` | | Free text, at most 50,000 characters |
| `targetDate` | | A day of the calendar written `YYYY-MM-DD`; `null` or `''` for none |

**Response:** `201 Created` with the milestone.

With a `boardId`, that board is looked for and the caller checked first (`404`
`Board not found`, then `403` `No edit access to that board`), and the other fields are read
after. A cross-board goal has nothing to look for, and its fields are read at once.

#### Get, Update, Delete

```http
GET    /api/v1/milestones/{milestoneId}
PATCH  /api/v1/milestones/{milestoneId}
DELETE /api/v1/milestones/{milestoneId}
```

`PATCH` accepts `name`, `description`, `targetDate`, `status` (`open` or `closed`) and
`boardId` (a board id, or `null` for a cross-board goal), each by the rules of the create.
The milestone is looked for and the caller checked first (`404`, then `403`), then the
fields are read. A value the milestone already holds, sent back unchanged, is accepted as
it is.

A `boardId` gives the milestone to a board only when every card in it, archived cards
included, is on that board (card 2179). It is asked after the other fields: the board is
looked for (`404` `Board not found`), the caller must be able to edit it (`403`
`No edit access to that board`), and then a card of the milestone on another board is
`400` `Some cards in this milestone are not on that board (archived cards count too). Take those cards out of it first, or make the milestone cross-board instead; only its creator or an administrator can change a cross-board milestone afterwards.` A refusal changes
nothing, and names no card and no board; archived cards are listed, with their
`milestoneId`, by `GET /boards/{boardId}/cards?archived=true`. Without the rule, every
reader of the new board would read the titles of the other boards' cards in the goal.
`boardId: null` (a goal across boards) is always accepted, and the milestone's own board
sent back is no change. An empty goal goes to any board the caller may edit.

`DELETE` removes the goal but **never the work** — its cards are released back to having no
milestone:

```json
{ "success": true, "cardsReleased": 9 }
```

**What is recorded** (card 2289). A `PATCH` logs `api:milestone_updated`, naming the fields
changed among `name`, `description`, `targetDate` and `boardId` (`Updated milestone "Launch":
name, targetDate`), and a change of `status` `api:milestone_closed` or
`api:milestone_reopened` (`Closed milestone "Launch"`). A `DELETE` logs
`api:milestone_deleted`, `Deleted milestone "Launch"; 2 cards on this board released` ("no
cards" when the board had none). Each has no card. It goes on the milestone's board, or for a
goal across boards on each board holding one of its cards, archived ones included (none for one
with no cards); a change of board goes on the boards before and after it. On each board the
milestone is named as that board's readers knew it: by its name before the change on a board it
stays on or leaves, by its name after on a board it joins, and as `milestone #<id>` where it is
across boards, since a reader of one of its boards may not be able to open it (card 2257). A
rename on its own board reads `Updated milestone "Old name": name`. Each of those boards is sent
a live update (`{ type: 'milestone' }`), and a delete every board of a card it released, so an
open board drops the goal's chip. No webhook is sent.

A `PATCH` whose every field is as stored writes nothing, logs nothing and sends no live update,
and answers `200` with the milestone as it is; `{}` is still `400` `No valid fields to update`,
and a request that would be refused is refused first.

#### Attach and Detach Cards

```http
POST   /api/v1/milestones/{milestoneId}/cards    { "cardId": 1559 }
DELETE /api/v1/milestones/{milestoneId}/cards    { "cardId": 1559 }
```

A card is in at most one milestone, so attaching replaces whatever it was in before rather
than erroring. A board-scoped milestone will not take a card from another board — make the
milestone cross-board first, or move the card. An archived card is not put in one: `400`
`Card does not exist or is archived`, as the batch reports one.

Both look for the milestone in the path and check the caller first (`404`
`Milestone not found`, then `403`), then read `cardId`
(an id, `400` otherwise), then look for the card and check the caller on its board.

Taking a card out is one rule, here, with `milestoneId: null` on `PUT /cards/:cardId`, and
in the batch below: the caller needs edit access to the card's board **and** to the
milestone the card is in (`403` `No edit access to this milestone`, or
`No access to this milestone` for a goal with cards on a board the caller cannot open). So
someone who may edit a board, and neither made a cross-board goal nor is an administrator,
can no more take a card out of that goal than put one in. Putting a card in another
milestone takes it out of the one it is in, so the `POST` above, `milestoneId` on
`PUT /cards/:cardId` and the batch ask the same of that one. The
`DELETE` takes a card out only of the milestone it names: a card that is not in it is `404`
`Card is not in this milestone`. Until 2026-10-14 it took the card out of whichever
milestone it was in.

Every route that puts a card in or takes it out logs it on the card's board, with its id
(card 2289): `api:milestone_card_added`, `Added "First" to milestone "Launch"`, or
`api:milestone_card_removed`, `Removed "First" from milestone "Launch"`, the milestone named
by the rule above. A card moved from another milestone reads `… (from milestone "Pilot")`, and
no `api:milestone_card_removed` is logged for the one it left. These two, the `POST`, the
`DELETE`, `milestoneId` on `PUT /cards/:cardId` and the batch below, are the same entry. A card
put into the milestone it is already in is answered `200` as it is, with nothing written,
logged or sent, and an archived card already in it is still `400`. **Goal membership sends no
`card.updated` on any route**; read `GET /milestones/{milestoneId}` or the audit log.

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
| `progress` | `total`, `done`, `percent`, `byColumn[]`, `openSubtasks`, `totalSubtasks` (every subtask of those cards, ticked or not), `boards[]` |
| `graph` | `nodes[]`, `edges[]`, `layers[][]` (topological, left to right), `unordered[]` |
| `criticalPath` | Ordered card ids — the longest chain of **open** dependencies |
| `nextActionable` | Startable today, sorted by `downstreamCount` then priority |
| `blocked` | `{ card, blockers[] }` pairs |

**Query parameters:**

| Parameter | Description |
|-----------|-------------|
| `compact` | `true` drops `graph` (only needed for drawing) and adds `cardTitles`, a card-id → title map, and `subtaskTitles`, a subtask-id → title map, so the ids stay readable. Until 2026-10-14 both were in `cardTitles` by the bare id, and a card and a subtask with the same id took one key between them |

**Response (abridged):**
```json
{
  "milestone": { "id": 4, "name": "Azure VM migration, all environments" },
  "progress": {
    "total": 9, "done": 1, "percent": 11,
    "byColumn": [{ "columnTitle": "To Do", "count": 7 }],
    "openSubtasks": 0, "totalSubtasks": 0,
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
- **Work on a board the key's user cannot open is withheld** (since 2026-10-14): an
  external blocker on such a board, and a card of the milestone that was moved onto one,
  which keeps the milestone. Each node carries `withheld`. A withheld node keeps its id,
  `kind`, whether it is finished and its place in the plan (`external`, its layer, its
  edges, `openBlockers`, `downstreamCount`, `onCriticalPath`); its `title` reads
  `A card on a board you cannot open` (or `A subtask on a board you cannot open`),
  `boardName` `A board you cannot open`, `columnTitle` `""`, and `boardId`, `columnId`,
  `priority` and `milestoneId` are `null`, with no `parentCardId` on a withheld subtask.
  The plan itself is worked out from the real work first, so `criticalPath`, the order of
  `nextActionable` and what is blocked are the same whoever asks; only what is shown of
  each node changes. So `criticalPath` gives the id of the card a withheld subtask on the
  chain belongs to, as it does for any subtask, though the node itself has no
  `parentCardId`: that id is all that is given of the card. `progress` counts the cards on such boards in one entry of `boards`,
  `{ "id": null, "name": "A board you cannot open", "cardCount": n }`, and under `""` in
  `byColumn`. `cardTitles` and `subtaskTitles` give the replacement text. The PDF prints the same. An administrator's key is given
  everything.

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

An end is a card or a subtask, written in one of three ways: a number, which is a card id;
the text `"subtask:42"` or `"card:42"`; or an object `{ "kind": "subtask", "id": 42 }`. In a
link, `blockedType` and `blockerType` (`card` or `subtask`) may say what an id is the id of
instead.

```json
{ "chain": [1686, "subtask:42", "subtask:43", 1201] }
```

Send `links` or `chain`, not both. A `chain` needs at least two ends. The limit is 500 links
in one request.

**Response:** `201 Created`

```json
{
  "created": 4,
  "skippedAsDuplicate": 1,
  "boardsTouched": [1, 8],
  "links": [
    { "blocked": 1559, "blockedType": "card", "blocker": 1686, "blockerType": "card" }
  ]
}
```

`links` holds the links that were written, each with what its two ids are the ids of. A link
that was already recorded is counted in `skippedAsDuplicate` and is not in `links`. When
every link of the batch was already recorded the answer is still `201`, with `created` 0.

Each link written is recorded as [Add a Dependency](#add-a-dependency) records one: an
`api:dependency_added` entry on the board of the card that waits (a subtask's card), with
that card's id, `#1559 now waits on #1686`. A link skipped as already recorded writes none,
and a batch that wrote nothing tells no board. Until card 2291 a batch wrote one
`api:dependencies_bulk_added` entry with no card, `Recorded 2 dependencies across 1
board(s)`, on the first board it touched alone; that name is no longer written.

A `400` means the batch could not be read at all, and names what it could not read: both
`links` and `chain` or neither, an empty `links`, an entry of `links` that is not an object
(`links[3] must be an object`), a `chain` of fewer than two, a link with no `blocked` or no
`blocker`, an end written in none of the three ways or whose id is not a whole number of 1
or more (`links[0].blocker must be a card id, "subtask:<id>", or {kind, id}`, and so for
`chain[1]`), an object whose `kind` is not `card` or `subtask`, a `blockedType` or
`blockerType` that is not `card` or `subtask`
(`links[0].blockedType must be one of: card, subtask`), or more than 500 links. The fields
are read before any end is looked for. An end that does not exist and a board the key's
user may not edit are not a `404` or a `403` here: they are lines in the `409` described
under [Batch Semantics](#batch-semantics).

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
surprise. Moving it takes it out of that goal, so the caller needs edit access to that goal
too: a card in one they cannot change is listed under `problems`,
`No edit access to milestone #2, which holds card #1444`, and nothing is written.

The `DELETE` answers `200` with `milestoneId`, `detached`, `skippedNotInMilestone` and
`boardsTouched`. Both still answer `403` and `404` for the milestone itself, before the list
is read. The `POST` refuses a card that is archived, as the single-card `POST` above does:
`Card does not exist or is archived`. **The `DELETE` takes an archived card out** (card
2290), as the single-card `DELETE` and `milestoneId: null` on `PUT /cards/:cardId` do, with
its entry and a live update to its board: an archived card keeps its milestone and still
holds the milestone to its board, so taking it out is what the milestone's own refusal of a
change of board asks for. An archived card that is not in the milestone is skipped and
counted, as any other. In the `DELETE`'s `409` a card that does not exist is
`Card not found`, and an archived card on a board the key's user cannot edit is
`No edit access to the board holding card #<id>`, by its id and with no title. Until
2026-10-14 the `DELETE` reported an archived card as `Card does not exist or is archived`
and refused the whole batch. A milestone whose only cards were archived can now be emptied,
and the next bulk attach to it then sends the plan-created mail (below). Each
entry of `cardIds` is a whole number of 1 or more: one that is not, `null` among them, is
`400` `cardIds[2] must be an id`, where `null` was read as card 0 and reported in the
`409`. A card that is not in the milestone is skipped by the `DELETE` and counted, not a
`404` as on the single-card route, so the same list can be sent again.

Each card attached logs `api:milestone_card_added` on its board, with its id, one moved
naming the goal it left, and each card detached `api:milestone_card_removed`; a card skipped
logs nothing (card 2289). A batch of 500 writes 500 entries, and a board's Activity Log shows
its last 50, so read the audit log for a large one. No webhook is sent.

The `POST` alone sends the **plan-created mail**: when the goal held no card before and at
least one was attached, the administrators and the cards' assignees who can open the plan are
mailed "Plan created". A card put in one at a time (the single `POST`, `milestoneId` on
`PUT /cards/:cardId`, the plan page's Add cards and the card window's picker) sends none, so a
plan laid down a card at a time mails nobody. Archived cards count when it decides whether the
goal held a card, so a goal holding only archived cards does not mail; once they are taken out
with the bulk `DELETE`, the goal is empty and the next bulk attach mails.

#### Batch Semantics

These rules apply to all three endpoints and are the reason they exist.

| Rule | Why |
|------|-----|
| **Validated as a whole, then written** | If anything is wrong, *nothing* is written and every problem comes back at once. Fixing a fifty-line list one error per round trip is what makes bulk import not worth using. |
| **Written in one transaction** | The checks and the writes are one transaction. A failure part of the way through answers `500` and leaves nothing of the batch behind: no milestone is left half attached and no chain half recorded. Send the same batch again. |
| **Duplicates are skipped, not errors** | Re-running the same list is safe, so a batch can be kept in a file and replayed as the plan evolves. |
| **Cycle detection covers the batch itself** | Two links can each be fine against the stored graph and still close a loop between themselves. Proposed edges are layered on the stored graph and added one at a time, so that case is caught — a per-link check would write both and strand nodes in the milestone view. |
| **Max 500 entries per call** | |
| **Edit access on both ends** | Cross-board links are allowed; each card's board is resolved once and cached, not re-checked per link. |

**Rejection response:** `409 Conflict`, nothing written.

```json
{
  "message": "Batch rejected — nothing was written",
  "written": 0,
  "rejected": [
    {
      "link": { "blocked": 1198, "blockedType": "card", "blocker": 1201, "blockerType": "card" },
      "reason": "cycle",
      "cycle": [
        { "kind": "card", "id": 1198 },
        { "kind": "card", "id": 1559 },
        { "kind": "card", "id": 1201 }
      ],
      "message": "#1198 waiting on #1201 would create a cycle: #1198 → #1559 → #1201 → #1198"
    },
    {
      "link": { "blocked": 9999, "blockedType": "card", "blocker": 1201, "blockerType": "card" },
      "reason": "missing-blocked",
      "message": "#9999 does not exist or is archived"
    }
  ],
  "forbidden": [],
  "wouldSkipAsDuplicate": 2,
  "wouldCreate": 7
}
```

The text is in `message`, as in every failure, and `written` is always 0. `rejected` lists
the links that are wrong in themselves and `forbidden` the links that are right in themselves
and have an end on a board the key's user cannot edit, each with the `link` and a `message`.

| `reason` | Meaning |
|----------|---------|
| `self` | An end waits on itself |
| `missing-blocked`, `missing-blocker` | That end does not exist or is archived |
| `cycle` | The link would close a loop, with the stored links or with earlier links of the batch. `cycle` holds the chain, each entry a `kind` and an `id` |
| `duplicate-in-batch` | The batch has the same link twice |

The two milestone endpoints answer a `409` of their own shape, with `problems` in place of
`rejected`. Each problem carries a `cardId` and a `reason` in words — including the
board-scope rule, whose reason names the two ways out (make the milestone cross-board, or
move the card).

```json
{
  "message": "Batch rejected — nothing was written",
  "attached": 0,
  "problems": [
    { "cardId": 9999, "reason": "Card does not exist or is archived" }
  ],
  "wouldAttach": 2,
  "wouldSkipAlreadyIn": 1
}
```

The detach has `detached` (always 0) and `problems`, and no `would...` counts. The token
batch has a fourth shape: see [Token Cost](#token-cost).

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

### Token Cost

What work cost in tokens, recorded entry by entry on a card or on a subtask and added up on
the card. An entry on a subtask counts towards its card.

| Route | Does | Answers |
|-------|------|---------|
| `GET /api/v1/cards/{cardId}/tokens` | Reads the card's totals and every entry behind them. Needs view access | `200` |
| `POST /api/v1/cards/{cardId}/tokens` | Adds one entry on the card. Needs edit access | `201` |
| `POST /api/v1/subtasks/{subtaskId}/tokens` | Adds one entry on the subtask. Needs edit access | `201` |
| `POST /api/v1/tokens/bulk` | Adds up to 200 entries, all or none | `201`, or `409` |
| `DELETE /api/v1/tokens/{entryId}` | Removes one entry outright. Needs edit access | `200` |

#### Add an Entry

```http
POST /api/v1/cards/{cardId}/tokens
POST /api/v1/subtasks/{subtaskId}/tokens
```

**Request Body:**

| Field | Required | Rule |
|-------|----------|------|
| `tokens` | ✅ | A whole number, sent as a number and not as text, and not 0. Negative corrects an earlier entry. 10,000,000,000 at most either way |
| `model` | | The model's id, 80 characters at most. Without it the entry cannot be priced |
| `note` | | 500 characters at most |
| `apiCalls` | | A whole number, 0 or more. When it is more than 0, `tokens` may be no more than 1,200,000 for each call |
| `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWrite5mTokens`, `cacheWrite1hTokens` | | The breakdown: what the tokens were. Each a whole number, 0 or more |

```json
{
  "tokens": 52900,
  "model": "claude-opus-5",
  "note": "applied the fix",
  "apiCalls": 14,
  "inputTokens": 1200,
  "outputTokens": 900,
  "cacheReadTokens": 48000,
  "cacheWrite5mTokens": 2800,
  "cacheWrite1hTokens": 0
}
```

- **Entries add. Nothing replaces.** Each request adds an entry, so the same request sent
  twice adds the tokens twice. To correct an over-report send a negative `tokens`, which
  leaves the first entry to be seen; when the entries it corrects were measured, send the
  breakdown of what is taken back.
- **A correction takes back no more than was recorded** (card 2220), on the same card (its
  own entries, not its subtasks') or the same subtask, for the same `model`. One with no
  breakdown takes back at most the tokens recorded without one: `400` `A correction without
  a breakdown can take back at most 10,000 tokens of claude-opus-5-5 on this card, which is
  what was recorded there without a breakdown. The rest were measured: send the breakdown of
  what is taken back, as positive numbers that add up to it, each no more than is recorded
  (inputTokens 5,000, outputTokens 5,000, cacheReadTokens 990,000).` One with a breakdown
  takes back no part beyond what is recorded of it: `400` `cacheReadTokens of this
  correction is 600,000, more than the 500,000 recorded for claude-opus-5-5 on this
  subtask.` Nothing is written. The message adds, for a correction sent to a card whose
  subtasks hold entries, `Only the card's own entries count here: an entry on one of its
  subtasks is corrected on that subtask.`; and for one sent with no `model` to a card or
  subtask whose entries name one, `This card has entries of claude-opus-5-5: send the model
  of the entries it corrects.` A correction
  sent as a bare total was priced at full input rates, and measured work is mostly cache
  reads at a tenth of that or less, so it took the card's cost below zero.
- **The breakdown is all or nothing.** If any of its five fields is sent, `inputTokens` and
  `outputTokens` must both be sent, and the fields sent must add up to `tokens`. A cache
  field left out counts as 0. For a negative entry they are sent as positive numbers that
  add up to its size.
- **The body is checked before the card or subtask is looked for.** A body at fault sent to
  a card that does not exist is answered `400`, not `404`.
- **An archived card can still be reported on.**

**Response from the card route:** `201 Created`, with the new entry's id and the card's
totals.
```json
{
  "entryId": 311,
  "cardId": 1713,
  "recorded": true,
  "total": 52900,
  "direct": 52900,
  "fromSubtasks": 0,
  "entries": 1,
  "byModel": [{ "model": "claude-opus-5", "tokens": 52900 }],
  "costUsd": 0.07,
  "costExact": true,
  "unpricedTokens": 0,
  "apiCalls": 14
}
```

**Response from the subtask route:** `201 Created`, with the total of the subtask's
**card**, not of the subtask.
```json
{ "entryId": 312, "subtaskId": 3471, "cardId": 1713, "cardTotal": 62000, "recorded": true, "entries": 2 }
```

#### Get What a Card Has Cost

```http
GET /api/v1/cards/{cardId}/tokens
```

Answers the same totals as the card route above, with `entryList`: every entry, newest
first, each with `id`, `cardId`, `subtaskId`, `subtaskTitle`, `tokens`, `model`, the five
breakdown fields, `apiCalls`, `note` and `createdAt`. An entry is on a card or on a subtask,
never both, and the one it is not on is `null`.

| Field | Meaning |
|-------|---------|
| `recorded` | `true` when there is at least one entry |
| `total` | Sum of every entry, on the card and on its subtasks |
| `direct`, `fromSubtasks` | Of which on the card itself, and on its subtasks |
| `entries` | How many entries make up the total |
| `byModel` | The total by model, largest first. Entries that named no model are under `unspecified` |
| `costUsd` | Estimated cost in US dollars. `null` when no entry named a model DumpFire has a price for |
| `costExact` | `true` only when every priced entry was costed from its own breakdown |
| `unpricedTokens` | Tokens left out of the cost: recorded with no model, or with a model DumpFire has no price for |
| `apiCalls` | Calls behind the total. `null` unless every entry said how many |

**How a cost is priced.** `costUsd` is worked out every time it is read, from each entry's tokens and model, at Anthropic's list rates; no price is stored, so a change of rate re-prices past entries. A model is priced when its id is one in DumpFire's table (the Claude 5.5, 5.1, 5, 4.x and 3.5 models, rates verified 2026-10-14), or one of them followed by a date (eight digits) or a tag (`claude-haiku-4-5-20251001`, `claude-opus-4-6[1m]`). An id that is one of them followed by a version DumpFire does not list (`claude-opus-5-6`, `claude-opus-50`) is not priced as the shorter id: it is unpriced, and its tokens are counted in `unpricedTokens`, as an entry with no model is. `claude-haiku-5-5` is billed by the size of each call's prompt, and DumpFire prices every Haiku 5.5 token at its rate for prompts of 100K tokens or fewer ($0.10 / $0.50 per million): an entry does not say which of its calls were longer. Opus 5.5's fast mode is priced at the standard rate.

> **`recorded: false` with `entries: 0` means not recorded. It does not mean a cost of zero.** Show it as unknown.

#### Delete an Entry

```http
DELETE /api/v1/tokens/{entryId}
```

Removes one entry, as if it had never been made, and answers `200` with `deleted` (the
entry's id), `cardId` and the totals of the card it counted towards. For an over-report a
negative entry is the better correction, because it leaves the first to be seen. An entry
is refused only when removing it would take what is recorded of its model on its card or
subtask below zero, as removing it before the negative entries that correct it would:
`400` `Removing entry #312 would leave the claude-opus-5-5 entries on this card below zero:
remove the negative entries that correct it first.` (card 2220).

#### Add Many Entries

```http
POST /api/v1/tokens/bulk
```

```json
{ "entries": [
    { "cardId": 1713, "tokens": 18400, "model": "claude-opus-5", "note": "planning" },
    { "subtaskId": 3471, "tokens": 9100, "model": "claude-sonnet-5" }
] }
```

Each entry names exactly one of `cardId` and `subtaskId`, and is otherwise the body of a
single entry. 200 entries at most.

**Response:** `201 Created`
```json
{ "written": 2, "boardsTouched": [1], "cardTotals": [{ "cardId": 1713, "total": 27500, "entries": 2 }] }
```

The batch is all or nothing. Every entry is checked before any is written, and if one is
refused the answer is `409` and none is written:

```json
{
  "message": "Batch rejected — nothing was written",
  "written": 0,
  "problems": [{ "index": 1, "reason": "Subtask #3471 does not exist" }]
}
```

`index` is the entry's place in `entries`, from 0. A card or subtask that does not exist,
and one on a board the key's user cannot edit, are lines in the `409`: this route answers no
`404` and no `403`. A correction is held to what is recorded and to the entries before it in
the same batch, so `+10000` then `-10000` on a new card is written, and an over-correction is
a line in the `409` (card 2220). A `400` means `entries` is not an array, is empty or has more than 200
entries, or holds an entry that is not an object (`entries[1] must be an object`, which was
a `500`).

**Not safe to send twice.** The dependency and milestone batches skip what is already there.
This one does not: entries add, so the same batch sent again adds the tokens again.

---

### Burndown

```http
GET /api/v1/burndown
```

How much work was open on each day, and where it is heading — for a board,
several boards, a board category, a milestone, or everything you can see,
narrowed by card category, label, assignee or priority. The series is rebuilt
from each card's own created, completed and archived dates, so any filter works
over any window (up to 730 days). Days are UTC.

**Query parameters:**

| Parameter | Description |
|-----------|-------------|
| `boardIds` | Comma-separated board ids. View access to each is required. |
| `boardCategoryId` | Every board in this board category that you can see. Not with `boardIds`. A board category that holds boards, none of which you can open, is `403` `No access to board category <id>` (until 2026-10-14 it was charted empty under its name). |
| `milestoneId` | The milestone's cards, wherever they live. Combine with `boardIds` to narrow. |
| `categoryIds` | Card category ids; `none` = uncategorised. |
| `labelIds` | A card matches if it carries any of these labels. |
| `assigneeIds` | User ids; `me` = you, `none` = unassigned. |
| `priorities` | Any of `critical`, `high`, `medium`, `low`. |
| `from`, `to` | UTC days. `to` defaults to today; later dates are clamped. |
| `days` | 1–730, ending at `to`. Default 30, or since creation for a milestone. Not with `from`. |
| `target` | `YYYY-MM-DD` draws an ideal line to zero; defaults to the milestone's target date; `none` hides it. |
| `groupBy` | `board`, `category`, `label`, `assignee` or `priority` — adds per-group series. |
| `options` | `true` adds the filter values present in scope, with counts. |

**Response (abridged):**
```json
{
  "scope": { "kind": "milestone", "label": "Azure VM migration, all environments" },
  "range": { "from": "2026-09-11", "to": "2026-09-30", "days": 20 },
  "series": [
    { "date": "2026-09-11", "scope": 32, "done": 5, "remaining": 27, "added": 32, "completed": 5, "removed": 0 }
  ],
  "summary": { "remainingStart": 0, "remainingNow": 27, "added": 32, "completed": 5, "removed": 0 },
  "forecast": {
    "status": "not-converging", "basisDays": 19, "completionRate": 0, "scopeRate": 0,
    "projectedDate": null, "projectedDateNoNewScope": null, "spansBoards": false
  },
  "delivery": {
    "status": "no-pace", "remaining": 27, "basisDays": 19, "throughputPerWeek": 0,
    "trials": 0, "p50": null, "p85": null, "p95": null, "chanceByTarget": 0
  },
  "target": { "date": "2026-12-01", "source": "milestone", "onTrack": false, "daysLate": null },
  "groups": [],
  "meta": {
    "basis": "card-timestamps", "timezone": "UTC", "cardCount": 32, "inferredInWindow": 5,
    "notes": [
      "5 cards sit in Complete with no completion date; the date of their last update is used instead. All of them fall in this period, so every completion counted here rests on an estimated date.",
      "Milestone membership is as it stands today, applied to the whole window."
    ]
  }
}
```

**How to read it:**

- **`forecast.status`** is `converging` (with `projectedDate`), `not-converging`
  (work is arriving as fast as it is finished, or nothing has been finished),
  `done`, or `insufficient-data` (under a week of history). The pace is the
  trailing 28 days; a scope younger than that is measured from the day after it
  began, so a milestone carded in one burst is not read as scope growth.
  `projectedDateNoNewScope` is the date if nothing more were added.
- **`forecast.spansBoards`** is `true` when the cards that pass the filters sit
  on more than one board, the same test `delivery` splits by board on; each row
  of `groups` is judged on its own cards. The rates still describe the pile as a
  whole, but the two dates are then pooled: they treat a card finished on one
  board as clearing another's backlog, so they are not when the work finishes.
  Read `delivery` for that. The web application shows no forecast date for such
  a scope. The field is new in 1.2.0; no other value changed with it.
- **`delivery`** answers "how long will the work open now take to finish?" as a
  range. It is a Monte Carlo simulation: 2,000 trials each replay randomly chosen
  days of the basis (their real completion counts) until the open work runs out.
  `p50` is the likely date, `p85` a date to commit to, and `p95` the cautious one.
  With a target, `chanceByTarget` is the share of trials finished by then. It
  assumes nothing new is added, and `arrivalPerWeek` shows how much that
  assumption carries. The generator is seeded from the inputs, so the same data
  always gives the same answer. Status is `estimated`, `done`, `no-pace`,
  `beyond-horizon` or `insufficient-data`.
- **Several boards** (`delivery.method: "slowest-board"`): each board is simulated
  at its own pace and the dates are when the **slowest** board is done, because
  the people finishing one board's cards are not clearing another's. `bottleneck`
  names that board, `parts` lists every board with open work (slowest first;
  boards with no recent pace are listed last and left out of the dates), and
  `pooled` keeps the one-pile figure "as if effort could move freely between
  boards". A single board uses `method: "pooled"`. `basisFinished` is how many
  finished cards the dates rest on; under 5, treat them as a rough guide.
  Example with a pace:
  ```json
  { "status": "estimated", "method": "pooled", "basisFinished": 5,
    "remaining": 32, "throughputPerWeek": 1.25, "arrivalPerWeek": 8.25,
    "trials": 2000, "p50": { "days": 187, "date": "2027-04-05" },
    "p85": { "days": 265, "date": "2027-06-22" }, "p95": { "days": 324, "date": "2027-08-20" },
    "chanceByTarget": 0.785 }
  ```
- **`target.onTrack`** compares the net forecast with the target date; `daysLate`
  is negative when early. When `forecast.spansBoards` is `true` that date is
  pooled, so both compare a date that is not when the work finishes. The page's
  verdict leads with `delivery.chanceByTarget` instead (85%+ on track, 50–85%
  tight, under 50% behind); with no chance to quote, a single board falls back to
  the net date, and several boards to `delivery` (slowest board over two years
  is behind, no recent pace on any board with open work is at risk).
- **`groups`** carry `remaining[]` and `scope[]` aligned to `series`, plus their
  own `forecast` and `delivery` (500 trials). A card with several labels or
  assignees counts in each of their groups.
- **`meta.inferredInWindow`** counts the cards with no completion stamp whose
  stand-in date falls inside the window: those are the ones that can inflate the
  completed figure.
- **`meta.notes`** lists only the caveats that bear on this result — read it
  before quoting a figure.

**Errors:** every invalid parameter is a `400` naming it; `403` for a board,
milestone or board category you cannot see; `404` for one that does not exist.

### Webhooks

A webhook sends each event of its board that it asks for (`card.created`, `card.updated`,
`card.moved`, `card.completed`, `card.deleted`, `comment.added`) to its `url` as a `POST`, after
the change is committed, signed with its `secret`. What is sent, and how a receiver checks the
signature: [Notifications & Email](docs/notifications-email.md#webhooks).

`card.moved` is every column change but a completion: a move within the board (`data.action`
`card_moved`), a card moved out of a Complete column (`card_reopened`), and a move to another
board, sent to the board it left (`card_moved_away`) and to the board it joined
(`card_moved_in`), each with its own board's entry, which names neither board (card 2278). A move
into a Complete column sends `card.completed` instead; one into another board's Complete column
sends the joined board both, the arrival and the completion. Ask for both events to hear every
column change.

Goal membership sends no `card.updated` on any route; read `GET /milestones/{milestoneId}` or
the audit log. A card put in a milestone or taken out, by any route, `milestoneId` on
`PUT /cards/:cardId` included since 2026-10-14, and a milestone changed or deleted, send no
webhook (card 2289; a `milestone.*` event is card 2343).

| Route | Does | Needs | Answers |
|-------|------|-------|---------|
| `GET /api/v1/boards/{boardId}/webhooks` | Lists the board's webhooks | View access | `200` |
| `POST /api/v1/boards/{boardId}/webhooks` | Creates one: `url` (required), `secret`, `events` | Edit access | `201`, `400`, `409` |
| `GET /api/v1/webhooks/{webhookId}` | Reads one | View access | `200` |
| `PUT /api/v1/webhooks/{webhookId}` | Changes `url`, `secret`, `events` or `active` | Edit access; the board's owner or an administrator for `url`, `secret`, or switching it on | `200`, `400`, `403`, `404` |
| `DELETE /api/v1/webhooks/{webhookId}` | Deletes one | Edit access | `200` |

- **The address and the secret are given only to the board's owner and an administrator**,
  and in the answer to the `POST` that made the webhook. Anyone else is given the webhook
  without `url` and `secret`, with `hasSecret` saying whether a secret is set.
- **What the last delivery came to** (card 2178) is `lastDelivery`, given with the address: to
  the board's owner and an administrator, `null` in the answer to the `POST`, and to nobody
  else. `outcome` is `delivered`, `answered`, `no-answer` or `not-sent`, with the receiver's
  `status` (or `null`) and a `reason` in fixed words, never the address. It is kept in the
  server's memory: `null` before the first delivery since the server last started (a restart,
  a deploy included, forgets every result), and after the `url` changes until the next
  delivery or until the address is changed back. It is the latest attempt only, not a
  history: an earlier failure followed by a success is not shown; the system log keeps each.
  **Read through the API only**: no page shows webhooks and nothing tells anyone a delivery
  failed, so poll `GET /api/v1/webhooks/{webhookId}` or the board's list. Every outcome and
  reason, with what to do about each: [Last Delivery](docs/notifications-email.md#last-delivery).
- **A webhook is sent only while the account that set it up can open the board** (card 2325):
  the account that created it, or last set its `url` or `secret`, or switched it on, asked at
  each event with its role as it is then. One whose setter was taken off the board, out of the
  team it is shared with, or lost it when it was made private, or was an administrator made an
  ordinary user, is held: nothing is sent and `active` is left as it is. **A webhook nobody is
  recorded as having set up (made before setters were recorded on 2026-10-18/19, or brought
  back by restoring an older backup) is held from the deploy on.** `pausedBecause`, given with
  the address (and `null` in the answer to the `POST`), is `null` unless the webhook is on and
  held, then one of two sentences, word for word: "The account that set this up can no longer
  open this board, so nothing is sent. The address was chosen by that account: delete the
  webhook unless you recognise it; to keep it, switch it off and on, which makes you its
  setter, and set a new secret and update the receiver." or "Nobody is recorded as having set
  this up. Delete it unless you recognise the address; to keep it, switch it off and on, which
  makes you its setter, and set a new secret." It is worked out each time, so it is there after
  a restart when `lastDelivery` is `null`. A held webhook is sent again when its setter can open
  the board again. **Taking one over**: the board's owner or an administrator sends `{"active":
  false}`, then `{"active": true, "secret": "<new>"}`, and updates the receiver with the new
  secret; `{"active": true}` for one already on takes nothing over. See
  [When Nobody Who Can Open the Board Set It Up](docs/notifications-email.md#when-nobody-who-can-open-the-board-set-it-up).
- **Only the board's owner or an administrator changes the address or the secret, or switches a
  webhook on.** An editor who sends `url` or `secret` at all, whatever the value, is `403`
  `Only the board's owner or an administrator can change a webhook's address or secret. Ask the board's owner.`, and one
  who sends `"active": true` for a webhook that is off `403` `Only the board's owner or an
  administrator can switch a webhook on. Ask the board's owner.`. An editor changes `events`, switches a webhook off, and
  deletes one. **Send only the fields that change**: the answer of the `POST` carries `url` and
  `secret`, and sent back whole by an editor it is refused.
- **Where a webhook may send.** Not inside the network: an address that is loopback, private,
  shared, link-local (the cloud metadata service among them), reserved, documentation or
  multicast, in IPv4 or IPv6, and the names `localhost`, `*.localhost`, a name with no dot,
  `*.local`, `*.internal` and `*.home.arpa`, are `400` `Webhook url points inside the network:
  <why>` when the webhook is created or its `url` changed; an address with a user name or
  password is `400` `Webhook url must not carry a user name or password`. A name is judged again
  at each delivery by every address it resolves to, and a delivery to one that resolves inside is
  not made. Redirects are not followed. The server's operator may let named receivers inside the
  network be sent to (`WEBHOOK_ALLOW_INSIDE`). The stored `url` sent back unchanged is accepted.
- **At most 10 webhooks a board**, switched-off ones counted: the 11th `POST` is `409` `This board
  has 10 webhooks, and a board may have at most 10: delete 1 before adding another.`, after every
  other check. Deleting one makes room.
- **A key ended while the request is arriving.** A `POST` or a `PUT` whose key a password reset
  ends while its body is still arriving is `401` `Invalid or expired API key`, with nothing
  written: the key is asked again in the transaction that writes.
- **A webhook switched off by a password reset** (the account that set its address or secret, or switched it on, was taken back) is switched on again with `PUT /api/v1/webhooks/{webhookId}` and `{"active": true}`,
  by the board's owner or an administrator. An editor is refused, for a webhook they set up themselves too: they ask the owner, or delete it and
  create it again. Whoever switches one on becomes its setter, so their own reset switches it off again.

```bash
curl -X PUT -H "Authorization: Bearer YOUR_KEY" -H "Content-Type: application/json" \
  -d '{"events": ["card.moved", "card.completed"]}' \
  https://dumpfire.example.com/api/v1/webhooks/7
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
