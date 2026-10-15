---
title: "External API Reference"
category: Integration
version: 1.45
status: As-Built
date: 2026-10-15
tags:
  - api
  - rest
  - integration
  - developer
  - automation
  - reference
  - deletes
  - retries
  - errors
  - openapi
  - dependencies
  - tokens
description: "REST API reference for DumpFire's external v1 API: authentication, how every failure is answered, what a failed write means, what each delete removes, the main endpoints, and examples"
---

# External API Reference

DumpFire exposes a RESTful API at `/api/v1/*` for automation, integrations, and external tooling. All data is JSON.

This reference does not list every route. The complete list, with every field, status and
body, is the OpenAPI document: read it as a page at `/docs`, or as JSON at
`/api/v1/openapi.json`.

## Authentication

All requests require a **Bearer token** in the `Authorization` header:

```
Authorization: Bearer df_your_api_key_here
```

The one exception is `GET /api/v1/openapi.json`, which needs no key and is not counted
against the rate limit.

### Generating a Key

1. Log in → **My Account** (⚙️) → **API Keys** section
2. Enter a name and your current password → **Generate Key**
3. Copy the key immediately — it is shown **once only**

Keys inherit the permissions of the user who created them. A key is made only there, by the
account's holder, with the password; the API has no route that makes one, and an account
has at most ten. A wrong password is refused with `Password is incorrect`, and no key is
made. After ten wrong passwords in 15 minutes from one signed-in browser, counted with the
Account page's email and password forms, that browser is refused for up to 15 minutes, the
right password included: `Too many wrong passwords. Try again in N minute(s).`

### When a Key Ends

A key ends when it is revoked on My Account, or when the account's password is set in a way
that ends keys:

| How the password is set | The account's keys |
|-------------------------|--------------------|
| The holder changes it on My Account | Kept, unless they tick **End my API keys too** (not ticked by default) |
| The holder changes it on their own row of the admin page | Kept |
| An administrator resets it | All end |
| An invite link is used to set it | All end |

A key that has ended is answered `401` `{ "message": "Invalid or expired API key" }`, as a
revoked one is, and whatever uses it stops until it is given a new key. Before an
administrator resets the password of an account a script runs on, the reset dialog says how
many keys it has. See
[What Setting a Password Ends](authentication-security.md#what-setting-a-password-ends).

## Rate Limits

| Limit | Value |
|-------|-------|
| Requests per minute | **60** per API key |
| Requests per minute with no key DumpFire accepts | **60** per address the requests come from |
| Exceeded response | `429 Too Many Requests` |
| Retry header | `Retry-After: <seconds>` |
| Body | `{ "message": "Rate limit exceeded", "retryAfterSecs": 42 }` |

`retryAfterSecs` and `Retry-After` carry the same number. The minute starts with the first
request it counts, and a request that is turned away has written nothing.

- **A key's requests are counted once the key is checked**, against the key itself. Nothing
  but the key reaches its count: a request with a wrong key, even one that begins as a real
  key does, never spends a real key's allowance. A key that is over its limit is not
  recorded as used.
- **A request with no key DumpFire accepts**, a missing `Authorization` header included, is
  counted against the address it came from, in a count of its own: sixty a minute are
  answered `401`, and then `429`. An IPv6 address is counted by its /64 network, an IPv4
  address written as IPv6 (`::ffff:198.51.100.7`) as the IPv4 address, and a port is taken
  off, so every address of one IPv6 network shares the one count. Where the server is behind a proxy that has not been set
  up to say who its callers are, every caller has the proxy's address, and a mistyped key
  may be answered `429` while somebody else is guessing. A valid key is never held up by it.
  See [The Caller's Address Behind a Proxy](deployment.md#the-callers-address-behind-a-proxy).

## Error Format

Every failure DumpFire answers under `/api/v1/` is JSON with one key, `message`, which says
why. That holds whatever `Accept` header the request sent, and whether a handler refused the
request or it never reached one:

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

The `message` of every rejected batch is `Batch rejected — nothing was written`. A dependency
that is already recorded is a `409` too, with `message` alone: a cycle is the `409` that has
`cycle` in it.

| Code | Meaning |
|------|---------|
| `200` | Success |
| `201` | Created |
| `400` | Bad request: a field is missing, is of the wrong type or holds what it may not (see [What a Field May Hold](#what-a-field-may-hold)), an id in the path or the query string is not a whole number of 1 or more, or the body is missing, is not valid JSON or is not a JSON object |
| `401` | No `Authorization: Bearer <key>` header, or a key that is unknown or expired |
| `403` | The key's user may not do this |
| `404` | The resource in the path does not exist, whoever asks; an id in the body names nothing (a category, a user, a milestone); something to be removed is not there (an assignee, a label on a card, a card in the milestone named); or the path is no route: `{ "message": "Not found" }` |
| `405` | The route does not have this method: `{ "message": "PATCH method not allowed" }`. The `Allow` header names the methods it has |
| `409` | Conflict: a card moved to a Complete column while it has open subtasks or sub-boards, a card moved onto a board beneath it, at any depth, a sub-board that would be more than 20 levels deep (made under a card, or carried by a card moved to another board), a dependency that already exists or would close a loop, or a rejected batch |
| `413` | The request body is over the size limit, 512 KB: `{ "message", "limitBytes" }`. See [The Request Body](#the-request-body) |
| `429` | Rate limited: 60 requests in the minute with one key, or 60 from one address with no key DumpFire accepts |
| `500` | DumpFire failed: `{ "message": "Internal Error" }`. Nothing of the fault is in the answer; it is written to DumpFire's system log, with the route and the key's user |

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

The body is judged by what it holds, not by the `Content-Type` it is sent with. Send
`Content-Type: application/json` all the same: see the first of the
[exceptions](#answers-that-are-not-json). A body sent with no `Content-Type` at all does
not reach the handler, and is answered as a body that is missing.

A body does not have to say how long it is. One sent in chunks, with no `Content-Length`, is
read and held to the same limit as it is read. Every ordinary client sends the length all
the same (`curl`, PowerShell's `Invoke-RestMethod` and a browser's `fetch` with a string or a
form all do), and a body that says it is too large is refused before any of it is read.

The limit is 512 KB here whatever `BODY_SIZE_LIMIT` the deployment sets: that variable is
the most the server accepts on any route, and it is raised for the web application's
attachment upload and its backup import, which are not part of this API. See
[Upload Size Limits](deployment.md#upload-size-limits).

### What a Field May Hold

Every operation reads each field it uses by the field's type and range, and refuses one it
cannot use with `400` and a `message` that names the field. A field it does not use is left
alone. Nothing is turned into another type: a number is never stored as text, text is never
a boolean, and `"false"` is not false. The one exception is a number written as text that is
exactly a number (`"5"`, `"-2.5"`, not `"1e3"`), which is read as that number wherever a
number or an id is read.

| A field | Holds | Refused with, for example |
|---------|-------|---------------------------|
| A name: of a board, a column, a label, a category, a board category or a milestone | Text, trimmed, of 1 to 200 characters | `name must be text`, `name is required`, `name cannot be empty`, `Board name too long (max 200 chars)` |
| A card's or a subtask's `title` | Text, trimmed, of 1 to 500 characters | `title must be text`, `title is required`, `title cannot be empty`, `Title too long (max 500 chars)` |
| `description`, `onHoldNote` | Text of at most 50,000 characters | `description must be text`, `Description too long (max 50000 chars)` |
| A comment's `content` | Text, trimmed, of 1 to 50,000 characters | `content must be text`, `Comment cannot be empty` |
| `businessValue` | Text of at most 10,000 characters | `businessValue must be at most 10000 characters` |
| `emoji` | Text of 1 to 32 characters | `emoji cannot be empty` |
| `priority` | `low`, `medium`, `high` or `critical`, in any case. It is stored in lower case | `priority must be one of: low, medium, high, critical` |
| `dueDate`, `targetDate` | A day of the calendar written `YYYY-MM-DD`: not `2026-02-30`, not a timestamp. `null` or `''` clears it | `dueDate must be a date written YYYY-MM-DD` |
| `colorTag` | A colour written `#rrggbb`, or `''` for none | `colorTag must be a colour written #rrggbb, or empty` |
| `color` | A colour written `#rrggbb`: `#` and six hex digits, in either case, trimmed, on a column, a label, a category and a board category, created or changed. `red`, `#fff` and `''` are refused | `color must be a colour written #rrggbb` |
| `position` | A finite number | `position must be a number` |
| `pinned`, a subtask's `completed`, `isPublic`, `showAddCard`, a webhook's `active` | `true` or `false` | `pinned must be true or false` |
| An id in the body: `columnId`, `categoryId`, `userId`, `cardId`, `milestoneId`, `parentCardId`, `labelId`, a milestone's `boardId` | A whole number of 1 or more, or one written as text (`"7"`, `"1.0"`) | `columnId must be an id` |
| `coverUrl` | A colour written `#rrggbb`, or one of the eight preset gradients exactly as [`PUT /api/v1/cards/:cardId`](#put-apiv1cardscardid) lists them, or `null`; `''` is read as `null` | `coverUrl must be a colour written #rrggbb, one of the preset gradients, or null` |
| A milestone's `status` | `open` or `closed` | `status must be open or closed` |
| `archivedAt` on `PUT /cards/:cardId` | `null`, which restores the card, and nothing else | `archivedAt may only be null, which restores the card. Archive a card with DELETE /cards/{cardId}` |
| A webhook's `url`, `secret`, `events` | An `http` or `https` address of at most 2,048 characters, trimmed; text of at most 256; a list of the six event names, each trimmed, where `[]` is every event | `url must be an http or https address`, `events must be a list` |
| The reporting fields (`summary`, `theme`, `customerImpact`, `closeReason`, `releaseState`) | Each in its own vocabulary, as before, or `null` to clear it | `theme must be one of: ...` |

`null` clears a field only where the field can be empty: a due or target date, a category,
the cover, a milestone, a milestone's board, a parent card, the reporting fields. Anywhere
else `null` is a value of the wrong type, and a `400`.

**A value the row already holds, sent back unchanged, is accepted as it is**, whatever these
rules say of it. "Unchanged" is the same JSON type and value as the row is read. So a card
stored before these rules with a priority they do not allow, or with a due date that is not
a date, can still be saved by a client that sends its stored fields back with the one it
changed. Any other value of that field is held to the rules. A create is held to them
always, even one that copies another card's fields.

**The order a request is refused in.** One request is answered for the first thing wrong
with it:

```mermaid
flowchart TD
    Req["A request a handler reads"] --> Body{"The body a JSON object,<br/>and every id in the path<br/>a whole number of 1 or more?"}
    Body -->|"No"| E400a["400: the body's message,<br/>or Invalid card ID"]
    Body -->|"Yes"| Row{"What the path names<br/>is there?"}
    Row -->|"No"| E404a["404, to everyone"]
    Row -->|"Yes"| Who{"The caller may do this?"}
    Who -->|"No"| E403["403"]
    Who -->|"Yes"| Fields{"Every field holds<br/>what it may?"}
    Fields -->|"No"| E400b["400 naming the field"]
    Fields -->|"Yes"| Named{"What a field names<br/>is there?"}
    Named -->|"No"| E404b["404: Category not found on this board,<br/>User not found, ..."]
    Named -->|"Yes"| Write["Written, in one transaction<br/>with the checks"]
```

So a caller who would be refused is answered `404` or `403` whatever the body holds. An
operation with nothing in its path to look for (`POST /boards`, `POST /board-categories`,
`POST /milestones` with no `boardId`) reads its fields first; `POST /milestones` with a
`boardId` looks for that board, and checks the caller, before it reads the rest. A card's
`columnId` on `POST /boards/:boardId/cards` is looked for with the fields: a column that is
not there, like one of another board, is `400` `Column does not belong to this board`, not
`404`. The token
routes and the three batches check their fields before they look for what the entries name:
see [Token Cost](#token-cost) and [`POST /api/v1/dependencies/bulk`](#post-apiv1dependenciesbulk).

### How a Request Is Answered

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

The key is checked before the path is looked at, so without a key every path under
`/api/v1/` answers `401`, a path that is no route included, or `429` once the address has
sent sixty such requests in the minute.

### Answers That Are Not JSON

Three answers are not JSON. Each is made by SvelteKit before DumpFire's gate is given the
request, so the gate cannot make it JSON:

| Request | Answer | Send instead |
|---------|--------|--------------|
| A `POST`, `PUT`, `PATCH` or `DELETE` whose `Content-Type` is that of a form (`application/x-www-form-urlencoded`, `multipart/form-data`) or `text/plain`, with no `Origin` header that matches the server. Only a deployed server makes this check; a development server does not. `curl -d` with no `Content-Type` header sends exactly this | `403` in plain text. It is JSON, `{ "message": "Cross-site POST form submissions are forbidden" }`, only when the request's `Accept` header is exactly `application/json` | `Content-Type: application/json` |
| A trailing slash on a route's path | `308` to the same path without it | The path without the slash |
| A URL that is not validly encoded | `400` in plain text | A valid URL |

`/api/v1` with nothing after it is not under `/api/v1/`. DumpFire's gate takes it for a path
of the web application's own, which a key does not open: it is answered `401`
`{ "message": "Not authenticated" }`, or, to a browser, with a redirect to the login page.
Send `/api/v1/` and a route.

### Headers on Every Answer

Every answer DumpFire's gate gives carries `X-Content-Type-Options: nosniff`,
`X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`,
`Permissions-Policy: camera=(), microphone=(), geolocation=()` and
`X-XSS-Protection: 0`, its own `401`, `413` and `429` included, unless the handler set the
header itself. The last switches off the filter old browsers ran over a page, which could
itself be used to make a page leak; current browsers have dropped it. Until 2026-10-14 an
answer under `/api/v1/` carried `nosniff` alone, and the `401` and `429` none. The three answers above are made before the gate, and carry none.
No answer of the API carries a `Content-Security-Policy`: the web application's pages carry
one, and an attachment keeps its own `sandbox`.
See [Security Headers](authentication-security.md#security-headers).

A `502`, `503` or `504` is not DumpFire's either: see [Writes and Failures](#writes-and-failures).

### Changes on 2026-10-14

The OpenAPI document's version went from `1.1.0` to `1.2.0` with these. No operation is
new; these answers and fields are:

- **A `413` carries `limitBytes`**, the limit as a number of bytes, beside a `message` that
  says the limit. It was `{ "message": "Payload Too Large" }` alone, which it still is for a
  body that runs past the `Content-Length` it declared.
- **A `413` can come before the key is looked at.** A body that declares more than 512 KB is
  refused before anything else, so a request with no key, or a wrong one, is answered `413`
  where it was `401`.
- **A request with no key DumpFire accepts can be answered `429`.** It is counted against its
  address, 60 a minute, and the 61st is `429` with `retryAfterSecs` and `Retry-After` where
  it was `401`.
- **A body sent in chunks, with no `Content-Length`, is held to the limit as it is read**, and
  answered `413` with `limitBytes` once it passes it. A deployed server read such a body to
  its end, however large.
- **The rate limit is counted after the key is checked**, against the key itself. It was
  counted first, against the first 11 characters of whatever key was sent, so a request with
  a wrong key that began as a real one did spend that key's allowance.
- **A request with no key DumpFire accepts is counted against its address**, 60 a minute,
  apart from every key's count. One with no `Authorization` header was not counted at all,
  and one with a wrong key was counted against the first 11 characters of that key.
- **`last_used_at` is not touched by a request refused for the rate limit.**
- **Every answer carries the five security headers**, `X-XSS-Protection: 0` among them. See
  [Headers on Every Answer](#headers-on-every-answer).
- **`/api/v1` with nothing after it is answered `401` in JSON**, where it was a `303` to the
  login page.
- **A body that is a JSON array is answered `400`
  `{ "message": "The request body must be a JSON object" }`** on every route, before the
  route reads a field of it. It was passed to the route, which refused it in its own words as
  a body without the fields it needs (`400` `name is required` on `POST /boards`).
- **A board that does not exist is `404` `Board not found` to everyone**, on `GET`, `PUT`
  and `DELETE /boards/:boardId`, on `GET` and `POST` of its `/cards`, `/columns`, `/labels`
  and `/categories`. Everyone but an administrator was answered `403`, and an administrator
  an empty list from the four lists and a `500` from the three creates of a column, a label
  and a category. A board that is there and that the caller cannot open is still `403`.
- **Every operation that takes a body reads it before it looks for the resource**, so a body
  that cannot be read is `400` to a caller who would be refused, where eleven operations
  answered `403` or `404`: see [Writes and Failures](#writes-and-failures). What a field
  holds is still looked at after the `404` and the `403`.
- **Fields are read by their type and range** on the operations that create or change a
  column, a label, a category or a webhook, that change a board category, and that put a
  label on a card or take it off. A field of the wrong type, or one it may not hold, is `400` naming the
  field, where it was stored as sent or was a `500`. A value the row already holds, sent back
  unchanged, is accepted as it is.
  - A name or a title is text, trimmed, of 1 to 200 characters. One that was not text was
    turned into text, or was a `500`.
  - A `color` is a colour written `#rrggbb` (`color must be a colour written #rrggbb`): see
    **Every colour is a colour written `#rrggbb`** below. Any text was stored; `''` gave
    the default on create and is now `400` in those words.
  - A column's `position` is a number, or a number written as text: text was stored, and
    `null` gave the default. `showAddCard` and a webhook's `active` are `true` or `false`:
    `"false"` was stored as true. `wipLimit` is read as before.
  - A webhook's `url` is an `http` or `https` address of at most 2,048 characters, trimmed
    (`url must be an http or https address`); any text was stored, and `''` was accepted on
    an update. Its `secret` is text of at most 256 characters. Its `events` are a list of the
    six names, each trimmed (`events must be a list`, `events[n] must be one of: ...`): text
    and `null` were stored, and `null` stopped the board's deliveries.
  - `labelId` on `POST /cards/:cardId/labels` is an id, `400` `labelId must be an id`: `0`,
    `''` and `false` were `labelId is required`, and `true` and a list went on.
- **Taking a label off a card that does not have it is `404`
  `Label not found on this card`**, where it was `200`.
- **A label, column, category, board category or webhook deleted while its update was
  arriving is `404`**, where it was `200` with no body, or for a webhook `500`.
- **The four dependency operations read their ids as ids**, `POST` and `DELETE` on
  `/cards/:cardId/dependencies` and `/subtasks/:subtaskId/dependencies`. An id in the path of
  `0`, `1.5` or `-1` is `400` `Invalid card ID` or `Invalid subtask ID`, where it was `404`,
  and so is `1e3`, which was read as the id 1000. An id in the body of `0`, `-1`, `1.5`, `''` or `false` is `400`
  `<field> must be an id`, where it was `404` `#0 not found`; `true`, which was read as card
  1, and a list, which was read as the id in it, are `400` as well. Two ends sent, one of
  them no id, is answered `<field> must be an id`, where it was the refusal for sending two.
- **A subtask's dependencies are recorded in the activity log**, as a card's are:
  `POST /subtasks/:subtaskId/dependencies` writes `api:dependency_added` on the board of the
  subtask's card, and `DELETE` writes `api:dependency_removed` on the board of the end that
  waits. They wrote none. See [Dependencies](#dependencies).
- **A new comment is read as an edit is.** `POST /cards/:cardId/comments` answers `400`
  `content must be text` for content that is not text, where it was a `500` (and `null` was
  `Comment cannot be empty`), and `400`
  `content must be at most 50000 characters` for content over 50,000 characters once
  trimmed, where any length was stored. `PUT /comments/:commentId` already held an edit to
  50,000. It looks for the card, and checks the caller, before it reads the content: a card
  that is not there is `404` and a key whose user may not edit its board `403`, whatever the
  content, where an empty or missing one was answered `400` `Comment cannot be empty` first.
- **The activity report does not count a dependency added or removed as work on a card.**
  `GET /reports/activity` leaves out a card whose only activity in the window is a
  `dependency_added`, `dependency_removed` or `dependencies_bulk_added` entry, in either
  spelling, and a report on one user does not take a card to be theirs for one. The API's
  own entries for a dependency counted until this date, and the web application now writes
  them too.
- **A board member stored with a role other than `owner`, `editor` or `viewer` has a
  viewer's access.** The web application's sharing stored any text as a role until this
  date; a member stored as `admin` had an administrator's access to that board, by either
  API tree.
- **Every id in a path is read as an id**, on every operation: one that is not a whole
  number of 1 or more written in digits (`1.5`, `abc`, `0`, `1e3`) is `400`
  `Invalid <thing> ID`. Some were read as another id (`1e3` as 1000) or as none, and
  answered `404` or `403`; `GET /cards/:cardId/comments` answered `404`. An id in a query
  string is read the same way: `columnId` on `GET /boards/:boardId/cards`, `boardId` on
  `GET /milestones` (`Invalid boardId`), `boardId`, `userId` and `cardId` on
  `GET /audit-log`, and each of `boardIds` on `GET /reports/activity`. One that was not an
  id matched nothing, or was left out.
- **Fields are read by their type and range** on the operations that create or change a
  board, a board category, a card, a subtask or a milestone, that move a card, that assign
  and remove an assignee, that edit a comment, and that put a card into a milestone or take
  it out. A field of the wrong type, or one it may not hold, is `400` naming the field,
  where it was stored as sent or was a `500`. A value the row already holds, sent back
  unchanged, is accepted as it is, even one these rules would refuse.
  - A name is text, trimmed, of 1 to 200 characters, and a card's or a subtask's title of 1
    to 500: an empty title was stored on an update, and a name that was not text was a `500`
    (`name must be text`). An emoji is 1 to 32 characters: `''` gave the default on
    `POST /boards` and is `emoji cannot be empty`.
  - A `description` and an `onHoldNote` are text of at most 50,000 characters, and a
    `businessValue` of at most 10,000. A `coverUrl` is a colour or one of the preset
    gradients, or `null` (card 2010, below).
  - A `priority` is `low`, `medium`, `high` or `critical`, in any case, and is stored in
    lower case (`priority must be one of: low, medium, high, critical`). Any text was
    stored.
  - A `dueDate` or a `targetDate` is a day of the calendar written `YYYY-MM-DD`
    (`dueDate must be a date written YYYY-MM-DD`), and `null` or `''` clears it. Any text
    was stored.
  - A `colorTag` is a colour written `#rrggbb`, or `''` for none, and a board category's
    `color` a colour written `#rrggbb`: see **Every colour is a colour written `#rrggbb`**
    below. Any text was stored.
  - A `position` is a number, or a number written as text: `"top"` was stored, and on
    `PUT /cards/:cardId/move` a position that was not a number was ignored. `pinned` and a
    subtask's `completed` are `true` or `false`: `"false"` was stored as true.
  - An id in the body (`columnId`, `categoryId`, `parentCardId`, `userId`, `cardId`,
    `milestoneId`, a milestone's `boardId`) is a whole number of 1 or more,
    `<field> must be an id`. A milestone's `status` is `open` or `closed`.
- **Those operations look for what the path names, and check the caller, before they read a
  field**, so a caller who would be refused is answered `404` or `403` whatever the body
  holds. `PUT /comments/:commentId` and `POST` and `DELETE /milestones/:milestoneId/cards`
  looked at a field first, and answered `400`. A board, a board category and a milestone of
  no board have nothing to look for, and read their fields first; `POST /milestones` with a
  `boardId` looks for the board, and checks the caller, before it reads the other fields.
- **`archivedAt` on `PUT /cards/:cardId` may only be `null`**, which restores the card, as
  the tracking workflow restores one. Another value, which was stored, is `400`
  `archivedAt may only be null, which restores the card. Archive a card with DELETE /cards/{cardId}`.
  The stamp the card already holds, sent back, changes nothing. `archivedAt: null` sent with
  a `milestoneId` restores the card and then puts it in the milestone, where the card was
  refused as archived; a milestone that is refused leaves the card archived.
- **A card's `categoryId` is one of its board's categories, or one that belongs to no
  board**, on `POST /boards/:boardId/cards` and `PUT /cards/:cardId`. Another board's, which
  was stored, and one that does not exist, which was a `500`, are `404`
  `Category not found on this board`. A card already filed under another board's keeps it
  while it is sent back unchanged. `PUT /boards/:boardId` answers a board category that does
  not exist `404` `Board category not found`, where it was stored.
- **Removing an assignee who is not on the card is `404`
  `User is not assigned to this card`** on `DELETE /cards/:cardId/assignees`, where it was
  `200`, with an activity entry that said they had been removed. It writes no entry and
  sends no live update.
- **Taking a card out of a milestone is one rule on every operation.**
  `DELETE /milestones/:milestoneId/cards` answers `404` `Card is not in this milestone` for
  a card that is not in it, where a card in another milestone was taken out of that one and
  a card in none was a success. Taking a card out, there or with `milestoneId: null` on
  `PUT /cards/:cardId`, needs the right to change the milestone it is in: someone who may
  edit the card's board, and neither made a cross-board milestone nor is an administrator,
  is answered `403` `No edit access to this milestone`, as they already were for putting a
  card in, or `403` `No access to this milestone` when the milestone has cards on a board
  they cannot open. Putting a card in another milestone takes it out of the one it is in,
  so it needs the right to change that one too: `POST /milestones/:milestoneId/cards` and
  `milestoneId` on `PUT /cards/:cardId` answer the same `403`, and
  `POST /milestones/:milestoneId/cards/bulk` lists the card under `problems`
  (`No edit access to milestone #<id>, which holds card #<n>`) and writes nothing. Each
  moved the card. The milestone the card is already in, sent back on `PUT /cards/:cardId`,
  changes nothing.
- **An archived card is not put into a milestone**, by `POST /milestones/:milestoneId/cards`
  or by `milestoneId` on `PUT /cards/:cardId`: `400` `Card does not exist or is archived`,
  the words the bulk operation refuses one in. It was put in.
- **A batch names an entry that is not what it holds.** An entry of `links` on
  `POST /dependencies/bulk`, or of `entries` on `POST /tokens/bulk`, that is not an object
  is `400` `links[<n>] must be an object`, where it was a `500`. An entry of `cardIds` on
  the two milestone batches that is not an id is `400` `cardIds[<n>] must be an id`, where
  `null` was read as card 0 and reported in a `409`. A `blockedType` or `blockerType` other
  than `card` or `subtask` is `400` `links[<n>].blockedType must be one of: card, subtask`,
  where it was reported in a `409`. The batches still report a link already recorded, and a
  card not in the milestone, and carry on.
- **`GET /audit-log` reads `limit` and `offset` as whole numbers.** `limit` is rounded down
  and held between 1 and 500, `offset` rounded down and 0 or more, and text that is not a
  number is the default, as `limit=0` is, as it was. `limit=-1` answered every entry,
  `limit=2.5` was a `500`, and a
  negative `offset` was echoed.
- **`GET /reports/activity` reads its window as dates.** A `from` or `to` that is neither a
  date nor a timestamp is `400` `from is not a date`, where it was taken as the window; a
  timestamp with an offset, or with no zone, is read in UTC, where `09:00+02:00` was
  compared as 09:00. A bare-date `to` is read as the end of that day when it is checked that
  `from` is not after it, as the report itself reads it:
  `from=2026-10-14T09:00:00Z&to=2026-10-14`, the rest of that day, was `400`
  `` `from` is after `to` ``. `commentLimit=0` gives each card an empty `comments` list,
  where it was read as 3, and a negative `commentLimit`, or one that is not whole, is `400`,
  where a negative one left the key out.
- **`GET /me/stats` answers an average cycle time of 0 as `0`**, where it was `null`.
- **The compact milestone summary keeps its titles apart.**
  `GET /milestones/:milestoneId/summary?compact=true` has the cards' titles in `cardTitles`
  and the subtasks' in a new `subtaskTitles`, each by its id. Both were in `cardTitles` by
  the bare id, and a card and a subtask with the same id took one key between them.
- **`POST /dependencies/bulk` reads each end as an id.** An end of a link, or an entry of
  `chain`, whose id is not a whole number of 1 or more (`1.5`, `"1e3"`, `0`, `-1`,
  `"subtask:abc"`), a list, or an object whose `kind` is not `card` or `subtask`, is `400`
  `<entry> must be a card id, "subtask:<id>", or {kind, id}`, naming the entry
  (`links[0].blocker`, `chain[1]`). `1.5` and `"1e3"` were taken as ids and reported in
  the `409` as links to nothing, a list was read as the id in it, and another `kind` as a
  card.
- **A webhook's `url` goes with its secret** (card 2133). It is answered only to the
  board's owner and an administrator, and in the answer to the `POST` that created the
  webhook. `GET /boards/:boardId/webhooks`, `GET /webhooks/:webhookId` and the answer to
  `PUT /webhooks/:webhookId` leave the key out for anyone else, an editor's own update
  included, where every caller who could view the board was given it. An editor may still
  set a new address.
- **`recentActivity` on `GET /me/stats` lists only entries on boards the key's user can
  open** (card 2126), the 20 counted after that, where an entry on a board they had been
  taken off was listed, with the card title in its `detail`. The counts beside it are as
  they were.
- **A board category is given only to a key whose user may be told of it** (card 2128).
  `GET /board-categories` lists the board categories that hold a board the key's user can
  open, and those that hold no board yet, where every one was listed; an administrator's
  key is given every one. `GET /board-categories/:categoryId` answers `403`
  `No access to this board category` for any other, where it was given.
  `GET /burndown` with the `boardCategoryId` of one answers `403`
  `No access to board category <id>`, where it was charted empty under the category's
  name. `PUT /boards/:boardId` answers `403` `No access to this board category` for a
  `categoryId` that names one, and saves nothing, where the board was filed under it.
- **`GET /categories/:categoryId` answers `403` `No access to this category`** for a card
  category of a board the key's user cannot open (card 2128), where any key was given any
  category. One that belongs to no board is given to every key.
- **Work on a board the key's user cannot open is withheld** (card 2129) where it is the
  other end of a dependency or in a milestone's plan: by `GET /cards/:cardId`,
  `GET /cards/:cardId/dependencies`, the three operations on
  `/subtasks/:subtaskId/dependencies`, and `GET /milestones/:milestoneId/summary`, whole and
  compact, and its PDF. It is still listed, so that what waits on it is still blocked, with
  its `id`, `kind` and whether it is finished, and the link's own id, author and date. Its
  `title` is `A card on a board you cannot open` or `A subtask on a board you cannot open`,
  its `boardName` `A board you cannot open`, its column title `""`, and its `boardId`,
  `columnId`, `priority` and `milestoneId` `null`; a withheld subtask in a plan has no
  `parentCardId`. Every end and every node carries a new boolean, `withheld`, `false` where
  nothing is withheld. Its title, board, column and priority were given. The summary's
  `progress` counts cards on such boards under one entry of `boards`,
  `{ "id": null, "name": "A board you cannot open" }`, and under `""` in `byColumn`, where
  it named each board. Its `criticalPath` is worked out from the real work, and is the same
  whoever asks: where the chain runs through a withheld subtask, the id of the subtask's
  card is given there, as for any subtask, though the node itself has no `parentCardId`;
  that id is all that is given of the card. An administrator's key is given everything as
  before. See [Dependencies](#dependencies).
- **`GET /milestones/:milestoneId` lists a card on a board the key's user cannot open
  withheld** (card 2129's review), as the summary does: its `id`, `withheld: true`,
  `A card on a board you cannot open` for its `title`, `columnTitle` `""`, and `priority`,
  `columnId` and `boardId` `null`. Every card carries `withheld`. A card moved off a board
  keeps that board's milestone, and its title and board were given to every viewer of the
  first board.
- **`GET /burndown?milestoneId=` charts only the milestone's cards on boards the key's user
  can open** (card 2129's review), and says in `meta.notes` how many are left out, where a
  card moved to a board they cannot open was charted and its board named in `scope.boards`.
  An administrator's key is charted every card as before.
- **Deleting a board deletes its card categories** (card 2128's review), on
  `DELETE /boards/:boardId`, with those of every sub-board deleted with it; a card on
  another board that carried one has none. They were kept as categories of no board,
  which every key is given.
- **Renaming a column into or out of Complete or Done is `409` while it holds a card**
  (card 2134), on `PUT /columns/:columnId`, archived cards included, and nothing is
  written. A card is finished because of the title of the column it is in, so such a
  rename made finished work open again, or made cards finished that nobody finished, with
  no completion date, no XP and no entry. An empty column is renamed freely, and so is one
  whose new title keeps what it means. The message says how many cards the column holds
  and, when any are, how many of them are archived, in one of two forms: see
  [`PUT /api/v1/columns/:columnId`](#put-apiv1columnscolumnid). A Complete or Done column
  that holds any card can be renamed only to Complete or Done.
- **A card created in a Complete or Done column is completed** (card 2134), on
  `POST /boards/:boardId/cards`, as a card moved into one is: `completedAt` and
  `firstCompletedAt` are the moment it was created, the key's user gets the XP for its
  priority, `api:card_created` and then `api:card_completed` are written, and the board's
  webhooks get `card.created` and `card.completed`. The answer is the card as written,
  with its `completedAt`. It was created with no completion date, no XP and no
  `api:card_completed`.
- **A move that completes a card mails its assignees** (card 2134), on
  `PUT /cards/:cardId/move`, each as their own "Card moved" setting says and only those who
  can open the board the card is on (card 2180, on every route), where no move
  through the API mailed them. A move through the API that does not complete the card still
  mails nobody, and **nobody is mailed about a move they made themselves**, on any route.
- **A restore through `PUT /cards/:cardId` is recorded as a restore** (card 2108):
  `archivedAt: null` on an archived card writes `api:card_restored`, where it wrote
  `api:card_updated` naming `archivedAt`, and `api:card_updated` is written only for the
  other fields sent, so a restore alone no longer delivers a `card.updated` webhook.
- **A subtask ticked or deleted through the API is recorded** (card 2108). Completing a
  subtask with `PUT /subtasks/:subtaskId` writes `api:subtask_completed`,
  `<subtask> (on <card>)`, and mails whoever asked for the card when it came from a task
  request; `DELETE /subtasks/:subtaskId` writes `api:subtask_deleted`. Neither wrote an
  entry.
- **In `GET /audit-log`, only a trailing `*` is a wildcard** (card 2127): `card_*` no
  longer finds `cards_purged` or `cards_cleared`, whose `cards` the `_` of the prefix
  matched as any one character.
- **A card's cover is a colour or one of the preset gradients** (card 2010), on
  `PUT /cards/:cardId`: `coverUrl` is a colour written `#rrggbb`, one of the eight
  gradients the card window offers, written exactly as
  [`PUT /api/v1/cards/:cardId`](#put-apiv1cardscardid) lists them, or `null`, `''` being
  read as `null`. Anything else is `400`
  `coverUrl must be a colour written #rrggbb, one of the preset gradients, or null`, and
  nothing in the request is written, where any value was stored, an address or a style
  included. A cover is drawn for everyone who views the board, as a strip across the top
  of the card, so a value written there would have made each
  viewer's browser fetch an address of the writer's choosing. A cover the card already
  holds, sent back unchanged, is accepted as it is, and a page does not draw one that is
  not a colour or a preset. `recurrenceRule` and `nextRecurrence` stay in every card
  answer, and the OpenAPI document now says they are not used: nothing sets or acts on
  them.
- **A card is not moved onto one of its own sub-boards** (card 2141), on
  `PUT /cards/:cardId/move`: a move onto one, or onto a board beneath one at any depth, is
  `409` `Card "<title>" cannot go onto "<board>", which hangs beneath it`, and nothing
  moves. It was `200`, and the sub-board then hung beneath itself, on no dashboard,
  and its card could never be completed. A move within one board is not asked, and the card
  such a loop already hangs from can still be moved onto a board outside it. See
  [`PUT /api/v1/cards/:cardId/move`](#put-apiv1cardscardidmove).
- **What is done in the web application is recorded as it is through the API** (card
  2143). Assigning someone to a card, taking them off, editing a comment, creating a
  board, updating one and creating a milestone on a board write the entry their operation
  here writes, in the same words, stored without `api:` and with `source` `ui`:
  `assignee_added`, `assignee_removed`, `comment_edited`, `board_created`,
  `board_updated` (naming the fields sent, in this API's order) and `milestone_created`.
  Accepting a task request with an assignee writes `assignee_added`, by whoever accepted
  it. So `GET /audit-log`, `GET /reports/activity` and `recentActivity` on `GET /me/stats`
  hold them, and the activity report counts a card as touched by, and attributes it to,
  whoever assigned someone to it or edited a comment on it on a page, as it did for the
  same actions through the API. They wrote nothing. None of them starts a webhook.
- **`POST /boards` with a `parentCardId` tells the board that card is on** (card 2143):
  the pages open on it are sent a live update, `{ "type": "board", "action": "created" }`,
  so the sub-board shows on its card without a reload, as the web application's own create
  now does too. It sent nothing. A board made at the top level sends nothing, and the
  answer is unchanged.
- **A card update records only what it changed** (card 2183), on `PUT /cards/:cardId` and
  on the web application's `PUT /api/cards/{id}`. A field sent with the value the card
  already holds is not a change, and `null` and `''` are the same value when comparing (`description`, `onHoldNote` and `businessValue` still take text only, and `''` clears them): a request that
  changes nothing writes nothing, so `updatedAt` stays, records no activity entry, sends no
  `card.updated` and no live update, and answers `200` with the card as it is. One that
  changes some fields writes, names and announces those alone. Every field sent was
  written and named, so a save of an unchanged card from the card window delivered
  `card.updated` and counted the card as worked on in the activity report. The milestone
  the card is in, sent back, is not a change, and `{}` is still `400`
  `No valid fields to update`. See [`PUT /api/v1/cards/:cardId`](#put-apiv1cardscardid).
- **A move out of an On Hold column clears the card's `onHoldNote`** (card 2208), on
  `PUT /cards/:cardId/move` and on every move in the web application: a move from a
  column titled On Hold, Hold, Blocked, Parked or Waiting to one that is not. Every route
  kept the note, and only a drag on the board page cleared it, with a second request that
  wrote `card_updated` naming `onHoldNote` and delivered `card.updated`. The move's own
  entry and events are the record now. On the web application's `PUT /api/cards/{id}`, which takes a `columnId` with other fields, an `onHoldNote` sent back equal to the note the move cleared is not written back; a different note sent with the move is written. See
  [`PUT /api/v1/cards/:cardId/move`](#put-apiv1cardscardidmove).
- **An archived card on a sub-board holds nothing back** (card 2205). A move to Complete,
  by `PUT /cards/:cardId/move`, `PUT /api/cards/{id}` or `PUT /api/cards/reorder`, is no
  longer refused `409` for archived cards on the card's sub-boards: only cards that are
  not archived and not in a Complete column count, and the refusal's count is of those
  alone, in the same words. A card held back only by archived cards now completes. The
  board page's sub-board figures (`subBoards[].done` and `total` on each card) leave
  archived cards out, as the card context and the dashboard already did, and so does
  `hiddenOpenCount`. A card already complete stays complete when an archived card under it
  is restored.
- **A cost is priced at the Claude 5.5 models' own rates** (card 2014). `costUsd` on the
  token answers prices `claude-opus-5-5` at $4 / $20 per million, cache reads at $0.20,
  where it was priced as `claude-opus-5` at about twice that, and prices
  `claude-sonnet-5-5` and `claude-haiku-5-5`, the last at its rate for prompts of 100K
  tokens or fewer, where Haiku 5.5 was unpriced. A listed id followed by a version
  DumpFire does not list (`claude-opus-5-6`) is unpriced and counted in `unpricedTokens`,
  where it was priced as the shorter id. Cost is worked out when it is read, so past
  entries are re-priced: see [Token Usage](#reading-the-totals). The totals
  `POST /api/v1/tokens/bulk` answers for each card price each entry as the card's own
  `GET` does, where a model with a measured entry and an entry with no breakdown was
  priced as a whole at the 90/10 blend, several times its cost.
- **`GET /api/v1/burndown` says when its forecast spans several boards** (card 1968).
  `forecast.spansBoards` is `true` when the cards that pass the filters sit on more than
  one board, and each row of `groups` carries its own, judged on that row's cards alone;
  it is the test `delivery` splits by board on. The forecast's `projectedDate` and
  `projectedDateNoNewScope` are then pooled across boards, as if a card finished on one
  board cleared another's, and are not when the work finishes: `delivery` dates it board
  by board, as before. Every other field and value is as it was, `target.onTrack` and
  `daysLate` included, which still compare the pooled date. Across several boards the
  burndown page, its chart and the milestone panel now show no forecast date, and the
  target's verdict comes from `delivery`: see [Burndown Charts](burndown-charts.md#the-forecast).
- **`GET /milestones/:milestoneId/summary` counts every subtask beside the open ones**
  (card 2225). `progress.totalSubtasks` is every subtask, ticked or not, of the cards
  `progress.openSubtasks` counts, so the open figure has a total to be read against.
  Every other field is as it was. The milestone page's progress panel reads `open/all`,
  and the milestone PDF's "Open steps" reads `<open> of <all>`.
- **Sub-boards nest at most 20 levels deep** (card 2172), below a board that is not a
  sub-board. `POST /boards` with a `parentCardId` on a board already 20 levels deep, or in
  or below a loop, is `409`
  `Sub-boards can be nested at most 20 levels deep, and a board under this card would be deeper.`,
  and nothing is created. `PUT /cards/:cardId/move` to another board is `409`
  `Card "<title>" cannot go onto "<board>": its sub-boards would then be nested more than 20 levels deep.`,
  and nothing moves, when the card's sub-boards would end up deeper than that and deeper
  than they are now; a card with no sub-board is never refused. Both were accepted at any
  depth. A tree already deeper keeps working, and a move that lifts it, or leaves it no
  deeper, is allowed. Archived cards count. See
  [`PUT /api/v1/cards/:cardId/move`](#put-apiv1cardscardidmove).
- **A request with no key DumpFire accepts is counted by its network** (card 2195). The
  address it came from is counted by its /64 network when it is IPv6, as the IPv4 address
  when it is an IPv4 address written as IPv6, and without a port, so the 61st request in a
  minute from any address of one IPv6 network is answered `429`, where each address had its
  own sixty. A key's own count is unchanged.
- **Every colour is a colour written `#rrggbb`** (card 2162). Every operation that takes a
  `color` or a `colorTag` reads it as `#` and six hex digits, in either case, trimmed, and
  answers `400` for anything else, `red` and `#fff` included, and for a value that is not
  text: `color must be a colour written #rrggbb` on `POST /boards/:boardId/columns`,
  `/labels` and `/categories`, `POST /board-categories`, and `PUT /columns/:columnId`,
  `/labels/:labelId`, `/categories/:categoryId` and `/board-categories/:categoryId`;
  `colorTag must be a colour written #rrggbb, or empty` on `POST /boards/:boardId/cards`,
  `PUT /cards/:cardId`, `POST /cards/:cardId/subtasks` and `PUT /subtasks/:subtaskId`, where
  `''` clears the tag. Nothing is written. Until then any text was stored, up to 32
  characters where a length was checked, a style such as `red;background:url(//x.io)`
  included, and a colour is drawn into the page of everyone who opens the board. A colour
  the row already holds, sent back unchanged, is accepted as it is, and one stored before
  this rule is answered as stored; the pages draw it as it is when it is a colour and
  nothing more (`red`, `#fff`), and grey otherwise. Through the tracking wrapper, quote a
  colour, `-Color '#ef4444'`: in PowerShell an unquoted `#` begins a comment, so the
  parameter gets no value and the call stops with "Missing an argument for parameter
  'Color'". The web application's routes take a colour by the same rule
  (below).

Three more on the same day touch no route of the API, and so not the OpenAPI document, but
reach the keys every caller uses:

- **Making a key asks for the account's password**, on My Account: see
  [Generating a Key](#generating-a-key). Keys made before are kept.
- **Setting a password can end the account's keys.** An administrator's reset and an invite
  used end every key of the account; the holder's own change ends them only if asked. A key
  that has ended is answered `401` `Invalid or expired API key`: see
  [When a Key Ends](#when-a-key-ends).
- **Wrong passwords at Generate Key are counted.** Ten in 15 minutes from one signed-in
  browser, counted with the Account page's email and password forms, and that browser is
  refused for up to 15 minutes, the right password included: see
  [Generating a Key](#generating-a-key).

These touch only the web application, whose routes under `/api/` the pages use, and not the
API:

- **A body that is not a form, sent where a form is read** (the attachment upload, and the
  sign-in, set-up and invitation pages), is answered `400` `The request body is not a form`
  where it was `500`. A form is a body sent as `multipart/form-data` or
  `application/x-www-form-urlencoded`.
- **Eleven handlers that checked access before reading the body read it first**:
  `PUT /api/teams/{id}`, `POST /api/teams/{id}/members/{userId}`, `PUT /api/boards/{id}`,
  `POST`, `PATCH` and `DELETE /api/boards/{id}/share`, `PUT /api/categories/{id}`,
  `PUT /api/board-categories/{id}`, `PUT /api/cards/{id}/comments/{commentId}`,
  `PUT /api/report-schedules/{id}`, and `POST /api/cards/{id}/dependencies`. A body that is
  missing, is not JSON or is not an object, sent by a caller who would be refused, is `400`
  where it was `403` or `404`. An id in their path, and in the path of
  `DELETE /api/cards/{id}/dependencies` and of both methods of
  `/api/subtasks/{id}/dependencies`, that is not a whole number of 1 or more (`1.5`, `0`,
  `-1`, `abc`) is `400` `Invalid <thing> ID`, where it was `403`, `404` or `500`; so is
  `1e3`, which was read as the id 1000.
- **A team or a board that is not there is `404`.** `PUT` and `DELETE /api/teams/{id}`, and
  `POST` and `DELETE /api/teams/{id}/members/{userId}`: a non-administrator was answered
  `403`, and an administrator `404`, `200` doing nothing, or `500`. `PUT /api/boards/{id}`:
  `403` to all but an administrator. `POST`, `PATCH` and `DELETE /api/boards/{id}/share`:
  `403`, and an administrator `500` or `200` doing nothing. A share that is not there is
  `404` on `DELETE`, after the owner's check: `This board is not shared with that user`, or
  `This board is not shared with that team`, where it was `200` doing nothing (the review of
  group Q-F, 2026-10-15).
- **Fields are read by their type and range**, `400` naming the field, where each was stored
  as sent or was a `500`. A value the row already holds, sent back unchanged, is kept.
  - `PUT /api/teams/{id}`: a body with no name or emoji is `No valid fields to update`,
    where it was `500`; `name` is text, trimmed, of 1 to 200 characters, and `emoji` text of
    1 to 32 (`''` was ignored).
  - `POST /api/teams/{id}/members/{userId}` adds the user in the path, where it added the
    body's. The body's `userId` may be left out; another user's is
    `userId must be the user in the path, or be left out`, and one that is no id
    `userId must be an id`. `{}` adds the user in the path, where it was `400`
    `userId is required`. `role` is `member` or `owner`,
    `role must be one of: member, owner`: any text was stored, and `''` and `null` were
    `member`.
  - `PUT /api/boards/{id}`: `name` text, trimmed, of 1 to 200 characters, `emoji` of 1 to
    32; `categoryId` an id or `null`, and a grouping that is not there `404`
    `Board category not found` (it was stored).
  - `POST /api/boards/{id}/share`: `type` `user` or `team`, `type must be "user" or "team"`,
    where any other `type` was taken as a team share; `targetId` a required id
    (`targetId is required`, `targetId must be an id`); `role` `viewer` or `editor`,
    `role must be one of: viewer, editor`: any text was stored, and `''` and `null` were
    `viewer`. Someone already stored as owner and sent back as owner keeps it.
  - `PATCH /api/boards/{id}/share`: `isPublic` a required boolean. `{}` made the board
    private and is `isPublic is required`; `"false"` made it public and is
    `isPublic must be true or false`.
  - `DELETE /api/boards/{id}/share`: `type` `user` or `team`, `type must be "user" or "team"`,
    where another was `200` doing nothing; `targetId` a required id.
  - `PUT /api/categories/{id}` and `PUT /api/board-categories/{id}`: `name` text, trimmed, of
    1 to 200 characters, `color` a colour written `#rrggbb` (card 2162, below).
  - `PUT /api/cards/{id}/comments/{commentId}`: `content` is text of at most 50,000
    characters, `content must be text` where it was a `500`. There was no limit.
  - `POST /api/cards/{id}/comments`, a new comment, the same: text of 1 to 50,000
    characters once trimmed, `content must be text` where it was a `500`, and
    `content must be at most 50000 characters` where any length was stored.
  - `PUT /api/report-schedules/{id}`: `enabled` a boolean; `name` 1 to 200 characters;
    `frequency` `weekly` or `monthly`, where another was ignored; `dayOfWeek` 0 to 6 and
    `dayOfMonth` 1 to 28, whole numbers (31 was stored as 28); `timeOfDay` `HH:MM`, `''` being
    09:00, where any text was stored; `recipients` addresses separated by commas,
    semicolons or lines, as the reports page takes them, and stored separated by commas, at
    most 2,000 characters; `statusFilter` one of its values, where another was stored as `all`.
    The answer is the schedule as it was written.
- **The share window offers Owner only on a row already stored as owner.** No share makes
  anyone an owner now (`role` above), so the choice it offered on every person's row was
  always refused, and the window threw the answer away: the role snapped back with nothing
  said. A refused change of role is now said, in the server's words, and the row shows the
  role that is stored. A person already shared as Owner keeps it and is shown so; the
  board's creator is its owner.
- **The card window's dependencies are recorded.** `POST` and `DELETE` on
  `/api/cards/{id}/dependencies` and `/api/subtasks/{id}/dependencies` write
  `dependency_added` and `dependency_removed`, as the API's card operations write theirs: the
  board's activity panel and the Audit page show them. They wrote none. Their ids in the body
  are read as the API's dependency operations read them, above.
- **`PUT /api/boards/{id}` puts a board under a card with `parentCardId`, or takes it out
  from under one with `null`.** It ignored the field and answered `200` with nothing saved,
  which the board page's "Link existing board" then called a success. It is now the board's
  owner's or an administrator's to do (the owner by the board's role: its creator, or a
  member shared as Owner), with edit access to the board the card is on, and the board's,
  the new card's board's and the old card's board's pages are sent a live update. Refused,
  nothing in the request is saved: `403`
  `Only the board's owner or an administrator can put it under a card or take it out from under one`;
  `403` `No edit access to the parent card's board`; `404` `Parent card not found`; `409`
  `Board "<name>" cannot go under a card on itself or on one of its own sub-boards`; `400`
  `parentCardId must be an id`. The card the board already hangs under, sent back, changes
  nothing. The API's `PUT /boards/:boardId` takes no `parentCardId`.
- **`POST /api/cards` answers `400` for a reporting field outside its vocabulary**, where it
  was `500`. The reporting fields answer their own `400` on every route that takes them.
- **The card window takes a card out of a milestone by the API's rule.**
  `PATCH /api/milestones/{id}` with `attach: false` needs the right to change the milestone
  the card is in, so someone who may edit a board, and neither made a cross-board milestone
  nor is an administrator, can no longer take a card out of that milestone from the card
  window: `403` `No edit access to this milestone`, or `No access to this milestone` when it
  has cards on a board they cannot open, where it was `200`. Nor can they by choosing
  another milestone, which takes the card out of the one it is in: `attach: true` needs the
  right to change that one too. Choosing another milestone and then None was the way round
  the rule. With `attach: true` it refuses an archived card, `400`
  `Card does not exist or is archived`.
- **`PATCH /api/milestones/{id}` looks at the milestone in its path, first.** One that is
  not there is `404` `Milestone not found` to everyone, and one the caller may not change
  `403`, before a field is read. With `attach: false`, a card that is not in that milestone
  is `404` `Card is not in this milestone`. The milestone in the path was not looked at: a
  card was taken out of its own through any id, a milestone of another board or none at
  all, and answered `200`. `attach` is `true` or `false`: `"false"` put the card in.
- **The web application's work routes read every field by its type and range**, `400`
  naming the field, as the API's twins read them, where each was stored as sent, given a
  default, or was a `500`. A value the row already holds, sent back unchanged, is kept,
  whatever these rules say of it. An id in the body that names the row the route checks
  keeps the words of the check: `Invalid column ID`, `Invalid board ID`, `Invalid card ID`,
  `Invalid label ID`.
  - `POST /api/boards`: `name` text, trimmed, of 1 to 200 characters, `name is required`
    (`{}` made "Untitled Board"); `emoji` 1 to 32; `parentCardId` an id or `null`,
    `parentCardId must be an id`, where one that was no id was `404`
    `Parent card not found` and `"1e3"` was looked for as card 1000; `categoryId` an id or
    `null`, and a dashboard grouping that is not there `404` `Board category not found`,
    where it was stored.
  - `POST /api/board-categories`, `POST /api/categories` and `POST /api/labels`: `name`
    text, trimmed, of 1 to 200 characters, where a missing name gave "New Category" and a
    label with none was a `500`; `color` a colour written `#rrggbb`, where any text was
    stored. `POST /api/categories` reads `boardId` as an id or `null`: `''` and `0` were
    taken for no board.
  - `POST /api/columns`: `title` text, trimmed, of 1 to 200 characters, where a missing one
    gave "New Column"; `position` a number; `color` a colour written `#rrggbb`.
    `PUT /api/columns/{id}`: the same `title`, `color` and `position`, and `showAddCard`
    `true` or `false`, which was left out, so the board page's "Show Add Task" was a `500`
    on every press and was never saved; a body with none of them, or only a `boardId`, is
    `400` `No valid fields to update`, where it was a `500`. The WIP limit is read as
    before.
  - `PUT /api/columns/reorder` and `PUT /api/cards/reorder`: `updates` a list of objects
    (`updates[<n>] must be an object`, where it was a `500`), each `id` and `columnId` an
    id (`updates[<n>].id must be an id`), and each `position` a number
    (`updates[<n>].position must be a number`): text was stored, and a column's missing
    position was a `500`.
  - `POST /api/cards`, `PUT /api/cards/{id}`, `POST /api/subtasks` and
    `PUT /api/subtasks/{id}`: as the API's card and subtask operations read them. `title`
    text, trimmed, of 1 to 500 characters, required on a create, where a missing one gave
    "Untitled" or "New subtask" and an empty one was stored on an update; `description` and
    `onHoldNote` at most 50,000 characters, `businessValue` at most 10,000
    (`Title too long (max 500 chars)`, `Description too long (max 50000 chars)` and
    `Business value too long (max 10000 chars)` as before); `priority` `low`, `medium`,
    `high` or `critical` in any case, stored in lower case; `dueDate` a date written
    `YYYY-MM-DD`, `''` or `null` clearing it; `colorTag` a colour written `#rrggbb`, or
    `''`; `position` a number; `pinned` and `completed` `true` or `false`, where `"false"`
    was stored as true, and a subtask so ticked wrote no entry and sent no notice;
    `coverUrl` a colour written `#rrggbb`, one of the preset gradients or `null` (card
    2010, below); `recurrenceRule` is not read at all (card 2010).
  - A card's `categoryId` is one of the board's categories, or one that belongs to no
    board, on `POST /api/cards` and `PUT /api/cards/{id}`: another board's, which was
    stored, and one that is not there, which was a `500`, are `404`
    `Category not found on this board`. A card moved to another board on
    `PUT /api/cards/{id}`, as All Tasks moves one, takes a new category of the board it ends
    on. One the card already holds, sent back, is kept, but not on a move to another board:
    there the move decides, and clears one of the old board's, which the card window's save
    wrote back over the clearing.
  - `POST` and `DELETE /api/cards/{id}/assignees`: `userId` an id. Removing someone who is
    not assigned to the card is `404` `User is not assigned to this card`, where it was
    `200`.
  - `PUT /api/labels`, which puts a label on a card or takes it off, and
    `DELETE /api/labels`: their ids are ids, `Invalid card ID` and `Invalid label ID`, where
    one that was not was looked for. `PATCH /api/labels`, which renames and recolours a
    label, is new (card 2010, below), and reads `name` and `color` as `POST /api/labels`
    does.
  - `POST /api/milestones` and `PATCH /api/milestones/{id}`: as the API's: `name`,
    `description`, `targetDate`, `status`, `boardId`, and `cardId` an id.
  - `POST /api/templates`: `name` text, trimmed, of 1 to 200 characters, where a template
    with no name was a `500`; the card it holds, `title` at most 500 characters and
    `description` at most 50,000; `priority` one of the four, so a template saved from a
    card whose stored priority no rule allows is refused; `subtasks` a list of objects,
    each a `title`, `description` and `priority` read by the same rules and stored as those
    three alone, where whatever was sent was stored; `labels` a list of ids.
  - `POST /api/boards/{id}/archive`: `cardId` an id.
- **Those routes look for what the path or the body names, and check the caller, before
  they read a field**, so a caller who would be refused is `404` or `403` whatever the
  body holds. `POST /api/cards` refused a title over 500 characters before it looked for
  the column, `400` to a caller who could not touch it and for a column that was not
  there; `POST /api/cards/{id}/comments` an empty comment, likewise. A board, a board
  category, and a category, milestone or template of no board have nothing to look for,
  and read their fields first.
- **Every id in the path or the query string of those routes is read as an id**: one that
  is not a whole number of 1 or more written in digits (`1.5`, `abc`, `0`, `1e3`) is `400`
  `Invalid <thing> ID`, or for a query string `Invalid boardId`, `Invalid cardId`,
  `Invalid columnId` or `Invalid forBoard`, but `Invalid board ID` on `GET /api/templates`
  and `Invalid card ID` for the `exclude` of `GET /api/cards/search`. That is every method
  under `/api/boards/{id}`,
  `/api/cards/{id}` and `/api/subtasks/{id}`, `/api/columns/{id}`, `/api/categories/{id}`,
  `/api/board-categories/{id}`, `/api/milestones/{id}` with its PDF and summary, and
  `/api/templates/{id}`, and the `boardId`, `cardId`, `columnId` and `forBoard` of
  `GET /api/labels`, `/api/subtasks`, `/api/activity`, `/api/graph`, `/api/milestones`,
  `/api/templates` and `/api/cards/export/csv`, and the `exclude` of
  `GET /api/cards/search`. Some were read as another id, `1e3` as 1000, and answered `404`
  or `403`, and `0` was an empty list.
- **Four routes answer `401` to a caller who is not signed in**:
  `GET /api/boards/{id}/cfd`, `/export/csv` and `/metrics`, and `GET /api/cards/export/csv`.
  They read the caller unchecked and threw, a `500`; the gate stands in front of them, so
  no request reached one that way.
- **The graph draws the superadmin among the administrators**, a member of every board. It
  was left out, and drawn with fewer boards than any administrator.
- **The card window offers the board's own categories and the shared ones**, of no board,
  and not every board's: the server files a card under nothing else. A card already filed
  under another board's category keeps it, and its chip still names it.
- **The accounts, administration, teams, reports and requests read every field by its type
  and range** (card 2117's fourth slice), as the work routes above do: `400` naming the
  field, where each was stored as sent, dropped without a word, read as another, or was a
  `500`. Every route that takes a JSON body now reads it one way. A value the account or
  the settings already hold, sent back unchanged, is kept.
  - `PUT /api/users/{id}`: **nobody changes their own role here**, the superadmin
    included, and the role they have sent back included: `403`
    `Your own role is not changed here: the superadmin can change it`, or to the
    superadmin `The superadmin's role cannot be changed`, and nothing else sent with it is
    saved. An administrator's request to make themselves a user was answered `200` and
    done, and the superadmin's to change theirs `200` and ignored. `username` and `email`
    are read by the rules of `POST /api/users`: trimmed, a username of at least 2
    characters (`Username must be at least 2 characters`), an email address
    (`Valid email required`), and one another account has `409` `Username already taken`
    or `Email already in use`, where each was stored as it came and a duplicate was a
    `500`. `emoji` is 1 to 32 characters, where `''` was ignored. The fields are read once
    the account is found and the caller may manage it, so a field of the wrong type for an
    account they may not manage is `403`, where it was `400`.
  - `POST /api/users`: `email` is an address by the readers' rule, with no space and none
    of `, ; < > " ( )`, where any text with an `@` was taken; `emoji` 1 to 32 characters,
    where `''` gave the default.
  - `PUT /api/users/{id}/password`: `password` is text, `password must be text`, where a
    number was a `500` from bcrypt. The account is looked for, and the caller checked,
    before it is read: an account that is not there is `404`, where a short password was
    `400`.
  - `POST /api/account/api-keys`: `name` is text, where a number was a `500`; `expiresAt`
    a timestamp in the future, or `null`, stored in UTC
    (`expiresAt must be a timestamp, such as 2027-01-01T09:00:00Z`,
    `expiresAt must be in the future`), where any text was stored, `"banana"` never
    expired, and one written with an offset was compared wrongly.
    `PUT /api/account/email`: `newEmail` is text, where a number was a `500`, and an
    address holding `, ; < > " ( )` is `Invalid email address`.
    `PUT /api/account/password`: `newPassword` is text, where a number was a `500`.
    `PUT /api/account/emoji`: at most 32 characters.
  - `PUT /api/account/notifications`: a preference it knows that is not `true` or `false`
    is `400` `<key> must be true or false`, where it was left out without a word. One it
    does not know is still left alone.
  - `POST /api/teams`: as `PUT /api/teams/{id}` reads a team, `name` of 1 to 200
    characters (`name must be text`, where a number was a `500`) and `emoji` of 1 to 32,
    where `''` gave the default.
  - `POST /api/xp` is gone (card 2010, below). It added `amount` written as text as
    text: `"10"` on 5 XP stored 510.
  - `POST /api/report-schedules`: as `PUT /api/report-schedules/{id}` reads them, and
    `periodDays` a whole number from 1 to 366, `detailLevel` `summary` or `detailed`, and
    `statusFilter` one of its values, where another was stored as `detailed` or `all`;
    `scopeId` an id. The board or the grouping is looked for, and the caller checked,
    before the other fields are read: a board that is not there is `404`
    `Board not found`, where an administrator's schedule of it was made, and a board the
    caller cannot see is `403` whatever else the body holds.
  - `POST /api/reports` and `POST /api/reports/email`: `scope` `board`, `category` or
    `all` (`Invalid scope. Must be: board, category, or all`; the mail's route read
    another as every board the caller can see); `periodStart` and `periodEnd` a date or a
    timestamp (`periodStart is not a date`), where one that was not text was a `500`, and
    `periodStart` not after `periodEnd` (`periodStart is after periodEnd`, a bare date being
    the whole day), where a period that ended before it began was drawn as a report of
    nothing; `scopeId` an id; `detailLevel` and `statusFilter` from their values, where another was
    read as `detailed` or `all`; `assigneeUserId` an id or `null`
    (`assigneeUserId must be a user id`), where `"all"` and `''` were taken for everyone.
    Each of the mail's `recipients` is an address,
    `recipients[<n>] must be an email address`: one that was not was dropped and the
    report sent to the rest, and with none left it was
    `No valid email addresses provided`.
  - `POST /api/requests`: `title`, `description`, `businessValue` and `requesterName` are
    text, where a number was a `500`, and `requesterName` at most 200 characters; `priority` `low`, `medium`, `high` or `critical` in
    any case, stored in lower case, where another was `medium`; `targetType` `user` or
    `team`; `targetId` and `desiredBoardId` ids. A requester's address holding
    `, ; < > " ( )` is `A valid email address is required`. `PATCH /api/requests/{id}`:
    `action` `accept` or `reject`; `boardId`, `columnId` and `assigneeId` ids, where one
    that was not was looked for as it came; `rejectReason` text of at most 10,000
    characters, or `null`. `DELETE /api/requests/{id}` answers a request that is not there
    `404` `Request not found`, where it was answered as deleted.
  - `POST /api/requests/{id}/messages`: `message` is text, where a number was a `500`;
    `senderType` `requester` or `admin`, where another was taken for a reply from the
    team; a `token` that is not text is answered as a wrong one, where it was a `500`. The
    request is looked for, and the sender checked, before the message is read: a request
    that is not there is `404`, and a sender who may not reply `401`, `403` or, with no
    session, `404` (card 2132, below), where an empty message was `400` first.
  - `POST /api/requests/{id}/confirm`: a body that is missing, is not JSON or is not an
    object is `400`, where it was read as no token and answered `404`. A `token` that is
    not text gets the `404` a wrong one gets, where it was a `500` for a request that is
    there and a `404` for one that is not, which told the ids of real requests from the
    rest.
  - `PUT /api/admin/backup` **keeps what it is not sent.** A save of part of the settings
    wrote the defaults over the rest: `{}` switched the schedule off and deleted every
    destination, and is `400` `No valid fields to update` now. `schedule` is one of
    `disabled`, `hourly`, `every6h`, `every12h`, `daily` and `weekly`; `scheduleTime`
    `HH:MM`, `''` being 02:00 as before; `scheduleDay` 0 to 6; `retention` a whole number
    from 1 to 100; `notifyOnFailure` `true` or `false`; `notifyEmail` one address or more,
    read as a schedule's `recipients` are and stored separated by commas, or `''`;
    `destinations` a list of destinations, each a text `name`, a `type` of `sftp`, `s3`,
    `gdrive` or `onedrive`, and the fields of its type, each text but an SFTP `port` (a
    whole number from 1 to 65535, or `null` for 22, as a Port box cleared sends it) and
    Google Drive's `authMethod` (`service_account` or
    `oauth`), named by their place (`destinations[0].port must be a whole number`). Text,
    the `name` included, is at most 2,048 characters, but an SFTP `privateKey` and Google
    Drive's `serviceAccountJson`, which hold a file pasted in, at most 20,000. Any other
    field of a destination is not kept, where each was stored as sent.
    `POST /api/admin/backup/test` reads its destination the same way, and
    `POST /api/admin/backup/gdrive/auth` its `code` and `destName` as text.
  - `POST /api/admin/backup`: a body that is missing, is not JSON or is not an object is
    `400`, where it was read as `{}` and a backup run to every destination. `destination`
    is text.
  - `PUT /api/admin/smtp`: only `host` and `user` (text of at most 2,048 characters),
    `pass` (text), `fromName` (text of at most 200), `port` (a whole number from 1 to 65535), `secure` (`true` or `false`), `fromAddress` (an
    address) and `appUrl` (an `http` or `https` address, or `''`) are read, each by its
    rule, where a port of `"abc"` or a host of `5` was stored as sent. An App URL with no
    scheme, `kanban.example.com`, was stored as typed and read as `http://`; it is stored
    with `http://`, as it is read, and one that is no host after that (`/kanban`,
    `ftp://kanban.example.com`) is refused. A body with none of them is `400`
    `No valid fields to update`, as the backup settings answer one, where `{}` was `200`
    with nothing saved. `POST /api/admin/smtp`: `to` is an address, or `''` for the
    caller's own.
  - **Refused now, where it was taken, and left so:** a recipient of an emailed report
    written with a name, `John Smith <john@example.com>`, is `400`
    `recipients[<n>] must be an email address`, where it was dropped and the report sent
    to the rest without a word; the first save of the mail settings with no From address
    is `400` `fromAddress must be an email address`; and a name past the new limits, a
    board's or a column's renamed past 200 characters among them, is `400`
    (`name must be at most 200 characters`, `Column title too long (max 200 chars)`). The
    board page says that a column's rename was refused, in the server's words, and keeps
    the old title (card 2134); it showed the new title until the next load.
- **Every id in the path or the query string of those routes is read as an id**: `1.5`,
  `abc`, `0` and `1e3` are `400` `Invalid <thing> ID`, or `Invalid boardId` and
  `Invalid userId` on `GET /api/audit`. That is `DELETE /api/account/api-keys/{id}`, where
  `1.5` and `0` were looked for; both `POST /api/admin/boards/{id}/...`;
  `DELETE /api/report-schedules/{id}`; every method under `/api/requests/{id}`, with its
  confirmation and messages; `DELETE /api/teams/{id}` and
  `DELETE /api/teams/{id}/members/{userId}`; and every method under `/api/users/{id}`,
  with its password and invite. Some were read as another id, `1e3` as 1000.
- **`GET /api/audit` and `GET /api/logs` read `limit` and `offset` as whole numbers**, as
  `GET /audit-log` reads them: `limit` rounded down and held between 1 and 500, or 1000
  for the system log, `offset` rounded down and 0 or more, and text the default, as
  `limit=0` is, as it was. `limit=-1` answered every entry, and `limit=2.5` was a `500`.
- **A board that is not there is `404` `Board not found` to everyone** on
  `GET /api/boards/{id}/cards` and `GET /api/activity?boardId=`, and only then is one the
  caller cannot open `403`. Everyone but an administrator was answered `403`, and an
  administrator an empty list.
- **`GET /api/milestones` reads `status` as `open` or `closed`**, as `GET /milestones`
  reads it: another is `400` `status must be open or closed`, where it was an empty list.
- **The public request routes tell a caller with no session nothing of a request they
  hold no link to** (card 2132). `GET /api/requests/{id}`,
  `GET /api/requests/{id}/messages` and a reply as the requester on
  `POST /api/requests/{id}/messages`, with no link or a wrong one, are `404`
  `Request not found` whatever the request's state, as for one that is not there, where a
  request that is there was `403` and a reply to a resolved or unconfirmed one `400`. A
  reply from the team with no session is `401` for every id, before the request is looked
  for, where it was `404`, `400` or `401` by the request. The holder of the link is told
  the state as before, and a signed-in caller is still answered `403` for a request that
  is not theirs.
- **The lists the pages read give what the caller may be told** (card 2128).
  `GET /api/users` gives every user's `id`, `username` and `emoji`, and `email`, `role` and
  `createdAt` to an administrator alone, where every signed-in caller was given every
  colleague's address and role. `GET /api/teams` gives every team, and its `members` only
  on the teams the caller is in, or on every one to an administrator.
  `GET /api/board-categories` lists as `GET /board-categories` does above, and
  `POST /api/boards` and `PUT /api/boards/{id}` refuse a `categoryId` of a board category
  outside that list, `403` `No access to this board category`. `GET /api/categories`
  lists the card categories of no board and of the boards the caller can open, where
  every board's was listed. `GET /api/burndown?boardCategoryId=` answers as
  `GET /burndown` does above. `GET /api/cards/{id}/context` gives the card categories by
  the same rule, with one the card itself carries from a board the caller cannot open
  marked `carried: true`; one of another board they can open is listed unmarked. It gives
  each person who can be assigned the card by name and emoji, with no `email`. `GET /api/boards/{id}/share` gives each member's `email` to the board's
  owner and an administrator only.
- **The public request form names no board to someone without an account** (card 2128).
  `GET /api/requests/targets` gives a holder of the form token every user and team as
  before and `boards: []`, and a signed-in caller the boards they can open, where it gave
  everyone every board, sub-boards included. `POST /api/requests` does not read
  `desiredBoardId` from a caller with no session: it is not checked, not looked up and not
  stored. From a signed-in caller it is optional, and must be a board they can open: `404`
  `Board not found`, or `403` `No access to this board`, before anything is written.
- **The card window and the plan withhold work on a board the caller cannot open** (card
  2129), as the API's operations above do: the answers of `GET`, `POST` and `DELETE` on
  `/api/cards/{id}/dependencies` and `/api/subtasks/{id}/dependencies`, and
  `GET /api/milestones/{id}/summary` and its PDF.
- **A sub-board the caller cannot open is left out** (card 2130).
  `GET /api/cards/{id}/context` lists only the sub-boards under the card that the caller
  can open, where it listed every one with its name and progress. The board page, the
  dashboard and the breadcrumbs do the same: see
  [Authentication & Security](authentication-security.md#what-a-list-gives).
- **`GET /api/boards/{id}/share` answers a board that is not there `404`
  `Board not found`**, to everyone, before access is asked. It was `403` to everyone but
  an administrator, and an empty list to an administrator.
- **The board page stops a drop onto Complete that the server would refuse, and says so
  when the server refuses one** (card 2130's review). Each card of the board page carries
  `hiddenOpenCount`, the number of cards not complete and not archived (card 2205) on
  sub-boards under it that the caller cannot open, with no name, and the page counts them before the drop as it counts
  the ones it shows; when only those hold the card back it offers no sub-board to open.
  A move that `PUT /api/cards/reorder` refuses is put back, with the server's words in a
  toast, where the card stayed in Complete, with its sound, until the next reload.
- **A card's request origin gives the requester's name and not their address** (card
  2128's review). The board page and All Tasks gave `requestOrigin.requesterEmail`, the
  address of someone who often has no account, to every viewer of the board; no screen
  read it.
- **`GET /api/burndown?milestoneId=`** answers as `GET /burndown?milestoneId=` does above,
  and **`DELETE /api/boards/{id}`** as `DELETE /boards/:boardId` does: it deletes the
  board's card categories with it (card 2128's review), and a board that is not there is
  `404` `Board not found` to everyone, before who is asking is looked at (card 2211,
  below).
- **A card created in a Complete or Done column is completed** (card 2134), by
  `POST /api/cards`, which the card window and Duplicate use, and by accepting a task
  request into such a column (`PATCH /api/requests/{id}`), as `POST /boards/:boardId/cards`
  does above: the stamp, the creator's XP, `card_created` and then `card_completed`, both
  webhooks, and the fireworks on the board. A request accepted into one mails its requester
  "Your request is complete" with its report, after "Request accepted".
- **Accepting a task request records the card it makes** (card 2108): a `card_created`
  entry by the accepter, which delivers `card.created`, a live update to the board, and
  the accepter as the card's `createdBy`. It recorded none of them.
- **Duplicate on a card in a Complete or Done column puts the copy at the end of the
  board's first column that is not one** (card 2134), open. Made beside the original, it
  would have been completed as it was created, with XP for whoever clicked. A board with no
  other column keeps it beside the original, where it is completed.
- **`PUT /api/columns/{id}` refuses a rename into or out of Complete or Done while the
  column holds a card**, `409`, as `PUT /columns/:columnId` does above, and the board page
  says so in the server's words and keeps the old title.
- **The page moves mail nobody about a move they made themselves** (card 2134): a drag,
  the card window and All Tasks mail the card's assignees for every move, as before, but
  not the assignee who made it.
- **Restoring a card is recorded** (card 2108). `POST /api/cards/{id}/restore` and
  `POST /api/boards/{id}/archive` write `card_restored`, with the card's title, as
  archiving writes `card_archived`. A card that is not archived is `200` as it is, with
  nothing written and no live update, where its `updated_at` was set.
- **The pages open on a board that a delete removes or empties are told** (card 2108),
  once the delete is committed: a deleted board, every sub-board deleted with it and the
  board of the card it hung from; every board a purge of the archive took cards from; a
  board whose cards are cleared; and every sub-board removed by any of these or by a card
  or column deleted for good. The update is `{ "type": "board", "action": "deleted" }`,
  `{ "type": "card", "action": "purged" }` or `{ "type": "card", "action": "cleared" }`, and
  for the board a deleted sub-board hung from, which is still there,
  `{ "type": "board", "action": "sub_board_deleted" }`; a board a purge or a clear took
  cards from that went with them, as a board beneath one of its own cards does, is told
  `{ "type": "board", "action": "deleted" }`, and the system log has an `INFO` line naming
  it. Each is sent with no board name, card title or user: the board of a sub-board's card can be read by people
  who could not open the sub-board. A page open on a deleted board shows "Board not
  found", and one on a board emptied reads it again. A member's dashboard is not told of a
  deleted board, which only an administrator can be told of once it is gone, and catches up
  when it is next brought to the front. None of these sent anything.
- **`GET /api/audit`, the Audit page's log, finds an action however it was done** (card
  2127). `action=card_completed` finds `card_completed` and `api:card_completed`, where it
  found the page's alone. Written with `api:` in front, the action means done through the
  API, so `api:*` and `api:card_completed` answer as they did. A new `source`, `ui` or
  `api`, read from the stored spelling as `GET /audit-log` reads it, is `400`
  `source must be "ui" or "api"` for anything else; empty is every source. Only a trailing
  `*` is a wildcard. The Audit page has a Source filter: All, Web application, API.
- **`POST /api/reports/email` says what was sent** (card 2113). With no mail set up it is
  `503` `Mail is not set up on this server, so the report was not sent. The superadmin sets
  it up on the admin page.`, after the caller is checked and before the PDF is built, and
  nothing is sent. Sent to every recipient, `200` `Report sent to <n> recipient(s)`; to
  some, `200` `Report sent to <s> of <n> recipients. Not sent to <addresses>.` and the
  reason below; to none, `502` `The report was not sent.` and the reason, which is
  `The mail server did not accept it. An administrator can see the reason in the system log.`
  Every answer but the `503` carries `results`, one `{ email, success, message? }` for
  each recipient. It was `200` with every `success` true whatever the mail server
  answered, and with no mail set up. The Reports page shows a report sent to some as a
  failure, keeps the dialog open and leaves only the addresses not reached in the box.
- **The card window makes, renames, recolours and deletes labels** (card 2010). A board's
  labels were made only through the API, and a board with none showed no Labels section in
  the card window. The section is now on every saved card, with "+ New label" and "Edit
  labels"; a label made there is put on the card at once, and a delete asks first, since
  it takes the label off every card on the board. For it, **`PATCH /api/labels` is new**:
  `{ id, name?, color? }`, by someone with edit access to the label's board. `id` is read
  first (`400` `Invalid label ID`), the label looked for (`404` `Label not found`) and the
  caller checked (`403` `No edit access to this board`), then `name` and `color` as
  `POST /api/labels` reads them (text, trimmed, of 1 to 200 characters,
  `name cannot be empty`; `color must be a colour written #rrggbb`), and a body with
  neither is `400` `Send name or color to change`. A colour the label already holds, sent
  back unchanged with a new name, is kept, a label made through the API with another
  colour among them. The answer is the label as it is now, and the pages open on its board
  are told once it is saved. Like the other label routes, it writes no activity entry. The
  New Task window no longer shows Labels or Cover: neither did anything there before the
  card was saved.
- **A card's cover is a colour or one of the preset gradients on `PUT /api/cards/{id}`
  too** (card 2010), by the rule `PUT /cards/:cardId` has above, and the board draws a
  card's cover as a strip across its top, which only the card window showed.
  **`recurrenceRule` is not read**: a body that names it changes nothing, and one that
  names it alone is `200` with the card as it was. No page set it and nothing acted on it.
- **`POST /api/xp` is gone** (card 2010). It let an administrator add any amount of XP to
  any name, nothing in DumpFire called it, and it added an amount written as text as
  text. A request to it is `405`. XP is still awarded when a card is completed,
  `GET /api/xp` still gives the board's XP display what it shows, and Reset XP on the
  admin page still clears it.
- **`PUT /api/cards/{id}` refuses a move onto one of the card's own sub-boards** (card
  2141), as `PUT /cards/:cardId/move` does above: `409` with the same message, and nothing
  in the request is saved, a title sent beside the `columnId` included. All Tasks' Move
  window shows the message in a toast and stays open, and the card stays where it was. A
  board that was already beneath one of its own cards no longer stops the server when it is
  opened, and the server names such boards in the system log, the first 20 and then how
  many more, at each start and as soon as an imported backup brings one (card 2142): see [Admin Operations Guide](admin-guide.md#a-board-beneath-one-of-its-own-cards).
- **The web application's routes record and tell what their API twins do** (card 2143).
  `POST` and `DELETE /api/cards/{id}/assignees`, `PUT /api/cards/{id}/comments/{commentId}`,
  `POST /api/boards`, `PUT /api/boards/{id}` and `POST /api/milestones` write the entry
  their operation above writes, with `source` `ui`, in the transaction of the write, and
  send the live update it sends, once that is committed: `{ "type": "card" }` to the
  card's board for an assignment (of someone already assigned too, with no entry and no
  mail), a removal and a comment edited; `{ "type": "board" }` to the board, once, for an
  update that sent a field, beside the updates to the boards a `parentCardId` left and
  joined; and `{ "type": "board", "action": "created" }` to the board a new sub-board's
  card is on. An update that sends no field writes nothing and sends nothing, and is
  still `200`. A milestone of no board writes no entry, and a new milestone sends no
  update. Accepting a task request with an assignee, `PATCH /api/requests/{id}`, writes
  `assignee_added` by the accepter after `card_created`. The answers are unchanged. So the
  Audit page and a board's Activity Log show these actions done on a page, and other open
  pages refresh after them.
- **Clearing or deleting a board that is not there is `404` `Board not found`** (card
  2211), and nothing is changed, recorded or sent.
  `POST /api/admin/boards/{id}/clear-cards` and
  `POST /api/admin/boards/{id}/clear-categories` answer so to an administrator; anyone
  else is still refused `403` `Forbidden` first, whether the board is there or not.
  `DELETE /api/boards/{id}` answers so to everyone, before who is asking is looked at, as
  `DELETE /boards/:boardId` does. Each was `200` for a board that was not there, the
  session delete `403` to anyone but an administrator, and the admin page said the cards
  were cleared, or the board deleted, for a board deleted in another tab.
- **`GET` and `PUT /api/account/notifications` answer and save `email_request_progress`
  and `email_mentions`** (card 2146), each `true` or `false` as the other keys are.
  Neither was answered or saved, so neither could be switched off: My Account's Request
  Progress went back on at every reload, and the mention mail could be stopped only by
  switching all mail off. My Account now has a Mentions switch. The keys are listed in
  [Notifications & Email](notifications-email.md#user-notification-preferences).
- **The card window sends no `colorTag`** (card 2147), on `PUT /api/cards/{id}` and
  `POST /api/cards`. It sent `''` with every save from a board or the plan page, which
  cleared a tag set through the API; such a tag now survives a save there, and the save's
  `card_updated` entry no longer names `colorTag`. Duplicate still copies a card's tag,
  and the field is read on both routes as before.
- **The subtask window offers no colour tag, and sends none** (card 2185), on
  `POST /api/subtasks` and `PUT /api/subtasks/{id}`. The colour it offered was stored and
  drawn nowhere; a colour set through the API now survives a save there, and a subtask it
  creates is stored with `''`. A subtask's `colorTag` is still accepted and returned by
  both trees, and Duplicate still copies it; no screen sets or shows it.
- **The web application's routes read a colour as the API's do** (card 2162): `color` on
  `POST /api/board-categories`, `PUT /api/board-categories/{id}`, `POST /api/categories`,
  `PUT /api/categories/{id}`, `POST /api/columns`, `PUT /api/columns/{id}`, and `POST` and
  `PATCH /api/labels`, and `colorTag` on `POST /api/cards`, `PUT /api/cards/{id}`,
  `POST /api/subtasks` and `PUT /api/subtasks/{id}`, each a colour written `#rrggbb` (a
  colour tag may be `''`), with the same refusals, where `PUT /api/categories/{id}` and
  `PUT /api/board-categories/{id}` took any text of 1 to 32 characters. Duplicate, and the
  card window's subtasks made with a new card, copy a colour tag only when it is one, and
  `''` otherwise, so a copy is never refused over a tag stored before the rule.
- **A report's recipients are read as the mailer reads them, and bounded** (card 2182). Any
  address may still be one. `POST /api/reports/email`, `POST /api/report-schedules`,
  `PUT /api/report-schedules/{id}`, the scheduler and the Reports page read a list one way:
  split on commas, semicolons and white space (spaces, tabs, new lines), each part
  lower-cased, a repeat dropped, and a part written `<address>` read as the address inside;
  an address has one `@` with a dot after it, none of `< > ( ) [ ] \ , ; : "`, and no
  control or format character (a right-to-left override, U+202E, would make the address
  shown differ from the one mailed). Each address is sent one mail, once.
  - `POST /api/reports/email`: more than 10 distinct addresses is `400`
    `A report can be emailed to at most 10 addresses at a time, and this names 12. Nothing was sent.`,
    before the board or the caller's access is looked at, administrators included. An
    entry the mailer would send to someone other than it shows (`a@b.c<x>` goes to `x`), or
    with no dot after its `@`, is `400` `recipients[<n>] must be an email address`, as any
    entry that is not an address is. `results` carry each address lower-cased.
  - One account's report mail reaches at most 100 addresses a day: `429`
    `Reports can be emailed to at most 100 addresses a day from one account, and this would make 104. Try again in 5 hour(s).`
    (minutes under an hour), with nothing built or sent, taken after the `503` and before
    the PDF. A schedule made (`POST`), turned on, or given a new `frequency`, `dayOfWeek`,
    `dayOfMonth` or `timeOfDay` (`PUT`) takes its addresses from the same 100: `429`
    `Report mail can reach at most 100 addresses a day from one account, and this schedule's 10 would make 104. The schedule was not saved. Try again in 5 hour(s).`
    (`… was not changed.` on the `PUT`), nothing saved. Otherwise a `PUT` that changes
    `recipients` takes the addresses the new list adds, those not in the stored list (one
    address changed to ten takes nine), refused in the same way with
    `this schedule's 9 new addresses would make 109`; the stored list sent back in another
    order or case, or cut down, a change of name or filter, and turning one off take
    nothing; a delete gives nothing back; a scheduled run takes nothing. The day is 24 hours
    from the account's first take, in memory, so up to 200 can go across one day's end and
    the next's start.
  - `POST` and `PUT /api/report-schedules`: more than 10 addresses is `400`
    `A schedule can be sent to at most 10 addresses, and this names 12. The schedule was not saved.`
    (`… was not changed.`); a part that is not an address is `400`
    `recipients holds "smith", which is not an email address`, or
    `recipients holds "alice", "smith", which are not email addresses`, up to five named,
    then `and 3 more`. `recipients` is stored as the addresses it is sent to, lower-cased,
    each once, separated by `, `. A list sent back as it is stored is kept unchecked.
  - `POST /api/report-schedules`: an account's 21st schedule is `409`
    `You have 20 report schedules, the most one account may have. Delete one first.`; an
    account that already has more keeps them all and is told
    `You have 25 report schedules, and the most one account may have is 20. Delete 6 first.`
  - A schedule kept from before with more than 10 addresses is switched off at its next
    run, sends nothing, and writes one `ERROR` line under `REPORTS`, with its owner as the
    line's user:
    `Report schedule 12 "Weekly sales", owner "pat" (user 7), was switched off: it is sent to 15 addresses, and the most is 10. Nothing was sent. Its owner can delete it and make it again with at most 10.`
    `PUT` with `enabled: true` on it while it is off is `400`
    `This schedule cannot be turned on: it is sent to 15 addresses, and the most is 10. Delete it and make it again with at most 10.`;
    with a list of 10 or fewer in the same `PUT`, it is accepted. On one still on,
    `enabled: true` sent back with the row is not a turning on, and is accepted. The Reports page shows
    such a schedule's addresses to copy, with "Copy the ones to keep into a new schedule of
    at most 10, then delete this one."
  - A stored part that is not an address is never sent to, and the run's line ends
    `Left out, as not email addresses: "alice", "smith".` Every scheduled mail says
    "Set up by `<username>`", as the one sent by hand says "Sent by". See
    [Notifications & Email](notifications-email.md#who-a-report-can-be-mailed-to).
- **Sign-in waits after five wrong passwords at one account** (card 2177), on the login
  form, from any number of addresses: every sign-in at the account from a browser not
  remembered for it, the right password included, waits 1, 2, then 4 seconds before its
  password is checked, until 15 minutes pass with no wrong password or the right one is
  given. The wait itself refuses nothing, and the answer's status and words do not change;
  card 2194, below, adds a refusal while it lasts. Ten attempts from one address in 15
  minutes are still refused `429` "Too many login attempts", at once and not counted at the
  account. The Sign In button reads "Signing in…" while it waits. See [Authentication &
  Security](authentication-security.md#guessing-a-password-at-sign-in).
- **A browser that has signed in is remembered, and other browsers are let in one at a time
  while an account is being guessed at** (card 2194), on the login form. A sign-in that
  succeeds, a password changed on the Account page, an invite used, set-up and a sign-out
  with an open session set a cookie, `dumpfire_known_<user id>` (`Path=/login`, `HttpOnly`,
  `SameSite=Strict`, a year), that lets that browser past the account's wait, the
  one-at-a-time rule and the per-address limit, until the account's password is set again.
  While an account (or a name that is no account) has had five wrong passwords within 15
  minutes of each other, a browser not remembered for it is let in only while fewer such
  sign-ins are in flight there than the free guesses left, and never fewer than one: the
  rest are answered at once `429` "A sign-in with this name is already under way from
  another browser. Wait a few seconds and try again, or sign in from a browser you have used
  here before.", counted at their address and not at the account. Nothing was refused for
  the account before. A remembered browser is refused in the same words, counting nothing,
  only while five of the account's sign-ins from remembered browsers and current-password
  checks are already in flight. See [Authentication &
  Security](authentication-security.md#browsers-that-have-signed-in-before).
- **The login form, an invite's form and set-up can answer `503`** (card 2191) when 150
  password checks for each thread are already waiting (about thirty seconds of them on a
  fast host, a minute or more on a small one), or the caller has gone before a
  thread was free for theirs: "Sign-in is very busy right now. Wait a minute and try again,
  or sign in from a browser you have used here before.", and on the other two "The server is
  very busy checking passwords right now. Wait a minute and try again." Passwords are hashed
  and checked on worker threads, never on the server's own. A name that is no account is now
  checked as slowly as a wrong password at an account (card 2192), so the time taken no
  longer tells which names are accounts.
- **`PUT /api/account/password`, `PUT /api/account/email` and `POST /api/account/api-keys`
  can answer `409`** "Your password was changed while this was being saved. Nothing was
  changed. Try again." (card 2191) when the account's password was changed twice while the
  request was being saved; once, and the current password is checked against the new one, as
  before. Nothing is written. Each can also answer `429` "The server is very busy checking
  passwords right now. Wait a minute and try again." when five of the account's
  current-password checks and sign-ins from remembered browsers are already in flight, with
  nothing counted or checked. So one account keeps at most five password checks in the
  first lane, which goes ahead of the rest, plus the new hash of each password change it
  completes (`PUT /api/account/password` makes its hash after giving its place back). That
  cannot starve the second lane (sign-ins from browsers not remembered, invites and set-up),
  which is served at least every fourth job the threads take. See [Authentication &
  Security](authentication-security.md#off-the-servers-thread-card-2191).
- **A sign-in that succeeds gives back only the attempts its address made at that account**
  (card 2226): attempts at another account, at a name that is no account, and refusals stay
  counted to the end of the 15 minutes, where the whole count was cleared. Sign-in and the
  public request form (`POST /api/requests`, `GET /api/requests/targets`, `POST
  /api/requests/{id}/confirm`) count an IPv6 address by its /64 network, an IPv4 address
  written as IPv6 as the IPv4 address, and no port (card 2195).
- **A failed sign-in's log line holds nothing that was typed** (card 2193), in `GET
  /api/logs` and on the Audit page: `Failed login attempt at "alice" (user 12) from IP …
  (bad password)` with the account as the line's user, or `Failed login attempt for a name
  that is no account (17 characters) from IP …`, each with the address as its `ip`. The
  lines already stored for names that were no account are rewritten that way at the first
  start, and in every backup.
- **Sub-boards nest at most 20 levels deep in the web application too** (card 2172), as
  `POST /boards` and `PUT /cards/:cardId/move` above: `POST /api/boards` with a
  `parentCardId` is `409` in the same words, and so is `PUT /api/cards/{id}` with a
  `columnId` on another board, with nothing in the request saved. `PUT /api/boards/{id}`
  with a `parentCardId` is `409`
  `Board "<name>" cannot go under this card: it and its sub-boards would then be nested more than 20 levels deep.`
  when the board, or one beneath it, would be deeper than 20 and deeper than it is now. A
  board in or below a loop counts as past the limit. The board page says each refusal:
  the card menu's Create Sub-board in an error toast
  (`No answer from the server. The sub-board may not have been made.` when there is none),
  and the new-card window for each sub-board refused, `Sub-board "<name>" was not made.`
  and the server's words, the card kept. Its breadcrumbs show the nearest 20 boards
  above, and a "…" titled "More boards above", with no link, when there are more; its Link
  existing board list is empty on a board 20 deep.
- **`PUT /api/cards/reorder` names at most 5,000 cards, each once, and moves at most 100 to
  another column** (card 2209). More entries is `400`
  `A reorder can name at most 5,000 cards, and this names 5,001. Nothing was moved.`, and a
  card named twice `400` `updates names card 12 more than once`, each checked before any
  card is read (a card named over and over, to and fro between two columns, was a real
  move for every entry, past the cap below); more cards moved is `400`
  `At most 100 cards can be moved to another column at once, and this moves 101. Nothing was moved: move them in groups of 100 or fewer.`,
  checked once every card and column has been read and the caller found able to edit the
  board. Nothing moves and nothing is sent. The board page's drop sends every card of the
  board and moves one; only a bulk move of more than 100 selected cards meets the cap, and
  the page now says so in an error toast and keeps the selection
  (`No answer from the server. The cards may not have been moved.` when there is none),
  where it read no answer. So one request sends at most 100 deliveries to each webhook of
  the board.

### Changes on 2026-10-13

The OpenAPI document's version went from `1.0.0` to `1.1.0` with these. The path is still
`/api/v1/`.

- **The key is `message` on every failure.** Until this date the `401`, the `429` and the
  `409` of each rejected batch carried their text as `error`, and the `409` of a dependency
  cycle on a card carried a fixed text as `error` beside its `message`. A caller that read
  `error` on those reads `message` now. Their other fields are unchanged.
- **A dependency cycle is told by `cycle`, not by its text.** The cycle's `message` holds
  the chain in words, as it did before. What is gone is the `error` key, which held the fixed
  text "That dependency would create a cycle" beside it, and only on the card route. The
  subtask route never had an `error` key: its `409` for a cycle was the `message` alone, and
  now has `cycle` as well.
- **A body that is missing, is not valid JSON or is not a JSON object is answered `400`.**
  It was answered `500`.
- **A body over the size limit is answered `413`.** A deployed server answered it `500`:
  see [The Request Body](#the-request-body).
- **A path that is no route is answered `404` as JSON**, where it was an HTML page, and **a
  method the route does not have is answered `405` as JSON**, where it was plain text. The
  `405` keeps its `Allow` header.
- **A failure is JSON whatever the `Accept` header.** A handler's refusal of a request sent
  with no `Accept` header, or with a browser's, used to be an HTML page.
- **Subtask dependencies answer as card dependencies do.** A subtask that depends on itself
  or on archived work is answered `400`, where it was `409`. Removing a subtask dependency
  that is not there is answered `404`, where it was `200`.
- **A comment answer says what was not found.** On `GET` and `POST`
  `/cards/:cardId/comments`, the `404` for a card whose column cannot be found says
  `Column not found`, where it said `Error: 404`.

Later the same day five operations began to refuse callers they used to let through. The
document's version did not change: each is a `403` on an operation that already answered
one, except the first.

- **`GET /cards/:cardId/assignees` needs view access to the card's board.** It answered
  any key. It now answers `403` as `GET /cards/:cardId` does.
- **`isPublic` on `PUT /boards/:boardId` is the owner's or an administrator's to send.**
  An editor who sends it is answered `403` and none of the request's fields is saved. See
  [`PUT /api/v1/boards/:boardId`](#put-apiv1boardsboardid).
- **A dependency is removed by an editor of the waiting end's board**, on the card route
  and the subtask route alike. See
  [`DELETE /api/v1/cards/:cardId/dependencies`](#delete-apiv1cardscardiddependencies).
- **A comment is edited by its author only while they can edit its board**, which is what
  posting one asks for. See
  [`PUT /api/v1/comments/:commentId`](#put-apiv1commentscommentid).

And two answers to the board's owner or an administrator changed, on an operation that
already answered the status:

- **`isPublic` on `PUT /boards/:boardId` is `true` or `false`, or the answer is `400`.**
  `null` was a `500`, and `1`, `"1"` and `[true]` were saved as true.
- **Removing a dependency writes its activity entry on the board of the end that waits**,
  where it was written on the board of the card in the path. See
  [`DELETE /api/v1/cards/:cardId/dependencies`](#delete-apiv1cardscardiddependencies).

## Writes and Failures

Every write is all or nothing. A request that changes several things (a card, its activity
entry, the XP, an "Unblocked" notice on another card) saves all of them or none.

```mermaid
flowchart TD
    Send["POST, PUT, PATCH or DELETE"] --> Answer{"What came back?"}
    Answer -->|"2xx"| Saved["The change is committed.<br/>It stays committed even if a webhook<br/>or an email that follows it fails"]
    Answer -->|"429"| Limited["Turned away. Nothing was written.<br/>Send it again unchanged,<br/>after the Retry-After seconds"]
    Answer -->|"Any other 4xx"| Refused["Refused. Nothing was written.<br/>Fix the request before sending it again"]
    Answer -->|"500 from DumpFire"| Failed["Failed. Nothing was written.<br/>The request was not at fault:<br/>send it again unchanged"]
    Answer -->|"502, 503 or 504 from a proxy,<br/>a timeout or a dropped connection"| Unknown["Not known. Read the resource<br/>to find out before sending again"]
    Saved --> After["Then, and only then: webhooks,<br/>live board updates, emails"]
```

- **A `500` that DumpFire itself answers to a write means nothing was written.** The
  database is as it was before the request, and no webhook, live update or email was sent
  for it. It is DumpFire's own when its body is the JSON `{ "message": "Internal Error" }`,
  which it is whatever `Accept` header the request sent. The request was not at fault, so
  the same request can be sent again: a `500` is never the answer to a body that cannot be
  read, which is a `400`.
- **A `502`, `503` or `504` is not an answer from DumpFire**, which sends none of them. It
  comes from a proxy in front of DumpFire that got no answer or did not wait for one, so the
  write may or may not have happened. Treat it as no answer at all, and read the resource
  before sending a `POST` again: a second `POST` of a write that did happen makes a second
  card, comment or subtask.
- **A body that is missing, is not valid JSON or is not a JSON object is answered `400`.**
  The same body gets the same answer every time: fix it before sending it again. See
  [The Request Body](#the-request-body).
- **A `429` means nothing was written.** The request was turned away before it reached a
  handler. Send it again, unchanged, after the number of seconds in `Retry-After`.
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
  request's.
- **A `2xx` means the change is committed.** Webhooks and emails are sent after the commit
  and are not awaited. One that fails is logged on the server and does not change the
  answer, so a `2xx` is never followed by a rollback.
- **A `4xx` means nothing was written**, including for a request that was partly valid. A
  `PUT /api/v1/cards/:cardId` with a new milestone and a title that is too long changes
  neither.
- **A webhook is only ever sent for a change that was saved.** A receiver is never told of a
  move, a completion or a delete that was then undone.
- **A batch that is refused answers `409` and writes nothing.** See
  [Milestones: Many Cards at Once](#milestones-many-cards-at-once).

## What a Delete Removes

| Request | Removes | Leaves |
|---------|---------|--------|
| `DELETE /api/v1/cards/:cardId` | Nothing. The card is archived: `archivedAt` is set and one `card_archived` entry is written | Everything: subtasks, comments, attachments, dependency links, sub-boards. Restoring the card brings it back whole |
| `DELETE /api/v1/cards/:cardId?permanent=true` | The card, its subtasks, comments, assignees and attachments; every sub-board under it, at every depth, with everything on it; every dependency link that has a deleted card or subtask at either end | Cards that were waiting on a deleted card, which are no longer waiting on it |
| `DELETE /api/v1/columns/:columnId` | The column and **every card in it**, archived or not, each as a permanent card delete | The board and its other columns |
| `DELETE /api/v1/boards/:boardId` | The board, its columns, cards, labels, milestones, webhooks and card categories (since 2026-10-14: the categories were kept, as categories of no board); every sub-board under it, with its categories; the report schedules that name it | Cards on other boards that were in one of its milestones, which are then in no milestone, and any that carried one of its categories, which then has none |
| `DELETE /api/v1/subtasks/:subtaskId` | The subtask and the dependency links that have it at either end | Its card |
| `DELETE /api/v1/milestones/:milestoneId` | The milestone | Its cards, which are then in no milestone |

Attachment files of deleted cards are not removed at once. They are kept on the server for
30 days, so that an administrator who restores an earlier backup has them back.

Ids are never reused. A card created after a delete does not get the deleted card's id.

What a delete records:

| Delete | Activity and audit log (`action`) | Webhook |
|--------|-----------------------------------|---------|
| Archive | `card_archived` | None |
| Restore (`PUT /api/v1/cards/:cardId` with `archivedAt: null`) | `card_restored`, with the card's title, only when the card was archived (since 2026-10-14) | None |
| Card, permanent | `card_deleted`, with `cardId` null because the card is gone | `card.deleted`, once, for the card asked for. Cards on sub-boards under it go with it and get no `card.deleted` of their own |
| Column | `column_deleted`, once for the column. Its detail names the column and how many cards went with it | None, for the column or for any of its cards |
| Board | None. The board's own log is deleted with it | None |
| Subtask | `subtask_deleted`, on its card, naming the subtask (since 2026-10-14: there was none) | None |

In `GET /api/v1/audit-log`, `action=column_deleted` finds column deletes made in the web UI
and through the API alike.

Pages open in the web application are told of each of these once it is committed: the
board of the card, subtask or column, and every board a delete removed, a deleted board
itself among them, and the board of the card a deleted sub-board hung from (since
2026-10-14: a deleted board's pages, and its sub-boards', were told nothing). The update
names nothing that went, and the page reads the board again.

---

## Endpoint Overview

```mermaid
flowchart TB
    subgraph Auth["Authentication"]
        Me["GET /me"]
        MeStats["GET /me/stats"]
    end

    subgraph Boards["Boards"]
        ListBoards["GET /boards"]
        GetBoard["GET /boards/:id"]
        CreateBoard["POST /boards"]
        DeleteBoard["DELETE /boards/:id"]
    end

    subgraph Columns["Columns"]
        DeleteColumn["DELETE /columns/:id"]
    end

    subgraph Milestones["Milestones"]
        BulkAttach["POST /milestones/:id/cards/bulk"]
        BulkDetach["DELETE /milestones/:id/cards/bulk"]
    end

    subgraph Cards["Cards"]
        ListCards["GET /boards/:id/cards"]
        CreateCard["POST /boards/:id/cards"]
        GetCard["GET /cards/:id"]
        UpdateCard["PUT /cards/:id"]
        DeleteCard["DELETE /cards/:id"]
        MoveCard["PUT /cards/:id/move"]
        BoardHistory["GET /cards/:id/board-history"]
    end

    subgraph Reporting["Reporting & Audit"]
        Report["GET /reports/activity"]
        Burndown["GET /burndown"]
        Audit["GET /audit-log"]
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
        GetComment["GET /comments/:id"]
        EditComment["PUT /comments/:id"]
    end

    subgraph Dependencies["Dependencies"]
        CardDeps["GET, POST, DELETE /cards/:id/dependencies"]
        SubtaskDeps["GET, POST, DELETE /subtasks/:id/dependencies"]
        BulkDeps["POST /dependencies/bulk"]
    end

    subgraph Tokens["Token Cost"]
        CardTokens["GET, POST /cards/:id/tokens"]
        SubtaskTokens["POST /subtasks/:id/tokens"]
        BulkTokens["POST /tokens/bulk"]
        DeleteToken["DELETE /tokens/:entryId"]
    end
```

The diagram shows the routes this reference describes. Every route is in the OpenAPI
document at `/docs`.

---

## Reporting

### `GET /api/v1/reports/activity`

A whole management activity report in one call — what previously took 229 calls
and about 18 minutes of hand collation.

| Param | Default | Meaning |
|---|---|---|
| `userId` | everyone | Report on one person, by id (`400` `userId must be an integer` otherwise). Another user requires admin. |
| `from`, `to` | last 30 days | Each a date (`2026-10-14`) or a timestamp; anything else is `400` `from is not a date`. Bare dates are whole days; `to` is inclusive. A timestamp with an offset, or with no zone, is read in UTC. `from` after `to` is `400`. |
| `boardIds` | all visible | Comma-separated ids; one that is not a whole number of 1 or more is `400` `boardIds must be a comma-separated list of ids`. |
| `include` | — | `subtasks`, `comments` |
| `commentLimit` | 3 (max 20) | Most recent comments per card: a whole number, 0 or more. `0` gives each card an empty `comments` list, more than 20 is read as 20, and a negative number or a fraction is `400` `commentLimit must be a whole number of 0 or more`. |

Cards are grouped by board and bucketed `completed`, `closed`, `progressed`,
`on hold`, `created`. **Completion is decided by each card's `completedAt`, never
by audit events**, so a window predating the audit-completeness work still
reports correctly.

`meta` carries the caveats that make a figure quotable —
`closeReasonAssumedCount`, `completedOutsideWindow`, `missingSummaryCount`,
`attribution`, `boardsExcludedForAccess`. Read it before quoting a headline
number.

Full design rationale: [Management Activity Reporting](management-reporting.md).

### `GET /api/v1/burndown`

How much work was open on each UTC day, and where it is heading, for any slice
of the workspace. Rebuilt from each card's created, completed and archived dates
rather than daily snapshots, so every filter works over any window up to 730
days.

| Param | Default | Meaning |
|---|---|---|
| `boardIds` | — | Comma-separated; view access to each is required. |
| `boardCategoryId` | — | Every board in the group that you can see. Not with `boardIds`. A group that holds boards, none of which you can open, is `403` (since 2026-10-14; it was charted empty under its name). |
| `milestoneId` | — | The milestone's cards; combine with `boardIds` to narrow. |
| *(no scope)* | — | Every board you can see. |
| `categoryIds`, `labelIds` | any | `categoryIds=none` = uncategorised. |
| `assigneeIds` | anyone | `me`, `none`, or user ids. |
| `priorities` | any | `critical,high,medium,low` |
| `from`, `to` / `days` | 30 days to today | A milestone defaults to since its creation. |
| `target` | milestone's date | `YYYY-MM-DD` draws the ideal line; `none` hides it. |
| `groupBy` | `none` | `board`, `category`, `label`, `assignee`, `priority` |
| `options` | `false` | `true` adds faceted filter values with counts. |

Returns `series` (per day: `scope`, `done`, `remaining`, `added`, `completed`,
`removed`), `summary`, `forecast` (`converging` with a `projectedDate`,
`not-converging`, `done` or `insufficient-data`, measured over the trailing 28
days), `delivery`, `target` (`onTrack`, `daysLate`) and `groups`. `forecast.spansBoards`
is `true` when the cards that pass the filters sit on more than one board: the forecast's
dates are then pooled across boards and are not when the work finishes; read `delivery`.

`delivery` answers "how long will the work open now take?": a seeded Monte Carlo
over the scope's own daily completions, giving `p50` (likely), `p85` and `p95`
finish dates and, with a target, `chanceByTarget`. It assumes nothing new is
added and reports `arrivalPerWeek` beside it. Every group has one too. Across
several boards `method` is `slowest-board`: each board is simulated at its own
pace, the dates are when the slowest is done, `bottleneck` and `parts` say which
boards set them (boards with no recent pace are listed but left out of the
dates), and `pooled` keeps the one-pile figure. `basisFinished` under 5 means
the dates rest on thin evidence.
`meta.inferredInWindow` says how many estimated completion dates fall inside the
window. **Read `meta.notes`
before quoting a figure** — it names every assumption that bears on the result.
Every bad parameter is a 400 that names it.

Full design: [Burndown Charts](burndown-charts.md).

### `GET /api/v1/audit-log` (admin)

Params: `boardId`, `userId`, `cardId`, `action`, `source` (`ui` | `api`), `from`,
`to`, `limit` (default **100**, max **500**), `offset`.

`boardId`, `userId` and `cardId` are ids, read as an id in the path is: one that is not a
whole number of 1 or more is `400` `Invalid board ID` (`Invalid user ID`,
`Invalid card ID`). `limit` and `offset` are never refused: each is rounded down, `limit`
is held between 1 and 500 and `offset` is 0 or more, and text that is not a number is the
default, as `limit=0` is. `limit=-1` is one entry, where it was every entry.

UI and API actions share one vocabulary. `action` comes back canonical (no `api:`
prefix) so one filter matches both sources; `rawAction` keeps the stored
spelling; `source` says which. A completion is logged as `card_completed`
whichever route performed it.

In the `action` filter only a trailing `*` is a wildcard: `card_*` finds `card_moved`,
`card_completed` and the rest, and not `cards_purged` or `cards_cleared`. A `%` or a `_`
in it is matched as itself. Until 2026-10-14 the `_` of a prefix was read as any one
character, and `card_*` found those two as well. An `api:` in front of the action is read
as part of its spelling, so `api:card_completed` asks what `card_completed` asks: filter
by `source=api` for what was done through the API.

`pagination` carries `total` and `hasMore` — check it, because a full default
page of 100 used to be indistinguishable from a complete result.

### `GET /api/v1/cards/:cardId/board-history`

Which board a card was on, and when — spans oldest first, `to: null` on the
current one. Needed because a card that changes board mid-window appears in the
audit log under two different `boardId`s.

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

#### `GET /api/v1/me/stats`

How the key's user is doing. Takes no parameters.

```json
{
  "cardsCompleted": { "total": 41, "last7Days": 3, "last30Days": 12 },
  "avgCycleTimeDays": 4.2,
  "streak": 2,
  "activeCards": 5,
  "recentActivity": [
    { "id": 9120, "action": "api:card_updated",
      "detail": "Updated fields: priority on \"Deploy v2.1\"",
      "boardId": 1, "createdAt": "2026-10-13 09:41:07" }
  ]
}
```

| Field | Meaning |
|-------|---------|
| `cardsCompleted` | Completions the activity log records as this user's, made in the web UI or through the API: in all, in the last 7 days and in the last 30 |
| `avgCycleTimeDays` | Mean days from a card's creation to its completion, to one decimal place, over the completed cards the user is assigned to. `null` when there is none, and `0` when they were completed as they were made |
| `streak` | Consecutive UTC days with at least one completion, counted back from today, or from yesterday if there is none today |
| `activeCards` | Cards the user is assigned to that are neither completed nor archived |
| `recentActivity` | The user's last 20 activity entries on boards they can open, newest first: an entry on a board they have been taken off is left out. `action` is as stored: one made through the API has the prefix `api:` |

---

### Boards

#### `GET /api/v1/boards`

List all boards accessible to your API key.

#### `GET /api/v1/boards/:boardId`

Get a single board with its columns. A board that does not exist is `404`
`Board not found` to everyone; one that is there and the key's user cannot open is `403`.
Every operation under `/boards/:boardId` answers in that order.

#### `POST /api/v1/boards`

Create a new board. Default columns (To Do, On Hold, In Progress, Complete) are created automatically.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | ✅ | Board name, trimmed, 1 to 200 characters |
| `emoji` | string | | Board icon, 1 to 32 characters (default: 📋) |
| `parentCardId` | number or null | | Link as sub-board to a card, by its id. Needs edit access to the board that card is on: `404` if there is no such card, `403` if the caller cannot edit its board. `409` `Sub-boards can be nested at most 20 levels deep, and a board under this card would be deeper.` if that board is already 20 levels below a board that is not a sub-board, or is in or below a loop, and nothing is created (card 2172) |

A new board has nothing to look for, so its fields are read first, and the parent card is
looked for after.

A sub-board sends a live update, `{ "type": "board", "action": "created" }`, to the pages
open on the board its card is on, so it shows on the card without a reload (card 2143). A
board made at the top level sends none.

#### `PUT /api/v1/boards/:boardId`

Update the fields sent, at least one of them. Answers the board.

| Field | Type | Who may send it | Description |
|-------|------|-----------------|-------------|
| `name` | string | Anyone with edit access to the board | Board name, trimmed, 1 to 200 characters |
| `emoji` | string | Anyone with edit access to the board | Board icon, 1 to 32 characters |
| `categoryId` | number or null | Anyone with edit access to the board | The dashboard grouping the board is filed under, or `null` for none. One that does not exist is `404` `Board category not found` |
| `isPublic` | boolean | The board's owner, or an administrator | Whether everyone who is signed in can view the board |

The board is looked for and the caller checked first (`404`, then `403`), then the fields
are read. A value the board already holds, sent back unchanged, is accepted as it is.

`isPublic` decides who can see the board, as sharing it does, and is the owner's to decide.
Sent by an editor who is not the owner, the whole request is answered `403` with
`Only board owners and admins can change visibility`, and none of its fields is saved, the
name that came with it included, whatever value was sent. An editor leaves `isPublic` out.
From the owner or an administrator it is `true` or `false`: anything else, `null`, `1`
and `"true"` among them, is answered `400` with `isPublic must be true or false` and
nothing is saved.

This operation takes no `parentCardId`. A board is put under a card, or taken out from
under one, on the board page, by the board's owner or an administrator: see
[Changes on 2026-10-14](#changes-on-2026-10-14).

#### `DELETE /api/v1/boards/:boardId`

Permanently delete a board and everything on it. Requires the board's owner or an
administrator. Answers `{ "success": true }`.

Its columns, cards, labels, milestones and webhooks go with it, and so does every sub-board
under any of its cards, at every depth. The report schedules that name the board are
deleted, and so are its card categories and its sub-boards': a card on another board that
carried one has none. Until 2026-10-14 they were kept, as categories of no board, which every
key is given. Cards on other boards that were in one of its milestones are kept, in no
milestone. No activity entry is written,
because the board's log is deleted with it, and no webhook is sent. See
[What a Delete Removes](#what-a-delete-removes).

---

### Columns

#### `PUT /api/v1/columns/:columnId`

Update a column: `title`, `color`, `position`, `wipLimit` and `showAddCard`. A title that
would make the column a Complete column (one called Complete or Done, case and spaces
aside), or stop it being one, is `409` while the column holds any card, archived ones
included, and nothing is written. A card is finished because of the column it is in, so
the rename would turn finished work back into open work, or make cards finished that
nobody finished. An empty column is renamed freely, and so is one whose new title keeps
what it means: Complete to Done, To Do to Backlog. The message says how many cards the
column holds and, when any are, how many of them are archived:

```json
{ "message": "This column holds 3 cards, 1 of them archived. They count as finished because the column is called Complete or Done, and renaming it to \"Shipped\" would turn them back into open work. Keep it called Complete or Done." }
```

Into a Complete column it reads `This column holds 1 card. Renaming it to "Done" would mark
it finished without anyone finishing it. Move each finished card to a Complete column and
the rest out of this one first, or choose another name.` So a Complete or Done column that
holds any card can be renamed only to Complete or Done. Until 2026-10-14 the title was
saved, and every card in the column became finished, or open, by its new title alone.

#### `DELETE /api/v1/columns/:columnId`

Permanently delete a column **and every card in it**. Requires edit access to the board.
Answers `{ "success": true }`.

The cards are deleted for good, not archived, each with its subtasks, comments, dependency
links and sub-boards. Move the cards to another column first if they are to be kept. One
`column_deleted` entry is written to the board's activity log, naming the column and how
many cards went with it. No `card.deleted` webhook is sent for the cards.

---

### Cards

Each card has a unique numeric ID shown in the UI as `#N`. You can search for cards by ID in both the board view and All Tasks view.

#### `GET /api/v1/boards/:boardId/cards`

List cards on a board.

| Parameter | Type | Description |
|-----------|------|-------------|
| `columnId` | number | Filter to specific column. A whole number of 1 or more, or `400` `Invalid column ID` |
| `archived` | boolean | Include archived cards |

#### `POST /api/v1/boards/:boardId/cards`

Create a card.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `columnId` | number | ✅ | Target column, one of this board's: `400` `Column does not belong to this board` otherwise |
| `title` | string | ✅ | Card title, trimmed, 1 to 500 characters |
| `description` | string | | Markdown description, at most 50,000 characters |
| `priority` | string | | `low` / `medium` / `high` / `critical`, in any case, stored in lower case |
| `dueDate` | string or null | | A day of the calendar written `YYYY-MM-DD`; `''` is none |
| `businessValue` | string | | Business justification, at most 10,000 characters |
| `colorTag` | string | | A colour written `#rrggbb`, or `''` for none |
| `categoryId` | number or null | | A category of this board, or one that belongs to no board: `404` `Category not found on this board` otherwise |
| `position` | number | | Position in column |
| `summary`, `theme`, `customerImpact`, `closeReason`, `releaseState` | string or null | | The reporting fields, each in its own vocabulary |

The board is looked for and the caller checked first (`404`, then `403`), then every field
is read (`400`, see [What a Field May Hold](#what-a-field-may-hold)), and then the column
and the category the body names are looked for.

A card created in a Complete or Done column is completed as it is created, by the rule a
move into one follows: `completedAt` and `firstCompletedAt` are the moment it was created,
the key's user is given the XP for its priority, `api:card_created` and then
`api:card_completed` (`"<title>": created in <column>`) are logged, the board's webhooks
get `card.created` and `card.completed`, and open pages get the celebration. The check for
open subtasks and sub-boards is not made: a new card has neither. The answer is the card as
written, with its `completedAt`. Until 2026-10-14 such a card had no completion date, no XP
and no `api:card_completed` entry.

#### `GET /api/v1/cards/:cardId`

Get a card with subtasks, labels, and assignees.

#### `PUT /api/v1/cards/:cardId`

Update card fields. Only include fields you want to change: `title`, `description`,
`priority`, `colorTag`, `categoryId`, `dueDate`, `onHoldNote`, `businessValue`, `pinned`,
`coverUrl`, the five reporting fields, `milestoneId` and `archivedAt`, each by the rules of
[What a Field May Hold](#what-a-field-may-hold). A body with none of them is `400`
`No valid fields to update`.

The card is looked for and the caller checked first (`404`, then `403`), then every field
is read (`400`), and then what the body names: the category (`404`
`Category not found on this board`) and the milestone. A value the card already holds, sent
back unchanged, is accepted as it is, whatever the rules say of it: a card filed under
another board's category keeps it while it is sent back.

Only what changed is recorded (card 2183). A field sent with the value the card already
holds is not a change, and `null` and `''` are the same value when comparing (`description`, `onHoldNote` and `businessValue` still take text only, and `''` clears them); a reporting value is
compared in the spelling it is stored in. A request that changes nothing writes nothing, so
`updatedAt` stays, records no activity entry, sends no `card.updated` webhook and no live
update, and answers `200` with the card as it is. One that changes some fields writes,
names in `api:card_updated` and announces those alone. Until 2026-10-14 every field sent
was written and named, changed or not.

- **`archivedAt`** may only be `null`, which restores an archived card, as the tracking
  workflow restores one. Any other value is `400`
  `archivedAt may only be null, which restores the card. Archive a card with DELETE /cards/{cardId}`;
  the stamp the card already holds, sent back, changes nothing. A restore writes
  `api:card_restored`, with the card's title, and `api:card_updated` is written only for
  the other fields sent, so a restore alone delivers no `card.updated` webhook. An
  `archivedAt` that changes nothing, `null` on a card that is not archived or the stamp the
  card holds, is not a change and is not named. Until 2026-10-14 a restore was
  recorded as `api:card_updated` naming `archivedAt`.
- **`milestoneId`** puts the card in that milestone, with edit access to it, and only a
  board's own card in a milestone of one board; an archived card is `400`
  `Card does not exist or is archived`. `null` takes the card out of its milestone, which
  needs edit access to that milestone as putting it in did (`403`
  `No edit access to this milestone`), and so does putting the card in another milestone,
  which takes it out of this one. `archivedAt: null` sent with a `milestoneId` restores the
  card first.
- **`coverUrl`** is the card's cover, drawn as a strip across the top of the card on the
  board: a colour written `#rrggbb`, or one of these eight gradients, written exactly so,
  or `null` (`''` is read as `null`). Anything else, an address or a style among them, is
  `400` `coverUrl must be a colour written #rrggbb, one of the preset gradients, or null`.
  The field's name is older than the rule: it holds a colour, not an address. A cover
  stored before the rule, sent back unchanged, is kept, and is not drawn.

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

`recurrenceRule` is not a field of the update. A card answer carries it and
`nextRecurrence`, and nothing sets or acts on either.

The `400`s are: no field it takes, a field of the wrong type, a title that is empty or over
500 characters, a description or an on-hold note over 50,000, a business value over
10,000, a cover outside the rule above, a priority, colour tag, due date or reporting field
outside its own rule, an `archivedAt` other than `null`, a milestone of another board, an
archived card put into a milestone, a `cardId` that is no id, and a body that cannot be
read.

The update is one transaction. A request that is refused leaves every field as it was, the
milestone included: a `400` for any field, or the refusal of a `milestoneId` the card
cannot join.

#### `DELETE /api/v1/cards/:cardId`

Archive a card. Add `?permanent=true` to hard-delete. Both answer `200` with
`{ "success": true }`.

- **Archive** (the default) sets `archivedAt` and writes a `card_archived` activity entry.
  Nothing else is touched: the card keeps its subtasks, comments, attachments, dependency
  links and sub-boards, and has them all when it is restored. No webhook is sent.
- **`?permanent=true`** deletes the card, its subtasks, comments and attachments, every
  sub-board under it with everything on it, and every dependency link that has a deleted
  card or subtask at either end. It writes one `card_deleted` activity entry and sends one
  `card.deleted` webhook to the board's receivers:

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

`data.cardId` is the id of the card that was deleted. The activity entry for the same delete
has a null `cardId`, because the card it would refer to no longer exists.

That is the only event. The cards on sub-boards under the deleted card are deleted with it,
and no `card.deleted` is sent for any of them.

#### `PUT /api/v1/cards/:cardId/move`

Move a card to a different column, on the same board or another one (edit access
is needed on both). Goes through the same service as a drag in the web UI:

- into a Complete/Done column: `completedAt` is stamped, `firstCompletedAt` is set
  if it was not already, XP is awarded the first time only, and `card_completed` is
  logged. Refused with 409 while subtasks or sub-boards are still open.
- out of a Complete/Done column: `completedAt` is cleared and `card_reopened` is logged.
- out of an On Hold column: a move from a column titled On Hold, Hold, Blocked, Parked or
  Waiting to one that is not clears the card's `onHoldNote` to `''`, in the same write as
  the move, with no entry of its own. The note stays on a move into such a column, between
  two of them, and between two working columns. Until 2026-10-14 only a drag on the board
  page cleared it (card 2208).
- to another board: the source board's labels are removed from the card, and so is
  a category that belongs to another board (a category with no board stays);
  `card_moved_away` and `card_moved_in` are logged, one on each board.
- onto one of its own sub-boards: a card's sub-boards go with it, so a move onto one, or
  onto a board beneath one at any depth, is refused with 409 and nothing moves:
  `Card "<title>" cannot go onto "<board>", which hangs beneath it` (card 2141).
  It is asked only of a move to another board, before the check for open subtasks and
  sub-boards, and an archived card in the chain counts. The card such a loop already hangs
  from can be moved onto a board outside the loop, which is how the loop is put right.
- where its sub-boards would be too deep: sub-boards nest at most 20 levels below a board
  that is not a sub-board, so a move to another board that would carry the card's
  sub-boards deeper than that, and deeper than they are now, is refused with 409 and
  nothing moves: `Card "<title>" cannot go onto "<board>": its sub-boards would then be
  nested more than 20 levels deep.` (card 2172). Asked after the loop check. A card with no
  sub-board is never refused, and a move that lifts a tree already too deep, or leaves it
  no deeper, is allowed.
- mail: a move that completes the card mails its assignees who can open the board it is now on,
  `Card moved: <title> → <column>`, each as their own "Card moved" setting says, as every
  move in the web UI does. A move that does not complete the card mails nobody. Whoever
  made the move is never mailed about it. Until 2026-10-14 no move through the API mailed
  an assignee.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `columnId` | number | ✅ | Target column ID: a whole number of 1 or more |
| `position` | number | | Position in target column: a number, or one written as text. Left out, the card keeps the position it had |

The card is looked for and the caller checked first, then the two fields are read, then
the target column is looked for and the caller checked on its board. Until 2026-10-14 a
`position` that was not a number was ignored, as if it had been left out.

---

### Assignees

#### `GET /api/v1/cards/:cardId/assignees`

List users assigned to a card. Needs view access to the card's board, as reading the card
does: `403` with `No access to this card's board` otherwise.

#### `POST /api/v1/cards/:cardId/assignees`

Assign a user: `{ "userId": 2 }`. The card is looked for and the caller checked first, then
`userId` is read: a whole number of 1 or more, `400` `userId must be an id` otherwise. A
user who does not exist is `404` `User not found`, and one who cannot open the card's board
`400` `User does not have access to this board`.

#### `DELETE /api/v1/cards/:cardId/assignees`

Remove an assignee: `{ "userId": 2 }`. Removing someone who is not assigned to the card is
`404` `User is not assigned to this card`, writes nothing and sends no live update; until
2026-10-14 it was `200`, with an activity entry that said they had been removed.

---

### Subtasks

#### `GET /api/v1/cards/:cardId/subtasks`

List subtasks for a card.

#### `POST /api/v1/cards/:cardId/subtasks`

Create a subtask.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `title` | string | ✅ | Subtask title, trimmed, 1 to 500 characters |
| `description` | string | | Details, at most 50,000 characters |
| `priority` | string | | `low` / `medium` / `high` / `critical`, in any case, stored in lower case |
| `colorTag` | string | | A colour written `#rrggbb`, or `''` for none |
| `dueDate` | string or null | | A day of the calendar written `YYYY-MM-DD`; `''` is none |
| `position` | number | | Position in the card's list |

#### `PUT /api/v1/subtasks/:subtaskId`

Update a subtask: any of the fields above, and `completed`. Set `"completed": true` to mark
done; it is `true` or `false`, and `"false"` is `400`, where it was stored as true. A value
the subtask already holds, sent back unchanged, is accepted as it is, and a body with none
of the fields is `400` `No valid fields to update`. The card or subtask is looked for, and
the caller checked, before a field is read, on both operations.

Completing a subtask writes an `api:subtask_completed` entry, `<subtask> (on <card>)`, then
the "Unblocked" notices, and mails whoever asked for the card when it came from a task
request, as ticking it in the web UI does. A subtask already complete, sent
`"completed": true` again, writes none of it. Until 2026-10-14 this wrote no entry and
mailed nobody.

#### `DELETE /api/v1/subtasks/:subtaskId`

Permanently delete a subtask, together with every dependency link that has it at either
end. The subtask and its links go together or not at all, with an `api:subtask_deleted`
entry naming the subtask. Until 2026-10-14 no entry was written.

---

### Milestones: Many Cards at Once

#### `POST /api/v1/milestones/:milestoneId/cards/bulk`

Put many cards in a milestone: `{ "cardIds": [1686, 1559, 1444] }`, up to 500.

#### `DELETE /api/v1/milestones/:milestoneId/cards/bulk`

Take many cards out of a milestone, with the same body. The cards themselves are untouched.

Both are all or nothing:

- The whole list is checked first. If any card does not exist, is archived, is on a board
  the caller cannot edit or (for an attach) is on another board than a single-board
  milestone, the answer is `409` with every problem listed, and no card is changed.
- If the list passes, every card is attached or detached in one transaction. A failure part
  of the way through answers `500` and leaves every card as it was.
- A card already in the milestone (attach) or not in it (detach) is skipped, not an error,
  so the same list can be sent again. On the single-card `DELETE /milestones/:milestoneId/cards`
  a card that is not in the milestone is `404` `Card is not in this milestone`.
- The milestone is looked for and the caller checked before the list is read. Each entry of
  `cardIds` is a whole number of 1 or more: one that is not, `null` among them, is `400`
  `cardIds[2] must be an id`, where `null` was read as card 0 and reported in the `409`.
- Taking a card out needs edit access to the milestone as well as to the card's board, here
  and on every route that takes one out (`DELETE /milestones/:milestoneId/cards`,
  `milestoneId: null` on `PUT /cards/:cardId`). An attach moves a card that is in another
  milestone, which takes it out of that one: a card in a milestone the caller may not change
  is a problem in the `409`, `No edit access to milestone #<id>, which holds card #<n>`.

The full contract, with the response fields, is in `DUMPFIRE_API.md` under *Bulk Planning*.
The fields of the `409` are under [Error Format](#error-format).

---

### Dependencies

A dependency link says that one piece of work waits on another. Either end is a card or a
subtask, on any board. The end that waits is `blocked`, and the end it waits on is `blocker`.
A card is finished when it is in a Complete column and a subtask when it is ticked, and work
that waits on something unfinished is blocked.

```mermaid
flowchart LR
    One["One link, from a card<br/>POST /cards/:cardId/dependencies"] --> Check
    Two["One link, from a subtask<br/>POST /subtasks/:subtaskId/dependencies"] --> Check
    Many["Many links<br/>POST /dependencies/bulk"] --> Check
    Check{"The same check for all three:<br/>both ends exist and are not archived,<br/>no end waits on itself,<br/>no loop is closed"}
    Check -->|"one link refused"| Single["400 or 409 for that link"]
    Check -->|"any link of a batch refused"| Batch["409 for the whole batch.<br/>Nothing written, every link at fault listed"]
    Check -->|"passes"| Stored[("work_dependencies")]
```

#### `GET /api/v1/cards/:cardId/dependencies`

What the card waits on (`blockedBy`) and what waits on it (`blocks`). Needs view access to
the card's board. Work that has been archived or deleted is not listed.

| Parameter | Description |
|-----------|-------------|
| `direction` | `both` (the default), `blocked-by` or `blocks`. With `blocked-by` the answer has no `blocks`, and with `blocks` no `blockedBy`. Anything else is a `400` |

```json
{
  "cardId": 10,
  "isBlocked": true,
  "blockedBy": [
    {
      "id": 7,
      "kind": "card",
      "cardId": 42,
      "parentCardId": null,
      "title": "Run the migration",
      "boardId": 1,
      "boardName": "Sprint 43",
      "columnName": "In Progress",
      "priority": "high",
      "resolved": false,
      "withheld": false,
      "createdByUserId": 2,
      "createdAt": "2026-10-13 09:41:07"
    }
  ],
  "blocks": []
}
```

`id` is the id of the link. `kind` says what `cardId` is the id of: for a subtask it is the
subtask's id, and `parentCardId` is the card it belongs to. `resolved` is true once that work
is finished.

An end on a board the key's user cannot open is **withheld** (card 2129). It is still
listed, so that the card is still blocked by it and the link can still be removed by its id:
`kind`, `cardId`, `resolved` and the link's `id`, `createdByUserId` and `createdAt` are kept.
Its `title` reads `A card on a board you cannot open` or
`A subtask on a board you cannot open`, `boardName` reads `A board you cannot open`,
`columnName` is `""`, and `boardId`,
`priority` and `parentCardId` are `null`. `withheld` is `true` for such an end and `false`
for every other. An administrator's key is given every end as it is. The same holds for
`GET /cards/:cardId`, the subtask routes below, and the nodes of a milestone's summary,
whose `progress` counts cards on such boards under one `boards` entry with `id` `null`.

#### `POST /api/v1/cards/:cardId/dependencies`

Record one link. Send exactly one of:

| Field | Meaning |
|-------|---------|
| `dependsOnCardId` | This card waits on that card |
| `dependsOnSubtaskId` | This card waits on that subtask |
| `blocksCardId` | That card waits on this card |
| `blocksSubtaskId` | That subtask waits on this card |

Needs edit access to the boards at both ends. Answers `201`:

```json
{ "blocked": { "kind": "card", "id": 10 }, "blocker": { "kind": "card", "id": 42 }, "isBlocked": true }
```

`isBlocked` is whether the card in the path is blocked now.

#### `DELETE /api/v1/cards/:cardId/dependencies`

Remove one link. The body names the other end with the same four fields. Answers `200`
with `{ "success": true, "removed": 1 }`.

Who may remove a link is not who may add one. Adding needs edit access to the boards at
both ends. Removing needs edit access to the board of **the end that waits**, whichever
end the request is addressed to, and an administrator may always:

| The caller can edit | At the waiting end's address | At the address of the end it waits on |
|---------------------|------------------------------|---------------------------------------|
| The waiting end's board | Removed | Removed, if they can view that end's board; `403` if they cannot open it |
| Only the board of the end it waits on | `403` | `403` |
| Both boards, or is an administrator | Removed | Removed |

So work can stop waiting on a board its owner can no longer open, and an editor of the
blocking end alone cannot unblock another board's work. The card in the path must be one
the caller can view, as it must to read its dependencies.

The `api:dependency_removed` activity entry is written on the board of the end that waits,
whichever end the request is addressed to: that is the board whose work changed, and the
one the caller was shown to edit. It names the card in the path where that card is on that
board, and otherwise the card that waits (a waiting subtask's card). Both ends' boards are
sent the live update, once where they are one board.

The refusals come in this order, and a refused request removes nothing:

```mermaid
flowchart TD
    A["DELETE .../dependencies"] --> B{"The card or subtask<br/>in the path exists?"}
    B -->|no| N1["404 Card not found"]
    B -->|yes| C{"The caller can view its board?"}
    C -->|no| F1["403 No access"]
    C -->|yes| D{"The end that waits exists?"}
    D -->|no| N2["404 #42 not found"]
    D -->|yes| E{"The caller can edit<br/>the waiting end's board?"}
    E -->|no| F2["403 No edit access to the board<br/>holding #10, the end that waits"]
    E -->|yes| G{"The link is there?"}
    G -->|no| N3["404 Dependency not found"]
    G -->|yes| OK["200, the link is removed"]
```

The `403` is decided before the link is looked for, so a caller who is refused is answered
the same whether the link exists or not. `Dependency not found` is answered only to a
caller who may edit the waiting end's board, who can read that end's links already.

#### Subtask dependencies

`GET`, `POST` and `DELETE` on `/api/v1/subtasks/:subtaskId/dependencies` do the same from a
subtask. The four body fields mean what they mean on a card, with "this subtask" for "this
card". Who may remove a link is decided as it is for a card, by the one rule: edit access
to the board of the end that waits. Three things differ:

| | Card route | Subtask route |
|---|---|---|
| `GET` | Takes `direction`. Each entry carries the link's `id`, `createdByUserId` and `createdAt` | No `direction`: both lists are always there. An entry has no link id |
| `POST` answers `201` with | `{ blocked, blocker, isBlocked }` | The subtask's dependencies as they then are |
| `DELETE` answers `200` with | `{ success, removed }` | The subtask's dependencies as they then are |

The subtask's dependencies:

```json
{
  "subtaskId": 3471,
  "cardId": 10,
  "isBlocked": true,
  "blockedBy": [
    { "kind": "card", "cardId": 42, "parentCardId": null, "title": "Run the migration",
      "boardId": 1, "boardName": "Sprint 43", "columnName": "In Progress",
      "priority": "high", "resolved": false, "withheld": false }
  ],
  "blocks": []
}
```

An end on a board the key's user cannot open is withheld, as on a card's list.

Each is recorded as it is on a card, the link and its entry in one transaction with the
check. `POST` writes `api:dependency_added` on the board of the subtask's card, naming that
card: "subtask #3471 now waits on #42". `DELETE` writes `api:dependency_removed` on the
board of the end that waits, naming the subtask's card where it is on that board, and
otherwise the card that waits. Until 2026-10-14 the subtask route wrote no entry.

#### When one link is refused

The card route and the subtask route refuse alike, and a refused request writes nothing:

| Code | Refused because | Body |
|------|-----------------|------|
| `400` | None of the four fields, or more than one of them | `{ message }` |
| `400` | An id in the body that is not a whole number of 1 or more, or a number written as one | `{ "message": "dependsOnCardId must be an id" }` |
| `400` | The id in the path is not a whole number of 1 or more | `{ "message": "Invalid card ID" }`, or `Invalid subtask ID` |
| `400` | An end waits on itself | `{ "message": "#10 cannot depend on itself" }` |
| `400` | An end is archived | `{ "message": "#42 does not exist or is archived" }` |
| `403` | `POST`: no edit access to the board at one of the ends | `{ message }` |
| `403` | `DELETE`: no edit access to the board of the end that waits, or no access to the board of the card or subtask in the path. Answered before the link is looked for | `{ "message": "No edit access to the board holding #10, the end that waits" }` |
| `404` | The card or subtask in the path, or the one named in the body, does not exist | `{ "message": "#42 not found" }` |
| `404` | `DELETE` of a link that is not there | `{ "message": "Dependency not found" }` |
| `409` | The link is already recorded | `{ "message": "That dependency already exists" }` |
| `409` | The link would close a loop | `{ message, cycle }` |

A loop is told from a duplicate by `cycle`, which holds the chain the link would close, in
order. `message` says the same in words:

```json
{
  "message": "#10 waiting on #42 would create a cycle: #10 → #42 → #10",
  "cycle": [
    { "kind": "card", "id": 10 },
    { "kind": "card", "id": 42 }
  ]
}
```

In a message, `#42` is card 42 and `subtask #42` is subtask 42.

#### `POST /api/v1/dependencies/bulk`

Record many links in one request. Send `links` or `chain`, not both:

```json
{ "links": [
    { "blocked": 1559, "blocker": 1686 },
    { "blocked": "subtask:3471", "blocker": 1559 }
] }
```

```json
{ "chain": [1686, 1559, 1444] }
```

- **An end is written in one of three ways:** a number, which is a card id; the text
  `"subtask:42"` or `"card:42"`; or an object `{ "kind": "subtask", "id": 42 }`.
- **`chain`** needs at least two ends, and each waits on the one before it: the chain above
  says that 1559 waits on 1686 and 1444 waits on 1559.
- **A link** needs a `blocked` and a `blocker`. `cardId` is read as `blocked` and
  `dependsOnCardId` as `blocker`, and `blockedType` or `blockerType` (`card` or `subtask`)
  may say what an id is the id of.
- **500 links at most** in one request.
- **Edit access is needed to the board of every end.**

It answers `201`:

```json
{
  "created": 2,
  "skippedAsDuplicate": 0,
  "boardsTouched": [1],
  "links": [
    { "blocked": 1559, "blockedType": "card", "blocker": 1686, "blockerType": "card" },
    { "blocked": 3471, "blockedType": "subtask", "blocker": 1559, "blockerType": "card" }
  ]
}
```

`links` holds the links that were written. A link that was already recorded is skipped and
counted in `skippedAsDuplicate`, so the same batch can be sent twice: when every link was
already there the answer is still `201`, with `created` 0.

The batch is all or nothing. Every link is checked before any is written, loops between the
links of the batch included, and if one is refused the answer is `409` and nothing is
written:

```json
{
  "message": "Batch rejected — nothing was written",
  "written": 0,
  "rejected": [
    {
      "link": { "blocked": 1444, "blockedType": "card", "blocker": 1559, "blockerType": "card" },
      "reason": "cycle",
      "cycle": [
        { "kind": "card", "id": 1444 },
        { "kind": "card", "id": 1686 },
        { "kind": "card", "id": 1559 }
      ],
      "message": "#1444 waiting on #1559 would create a cycle: #1444 → #1686 → #1559 → #1444"
    }
  ],
  "forbidden": [],
  "wouldSkipAsDuplicate": 0,
  "wouldCreate": 1
}
```

| `reason` | Meaning |
|----------|---------|
| `self` | An end waits on itself |
| `missing-blocked`, `missing-blocker` | That end does not exist or is archived |
| `cycle` | The link would close a loop, with the stored links or with earlier links of the batch. `cycle` holds the chain |
| `duplicate-in-batch` | The batch has the same link twice |

`forbidden` lists the links that are right in themselves and have an end on a board the
key's user cannot edit. An end that does not exist and a board the user may not edit are
lines in the `409`: this route answers no `404` and no `403`. A `400` means the batch could
not be read at all, and names what it could not read: both `links` and `chain` or neither,
an empty `links`, an entry of `links` that is not an object (`links[3] must be an object`),
a `chain` of fewer than two, a link with no `blocked` or no `blocker`, an end written in
none of the three ways or whose id is not a whole number of 1 or more
(`links[0].blocker must be a card id, "subtask:<id>", or {kind, id}`, and so for
`chain[1]`), an object whose `kind` is not `card` or `subtask`, a `blockedType` or
`blockerType` that is not `card` or `subtask`
(`links[0].blockedType must be one of: card, subtask`), or more than 500 links. The fields
are read before any end is looked for.

---

### Token Cost

What work cost in tokens, recorded entry by entry on a card or on a subtask and added up on
the card. An entry on a subtask counts towards its card.

```mermaid
erDiagram
    CARD ||--o{ TOKEN_ENTRY : "entries on the card (direct)"
    CARD ||--o{ SUBTASK : ""
    SUBTASK ||--o{ TOKEN_ENTRY : "entries on a subtask (fromSubtasks)"
    TOKEN_ENTRY {
        int id
        int cardId "null for an entry on a subtask"
        int subtaskId "null for an entry on a card"
        text subtaskTitle "null for an entry on a card"
        int tokens "negative for a correction"
        text model
        int inputTokens
        int outputTokens
        int cacheReadTokens
        int cacheWrite5mTokens
        int cacheWrite1hTokens
        int apiCalls
        text note
        text createdAt
    }
```

| Route | Does | Answers |
|-------|------|---------|
| `GET /api/v1/cards/:cardId/tokens` | Reads the card's totals and every entry behind them. Needs view access | `200` |
| `POST /api/v1/cards/:cardId/tokens` | Adds one entry on the card. Needs edit access | `201` |
| `POST /api/v1/subtasks/:subtaskId/tokens` | Adds one entry on the subtask. Needs edit access | `201` |
| `POST /api/v1/tokens/bulk` | Adds up to 200 entries, all or none | `201`, or `409` |
| `DELETE /api/v1/tokens/:entryId` | Removes one entry outright. Needs edit access | `200` |

#### The body of an entry

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

| Field | Required | Rule |
|-------|----------|------|
| `tokens` | ✅ | A whole number, sent as a number and not as text, and not 0. Negative corrects an earlier entry. 10,000,000,000 at most either way |
| `model` | | The model's id, 80 characters at most. Without it the entry cannot be priced |
| `note` | | 500 characters at most |
| `apiCalls` | | A whole number, 0 or more. When it is more than 0, `tokens` may be no more than 1,200,000 for each call |
| `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWrite5mTokens`, `cacheWrite1hTokens` | | The breakdown: what the tokens were. Each a whole number, 0 or more |

- **Entries add. Nothing replaces.** Each request adds an entry, so the same request sent
  twice adds the tokens twice. To correct an over-report send a negative `tokens`.
- **The breakdown is all or nothing.** If any of its five fields is sent, `inputTokens` and
  `outputTokens` must both be sent, and the fields sent must add up to `tokens`. A cache
  field left out counts as 0. For a negative entry they are sent as positive numbers that
  add up to its size.
- **The body is checked before the card or subtask is looked for.** A body at fault sent to
  a card that does not exist is answered `400`, not `404`.
- **An archived card can still be reported on.**

`POST /api/v1/cards/:cardId/tokens` answers the new entry's id and the card's totals:

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

`POST /api/v1/subtasks/:subtaskId/tokens` answers the total of the subtask's **card**, not
of the subtask:

```json
{ "entryId": 312, "subtaskId": 3471, "cardId": 1713, "cardTotal": 62000, "recorded": true, "entries": 2 }
```

#### Reading the totals

`GET /api/v1/cards/:cardId/tokens` answers the same totals with `entryList`, every entry
newest first.

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

**How a cost is priced.** `costUsd` is worked out every time it is read, from each entry's
tokens and model, at Anthropic's list rates; no price is stored, so a change of rate
re-prices past entries. A model is priced when its id is one in DumpFire's table (the
Claude 5.5, 5.1, 5, 4.x and 3.5 models, rates verified 2026-10-14), or one of them
followed by a date (eight digits) or a tag (`claude-haiku-4-5-20251001`,
`claude-opus-4-6[1m]`). An id that is one of them followed by a version DumpFire does not
list (`claude-opus-5-6`, `claude-opus-50`) is
not priced as the shorter id: it is unpriced, and its tokens are counted in
`unpricedTokens`, as an entry with no model is. `claude-haiku-5-5` is billed by the size
of each call's prompt, and DumpFire prices every Haiku 5.5 token at its rate for prompts
of 100K tokens or fewer ($0.10 / $0.50 per million): an entry does not say which of its
calls were longer. Opus 5.5's fast mode is priced at the standard rate.

**`recorded: false` with `entries: 0` means not recorded. It does not mean a cost of zero.**
Show it as unknown.

#### `DELETE /api/v1/tokens/:entryId`

Removes one entry, as if it had never been made, and answers `200` with `deleted` (the
entry's id), `cardId` and the totals of the card it counted towards. For an over-report a
negative entry is the better correction, because it leaves the first to be seen.

#### `POST /api/v1/tokens/bulk`

```json
{ "entries": [
    { "cardId": 1713, "tokens": 18400, "model": "claude-opus-5", "note": "planning" },
    { "subtaskId": 3471, "tokens": 9100, "model": "claude-sonnet-5" }
] }
```

Each entry names exactly one of `cardId` and `subtaskId`, and is otherwise the body of a
single entry. 200 entries at most. It answers `201`:

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
`404` and no `403`. A `400` means `entries` is not an array, is empty or has more than 200
entries, or holds an entry that is not an object (`entries[1] must be an object`, which was
a `500`).

**Not safe to send twice.** Unlike the dependency and milestone batches, which skip what is
already there, entries add: the same batch sent again adds the tokens again.

---

### Attachments

Attachments are not part of the v1 API. The web application uploads and serves them through
its own routes, with a session and not an API key. What a browser gets when it opens one by
its address:

| The file | Answered as |
|----------|-------------|
| A PNG, JPEG, GIF, WebP or `.txt` file, where the type stored at upload and the file name's extension agree | Shown in the browser (`Content-Disposition: inline`), with the type DumpFire names for it |
| Anything else: PDF, HTML, SVG, Office documents, archives, or a file whose name and stored type disagree | A download (`Content-Disposition: attachment`, `application/octet-stream`) |

Every answer carries `Content-Security-Policy: sandbox` and `X-Content-Type-Options: nosniff`.

On a card, the four image types have a thumbnail that opens the image. Every other
attachment is saved to disk, and so is an image when its name is clicked.

---

### Comments

#### `GET /api/v1/cards/:cardId/comments`

List all comments on a card.

#### `POST /api/v1/cards/:cardId/comments`

Add a comment: `{ "content": "Your message here" }`. The card is looked for and the caller
checked first (`404`, then `403`), then `content` is read: text, trimmed, of 1 to 50,000
characters (`content must be text`, `Comment cannot be empty`,
`content must be at most 50000 characters`).

#### `GET /api/v1/comments/:commentId`

Fetch a single comment (requires view access to the card's board).

#### `PUT /api/v1/comments/:commentId`

Edit a comment's text: `{ "content": "Replacement text" }`. Only the comment's author or an admin may edit, and the author only while they can still edit the board the comment is on, which is what posting a comment asks for: someone taken off a board, or left on it as a viewer, is answered `403` with `No edit access to this board` for a comment they wrote there. A viewer can still read it. Sets `updatedAt`, logs `api:comment_edited` to the activity feed and pushes a live board update. The comment is looked for and the caller checked before `content` is read, which is held to the rule of a new comment, `Comment too long (max 50000 chars)` past it. The text is stored trimmed and otherwise as sent (no tag prefixing).

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
