---
title: "External API Reference"
category: Integration
version: 1.175
status: As-Built
date: 2026-11-24
tags:
  - card-2689
  - decision-webhooks
  - card-2688
  - record-exported
  - card-3059
  - waiting-on-decisions
  - card-3064
  - compatibility-release
  - openapi-1-15-1
  - card-2687
  - decision-waits
  - card-2684
  - card-2683
  - card-3004
  - card-3031
  - card-3033
  - card-3002
  - card-3020
  - unsealed-request-addresses
  - card-3012
  - unsealed-backup-outside-reach
  - api
  - card-3009
  - unsealed-backup-grants
  - card-2997
  - passwords-kept-on-restore
  - card-2996
  - account-endings
  - card-2995
  - card-2947
  - webhook-reveals
  - card-2941
  - card-2920
  - uploads-disk-floor
  - card-2928
  - webhook-addresses-at-rest
  - card-2923
  - ended-access-holds-webhooks
  - card-2915
  - two-step-reset-ends-keys
  - card-2910
  - upload-limits
  - card-2671
  - account-disable
  - card-2914
  - card-2911
  - hidden-milestone-not-found
  - card-2894
  - card-2893
  - card-2752
  - webhook-switched-off
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
  - webhooks
  - product-owner
  - step-up
  - people-directory
  - decision-records
  - untrusted
  - attachments
  - images
  - retention
  - mfa
  - two-step-sign-in
  - api-key-deadline
  - breaking-change
  - milestones
  - cross-board
  - card-2761
  - exif
  - card-2719
  - not-found-not-forbidden
  - card-2762
description: "OpenAPI 1.15.1 point (11): four decision webhook events, decision.opened, decision.ruled, decision.withdrawn and decision.superseded, sent only to a webhook that names them, to the decision's own board while its setter may view the decision, with an allowlisted data (card 2689). OpenAPI 1.15.1 point (10): a decision record may give record_exported, a full record downloaded as a PDF on its page, no PDF to a key (card 2688). OpenAPI 1.15.1, not breaking (card 3064, the compatibility release): on a server upgraded from before 1.8.0 the one-off effects of 1.8.0, 1.9.1 (4), 1.11.0 (9)-(10) and 1.15.0 (1)-(4), (7) and (9) are not applied at installation, a key has a deadline only where the administrator has applied one, the list of everything a client written for 1.3.1 sees change, and a key made or confirmed with the password alone by an account with no authenticator while two-step sign-in is dormant; point (9), card 3059: GET /cards/{cardId} and GET /cards/{cardId}/dependencies give waitingOnDecisions, isBlocked unchanged, both answered no-store. Objections and requests to talk (card 2684) are a person's, never a key's: no v1 operation raises, replies to or reads one, the summary is unchanged, and GET …/record leaves the four flag events out; no new point in 1.15.0. Point (14) of 1.15.0, decisions may ask survey questions: surveyQuestions in the content (kept when a PATCH does not send it, [] removes them), the refusal survey_incomplete, the response kind answered, answers and survey figures on the summary, never answered with a key (card 2683). Point (13) of 1.15.0, webhooks a restore brings back switched off with three new pausedBecause sentences, and the import's outboundKept and recordsNotTaken.outboundChanges (card 3004). A restore keeps decision roles as recorded: the import's accessKept and accessAsHere fields, and point (12)'s 409 for a Product Owner or decider whose account time does not read (card 3033). The import answering accessKept, accessAsHere and recordsNotTaken.accessChanges with no /api/v1 change (card 3002), The import answering recordsNotTaken and accountStateAsHere with no /api/v1 change (card 3013), an unsealed import's unsealedReach.mailFrom and the From handed over as a name and an address (card 3029), REST API reference for DumpFire's external v1 API: authentication, point (11) of 1.15.0 and Person.status for people marked left by an unsealed restore, GET and POST /api/requests/held, mailHeld, the reply's mailed and Mark active's step-up (card 3020), point (10) of 1.15.0 holding a webhook from an unsealed backup and the import answering unsealedReach (card 3012), the import answering passwordsKept.unsealed, superadminGivenYours and unsealedHeld with no /api/v1 change (card 3009), the import answering passwordsKept with no /api/v1 change (card 2997), ending an account's access also holding the webhooks it set that were already switched off without a hold, and the boards' owners mailed (card 2923, OpenAPI 1.15.0, breaking), a two-step reset ending the account's keys and switching off its webhooks (card 2915, OpenAPI 1.14.0, breaking), every upload counted against a key's user's hour and day whatever the file and only so many at once, a 429 before the body closing the connection (card 2910, OpenAPI 1.13.1, not breaking), with the card window's stricter upload, a disabled account with no access to anything, its key 401 and the account refused as one without the board, breaking, OpenAPI 1.13.0, with the internal disable and enable routes and a delete only of a disabled account (card 2671), the internal task request routes answering a signed-in caller who cannot read a request 404 Request not found (card 2914), a milestone the key's user cannot see answered 404 Milestone not found and the goal a card is in refused in words of its own, breaking, OpenAPI 1.12.0 (card 2911), the internal password change and two-step reset pausing report schedules and answering reportSchedulesPaused (card 2894), a webhook switched off for good when the API key that set it up ends and key rotation (card 2893), a webhook whose setter loses the board switched off for good, switched on again only by the board's owner or an administrator with a new secret, and a create at its address refused to anyone else (card 2752, breaking, OpenAPI 1.11.0), a board, card or anything on a board the key's user cannot open answered 404 as one that is not there, where it was 403 (card 2719, breaking, OpenAPI 1.10.0), and a card asked first under its own address, so any attachment id under a card the key's user cannot open is Card not found (card 2762, in the same release), the image upload's allowances shared with the card window and a JPEG's orientation kept (card 2761, OpenAPI 1.9.1), the deadline of a key made before two-step sign-in and Keep this key (card 2772, breaking, OpenAPI 1.8.0), the milestone list's touching=true for the cross-board goals holding a board's cards (card 2891, OpenAPI 1.9.0), how every failure is answered, what a failed write means, what each delete removes, the main endpoints (webhooks among them: where one may send, who may change one, at most 10 a board; the people directory and its groups, an administrator's key's, with no addresses; decision records since 1.6.0, what a key may and may not do with one; a card's files and image uploads since 1.7.0), examples, and the changelog, the internal routes that ask for the current password among it (since card 2751 the report schedule and report mail routes too, v1 unchanged) (and, since card 2771, a code beside it: currentCode, its form, the four new stepUp codes, the Account routes on the same check with currentPassword), and card 2773's reset of an account's two-step sign-in and the invite's new 409, and card 2769's two-step sign-in, which leaves the v1 API and keys unchanged and sends the login, invite and set-up forms on to /login/verify or /login/enrol"
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

1. Log in, with your password and then a code from your authenticator app (card 2769) → **My Account** (⚙️) → **API Keys** section
2. Enter a name, your current password and a code from your authenticator app (or one of
   your recovery codes, by **Use a recovery code instead**) → **Generate Key**
3. Copy the key immediately — it is shown **once only**

While two-step sign-in is dormant on a server (card 3064: until the superadmin requires it), an
account that holds no authenticator signs in with its password alone and makes a key with its
current password alone: the code is asked only of an account that holds an authenticator, and of
every account once two-step sign-in is required (see
[Two-Step Sign-In: Dormant Until Required](authentication-security.md#two-step-sign-in-dormant-until-required-card-3064)).

Keys inherit the permissions of the user who created them. A key is made only there, by the
account's holder, with the password and a code; the API has no route that makes one, and an
account has at most ten. A wrong password or a wrong code is refused with `Your password or
code was not right. Nothing was changed.`, never saying which, and no key is made. The third
wrong answer from one signed-in browser, counted with every other action that asks for the
password (cards 2701 and 2771), ends that browser's session: `403` `{ "message": "Nothing was
changed. This session has been signed out, after three wrong passwords or codes, or because it
had ended: sign in again.", "signedOut": true, "stepUp": "signed-out" }`. Only a right password
with a right code sets the count back.

### When a Key Ends

A key ends when it is revoked on My Account, or when the account's password is set in a way
that ends keys:

| How the password is set | The account's keys |
|-------------------------|--------------------|
| The holder changes it on My Account | Kept, unless they tick **End my API keys too** (not ticked by default) |
| The holder changes it on their own row of the admin page | Kept |
| An administrator resets it | All end |
| An invite link is used to set it | All end |

**A key has a deadline only where the administrator has applied a deadline** (card 3064, OpenAPI
1.15.1). Migration 0069 gave every key that existed at card 2772's release a deadline 60 days after
it, but migration 0084 takes it back in the same start, so a server upgraded from before 1.8.0
applies none at installation, and a new server has none either. The administrator applies one later
as a planned event (E4, within 60 days of requiring two-step sign-in), with notice to every key
holder, to the keys that exist then (see
[The Compatibility Release](deployment.md#the-compatibility-release-card-3064)). Where one is applied
(card 2772), it is the same moment for every such key. **My Account → API
Keys** shows the date beside it, "⚠️ Made before two-step sign-in: stops working on *date
time* UTC unless you keep it", with **Keep this key**: with your password and a code it clears
the deadline and leaves the key itself unchanged. A key not kept ends at its deadline, and one
past it cannot be kept: generate a new key. Each key also shows its expiry, "Expires *date
time* UTC" or "No expiry". A key that expires, or reaches its deadline, at the current second
has ended.

A key that has ended is answered `401` `{ "message": "Invalid or expired API key" }`, as a
revoked one is, and whatever uses it stops until it is given a new key. Before an
administrator resets the password of an account a script runs on, the reset dialog says how
many keys it has. The webhooks the account set up go with its keys, switched off (see
[Webhooks](#webhooks)); a reset and an invite also pause its report schedules. See
[What Setting a Password Ends](authentication-security.md#what-setting-a-password-ends).

**A key that ends stays ended** (card 2995). A revoke, a password set in a way that ends keys, a
two-step reset, a disable, a delete of the account and Reset Everything each record the key's id and
its SHA-256 on the server, never the key itself. An administrator who later restores a backup made
before the key ended does not bring it back: the restore leaves it out, and the key is answered
`401` as above wherever it is presented. A key that has merely expired or passed its deadline is not
recorded, since it is still ended in any backup. A working copy restored from a backup has no API
key at all. After a restore, a script whose key was ended is given a new key, as after any ending.

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
`cycle` in it. So is a board's 11th webhook (`This board has 10 webhooks, and a board may
have at most 10: delete 1 before adding another.`).

| Code | Meaning |
|------|---------|
| `200` | Success |
| `201` | Created |
| `400` | Bad request: a field is missing, is of the wrong type or holds what it may not (see [What a Field May Hold](#what-a-field-may-hold)), an id in the path or the query string is not a whole number of 1 or more, or the body is missing, is not valid JSON or is not a JSON object |
| `401` | No `Authorization: Bearer <key>` header, or a key that is unknown or expired, or one of an account that is disabled (since 1.13.0, card 2671) |
| `403` | The key's user can open the board the resource is on, and their role does not allow this (since 1.10.0, card 2719), or can see a milestone and may not change it (since 1.12.0, card 2911), or the milestone a card is in, when putting it in another or taking it out (`No access to the milestone this card is in`) |
| `404` | The resource in the path does not exist, whoever asks, or is on a board the key's user cannot open: the two are answered alike, in the same words (since 1.10.0, card 2719), and so is a milestone they cannot see (since 1.12.0, card 2911); an id in the body names nothing (a category, a user, a milestone); something to be removed is not there (an assignee, a label on a card, a card in the milestone named); or the path is no route: `{ "message": "Not found" }` |
| `405` | The route does not have this method: `{ "message": "PATCH method not allowed" }`. The `Allow` header names the methods it has |
| `409` | Conflict: a card moved to a Complete column while it has open subtasks or sub-boards, a card moved onto a board beneath it, at any depth, a sub-board that would be more than 20 levels deep (made under a card, or carried by a card moved to another board), a dependency that already exists or would close a loop, a board's 11th webhook, a card's 21st image or an image sent to a card whose images retention is moving to the trash, or a rejected batch |
| `413` | The request body is over the size limit, 512 KB (5 MB for the image upload): `{ "message", "limitBytes" }`. See [The Request Body](#the-request-body) |
| `415` | The image upload only: the `Content-Type` is not `image/png`, `image/jpeg`, `image/gif` or `image/webp`, or the bytes are not the type it names. See [Attachments](#attachments) |
| `429` | Rate limited: 60 requests in the minute with one key, or 60 from one address with no key DumpFire accepts; for the image upload, also 30 uploads in the hour or 100 MB in the day for the key's user, every file they upload through the card window counted too (since 1.13.1), or 3 uploads of theirs, or 6 on the server, already in progress (since 1.13.1) |
| `500` | DumpFire failed: `{ "message": "Internal Error" }`. Nothing of the fault is in the answer; it is written to DumpFire's system log, with the route and the key's user |
| `507` | The image upload only (since 1.15.0, card 2920): the server's uploads volume has too little free space, or its free space cannot be read. See [Attachments](#attachments) |

### The Request Body

What a route that takes a body answers to one it cannot use:

| The body sent | Answer |
|---------------|--------|
| No body, an empty one, or text that is not JSON | `400` `{ "message": "The request body is missing or is not valid JSON" }` |
| JSON that is `null`, a number, a string or a boolean | `400` `{ "message": "The request body must be a JSON object" }` |
| A JSON array, `[]` included | `400` `{ "message": "The request body must be a JSON object" }`. No route takes one |
| More than the size limit, which is 512 KB on every route of this API but the image upload (5 MB, see [Attachments](#attachments)), declared in `Content-Length` | `413` `{ "message": "The request is larger than this server accepts here: it is 600 KB, and the limit is 512 KB", "limitBytes": 524288 }`, before the body is read and before the key is looked at |
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
attachment upload and its backup import, which are not part of this API. One operation of
this API has a larger limit: `POST /api/v1/cards/{cardId}/attachments`, whose body is an
image and not JSON, takes 5 MB, and it is the one operation that asks for the card and the
caller before it reads its body (see [Attachments](#attachments)). See
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
| `coverUrl` | A colour written `#rrggbb`, or one of the eight preset gradients exactly as [`PUT /api/v1/cards/:cardId`](#put-apiv1cardscardid) lists them, or `null`; `''` is read as `null` | `coverUrl must be a colour written #rrggbb, one of the preset gradients, or null` |
| A milestone's `status` | `open` or `closed` | `status must be open or closed` |
| `archivedAt` on `PUT /cards/:cardId` | `null`, which restores the card, and nothing else | `archivedAt may only be null, which restores the card. Archive a card with DELETE /cards/{cardId}` |
| A webhook's `url`, `secret`, `events` | An `http` or `https` address of at most 2,048 characters, trimmed, not inside the network as written and with no user name or password (see [Webhooks](#webhooks)); text of at most 256; a list of the fourteen event names, each trimmed, where `[]` is every event but the four decision events (card 2689) | `url must be an http or https address`, `Webhook url points inside the network: 127.0.0.1 is a loopback address`, `Webhook url must not carry a user name or password`, `events must be a list` |
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
    Row -->|"Yes"| Opens{"The caller can open<br/>the board it is on?"}
    Opens -->|"No"| E404a
    Opens -->|"Yes"| Who{"The caller's role<br/>allows this?"}
    Who -->|"No"| E403["403"]
    Who -->|"Yes"| Fields{"Every field holds<br/>what it may?"}
    Fields -->|"No"| E400b["400 naming the field"]
    Fields -->|"Yes"| Named{"What a field names<br/>is there?"}
    Named -->|"No"| E404b["404: Category not found on this board,<br/>User not found, ..."]
    Named -->|"Yes"| Write["Written, in one transaction<br/>with the checks"]
```

So a caller who would be refused is answered `404` or `403` whatever the body holds: `404`, in
the words a missing one gets, for what is on a board they cannot open, and `403` for what
their role does not allow (card 2719). An
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
    Handler -->|"refused: 404 for what the path names, missing or unopenable,<br/>403 for the role, 400 for a field, 404 for what a field names"| E4xx["400, 403, 404 or 409 message"]
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

The image upload is not refused by the first row: its body is sent as `image/png`,
`image/jpeg`, `image/gif` or `image/webp`, none of which is a form type. A file upload sent as
`multipart/form-data` would be, which is why the upload takes the image itself as its body.

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
No answer of the API carries a `Content-Security-Policy` but one: a file downloaded with
`GET /api/v1/cards/{cardId}/attachments/{attachmentId}` carries `sandbox`, with `nosniff` and
`Cache-Control: no-store` (since 1.7.0). The web application's pages carry their own, and an
attachment served there keeps its own `sandbox`.
See [Security Headers](authentication-security.md#security-headers).

A `502`, `503` or `504` is not DumpFire's either: see [Writes and Failures](#writes-and-failures).

### Timestamps

Every timestamp in an answer under `/api/v1/` is UTC, in ISO 8601 with `Z`, as
`2026-10-14T08:00:00.000Z`. That holds for every stored time (`createdAt`, `updatedAt`,
`completedAt`, `firstCompletedAt`, `archivedAt`, an audit-log entry's `createdAt`), for the
`from` and `to` of the activity report's `period` and of a card's board history, and for the
moments of answering, `generatedAt` and a webhook's own `timestamp`. The OpenAPI document
declares each of them `format: date-time`. A stored time is kept to the whole second, so
its fraction is always `.000`. A moment of answering is not stored: `generatedAt` and a
webhook's `timestamp` carry the milliseconds of the moment they were made, as in
`2026-10-14T08:00:00.357Z`. A date (`dueDate`, `targetDate`, `asOf`, a burndown day) is
`YYYY-MM-DD`.

A timestamp you send, as a parameter or in a body, may be written three ways:

| Written as | Read as |
|---|---|
| ISO 8601, with or without a fraction, with `Z` or an offset (`2026-10-14T09:00:00+01:00`, PowerShell's `Get-Date -Format o`) | That moment, moved to UTC; the fraction is dropped |
| `YYYY-MM-DD HH:MM:SS` | That moment in UTC, as DumpFire stores it |
| A date alone, `2026-10-14` | The start of that day, 00:00:00 UTC; as the end of a range (`to`), its last second, 23:59:59 UTC |

Anything else is `400` naming the parameter (`from is not a date`). DumpFire stores every
moment as `YYYY-MM-DD HH:MM:SS` in UTC, and the web application's own routes and the CSV
exports answer that form; the API turns it into ISO 8601 as it answers. Until 2026-10-14
some fields were answered in that form, which names no zone, and the same field could be in
either.

### Changes on 2026-11-24: version 1.15.1, the compatibility release (card 3064)

**Not breaking.** OpenAPI is now `1.15.1`. No operation, status code or existing field changes
against 1.15.0, and behaviour is only relaxed, never tightened; the additions are point 9's
`waitingOnDecisions` on the two card reads (card 3059), a new field a client may ignore, point
10's `record_exported` record entry (card 2688), and point 11's four decision webhook events
(card 2689), which a webhook hears only once its `events` list names them. Everything built
since live's `106ea45` (API 1.3.1) is released together, and the release's first start changes
nothing a key holder or a webhook receiver can see beyond a short outage.

On a server upgraded from before 1.8.0, the one-off effects of 1.8.0 (a deadline on existing
keys), 1.9.1 (4) (every stored image checked once), 1.11.0 (9)-(10) and 1.15.0 (1)-(4), (7) and
(9) (holds of webhooks set up or read before this version) are **not applied at installation**:
existing keys keep working with no deadline, and existing webhooks keep sending with their
secrets, except those already not delivered (no setter recorded, or a setter who cannot open the
board), which are switched off for good. An administrator may apply the key deadline later as a
planned event, with notice. Every rule for what happens from now on is as each note describes.

```mermaid
flowchart LR
    L["Live: API 1.3.1<br/>migration 0060"] --> S["First start of 1.15.1:<br/>0061 to 0084"]
    S --> K["Keys: kept, no deadline"]
    S --> W["Webhooks: keep sending, same secret<br/>(those already not delivered: switched off)"]
    S --> R["Rules for changes from now on:<br/>as 1.8.0 to 1.15.0 describe"]
    K -. "E4, planned, with notice" .-> D["A deadline applied"]
```

Everything a client written for 1.3.1 sees change:

1. Every board answer carries `productOwnerUserId`, the id of a user or null, which
   `PUT /boards/{boardId}` takes and keeps when it is left out (1.4.0).
2. `costUsd` on token answers is priced anew, past entries included (1.7.1).
3. A board, card, label, milestone or anything on a board the key's user cannot open is answered
   `404` in the words a missing one gets, where it was `403`; a label not of the card's board is
   `404`, where it was `400`; a withheld node of a `409`'s cycle gives `id` null and `withheld`
   true, and a withheld span of board-history `boardId` null and `withheld` true;
   `POST /dependencies/bulk` counts only the links whose ends the user can edit (1.10.0, 1.12.0).
4. A webhook whose setter can no longer open its board, and one set or switched on with an API
   key from this version on whose key then ends, is switched off for good, `pausedBecause` saying
   why, and only the board's owner or an administrator switches it on again, with a new secret;
   `DELETE` of such a webhook by an editor is `403`, and `POST` of a webhook to its receiver by
   anyone but the board's owner or an administrator is `409` (1.11.0).
5. A key ends at its expiry's own second (1.8.0 (2)); a disabled account's keys answer `401` and
   the webhooks it set are switched off (1.13.0); a reset of an account's two-step sign-in ends
   its keys and switches off the webhooks it set (1.14.0); and the end of an owner's or an
   administrator's access, or the lowering of its role, from this version on holds the webhooks
   whose secret it could read (1.15.0 (1), (7)); and a key given a webhook's secret from this
   version on (by a `GET`, or by the `POST` or `PUT` that set it) is recorded, and when that key is
   revoked or expires every webhook whose secret it was given is held, and is switched on again only
   with a new secret (1.15.0 (9)).
6. A webhook secret or url that cannot be opened is never sent; a url that is not well-formed text
   is `400`; a secret beginning `dfsealed:` is `400` (1.15.0 (5), (6)).
7. `PUT /webhooks/{webhookId}` gives `secret` only where that PUT set or replaced it, and the four
   answers that can give a secret carry `Cache-Control: no-store` (1.15.0 (9)).
8. `409`, with nothing written, for a Product Owner or decider whose account's creation time
   cannot be read on this server, and `503` in place of `500` on a server with no MFA key loaded
   (1.15.0 (12), (13)).

Added with it, not breaking: the People (1.5.0), Decisions (1.6.0) and Attachments (1.7.0)
operations, `touching=true` on `GET /milestones` (1.9.0), survey questions and cards that wait on
a decision (1.15.0 (14), (15)), each as its own note describes.

9. `GET /cards/{cardId}` and `GET /cards/{cardId}/dependencies` give `waitingOnDecisions`, the
   decisions the card waits on while each is open or awaiting a ruling and the key's user may
   view it, and `[]` for a card that is complete or an option (card 3059); `isBlocked` and
   `blockedBy` are unchanged and still count dependencies alone, so a card is free to start when
   `isBlocked` is false and `waitingOnDecisions` is empty; keys of two users may be given
   different lists for one card, and both answers carry `Cache-Control: no-store`.

10. `GET /decisions/{decisionId}/record` may give entries of a new kind, `record_exported`,
    written when the decider or an administrator downloads the decision's full record as a PDF on
    its page (card 2688), naming no participant, with detail `{}` and `versionNumber` the version
    exported; the PDF itself is not offered to an API key.

11. Four webhook events are new, `decision.opened`, `decision.ruled`, `decision.withdrawn` and
    `decision.superseded` (card 2689), sent to the decision's own board while the webhook's
    setter may view the decision, each with `data.decisionId`, `data.action`, `data.source`,
    `data.title` and `data.status` (and `data.supersededByDecisionId` for `decision.superseded`),
    never a name, count, option, reason or moment, and in no guaranteed order; they are sent only
    to a webhook whose `events` list names them: an empty list is still every event but these
    four, so no existing webhook receives them; `POST /boards/{boardId}/webhooks` and
    `PUT /webhooks/{webhookId}` take the four in `events`.

12. No other operation, field or schema changed; beside those, a few answers read differently: an
    audit entry's `source` may be `system` (1.7.0), a disabled user named as an assignee or a Product
    Owner is `400` (1.13.0 (2)), a `413` for a body declared too large, and every other refusal of an
    upload before its body is read, carries `Connection: close` (1.13.1 (3)), a card's move
    between milestones it cannot see is refused in words of its own (1.12.0 (3)), and the `400`
    for a webhook event that is not one of them names fourteen events where it named ten (card
    2689).

The key's description (`bearerAuth`) now says a key has a deadline only where the administrator
has applied one. Outside `/api/v1`, a key is made, and kept, with the current password alone by an
account with no authenticator while two-step sign-in is dormant (see
[Generating a Key](#generating-a-key)). The later planned events (stored images checked, the
backup seal key renewed, two-step sign-in required, the key deadline, image retention, the oldest
webhooks re-keyed) are each announced before they happen; see
[The Compatibility Release](deployment.md#the-compatibility-release-card-3064).

### Changes on 2026-11-23: cards waiting on a decision in the plan (card 2687)

**Within 1.15.0 (point 15), with two behaviour changes.** A card linked to a decision as `waits`
is held out of `nextActionable` and listed in `blocked`, with the decision in its `decisions`,
while the decision is open or awaiting a ruling and the key's user may view it, and so are its
ordered subtasks not ticked. OpenAPI stays `1.15.0` (unreleased); its note gains point (15), and
"nothing else changed" is now (16).

1. **`PUT /api/v1/decisions/{decisionId}/cards/{cardId}` now reads an optional body**, where
   before no body was read: `{ "relation": "relates" | "waits" }`, both the body and the field
   optional. A body that is not a JSON object, a body sent with any `Content-Type` other than
   `application/json` (parameters such as `charset` aside) or with none, or a relation other than
   `relates` or `waits` is answered `400`; a body too large `413`; `waits` on a ruled or
   superseded decision `409`. A PUT with **no body** (no `Transfer-Encoding`, and no
   `Content-Length` or one of `0`) is still taken and now **leaves an existing link's relation as
   it is**; until `1.15.0` a link stored with another relation was changed to `relates` (no
   server held another relation before this card). A link marked `waits` now holds a card in the
   plan.
2. **`nextActionable` and `blocked` are made for the key's user.** A card may leave
   `nextActionable` and join `blocked` with `blockers: []`, and keys of two users may be given
   different lists for one plan: a decision the key's user may not view holds nothing for them,
   and is named nowhere in their answer. `criticalPath`, `criticalPathNodes`, `graph` layers and
   edges, `downstreamCount` and `progress` are unchanged and the same for every key.

A relation changed is logged as `decision_card_relation_changed` on the decision's board, naming
no card (`api:decision_card_relation_changed` through a key). Added with it, and not breaking:
`waitingOnDecisions` on each `MilestoneNode` (required), `decisions` on each `blocked` entry
(required), both of the new schema `PlanDecisionWait` `{ id, title, shownStatus: 'open' |
'awaiting_ruling', closesAt }`, in the full and the `compact=true` summary; `relation` on
`DecisionLinkedCard` (required); and the PUT's optional body. A decision is never a node of the
graph.

How the PUT reads its body, and the order of its refusals:

```mermaid
flowchart TD
    A["PUT /api/v1/decisions/{decisionId}/cards/{cardId}"] --> K{"key valid?"}
    K -- no --> R401["401"]
    K -- yes --> P{"both ids whole numbers of 1 or more?"}
    P -- no --> R400a["400 a bad id"]
    P -- yes --> NB{"request.body null?"}
    NB -- yes --> TE{"Transfer-Encoding, or a<br/>Content-Length other than 0?"}
    TE -- yes --> R400b["400 send the body as application/json"]
    TE -- no --> NONE["body: none"]
    NB -- no --> CT{"Content-Type application/json?"}
    CT -- no --> R400b
    CT -- yes --> RB{"readBody: a JSON object,<br/>within the size limit?"}
    RB -- "too large" --> R413["413"]
    RB -- "not an object" --> R400c["400"]
    RB -- yes --> OBJ["body: the object"]
    NONE --> G
    OBJ --> G["linkCard: decision 404 or 403,<br/>card edit 404 or 403,<br/>status 409, archived card 409"]
    G --> RC{"relation sent and<br/>not relates or waits?"}
    RC -- yes --> R400d["400 relation must be one of: relates, waits"]
    RC -- no --> EX{"link there, with the same<br/>relation or none sent?"}
    EX -- yes --> UN["200 unchanged, nothing written"]
    EX -- no --> WR{"waits on a ruled or<br/>superseded decision?"}
    WR -- yes --> R409["409 This decision is ruled: a card cannot wait on it"]
    WR -- no --> CH{"link there?"}
    CH -- yes --> RCH["UPDATE relation, decision_card_relation_changed<br/>on the decision's board: 200 relation_changed"]
    CH -- no --> CAP{"below both caps?"}
    CAP -- no --> R409b["409 limit of links"]
    CAP -- yes --> NEW["INSERT, relates unless waits sent,<br/>decision_card_linked on the card's board: 200 linked"]
```

The body's own `400` and `413` come before the access checks, as on every route that reads a body;
the relation's `400` comes after them, so a key whose user may not view the decision or edit the
card is refused `404` or `403` first. The web application's twin,
`PUT /api/decisions/{id}/cards/{cardId}`, reads its body the same way (`readOptionalBody` in
`src/lib/server/request-body.ts`); there, as for every write under `/api/` from the pages, a
request that does not say it is JSON, body or not, is refused `415` at the gate before the route
runs.

### Changes on 2026-11-19: uploads refused when the uploads volume is nearly full (card 2920)

**Within 1.15.0 (point 8).** `POST /api/v1/cards/{cardId}/attachments` is answered **`507`**
when the server's uploads volume has too little free space (less than 1 GB plus twice the
database's size would be left after a 25 MB upload), or its free space cannot be read:
`{"message": "Uploads are paused: the server has too little free disk space, or cannot read how
much it has. Nothing was written. An administrator can see which on the admin page."}`. Asked
before the body is read, after the `Content-Type` and before the place and the hour, so nothing
is read, taken or counted, and the connection is closed (`Connection: close`); and at the write,
should the disk fill while the body arrives, when the upload has been counted. OpenAPI stays
`1.15.0` (unreleased); its note gains point (8), and "nothing else changed" is now (9).

The web application's own upload, `POST /api/cards/:id/attachments`, answers the same `507` with
the same words, at the same two points (before the form is read, after the session, the card
and its access; and at the write). Not marked Breaking. The admin page's load
(`/admin`) gains `uploadsSpace`, `{ state: 'room' | 'low' | 'unreadable', lowBecause: 'space' |
'inodes' | 'full' | null, freeBytes, totalBytes, freeInodes, refusedBelowBytes }`, free and total
`null` when unreadable, `freeInodes` `null` where the volume counts none. The 507 is given too when
fewer than 1,000 inodes are free, when the free space is not read within 2 seconds, and for 5
minutes after a write found the disk full unless the free space has grown since.

### Changes on 2026-11-21: decisions may ask survey questions (card 2683)

**Within 1.15.0 (point 14), breaking.** A decision's content holds `surveyQuestions`, the author's
own questions ([Decisions](#decisions)); one with none of its options live but at least one survey
question asks those alone, a survey. The readiness refusal `too_few_options` now refuses one option,
or none with no survey question, so a survey-only draft is no longer refused; the new refusal
`survey_incomplete` is a survey question with no prompt or a choice question with fewer than two
choices. `PATCH /api/v1/decisions/{decisionId}` content without `surveyQuestions` keeps the stored
ones, the one section not emptied when not sent, and `[]` removes them; both PATCH descriptions say
so. The PATCH no longer answers `409` for a change of `voteMode` on an opened decision while its
current version puts no option to a vote (a survey): the re-publish that adds the first options
publishes them in that mode, and such a change through a key is flagged
`content.agentDrafted.voteMode`, a readiness warning ("The vote mode was chosen by an agent and not
yet reviewed by a person") until a person marks it reviewed. A
response row of `GET /api/v1/decisions/{decisionId}/summary` may have kind `answered`, a survey
answered in a round with no options. Answers are given on the decision's page or by personal link
alone, never with an API key: no operation is added. DumpFire counts a new value in an enum of an
answer as breaking, hence the point.

Added with it, and not breaking: `surveyQuestions` in `DecisionContent` and in the PATCH request
(schema `DecisionContentSurveyQuestion`); `surveyQuestions` rows (`DecisionSurveyQuestion`,
`{ id, position, addedInVersion, retiredInVersion }`) on the decision's GET and PATCH answers; and on
the summary `answers` on each response row, `survey` on each tally (`DecisionSurveyTally`: per version
answered under, each question's `answered`, a choice's counts and a scale's counts and mean), and the
current version's `surveyQuestions`. `agentDrafted` may name `survey.<questionId>`. OpenAPI stays
`1.15.0` (unreleased); its note gains point (14), and "nothing else changed" is now (15).

Internal (`/api`):

- `PUT /api/decisions/[id]` (additive): the answer gains `surveyQuestions`, the live survey question
  rows; the body's `content` takes `surveyQuestions` as v1's does.
- `POST /api/decisions/[id]/responses` and `POST /api/decision-by-link/responses` (additive): the body
  may hold `answers`, keyed by the current version's live survey question ids, and `kind` may be
  `answered` in a round with no options; in such a round `vote` and `no_concerns` are `400`, and with
  options `answered` is `400`. The answer's `OwnResponse` gains `answers` (`{}` for none).
- `POST /api/decisions/[id]/republish`: telling only is `409` where a survey question would be added,
  retired or changed in anything but its help; a decision that has put options to a vote cannot be
  re-published with none (`409`). `POST /api/decisions/[id]/release`: a decision ruled on a version
  with no options is `409` "This decision put no options to a vote: there are no totals to release,
  and survey answers are never released".

### Changes on 2026-11-21: a restore keeps where this server sends as it recorded it (card 3004)

**Within 1.15.0 (point 13).** A webhook deleted, switched off with `PUT /api/v1/webhooks/{webhookId}`
(`active: false`) or given another `url` on this server after a backup was made, or on a board deleted
since, or deleted before this version, comes back from a restore of that backup switched off (`active`
false). One switched off stays off, with `pausedBecause` null. One deleted, re-pointed or not in this
server's record is switched off for good with its secret discarded, and `pausedBecause` gives, word for
word, one of three new sentences: "This was switched off because it was deleted on this server after the
backup it came back from was made. …", "This was switched off because it was pointed elsewhere on this
server after the backup it came back from was made. …" or "This was switched off because it was not in
this server's record of where it sends when a backup of it was restored. …", each going on as card 3012's
does ("Delete it unless you recognise the address; to keep it, switch it on with your own key, …").
Switching such a webhook on, by the board's owner or an administrator, gives it a new secret and refuses a
secret sent with it (`400`), as for the other holds. A webhook held here stays held with this server's
`pausedBecause` whatever address or setter the backup gives it; and an account a restore signs out
because its password was replaced here has the webhooks it set, and those whose secret it could read,
held as setter access ended. Every start, and every five minutes, puts a webhook that is not held back
as this server's record says (an older image's import, a host edit): one recorded as deleted, or at
another `url`, is switched off for good in the same way; one recorded as held is held again as setter
access ended; one recorded as switched off is switched off. OpenAPI stays `1.15.0` (unreleased); its note
gains point (13), "nothing else changed" is now (14), and `Webhook.pausedBecause` gives the three
sentences. `POST /api/v1/boards/{boardId}/webhooks`, `PUT` and `DELETE /api/v1/webhooks/{webhookId}` and
a board's delete write one more row in their transaction (`outbound_changes`, migration 0081), nothing a
caller sees. With no MFA key loaded (a development server: production does not start without one), a
create and a `PUT` that changes `url` answer `503`, documented on both, with nothing written: "No MFA key
is loaded, so this server cannot record report addresses or webhook addresses right now. Nothing was
saved. Ask an administrator to load the MFA key (MFA_KEY_FILE)." (they failed with a `500` before). A
`PUT` that leaves the address as it is needs no key. `POST /api/report-schedules` with an address, and a
`PUT /api/report-schedules/{id}` that adds or takes off one, answer the same `503` before the password is
asked, nothing written and none of the day's report mail taken.

Internal (`/api`):

- `POST /api/admin/import` (additive): `outboundKept`, `{ webhooksDeletedHeld, webhooksNotRecordedHeld,
  webhooksRepointedHeld, webhooksUncomparedHeld, webhooksOff, webhooksHeld, schedulesDeletedPaused,
  schedulesNotRecordedPaused, schedulesOff, schedulesUncomparedPaused, recipientsLeftOff,
  schedulesOverCap, recipientsOverCap, settingsRemovedHeld, settingsNotRecordedHeld, settingsHeld,
  resetSettingsHeld, settingsNotText }` (the code review added `webhooksUncomparedHeld` and
  `schedulesUncomparedPaused`, what could not be compared after an MFA key change, and
  `schedulesOverCap` and `recipientsOverCap`, a schedule restored with more than 10 addresses, paused,
  those beyond 10 left out, each with its own sentence and its own words in the CRITICAL line), what this server's record of where it sends kept, present only
  where a count is above 0, on a restore that commits and then fails too; and `recordsNotTaken` gains
  `outboundChanges`, the rows of an unsealed backup's record counted and not taken (present where any of
  its four counts is). `accountsKeptLines` and the message gain, each only where its count is above 0:
  "N webhook(s) deleted on this server after the backup was made came back switched off for good, their
  secrets discarded: delete them again, or switch one on with your own key to give it a new secret.", "N
  webhook(s) pointed elsewhere on this server since the backup was made came back switched off for good,
  their secrets discarded.", "N webhook(s) whose address could not be compared with this server's
  record (no MFA key is loaded, or it was replaced since the address was recorded) came back switched off
  for good, their secrets discarded.", "N webhook(s) and N report schedule(s) not in this server's record
  came back switched off or paused.", "N webhook(s) and N report schedule(s) switched off, paused or held on
  this server since the backup was made stay off.", "N report schedule(s) deleted on this server since
  the backup was made came back paused.", "N address(es) taken off report schedules on this server since
  the backup was made were left off.", "N report schedule(s) came back paused: addresses taken off them on
  this server were recorded under an MFA key since replaced, or none is loaded, so the addresses they came
  back with could not be compared.", "N report schedule(s) came back with more than 10 addresses: each was
  paused, and the N address(es) beyond the first 10 were left out.", "N setting(s) where this server sends
  (backup destinations, the
  mail settings or the App URL) removed, moved, held, or not in this server's record, are held for the
  superadmin's review under Settings held for review.", "N setting(s) set by accounts this restore
  signed out are held for the superadmin's review." and "N setting(s) where this server sends were not
  text in the backup, and were left out or read as text."; card 3013's records sentence gains "… and of N
  change(s) of where this server sends …", saying of that half alone that an unchecked file "decides
  nothing of where this server sends". The `[CRITICAL] [IMPORT]` line gains "keeping N outbound change(s)
  made on this server", "holding N setting(s) set by accounts it signed out" and "leaving out or reading
  as text N outbound setting(s) that were not text", each only where above 0, its details `outboundKept`;
  and, apart from the changes made here, "holding N webhook(s) and pausing N report schedule(s) whose
  addresses could not be compared with this server's record" and "pausing N report schedule(s) over 10
  addresses and leaving out N address(es)".
  Counts only, naming no webhook, schedule, address, destination or account.
- `POST /api/report-schedules` and `PUT /api/report-schedules/{id}`: with no MFA key loaded, a schedule
  made with addresses, or a change that adds or takes off an address, is refused and writes nothing.

### Changes on 2026-11-21: a restore keeps decision roles as this server recorded them (card 3033)

**Within 1.15.0 (point 12).** A board's Product Owner named by `PUT /api/v1/boards/{boardId}`, a
decider named by `PUT /api/v1/decisions/{decisionId}/decider`, and the decider a decision made by
`POST /api/v1/boards/{boardId}/decisions` or `POST /api/v1/decisions/{decisionId}/supersede` would be
given, are refused with **`409`** and nothing written where that account's creation time cannot be
read on this server, as the record of access changes, which a restore reads, could not name it. No
account made through DumpFire has such a time: a fault answer, not a new contract. Each of the four
operations' `409` says so. OpenAPI stays `1.15.0` (unreleased); its note gains point (12), and
"nothing else changed" is now (13). The v1 decision and board routes write one more record row in their
transaction (migration 0080), nothing a caller sees.

Internal (`/api`):

- `POST /api/admin/import` (additive): `accessKept` gains `participantsRemoved`, `participantsLowered`,
  `accountsCleared`, `decidersCleared`, `decidersFixed` and `decisionsEnded`, the decision roles this
  server's record kept as it says; `accessAsHere` gains `decisions` and `decisionsNotHere`, on a backup
  whose seal does not verify, the decisions this server holds kept with their board, stage and roles as
  here, and those it does not hold brought in with no board, no account and nobody on them. Each object
  is still present only where a count is above 0, all its fields counted, `decisionsEnded` included.
  `accountsKeptLines` and the message gain, each only where its count is above 0: "N place(s) on
  decisions removed on this server after the backup was made stay removed.", "N participant(s) made
  informed on this server stay informed.", "N account(s) taken off a place on a decision on this server
  stay off it: …", "N decision(s) keep no decider, as this server's record says: …", "N decision(s)
  keep no decider and cannot be given one here, …" and "N decision(s) deleted on this server came back
  with no author, decider or participants: …"; card 3002's unsealed sentence gains "… and of the
  decisions in it, N this server holds kept their board, stage, author, decider and participants as
  here, and N it does not hold came in with no board, no account and nobody on them.", and the records
  sentence reads "change(s) of board, team and decision access and person links". The `[CRITICAL]
  [IMPORT]` line counts the decision roles among "keeping N access change(s) made on this server" and
  adds "N decision(s) no role this server did not give". Counts only, naming no decision, person or
  account.

### Changes on 2026-11-20: a restore keeps board, team and person access as this server recorded it (card 3002)

No change to the v1 API or its OpenAPI document: it stays `1.15.0` (unreleased), its note unchanged.
`POST /api/v1/boards`, `PUT /api/v1/boards/{boardId}` and the v1 people routes write one more row in
their transaction (the record of access changes, migration 0079), nothing a caller sees.

Internal (`/api`):

- `POST /api/admin/import` (additive): `accessKept`, `{ removed, lowered, madePrivate, productOwners,
  creators, teamsEnded, unlinked }`, the restored access this server's record of access changes kept as
  it says; `accessAsHere`, `{ boards, teams, people }`, on a backup whose seal does not verify, the
  boards, teams and people given this server's access; and `recordsNotTaken` gains `accessChanges`, the
  rows of such a backup's record of access changes, counted and not taken. `accessKept` and
  `accessAsHere` are each present only where a count is above 0, on a restore that commits and then
  fails too; `recordsNotTaken` is present where any of its three counts is. `accountsKeptLines` and the
  message gain, each only where its count is above 0: "N board or team membership(s) and share(s) in
  the backup were removed on this server after it was made, and are left out.", "N role(s) on boards
  and teams were given back the lower role they have on this server.", "N board(s) made private on this
  server after the backup stay private.", "N board(s) keep no Product Owner, and N no recorded creator,
  as this server's record of access says: …", "N team(s) deleted on this server came back without the
  members and boards they had then: …", "N person(s) unlinked from an account on this server since the
  backup stay unlinked." and "The backup's seal did not verify, so who may open what is not taken from
  it: …"; card 3013's records sentence gains a third half, "… and of N change(s) of board and team
  access and person links …", and says of the halves present alone what an unchecked file does not do
  ("ends no account and no key", "gives no access"). The `[CRITICAL] [IMPORT]` line gains "keeping N
  access change(s) made on this server" (N leaves out `teamsEnded`, whose rows `removed` counts) and
  "giving N board(s), team(s) and person(s) this server's access", its details `accessKept` and
  `accessAsHere`. Counts only, naming no board, team, person or account.

### Changes on 2026-11-20: an unsealed backup adds nothing to this server's records of endings (card 3013)

No change to the v1 API or its OpenAPI document: it stays `1.15.0` (unreleased), its note unchanged.

Internal (`/api`):

- `POST /api/admin/import` (additive), on a backup whose seal does not verify: `recordsNotTaken`,
  `{ accountEndings, keyRevocations }`, the rows of the backup's record of account endings and of
  ended API keys that are not watermark rows, counted and not taken; and `accountStateAsHere`, the
  accounts of this server's id and creation time given its role or enabled or disabled state exactly as
  here, counting a change of role or of whether one is disabled. Each is present only where a count is above 0, on a restore that commits and
  then fails too, and never on a sealed backup. `accountsKeptLines` and the message gain "N account(s)
  in the backup with the id and creation time of an account on this server took that account's role
  and enabled or disabled state exactly as it is here, not the backup's: …" and "The backup's seal did not verify, so its record of N account
  ending(s) and of M ended API key(s) was not added to this server's: …", each half only where its
  count is above 0. No `errors` line is added. Counts only, naming no account.

### Changes on 2026-11-20: an unsealed backup's From address no longer goes on this server's mail (card 3029)

No change to the v1 API or its OpenAPI document, which has no mail settings: it stays `1.15.0`
(unreleased), its note unchanged.

Internal (`/api`):

- `POST /api/admin/import` (additive): `unsealedReach` gains `mailFrom`, 1 where a restore kept as it
  is gave the mail's From Address and From Name this server's rows back (or none, where it had
  none) and the From a mail would use changed, 0 otherwise and always 0 on a working copy, which
  removes the mail settings, and on a sealed backup. `settingsHeld`'s sentence gains, after the
  people clause and before the failure mail, "mail goes out under this server's From address and
  name, not the backup's, or under none where this server had none", and the `[CRITICAL] [IMPORT]`
  line's words "the mail's From address and name kept as on this server". No address or name.
- Every mail is handed to the mail server with its From as a name and an address apart
  (`mailFromAsRead`), so a From Name with quote marks or commas is shown as typed and never adds an
  address. `GET` and `PUT /api/admin/smtp` are unchanged.

### Changes on 2026-11-20: an unsealed backup's requesters and people are no longer mailed as the file has them (card 3020)

**Within 1.15.0 (point 11).** A person whose address and account came in with a backup whose seal did
not verify, and are not the ones this server held for them, or whose status in it was neither active
nor left, is listed with `status` `left` and `leftAt` the restore's moment, and one this server has as
left stays left. `Person.status` says so, and that marking someone active, on the People page only,
asks for the password and a code. OpenAPI stays `1.15.0` (unreleased); its note gains point (11), and
"nothing else changed" is now (12). The reply's `mailed`, below, is not in the v1 document, which has
no `/api/requests` route. **Migration 0078** adds `task_requests.mail_held_because`,
`mail_released_at`, `mail_released_by` and `mail_released_by_name` (see
[data-model.md](data-model.md)); no environment variable.

Internal (`/api`):

- `POST /api/admin/import` (additive): `unsealedReach` gains `requestsMailHeld` (confirmed requests
  whose requester mail this restore held and this server did not, whatever the file put in the
  hold), `requestsUnconfirmedHeld` (unconfirmed ones, which
  cannot be released and lapse 7 days after they were made), `peopleMailOff` (people it marked left)
  and `decisionPlacesMailOff` (the participant rows, not removed, of those people), counts only, also
  on a working copy and on the answer of a restore that committed and then failed. `settingsHeld`'s
  sentence gains, after the notification clause and before the failure mail, each only where its
  count is above 0: "N request(s) came in with a requester or card this server did not hold as it is:
  mail to each requester, links and completion reports included, is held until an administrator
  releases it under Mail held in the Requests inbox", "N unconfirmed request(s) were held too: they
  cannot be released, and lapse 7 days after they were made", and "N person(s) in the people
  directory were marked left, as this server did not hold their address and account, or has them as
  left, so N place(s) on decisions are mailed nothing: an administrator marks each active on the
  People page, with a password and a code, once the address is checked" (the "so N place(s)" part
  only where above 0). The `[CRITICAL] [IMPORT]` line's words gain "N request(s)' requester mail
  held; N unconfirmed request(s) held; N person(s) marked left; N place(s) on decisions mailed
  nothing", each above 0 only. No address, name, request title or id.
- **`GET /api/requests/held`** (new, administrators only, `403` otherwise; `Cache-Control:
  no-store`): every request whose requester mail is held, whoever it was addressed to, id order:
  `{ held: [{ id, title, status, unconfirmed, releasable, requesterName, address, card: { id, title,
  board } | null, heldBecause, createdAt }], mayRelease: true }`. `address` is the requester's address
  as stored (the account's for a request made by one), `null` where it has none; `releasable` is
  `false` for an unconfirmed request and for one with no address. Every value is the file's text: show each address with its code points and each name with
  `printable`, as the inbox does.
- **`POST /api/requests/held`** (new; an administrator, with `currentPassword` and `currentCode`,
  on `STEP_UP_ACTIONS`, forty-four): `{ requestId, address, cardId, cardTitle, cardBoard,
  currentPassword, currentCode }`, the address and the card's id, title and board as the GET gave
  them, the card's three `null` where it gave no card. `404` "Request not found"; `409` "That
  request's mail is not held now: it was released since the list was read. Nothing was changed.";
  `409` "An unconfirmed request cannot be released: it lapses 7 days after it was made. Nothing was
  changed."; `409` "A request with no address cannot be released: it stays held. Nothing was
  changed."; `409` "That request's address or card has changed since the list was read: read it
  again and review it as it is now. Nothing was changed." where the address, the card, its title or
  its board is not the one sent. Each is asked before the password and again in the write's
  transaction.
  Answers `{ success: true, released: requestId }`, records who released it and when in the row, and
  mails nothing; one `INFO` line under `REQUESTS` names the request and the administrator, never the
  address.
- **`mailHeld`** (boolean) on each request of `GET /api/requests` and on the signed-in
  `GET /api/requests/{id}`. The token holder's answers (`POST /api/requests`, a requester's
  `GET /api/requests/{id}`) and `PATCH /api/requests/{id}`'s carry no `mailHeldBecause` and no
  `mailReleased*`.
- **A held request mails nothing**: no progress mail or completion report on its card, no accept or
  decline (`PATCH /api/requests/{id}` accepts, makes the card and answers as before), no reply, and
  `POST /api/requests/{id}/link` with its exact address is answered `202` with the usual words and
  sends nothing. Progress mail on a card now goes to every accepted request on it that is not held,
  each with its own link.
- **The reply's `mailed`.** An administrator's or a team member's `POST /api/requests/{id}/messages`
  answers the saved message with `mailed: true` only where a mail to the requester was handed on, and
  `mailed: false` otherwise: the request held, no address, mail not set up, or no App URL for the
  link. The inbox then shows "Mail held – the requester was not mailed" for a held request. A
  requester's own post answers as before.
- **`PUT /api/people/{id}` asks for the password and a code for Mark active**: a body with `status`
  of any value other than the exact string `'left'` is on the step-up, as `email` and `userId` are
  (`400` `STEP_UP_MISSING` without them). `{ "status": "left" }` alone asks nothing more. Left to
  active without the step-up is refused `400` "Marking a person active asks for your password and a
  code: their decision mail and personal links go to their address again. Nothing was changed."
  Mark active also carries `reviewedEmail`, the address the confirmation showed, which is required
  (`400` "reviewedEmail is required") and writes nothing: where it is not the person's address now,
  `409` "This person's address has changed since the page was read: read it again and check the
  address before you mark them active. Nothing was changed."
- An unsealed restore marks left each person whose id, address and account this server did not hold
  (the account the same here), whom it has as left, or whose status is neither active nor left, with
  a `people_changes` row by DumpFire, source `restore`; and holds each request with an address that it
  did not hold as it is (the request, its card and the card's board). A sealed restore does none of
  it.

### Changes on 2026-11-20: an unsealed backup's webhooks, schedules and addresses no longer reach outside (card 3012)

**Within 1.15.0 (point 10).** A webhook that comes in with a backup whose seal did not verify and
has an address is switched off for good, whatever the file says of it, and its secret is discarded.
`pausedBecause` says so: "This was switched off because it came in with a backup whose seal did not
verify, so its address, its secret and who set it up are only the file's word, and its secret was
discarded. Delete it unless you recognise the address; to keep it, switch it on with your own key,
which makes you its setter and gives it a new secret, given in that answer and readable by the
board's owner or an administrator, and update the receiver." Switching it on (`PUT
/api/v1/webhooks/{webhookId}` with `{"active": true}` alone, by the board's owner or an administrator)
gives it a new secret in that answer, and a `secret` sent with it is `400`, as for every other hold.
OpenAPI stays `1.15.0` (unreleased); its note gains point (10), and "nothing else changed" is now
(11). No migration and no environment variable.

Internal (`/api`):

- `POST /api/admin/import` (additive) gains `unsealedReach`, `{ webhooks, schedules, accountsAsHere,
  addressesGivenUp, notificationsOff, notifyEmail }`, counts only and absent where all are 0, also on
  the answer of a restore that committed and then failed. `webhooks` counts those held and still
  held for this reason after this server's own holds were carried, whatever the file put in
  `held_because` (card 3020's code review, FP2); `schedules` the report schedules
  paused (restored as it is only); `accountsAsHere` the accounts that are the same here given this
  server's email address and notification choices; `addressesGivenUp` the other accounts that held
  one of those addresses, or shared one apart from case with a lower-numbered account not the same
  here, given `email-given-up-<id>@restore.invalid`; `notificationsOff` the accounts not the same here
  whose notification mail was switched off (not one the record of account endings deleted);
  `notifyEmail` 1 where the address the backup failure mail goes to changed to this server's. `settingsHeld` gains, after card 3009's sentence, each
  clause only where its count is above 0: "The backup's seal did not verify, so what it would send
  outside was not taken as the file has it: N webhook(s) with an address were held and their secrets
  discarded: each sends nothing until an owner of its board or an administrator switches it on, which
  gives it a new secret; N report schedule(s) were paused: each owner turns one on again on the
  Reports page; N account(s) that are the same here keep the email address and notification choices
  they have on this server; N other account(s) that held one of those addresses were given one that
  receives no mail: set each one's address on the Users page before inviting it; N account(s) not the
  same here have their notification mail switched off until each signs in and switches it on; and the
  backup failure mail goes to this server's address, not the backup's."
- Every webhook held for this reason, one the file already held included, is added to
  `toEnter.heldWebhooks` (`{ id, boardId, board }`), so the "To enter again" sentence lists each by id
  and board as switched off for good: at most ten, then "and N more", each board name quoted as JSON
  and cut to 60 characters. The restore's notice of the
  webhooks it switched off or held is a `WARN` line only: they "were not mailed, as the backup's seal
  did not verify".
- The `[CRITICAL] [IMPORT]` line gains ", keeping what a backup whose seal did not verify would send
  outside: N webhook(s) held; N report schedule(s) paused; N account(s)' email address kept as on this
  server; N other account(s)' address given up; N account(s)' notification mail switched off; the
  backup failure mail's address kept as on this server" (the parts above 0 only), and its details
  carry `unsealedReach` where any count is above 0. No username, email address, host or schedule name.
- The Users page's 📧 confirm reads "Send {username} a new invite, to {address}? …", the username
  through `printable` and each character of the address outside printable ASCII shown as its code
  point (`\u{202E}`).
- `PUT /api/v1/webhooks/{id}` switching on any held webhook gives it a new secret and refuses one
  sent with it, whatever its reason, one this build does not name included (no change to the
  OpenAPI document: a reason this build does not name is none it describes).

### Changes on 2026-11-20: an unsealed backup gives no account not here a password, key or factor (card 3009)

Not Breaking; no operation, field or schema of `/api/v1` changes, and OpenAPI stays `1.15.0`
(unreleased) with its note as it is. No migration and no environment variable. An import of a backup
whose seal does not verify takes no password, second factor or API key from it for any account that
is not the same account here; every backup now carries the server's installation id, which decides
that, and which no answer or log line ever holds. A key of such an account answers `/api/v1` `401`, as
any key the server does not hold.

Internal (`/api`):

- `POST /api/admin/import` (additive). `passwordsKept` is now `{ here, reset, superadmin, unsealed,
  superadminGivenYours, givenYoursWithoutFactor, givenYoursMayEnrol, emailGivenUp }`, given where any
  of the first five is above 0: `unsealed`, accounts not the same here whose password in the backup was
  not taken; `superadminGivenYours` (0 or 1), the backup's superadmin given the importing account's
  password and authenticators; `givenYoursWithoutFactor` (0 or 1), given none of its authenticators;
  `givenYoursMayEnrol` (0 or 1), so given, it holds the importer's leave to set up on its password alone
  and that leave's 14 days run; `emailGivenUp`, the other accounts in the backup that held the
  importer's email address, which the carried superadmin always takes, given one under `.invalid`
  (card 3009's code review, FP5, FP6). Each adds its sentence to `accountsKeptLines` and `message`:
  "N account(s) in the backup are not on this server as the same account, and the backup's seal did
  not verify, so the password each holds in it was not taken: each needs its password set (🔑) or an
  invite (📧) before it can sign in, and its report schedules were paused. The backup's App URL and
  mail host, where they differ from this server's, are held for review. Before sending an invite, check
  each one's email address and role, and the App URL and the mail host: in a backup whose seal did not
  verify they are only the file's word. Or set its password with 🔑, which mails nothing." (for
  `?outside=off`: "…: each needs its password set (🔑) before it can sign in. As a working copy, every
  report schedule was switched off, and the mail settings and the backup's App URL were removed, so no
  invite can be mailed. Before giving anyone a password, check each one's email address and role: in a
  backup whose seal did not verify they are only the file's word.", FP14) and "The backup's superadmin
  is not the account you imported with, and the backup's seal did not verify, so its password in the
  backup was not taken: it was given the password you confirmed this import with, and your
  authenticators. Sign in as it, the superadmin that now holds your email address, with that password
  and a code from your authenticator, and change the password on the Account page if you wish."
  (without a factor: "…, but none of your authenticators, as no MFA key is loaded or none of yours
  could be moved: it cannot sign in until the server's host resets its two-step sign-in with
  scripts/mfa-reset.mjs. Then sign in as it, the superadmin that now holds your email address, with
  that password."; with the leave: "…, and your leave to set up two-step sign-in on that password
  alone. Sign in as it, the superadmin that now holds your email address, with that password and set
  up an authenticator when asked, while that leave's 14 days run; if it is asked for a link instead,
  the server's host resets its two-step sign-in with scripts/mfa-reset.mjs."), never naming a username
  (FP7), and, where `emailGivenUp` is above 0, " N other account(s) in the backup held your email
  address and were given one that receives no mail: set each one's address on the Users page before
  inviting it.".
- `outside` for `?outside=off` of a backup whose seal did not verify gains `appUrl: 1` where its App
  URL was removed (absent otherwise), and `workingCopy` ends ", and the backup's App URL removed, as
  its seal did not verify: links begin with this server's own address." (FP3).
- An unsealed import restores no invite at all; a sealed one only used invites, written used (FP1).
- The answer's `apiKeysLeftOut` stays the count of keys ended here; the restore's figure, in the
  `[CRITICAL] [IMPORT]` line's details, is now `{ count, keyIds, workingCopy, unsealed }`. `unsealed`
  above 0 adds to `keysLeftOut`: "N API key(s) in the backup were left out, because the backup's seal did not
  verify and this server did not hold them for the same account: none of them works, and their holders
  make new ones on the Account page."
- `unsealedHeld`, `{ mail, destinations, appUrl }`, absent where all are 0: what the restore held for
  the superadmin's review; `settingsHeld` gains its sentence, which the panel shows: "The backup's seal
  did not verify, so the mail settings, the App URL and N backup destination(s) it brought in, at
  places this server did not hold, were held for the superadmin's review: nothing is sent through them,
  and no link begins with the App URL, until the superadmin checks each and keeps or removes it under
  Settings held for review." (naming only the kinds held).
- `mfaWithoutFactor`, for an unsealed import, names no account (FP7): the accounts not the same here
  "N account(s) in the backup are not on this server as the same account and have no second factor
  after this restore: each needs its two-step sign-in reset before it can sign in.", and those that are
  "N account(s) on this server have no second factor after this restore and each needs its two-step
  sign-in reset before it can sign in; the backup's seal did not verify, so none is named here."; where
  the carry gave the first second factors on the server (FP12), it begins "Your authenticators, given
  to the backup's superadmin, are the first second factors on this server, so two-step sign-in is in
  use from this restore: every other account needs a second factor before it can sign in."
- A restore that committed and then failed answers `settingsHeld` and `unsealedHeld` too.
- The `[CRITICAL] [IMPORT]` line counts `unsealed` in "keeping N of the backup's password(s) out of
  use", adds ", giving the backup's superadmin the importing account's password" (" but no
  authenticator"), "N API key(s) of a backup whose seal did not verify" and ", holding N setting(s) of
  a backup whose seal did not verify for the superadmin's review"; its details carry the new fields,
  `unsealedHeld` where any, and `installation` (`this`, `other` or `none`, only where the seal did not
  verify), never the id.
- `GET /api/admin/settings/held` lists the restore's holds as any other, with no setter (the
  `setting_holds` row's `held_because` is `restored from a backup whose seal did not verify`); Keep
  and Remove work on them unchanged. Each item now carries `heldBecause`, which the page words it by:
  a restore's hold names no setter (FP4). A held mail's `problem` stays `held`, and its words, and a
  held destination's `409` message, say it came in with a backup whose seal did not verify.

### Changes on 2026-11-20: a restore never brings back a password replaced here (card 2997)

Not Breaking; no operation, field or schema of `/api/v1` changes (it signs in with API keys, never a
password), and OpenAPI stays `1.15.0` (unreleased) with its note as it is. Every password change on the
server records a fingerprint of the password hash it replaces, never the hash, and an import never
brings such a password back into use.

Internal (`/api`):

- `POST /api/admin/import` (additive) answers `passwordsKept`, `{ here, reset, superadmin }`, the
  restored passwords kept out of use, counted and never named: `here`, accounts that are the same
  account on this server and keep its password; `reset`, accounts given a password nothing matches,
  each needing its password set or an invite (for a superadmin, its password set by another
  superadmin); `superadmin`, superadmin accounts left with a password
  to change at once, so that a superadmin can still sign in. It is absent where all three are 0. Each
  count above 0 adds its sentence to `accountsKeptLines` (after card 2996's) and to `message`, and a
  restore that committed and then failed answers them too.
- The sign-in, a session's creation and every action that asks for the password again answer a
  password the record names as replaced as they answer a wrong one, for every account but a
  superadmin.

Not Breaking; no operation, field or schema of `/api/v1` changes, and OpenAPI stays `1.15.0`
(unreleased) with its note as it is. Every delete, disable, enable and role change of an account, and
the role it is made with, is recorded on the server by the account's id and creation time (for a
delete, a fingerprint of its password hash, never the hash). A key of an account the record names as
deleted is answered `401` `{ "message": "Invalid or expired API key" }`, as a disabled account's is,
whatever a host edit has done to its row; an import of an older backup brings such an account back
disabled, so its keys stay ended.

Internal (`/api`):

- `POST /api/users/{id}/enable` answers `409` `{ "message": "The record of account endings names this
  account as deleted, and a restore brought it back: it cannot be enabled. Delete it; then make a new
  account for anyone who returns." }` for an account the record names as deleted, before the
  password and code are asked, with nothing written; and `403` `{ "message": "Only the superadmin can
  enable an account the record of account endings keeps disabled (a restore or the start brought its
  disable)" }` to an administrator for an account whose disable the record ruled, before the password.
- `POST /api/admin/import` (additive) answers `accountsKept`, `{ deleted, beforeRecord, disabled,
  lowered }`, the restored accounts the record kept ended or lowered, counted and never named, and
  `accountsKeptLines`, one sentence for each kind there was, absent where all are 0; and
  `accountRecordLeftOut`, the rows of the backup's record left out whole for its size (more than
  1,000,000 rows naming accounts by number alone, or other rows, or more than 100 for one account),
  0 where it was taken; a restore that committed and then failed answers them too.
- `POST /api/admin/reset` (additive) answers `accountsRecorded`: every account but the superadmin,
  recorded as disabled before the clear, so that an import after the reset brings them back
  disabled.

### Changes on 2026-11-19: a restore never brings back a key ended here (card 2995)

Not Breaking; no operation, field or schema of `/api/v1` changes, and OpenAPI stays `1.15.0`
(unreleased) with its note as it is. Every way a key ends (a revoke, an ending of its account's
access, the account's delete, Reset Everything) records the key's id and SHA-256 on the server,
never the key. A key that record names is answered `401` `{ "message": "Invalid or expired API key"
}` wherever it is presented, as an ended key is; an import of a backup made before the key ended
leaves it out of the restored data; and the server's start, and a sweep every five minutes, end any
such key it finds in place. A script whose key was revoked, or whose account's keys were ended,
keeps getting `401` after an administrator restores an older backup: give it a new key. A working
copy restored from a backup has no API key at all.

### Changes on 2026-11-19: an API key given a webhook's secret holds it when it ends (card 2947)

**Breaking (security), within the unreleased 1.15.0, point (9) of its note; "nothing else
changed" is now (10).** No operation or schema changes.

- Every answer that gives a webhook's `secret` records the API key it was given to:
  `GET /api/v1/webhooks/{webhookId}`, `GET /api/v1/boards/{boardId}/webhooks`, `POST
  /api/v1/boards/{boardId}/webhooks` with a secret, and `PUT /api/v1/webhooks/{webhookId}`. All four
  answer with `Cache-Control: no-store`.
- `PUT /api/v1/webhooks/{webhookId}` now gives `secret` only where that request set or replaced it
  (a `secret` sent, or the new one a switch-on out of a hold gives); any other change is answered
  with `url`, `lastDelivery` and `pausedBecause` but no `secret`. A script that read the secret
  back from an `events`-only `PUT` reads it with `GET` instead.
- When that key is revoked, expires or passes its deadline, every webhook with a secret it was given
  since the secret last changed, and not already held, is switched off (or held, where already off)
  as `setter access ended`, whoever set it: in the same change as a revoke, within five minutes of an
  expiry or a deadline, at every start and in a restore. So is every webhook an account's keys were
  given when its access ends with its keys. Switching it on gives it a new secret, as point (1) says.
- Once, at the first start of 1.15.0, every key used before it counts as given the secret of each
  webhook with a secret its account can read or set, made before the key's last use; the webhooks
  of keys already ended are held then. (Since 1.15.1, card 3064: not at installation on an
  upgraded server; only reads from then on are recorded until the administrator runs this seed at
  a planned event, E4.)
- `pausedBecause`'s `setter access ended` sentence names the key and says to treat the old secret as
  exposed and change it at the receiver now. The owners' mail says the same.

Internal (`/api`, additive): `GET /api/account/api-keys` gives each key `webhooksRevealed` (how many
more a revoke or the key's end would hold); `DELETE /api/account/api-keys/{id}` answers
`revealedWebhooksHeld` beside `webhooksSwitchedOff`, and its mail to the boards' owners names no
account.

### Changes on 2026-11-19: settings held for review (card 2922)

**The published API does not change**: no `/api/v1` route reads or writes the mail settings, the
App URL or the backup destinations, and no v1 answer carries a mail problem. OpenAPI stays `1.15.0`.
The web application's own routes change:

- `PUT /api/users/:id/password`, `PUT /api/account/password` and `POST
  /api/users/:id/mfa/reset` answer `settingsHeld`, `{ mail, appUrl, destinations }` or `null`:
  what the account set that the ending held for the superadmin's review. The two-step reset's
  message says it by count. A two-step reset whose only link address would be an App URL the
  account set is refused `503` before the password is asked.
- New: `GET /api/admin/settings/held` (every administrator) answers `{ held: [{ setting, kind,
  name, place, heldAt, setBy, setByName, where }], tombstones, mayRelease }`, `where` with no
  secret. `POST /api/admin/settings/held` (the superadmin, with `currentPassword` and
  `currentCode`) takes `{ setting, place, action: 'keep' | 'remove' }`: `403` for anyone else, `409`
  for a setting not held now or held at another place than `place` (for an SFTP destination,
  `place` covers its confirmed host key too). It answers `{ success, kept }` or `{ success,
  removed, ended }`, `ended` the counts of invites, set-up links, request links and decision links
  (`decisionLinks`) a Remove of held mail or a held App URL ended across the server. The `GET` is
  answered with `Cache-Control: no-store`.
- `PUT /api/admin/smtp` answers `409` for a save of the mail settings while they are held, and of
  the App URL while it is held. `POST /api/users/:id/invite` answers `409` where the mail settings
  or the App URL in force were set by the account invited.
- `POST /api/admin/backup/test` and `GET`/`POST /api/admin/backup/gdrive/auth` answer `409` for a
  held destination; `PUT /api/admin/backup` answers `409` for a save that renames, retypes or
  removes one.
- Mail held for review is refused as mail that cannot go: `POST /api/users/:id/invite` and a
  user made with no password `400`, `POST /api/requests` (one to confirm) and `POST
  /api/requests/:id/link` `503` in their plain words.
- `POST /api/admin/import` answers a line, and `settingsHeld` among its figures, where this
  server's holds were carried over a backup that lacked them.

### Changes on 2026-11-18

**Breaking, within 1.15.0 (point 7): ending or lowering an owner's or administrator's access holds
every webhook whose secret it could read** (card 2935). A webhook's secret is given only to the
board's owner (its creator, or an exact `owner` member row) and to an administrator or the
superadmin (every board), through `GET /api/v1/boards/{boardId}/webhooks`, `GET
/api/v1/webhooks/{webhookId}` and the `PUT` that switches one on. So when such an account's access
ends with its keys (a password reset, a two-step reset, on the server's host too unless run with
`--keep-api-keys`, an invite used, its own password change that ends keys, a disable, or a delete,
unless the account's disable already covered it and it held no key), or an administrator is made
an ordinary user, or an owner of
a board is made an editor or a viewer or taken off it, every webhook whose secret it could read and
can no longer, that has a secret and is not already held, is switched off (or held, where already
off) as `setter access ended`, whoever set it: switched on again it is given a new secret, a
`secret` sent with that switch-on is `400`, and only the board's owner or an administrator deletes
it or makes a webhook to its receiver. An account that provably read nothing (never signed in, no
API key, no invite used but the one being used, made after two-step sign-in was released here) is
left out. Every start holds each webhook with a secret that an owner or administrator disabled
since the last start could read (the first time, any, and every webhook made before setters were
recorded), and every restore does the same from the backup's own record of it. The two `GET` routes
that give a secret ask again whether the key still works, and who its account is now, before
giving it (a key ended meanwhile is `401`). The `setter access ended` sentence now names an account
that could read the secret. The boards' owners are mailed as for any ending. Internal answers,
additive: the password set, the own change, the disable and the two-step reset answer
`readableWebhooksHeld`; `webhooksSwitchedOff` still counts only the webhooks the account set.

**Breaking: ending an account's access also holds the webhooks it set that were already switched
off, and mails the boards' owners** (card 2923; OpenAPI document version `1.15.0`, with a dated
note, marked breaking, at the top of its description). Every way an account's access ends with
its keys (an administrator's password set, an invite used, the holder's own change that ends
their keys, a two-step reset by an administrator or on the server's host unless run with
`--keep-api-keys`, a disable, a delete) already switched off the webhooks it set that were on.
Now:

1. A webhook it set that was switched off without a hold (by `PUT` with `active` `false`, or by a
   restore kept apart) is held too, `setter access ended`, `active` left `false`. So is every
   webhook already switched off with no hold, whoever set it, once: at the first start of 1.15.0,
   and in a restore of a backup made before it (one whose settings lack
   `webhooks_already_off_held`); and one whose setter is disabled or not recorded, at every start
   and in every restore, a restore kept apart included. (Since 1.15.1, card 3064: the once-only
   hold is not applied at installation, which records `webhooks_already_off_held`, and a restore
   keeps this server's; the administrator applies it at a planned event, E6. The every-start hold
   of one whose setter is disabled or not recorded still runs.) `pausedBecause` gives the sentence where
   it was `null`; switching it on gives it a new secret and refuses a `secret` sent with it
   (`400`); only the board's owner or an administrator deletes it (an editor's `DELETE` is `403`)
   or makes a webhook to its receiver on that board (`409`).
2. The boards' owners are mailed, once the write is committed, one mail each per write: the
   webhooks it switched off, and apart the ones it held, host only, with the kind of action that
   caused it and no account ("the account that set it up had its password reset by an
   administrator"); the system log names both accounts. A reset on the server's host mails
   nobody: it logs that the owners were not mailed and prints the list for its operator to pass on.
3. The `setter access ended` sentence now names the holder's own change that ends keys, and the
   webhooks held when already off: "This was switched off because the account that set it up had
   its password or its two-step sign-in reset, ended its API keys when changing its own password,
   used an invite, was disabled, or was deleted; one already switched off then, or found switched
   off with its setter disabled or not recorded, is held the same way. …" (the same advice).
4. A webhook switched off because nobody was recorded as its setter is given a new secret too when
   switched on, and a `secret` sent with that switch-on is `400`; its `pausedBecause` says so. It
   kept its secret before, which an account whose access has ended since may have set.
5. Webhook secrets are stored sealed, under a key derived from the server's MFA key and bound to
   the webhook's id, board and url (card 2898), and are given in answers as before. A webhook
   whose stored secret cannot be opened (sealed under another key, or its row changed outside
   DumpFire) is never delivered, neither unsigned nor with that stored text: its `lastDelivery`
   says "Not sent: its signing secret cannot be opened", it stays as `active` as it was with its
   `pausedBecause` unchanged, and a read that gives the secret gives `''` with `hasSecret` `true`.
   A `PUT` that sends `secret` for such a webhook always replaces it, `''` clearing it to
   unsigned, and records the caller as its setter as any change of secret does.
6. Webhook urls are stored sealed too, bound to the webhook's id, board and receiver (card 2928),
   and are given in answers as before, to the same callers. A backup holds no url: a restore onto
   the server that made it puts each back, and any other gives `url` `''` until it is entered, the
   webhook off and listed to enter. A webhook whose `url` is `''` or cannot be opened is never
   delivered ("Not sent: it has no address", "Not sent: its address cannot be opened") and its
   `url` is given as `''`, so `Webhook.url` is no longer `format: uri`. A `PUT` that switches such a
   webhook on must send `url`, a `secret` other than `''` sent for it must come with `url`, a `url` sent beside a
   secret that cannot be opened must come with a new `secret` (each `400` otherwise), and a `url`
   that is not well-formed text is `400`. The same url sealed again keeps its `lastDelivery`.
7. Nothing else changed: no operation, field or schema. The internal answers'
   `webhooksSwitchedOff` still counts only the webhooks that were on; an ending that keeps the keys
   (the holder's own change without ending them, or `--keep-api-keys` on the host) holds nothing,
   and `pausedBecause` stays `null` for one of its webhooks switched off by a `PUT`.

Before, a webhook its owner had paused, or an intruder had switched off, kept the secret its
setter knew through the ending of that setter's access, and was sent with it again once
switched on.

**Breaking: a reset of an account's two-step sign-in ends its API keys and switches off its
webhooks** (card 2915; OpenAPI document version `1.14.0`, with a dated note, marked breaking, at
the top of its description). A reset by an administrator, on the admin page, or on the server's
host (`scripts/mfa-reset.mjs`, unless it is run with `--keep-api-keys`) now does what a password
reset has done since 1.11.0:

1. The account's keys answer `401 {"message": "Invalid or expired API key"}`, as after a password
   reset. Its holder makes new ones on the Account page once their new authenticator is set up.
2. The webhooks it set are switched off, `active` `false`, recording `setter access ended`, so
   switching one on again is the board owner's or an administrator's and gives it a new secret.
3. `pausedBecause` for that hold now names a two-step reset: "This was switched off because the
   account that set it up had its password or its two-step sign-in reset, used an invite, was
   disabled, or was deleted."
4. Nothing else changed: no operation, field or schema.

Before, a reset kept the keys and webhooks and listed them for the holder to look over; a key
skips the second factor, so one made by whoever had the lost phone and the password outlived the
reset. Since card 2923 (1.15.0, above) the boards' owners are mailed when a reset switches a
webhook off, and of any it held that was already off.

**Internal route, additive** (card 2915): `POST /api/users/{id}/mfa/reset` answers two more
fields, `apiKeysEnded` (every key row ended, one already ended included) and
`webhooksSwitchedOff`, in both branches. Its `message` says what ended: where the link is given,
how many working keys ended and webhooks were switched off, with the day each was made and no
name ("Their 2 API keys (made 2026-11-01 and 2026-11-10) were ended and the 1 webhook they set up
(made 2026-11-12) switched off; the lists are in the notice mailed to them."), and, for an
account that set the mail settings, the App URL or backup destinations, "They set …: review them
on the admin page."; where the link is withheld, the counts alone. See
[The Administrator's Reset](authentication-security.md#the-administrators-reset).

**Every upload counts, and only so many at once** (card 2910; OpenAPI document version
`1.13.1`, with a dated note at the top of its description; not breaking). No operation, status,
field or schema changes, but five things a key sees do (the fifth with a new `408`):

1. The 30 uploads an hour and 100 MB a day of a key's user now count every file that user
   uploads through the card window, not only images, so a key can be answered `429` sooner.
2. `POST /api/v1/cards/{cardId}/attachments` is also answered `429` when the user already has
   3 uploads in progress, either way, or the server 6, with `Retry-After: 5`, before the body is
   read and with nothing counted: `{"message": "Too many uploads are in progress. Nothing was
   read or written. Try again when the others have finished.", "retryAfterSecs": 5}`.
3. A `429` given before the body is read, for the hour or for uploads in progress, closes the
   connection (`Connection: close`), and so does every other refusal given before the body is
   read: the `404`, the `403`, the `415`, and a declared `Content-Length` over 5 MB answered
   `413`. The day's `429`, given after the body, does not.
4. The `429`'s words say files where they said images: `An account can upload at most 30 files
   an hour. Nothing was read or written. …` and `An account can upload at most 100 MB a day, and
   this upload would pass it. Nothing was written. …`.
5. The body must arrive within 120 seconds of its read beginning, else the upload is answered
   `408 {"message": "The upload did not arrive within 120 seconds. Nothing was written."}` with
   `Connection: close`, and the read is stopped. A body whose read fails, is cut off past 5 MB
   (`413`) or runs out of time is counted against the day with what was read, before its failure
   is answered.

Internal routes, stricter, not breaking: `POST /api/cards/:id/attachments`, the card window's
upload, takes a place in flight and counts the upload against the account's hour **before the
form is read, for every file** (`429`, `Connection: close`), and charges the day what was read
of the form, before anything in it is checked. Every refusal before the form is read (`401`,
`400`, `404`, `403`, the gate's `413` for a declared length, the `429`s) closes the connection;
the form is given 120 seconds to arrive (`408`, `Connection: close`), and a read that fails,
is cut off or runs out of time is charged what was read. A form that is not exactly one part named
`file` is `400 Send one file, as the only part of the form, named "file"` (it was `400 No file
provided` for no file, and other parts were read and ignored). The 21st file that is not an
image on a card is `409 This card already has 20 files other than images`. A file that is not
an image has its name cleaned and cut to 100 characters, its extension kept as sent
(`file-<UTC date>-<time>` with nothing left), its type kept only when plain and in lower case
(else `application/octet-stream`), and is stored on disk as `<uuid>` alone, so the list's
`filename` for such a file is a bare UUID. See
[Authentication and Security](authentication-security.md#upload-limits-for-every-file-card-2910).

**Breaking: a disabled account has no access to anything** (card 2671; OpenAPI document version
`1.13.0`, with a dated note, marked breaking, at the top of its description). An administrator
disables an account on the admin page, not through a key. From this release:

1. Its API keys end when it is disabled, and a key of a disabled account is answered
   `401 {"message": "Invalid or expired API key"}` by every operation, as an ended key is.
2. It can open and edit no board, so it is refused as an account without the board: as `userId`
   on `POST /cards/:cardId/assignees`, `400 {"message": "User does not have access to this
   board"}`; as `productOwnerUserId` on `PUT /boards/:boardId`, `400 productOwnerUserId N cannot
   edit this board: …`; as `deciderUserId` on `PUT /decisions/:decisionId/decider`,
   `400 deciderUserId N cannot edit this board: …`. It is not among a decision's
   `deciderCandidates`.
3. `PUT /decisions/:decisionId/participants` refuses a person whose account is disabled,
   `409 {"message": "<name> cannot be included: their account is disabled"}`, and writes nothing.
4. The webhooks it set are switched off for good (`setter access ended`), and `pausedBecause`
   says of them "This was switched off because the account that set it up had its password
   reset, used an invite, was disabled, or was deleted." (since 1.14.0, "had its password or its
   two-step sign-in reset, …").
5. Nothing else changed: no operation, field or schema. Enabling the account again gives back
   its sign-in alone: none of its keys, and none of its webhooks switched back on.

**Internal routes, breaking: disable, enable, and delete only a disabled account** (card 2671).
Each is a session's route, behind the password and a code (`currentPassword`, `currentCode`,
step-up actions `POST /api/users/[id]/disable`, `POST /api/users/[id]/enable`):

| Route | Answers |
|-------|---------|
| `POST /api/users/{id}/disable` (new) | `{ disabled: true, disabledAt, sessionsEnded, invitesEnded, apiKeysEnded, webhooksSwitchedOff, reportSchedulesPaused, requestLinksEnded, soleOwnerOf, noticeSent, settingsRemoved? }`, `settingsRemoved` being `{ mail, appUrl, destinations, failureAddress }` where something was. `403` for the caller's own account (`You cannot disable your own account`), the superadmin's, or an administrator's by an administrator; `409 This account is already disabled` |
| `POST /api/users/{id}/enable` (new) | `{ enabled: true, noticeSent }`. `403` for the caller's own account, as disable, and for an account the superadmin disabled, by an administrator (`Only the superadmin can enable an account the superadmin disabled`); `409 This account is not disabled`; since card 2996, `409` for an account the record of account endings names as deleted (`The record of account endings names this account as deleted, and a restore brought it back: it cannot be enabled. Delete it; then make a new account for anyone who returns.`), before the password |
| `DELETE /api/users/{id}` (**breaking**) | `409 {"message": "Disable the account first"}` for an account that is not disabled, where it deleted it; `403 Only the superadmin can delete an account the superadmin disabled`. Both before the password is asked |
| `PUT /api/users/{id}/password`, `POST /api/users/{id}/invite`, `POST /api/users/{id}/mfa/reset` | `409 This account is disabled: enable it first` for a disabled account |
| `POST /api/boards/{id}/share`, `POST /api/teams/{id}/members/{userId}` | `400 That account is disabled` for a disabled account added, or given a higher role; lowering and removal stay open |
| `POST /api/people`, `PUT /api/people/{id}`, `POST /api/people/from-accounts` | `400 userId N is a disabled account` for a link to one, or one added from accounts |
| `GET /api/users`, `GET /api/requests/targets` | Leave disabled accounts out; the Teams page's list names them with `disabled: true` |
| `POST /api/requests` | `404` for a disabled target, as for one that is not there |

See [Disabled Accounts](authentication-security.md#disabled-accounts-card-2671).

**Internal routes: a task request a signed-in caller cannot read is answered 404, not 403**
(card 2914; the v1 API does not change, as no task request route is under `/api/v1/`). Request
ids are counted up one at a time, and a `403` for one that exists beside a `404` for one that
does not let any account learn which requests exist among those it cannot see. A signed-in
caller who cannot read a request (its addressee, a member of the team it is addressed to, an
administrator, or the requester signed in can) is answered `404 {"message": "Request not
found"}`, the words one that is not there gets, by `GET /api/requests/{id}`,
`GET /api/requests/{id}/messages`, `POST /api/requests/{id}/messages` (from the team, or as the
requester without the link) and `PATCH /api/requests/{id}` (accept and reject), where it was
`403` (`Access denied`, `This request is not addressed to you` or `Invalid or missing link
token`). `403` is kept for a caller who can read it and asks for what they may not do: the
requester accepting, rejecting or replying as the team (`This request is not addressed to
you`), or a reader replying as the requester without the link (`Invalid or missing link
token`). The accept and reject now ask the same rule as the other request routes. Nothing
changes for the people a request is addressed to, for the requester's emailed link, or for the
inbox. See [The Public Request Form](authentication-security.md#the-public-request-form).

**Breaking: a milestone the key's user cannot see is answered 404, not 403** (card 2911;
OpenAPI document version `1.12.0`, with a dated note, marked breaking, at the top of its
description). Milestone ids are counted up one at a time, and a `403 No access to this
milestone` for one that exists beside a `404 Milestone not found` for one that does not let any
key holder learn which goals exist among those they cannot see. From this release:

1. Every operation that names a milestone by its id (under `/milestones/:milestoneId`, as
   `milestoneId` on `PUT /cards/:cardId`, and as `milestoneId` on `GET /burndown`) answers a
   milestone the user cannot see (of a board they cannot open, or across boards with a card on
   a board they cannot open) `404 {"message": "Milestone not found"}`, the words one that is not
   there gets, where it answered `403 {"message": "No access to this milestone"}`. That
   includes a goal across boards the user made, once it holds a card on a board they cannot
   open: such a goal is its maker's only while it has no card.
2. A milestone the user can see and may not change is still `403 {"message": "No edit access
   to this milestone"}`.
3. Putting a card in another milestone, or taking it out (`milestoneId` another id or `null` on
   `PUT /cards/:cardId`, `POST /milestones/:milestoneId/cards`), when the user cannot see the
   milestone the card is in, is answered `403 {"message": "No access to the milestone this card
   is in"}`, where it was `403 No access to this milestone`: that milestone's id is on the card,
   and the request did not name it.
4. Nothing else changed: no operation, field or schema.

**What to do.** A script that treats `403` as "no access" to a milestone should treat `404` the
same way. Nothing to migrate. The rule is in
[Authentication and Security](authentication-security.md#not-found-not-forbidden-card-2719).

**Breaking: a webhook whose setter can no longer open its board is switched off for good, and
so is one whose API key has ended** (cards 2752 and 2893; OpenAPI document version `1.11.0`,
with a dated note, marked breaking, at the top of its description). Until this release such a
webhook was held, and sent again by itself once its setter could open the board again, with no
password asked; and a webhook went on sending after the key that set it up had ended. From this
release:

1. A webhook whose setter (the account that created it, or last set its `url` or `secret`, or
   switched it on) can no longer open its board, and one nobody is recorded as having set up,
   is switched off, `active` `false`: at the change that takes the access away (a person or a
   team taken off the board, the setter taken out of a team, a team deleted, the board made
   private, the setter's role changed), at every start, after every restore of a backup, and at
   its next event where none of those saw it.
2. It stays off when the setter is given the board back, the board is made public again or the
   role is given back.
3. A password reset, an invite used or the setter's account deleted, which switched off the
   webhooks the account set, now records why too (`setter access ended`), so such a webhook is
   held as one whose setter lost the board is.
4. `pausedBecause` says, as history, why it was switched off and what to do; for one still on
   and held now it begins "Nothing is sent: "; it is `null` for one switched off by `PUT`.
5. `PUT /webhooks/:webhookId` with `{"active": true}`, the board's owner's or an
   administrator's as before, makes the caller its setter and, for one whose setter lost the
   board or had its access ended, answers a new `secret`, 64 hexadecimal characters, given
   there and readable by the board's owner or an administrator; a `secret` sent with that
   switch-on is `400`, nothing written. One with no recorded setter keeps its secret (until
   1.15.0, card 2923, since which it is given a new one too).
6. `DELETE /webhooks/:webhookId` of a webhook switched off this way is the board's owner's or
   an administrator's: an editor is `403`, nothing deleted.
7. `POST /boards/:boardId/webhooks` by anyone but the board's owner or an administrator is
   `409`, nothing created, for a receiver (the same scheme, host and port, whatever the path,
   query, fragment, case or default port) of a webhook of the board switched off this way,
   asked after every other check.
8. The board's owners, or the administrators where it has none, are mailed when its webhooks
   are switched off for lost access, naming the change and who made it, and when someone else
   makes a webhook on the board.
9. Each webhook records the API key that created it, last set its `url` or `secret`, or
   switched it on, which no answer gives (card 2893). It is switched off for good the same way,
   its key ended, when that key ends: revoked by its holder (in the same change, and the
   Account page says how many first), expired, past its deadline, deleted any other way, or not
   its setter's; at the revoke, at every start, after every restore and at its next event. One
   set with no API key, as through a session, is switched off at its next event. One made before
   this version records no key, and is switched off once its setter has no working API key made
   before this version: its board's owners are mailed once, at the first start, with the
   earliest date each will stop (later if that account keeps or replaces a key from before this
   version), and re-saving it with a key (`PUT` with `{"active": false}`, then
   `{"active": true}`) binds it to that key. (Since 1.15.1, card 3064: on an upgraded server a
   webhook made before keys were recorded is marked as set with no key, so no key's end stops it
   and nobody is mailed, until the administrator restores the rule at a planned event, E4.)
10. Of such a webhook `pausedBecause` says "This was switched off because the API key that set
    it up ended: …", and what to do; switching it on again, as in 5, records the caller's key and
    answers a new `secret`. A `PUT` or `DELETE` of one that is on and held now records the hold
    first, so an editor's switch-off leaves it switched off for good, an editor's delete is `403`
    as in 6, and a switch-on gives it a new secret. To rotate a key, the board's owner or an
    administrator re-saves each webhook with the new key before the old one is revoked, which
    keeps its secret; revoked first, each is switched on again with a new `secret` for its
    receiver. The account that set it up is mailed too, while it can open the board.
11. Nothing else changed: no operation, field, status or schema is new, and a webhook whose
    setter can open its board and whose key has not ended is sent as before.

**What to do.** An integration that stopped: read why with `GET /webhooks/:webhookId`, then
switch it on with the board owner's key, `{"active": true}`, and give the receiver the new
`secret` from the answer. Before revoking a key an integration's webhooks were set with, make the
new one, and have the board's owner or an administrator re-save each webhook with it
(`{"active": false}`, then `{"active": true}`), which keeps its secret; then revoke the old one.
See [Webhooks](#webhooks).

**Internal routes, additive** (card 2893): `GET /api/account/api-keys` answers each key's
`webhooks`, how many webhooks revoking it would switch off now (those that are on and record it,
and, for the account's last working key from before the release, the account's webhooks from
then that are still sent; the code review's CS4); `DELETE /api/account/api-keys/{id}` answers
`{ "success": true, "webhooksSwitchedOff": n }`, the webhooks it switched off in the same
change. The Account page shows the first on each key's row and in the revoke's confirm, and the
second after it.

**Internal routes: a behaviour change and additive fields** (card 2894; the v1 API does not
change, still `1.11.0`). `PUT /api/account/password`, the holder's own change, now always pauses
the account's report schedules that are on, whatever `endApiKeys` says, and answers `{ success,
apiKeysEnded, webhooksSwitchedOff, reportSchedulesPaused }`. `POST /api/users/{id}/mfa/reset`, an
administrator's reset of another account's two-step sign-in, pauses them too and answers
`reportSchedulesPaused` beside its other counts; both branches of its `message` add the count
("Their 2 report schedules were paused.", nothing for none), and the branch that gives the link
adds how many live API keys the account has and webhooks it set that are on, with the day each
was made and no name ("They keep 2 API keys (made 2026-11-01 and 2026-11-10) and 1 webhook they
set up (made 2026-11-12); the lists are in the notice mailed to them. A password reset ends
them."; since card 2915 the reset ends them, and says so: see the 1.14.0 change above). A paused schedule
is turned on again by its owner with `PUT /api/report-schedules/{id}`, which asks for the
password and a code (card 2751). See
[What Setting a Password Ends](authentication-security.md#what-setting-a-password-ends).

**Breaking: a board or card the key's user cannot open is answered 404, not 403** (card
2719; OpenAPI document version `1.10.0`, with a dated note, marked breaking, at the top of its
description). Board and card ids are counted up one at a time, and a `403` for one that
exists beside a `404` for one that does not let any key holder learn what exists on boards
they will never see. From this release:

1. A board, a card, a dashboard grouping holding only boards the key's user cannot open, or
   anything on a board they cannot open (a column, a label, a subtask, a comment, a card
   category, a webhook, a token entry, a link's other end) is answered `404` by every
   operation, in the very words one that is not there gets (`Card not found`, `Webhook not
   found`, `Board 7 not found`, `#42 not found`), where it was answered `403`. A batch reports
   such an item as a missing one: `POST /tokens/bulk` as `Card #N does not exist`, the
   milestone card batches as a card that does not exist.
2. `POST /cards/:cardId/labels` answers `404 Label not found` for a label that is not of the
   card's board, wherever it is, where it answered `400 Label does not belong to this card's
   board`.
3. `POST /dependencies/bulk` looks at the boards of every link's ends first. A link with an
   end the key's user cannot open is rejected as `missing-blocked` or `missing-blocker`, `#N
   does not exist or is archived`, as one to a missing end is, and is never judged a
   duplicate or part of a loop: duplicates and loops are judged only among the links whose
   ends the user can edit, and `wouldSkipAsDuplicate` and `wouldCreate` count only those.
4. A `409` for a link that would close a loop, from the single add and from the batch, gives a
   node on a board the user cannot open as withheld: `{ "kind": "card", "id": null,
   "withheld": true }` in `cycle` (the schema `CycleNode`), and `A card on a board you cannot
   open` (or `A subtask on a board you cannot open`) in its place in the message.
5. `GET /cards/:cardId/board-history` gives a stay on a board the user cannot open by its dates
   alone: `boardId` is `null` and `withheld` is `true`, where the board's id was given.
6. `403` now means the key's user can open the board and their role does not allow the
   operation (a viewer asking to edit, anyone but the owner asking to share, an author rule).
   A milestone's own visibility is unchanged: one the user cannot see is still `403 No access
   to this milestone` (card 2911).
7. Under a card's address, the card is asked first: `GET /cards/:cardId/attachments/:attachmentId`
   for a card the key's user cannot open is `404 Card not found` whatever attachment id
   follows it, where an id not on that card was `404 Attachment not found` and so the ids on
   it could be told apart (card 2762). Only a user who can open the card is told whether a
   file is on it.

The rule is about an id the key's user asks for. The dependency lists of their own cards and
subtasks still give the id of linked work on a board they cannot open, withheld with no title
or board (card 2129's design); a card of its own is to close that.

A script that treats `403` as "no access" should treat `404` the same way. Nothing to migrate;
no field or route is added or removed beyond `CycleNode`. The rule, and why timing is an
accepted risk, are in
[Authentication and Security](authentication-security.md#not-found-not-forbidden-card-2719).

### Changes on 2026-11-17

Eight changes are dated 2026-11-17: card 2761's, a patch, which takes the OpenAPI document to
`1.9.1` (first); card 2891's, additive, which took it to `1.9.0`; card 2751's, which changes
no `/api/v1` route; card 2772's, which is **breaking** for API keys made before its release;
that of cards 2770 and 2771, which is not (after it); and cards 2888's, 2851's and 2847's,
which change no `/api/v1` route (last).

**The card window's image upload is checked as the API's, and the images already stored are
checked once (card 2761; OpenAPI document version `1.9.1`, with a dated note at the top of its
description).** No `/api/v1` operation, status, field or schema changes, but four things a
key sees do:

- **The allowances are shared.** The 30 images an hour and 100 MB a day of a key's user now
  also count the images that user uploads through DumpFire's own card window, and those count
  these: a key can meet the `429` sooner.
- **A JPEG keeps its orientation.** A JPEG uploaded through
  `POST /api/v1/cards/{cardId}/attachments` keeps its EXIF orientation (a value of 2 to 8),
  as one EXIF segment holding nothing else, so a photo taken upright shows upright. Every other
  piece of its metadata is still taken out. See [Attachments](#attachments).
- **A JPEG's trailing data is cut off.** Whatever follows the end of a JPEG's image (a gain
  map, a motion photo's video, a trailer) is cut off and the image kept, where it was refused
  `400`. Anything after the end of a PNG, GIF or WebP is still refused.
- **The images stored before the release are checked once**, at the first start after it and
  after an import of a backup, as an upload is now: one that held metadata or trailing data is
  stored again without it, and its `sizeBytes` is the smaller size; one refused by the check
  (not the image its type names, animated, too large, or malformed) is kept as it was and
  answered with `mimeType` `application/octet-stream`, and is only ever downloaded as such.
  (Since 1.15.1, card 3064: not at installation on an upgraded server, nor at an import while the
  server holds its `stored_images_rechecked` flag; the administrator runs the check at a planned
  event, E1.)

Internal routes, stricter, not breaking: `POST /api/cards/:id/attachments`, the card window's
upload, holds a file declared as `image/png`, `image/jpeg`, `image/gif` or `image/webp` to the
API upload's rules: its bytes checked (`415` not that type, `400` not a valid image), its
metadata taken out, its name's extension the bytes', `409` for the 21st image on a card or a
card whose images retention is moving to the trash, and `429` (with `Retry-After` and
`retryAfterSecs`) past the account's shared hour or day, counted once the form is read. Its
answer for an image is the row without `filename`. Every other file is stored as before. See
[Authentication and Security](authentication-security.md#the-card-windows-images-card-2761).

**The milestone list of a board can also list the cross-board goals that hold its cards (card
2891, additive; OpenAPI document version `1.9.0`, with a dated note at the top of its
description).** `GET /api/v1/milestones?boardId=N` still lists only board N's own goals: a goal
that spans boards is not among them, even one whose cards are all on N. Add `&touching=true`
and each goal that spans boards and has a card on N that is not archived is listed too, as the
plan page reached from a board lists them; still only the goals the key's user can see, so a
goal with a card on a board they cannot open is not listed, and a board they cannot open lists
nothing (`[]`), as before.

- **`touching` is `true` or `false`**: anything else is `400` `touching must be true or false`,
  and `touching=true` without `boardId` is `400` `touching needs boardId`. Without it, or with
  `false`, the answer is exactly as before.
- **An older server ignores it**: before this release `touching` is not read, so the request is
  answered with board N's own goals alone and no error. The wrapper's `milestones -BoardId N
  -Touching` sends it, and refuses `-Touching` without `-BoardId` before sending.
- The internal twin `GET /api/milestones` does not take it. No migration, and nothing to set.

**Report schedules and report mail ask for the password and a code (card 2751). The v1 API
does not change**: still `1.8.0` (`1.9.0` since card 2891), and no `/api/v1` operation,
answer or schema is different. No v1 route makes or changes a report schedule or mails a report, and a key cannot reach the
internal routes below. These are DumpFire's own internal routes, which the Reports page calls;
the change is stricter, so a script that calls them as a signed-in session must now send
`currentPassword` and `currentCode`.

- **What asks.** `POST /api/report-schedules`, always (to any address, the caller's own, or
  none). `PUT /api/report-schedules/[id]` when the change adds an address (one of the list sent
  not in the stored list, both read as the scheduler reads them: a swap adds one; on or off),
  turns the schedule on (`enabled: true` on one that is off), or widens its `statusFilter` (any
  new filter while the stored one, as the scheduler reads it, is not `all`). `POST
  /api/reports/email`, always, for every address. Three more listed step-up actions, **forty**
  in all ([Step-up Before Destructive Actions](authentication-security.md#step-up-before-destructive-actions-card-2701)).
- **What asks nothing**: a `PUT` that renames, re-times (frequency, day, time, `timeZone`),
  removes an address, narrows the filter (from `all`, or not at all), or turns the schedule
  off; `enabled: true` on a schedule already on; `DELETE /api/report-schedules/[id]`;
  `GET /api/report-schedules`; and `POST /api/reports` (the PDF itself).
- **Every refusal that needs no password comes first, in its old order and words**, with
  nothing counted and no code spent: the fields, the addresses and their caps (`400`), what a
  report or schedule covers (`403`, `404`; the email route now refuses a board or grouping that
  is not there, or none of whose boards the caller can open, `403` "Failed to generate report
  or no access", before the password), the twenty schedules (`409`), the `503` with no mail set
  up, and the day's 100 addresses (`429`), read with nothing taken. Then the step-up's answers:
  `400` `missing` or `code-malformed`, `403` `wrong`, and the rest, as for every listed action.
  A refusal after the password (a `429` lost to a race, access lost meanwhile, the password
  changed) leaves the code spent.
- **The email asks again before every send.** The session, the caller's access and the password
  are checked before each mail. Refused before any mail has gone (the first, or a later one when
  the mail server refused every address before it), the answer is that refusal (`401`, `403`, or
  `403` `{ "stepUp": "changed" }`) and nothing more is sent. Refused once a mail has gone, the
  sending stops: each address left is in `results` as `{ "email", "success": false, "message":
  "Not sent: sending stopped because the session ended, access changed or the password changed
  while the report was being sent" }`, and the answer is the partial `200`, its `message` ending
  with those words. When the mail server also refused an address, the `message` names both
  reasons, each after its addresses: `Not sent to b@x.test: The mail server did not accept it. …
  Not sent to c@x.test: Not sent: sending stopped …`.
- **Recorded.** A schedule made or changed so writes an `INFO` line naming every address it is
  sent to and mails its owner (`report-schedule-set`); a report emailed by hand writes an `INFO`
  line naming the addresses it reached. The answers are unchanged.
- No migration, and nothing to set. Reload every Reports tab opened before the release: an old
  page sends no password and is answered `400` `missing`, with nothing saved or sent. See
  [Report Schedules and Report Mail](authentication-security.md#report-schedules-and-report-mail-card-2751).

**Breaking: API keys made before card 2772's release stop working 60 days after it unless
kept** (card 2772; OpenAPI document version **1.8.0**, with a dated note at the top of its
description and the deadline in `bearerAuth`). No `/api/v1` route, field, status or schema
changes, but a key that worked is answered `401` `{ "message": "Invalid or expired API key" }`
from its deadline on, as an expired key is.

- **Which keys.** Migration 0069 gives every key that exists when it runs, with no expiry or
  one later than the deadline, a deadline: the moment the migration ran plus 60 days, the same
  for every key (`settings.api_key_deadline`). A key that expires before then anyway, and every
  key made after the release, has none. A key's own `expiresAt` is never changed. **Since 1.15.1
  (card 3064)** migration 0084 takes that deadline and the setting back in the same start, so no
  key has a deadline until the administrator applies one at a planned event (E4), with notice: see
  [When a Key Ends](#when-a-key-ends).
- **Keeping a key.** Its holder presses **Keep this key** beside it on **My Account → API
  Keys**, with their password and a code: the deadline is cleared and the key itself (its value,
  prefix and expiry) is unchanged, so nothing that uses it needs a change. A key past its
  deadline is never revived: generate a new one. Holders are told before the release (the
  owner's notice, [deployment.md](deployment.md#the-release-that-gives-older-api-keys-a-deadline-card-2772)).
- **One boundary for a key's end.** A key whose expiry is exactly the current second has
  ended, as one whose deadline is has (`keyEnded()`), where it worked until the second after.
- **Internal routes, additive** (DumpFire's own pages call them; a script calling them as a
  signed-in session sends `currentPassword` and `currentCode` to each but the confirm):
  - `GET /api/account/api-keys` answers `deadlineAt` for each key, as stored, `null` when it
    has none.
  - `POST /api/account/api-keys/[id]/keep`, body `{ currentPassword, currentCode }`: `200`
    `{ "success": true }`; `404` "API key not found"; `409` "This key has no deadline to
    clear."; `409` "This key has passed its deadline and no longer works. Generate a new key."
  - `POST /api/account/two-step/authenticators`, body `{ label, currentPassword, currentCode }`:
    `200` `{ pendingId, account, issuer, secret, qr, expiresAt }` with `Cache-Control:
    no-store`; `label` required, white space collapsed, 1 to 40 characters, no control or
    format character (`400` "Name this authenticator, such as Work phone.", "label must be at
    most 40 characters", "The name cannot hold control or formatting characters."); `409` "You
    have three authenticators, the most an account can hold. Remove one first."; `503` with no
    MFA key.
  - `POST /api/account/two-step/authenticators/confirm`, body `{ pendingId, code }`, no
    step-up: `201` `{ id, label, createdAt }`; `400` "Enter the 6-digit code from your new
    authenticator app." (not counted); `400` for a wrong code; `409` "This set-up has ended.
    Start again with Add an authenticator." (none live, another session's, or a `pendingId` that
    is neither the live one's nor one of the last two it replaced: the code review's CS2),
    "This set-up was replaced by a newer one. Use the newest, or start again." (one of the last
    two the live set-up replaced), "Too many wrong codes. Start again with Add an authenticator." (the
    fifth), the password-changed `409`, or the three-authenticators `409`; `503` when its secret
    cannot be opened.
  - `DELETE /api/account/two-step/authenticators/[id]`, body `{ currentPassword, currentCode }`:
    `200` `{ "success": true, "sessionsEnded": n }`, every other session of the account ended;
    `404` "Authenticator not found"; `409` "This is your only authenticator. Add the new one
    first, then remove this one."; `409` when no other authenticator can be checked here.
  - `POST /api/account/two-step/recovery-codes`, body `{ currentPassword, currentCode }`: `200`
    `{ "codes": [ten, "XXXX-XXXX-XXXX-XXXX"] }` with `Cache-Control: no-store`; every earlier
    code no longer works.
  - `DELETE /api/account/two-step/banner`, body `{ bannerAt, currentPassword, currentCode }`,
    `bannerAt` the moment of the latest signal the page showed (`security_signal_last_at`, set
    by every signal, even one inside the hour that raises no new warning: the code review's
    CS1): `200` `{ "success": true }`, the warning, its time and the latest signal's cleared;
    `409` "There is no warning to dismiss."; `409` "A newer warning arrived. Read it, then
    dismiss it again." for any other moment.
  - **Five more listed actions**, thirty-seven in all (forty since card 2751): the keep, the start, the remove, the
    recovery codes and the banner. Their own fields are refused before the password, nothing
    counted.
  - **The step-up's count is weighted**: an attempt with an authenticator code counts once for
    each authenticator that can be checked on this server (one to three; one whose secret
    cannot be opened here is skipped and not counted), taken before the compare and the same
    for a wrong password or a wrong code, so with two authenticators two wrong answers sign the
    browser out, and with three one does. The confirm dialog's line counts every authenticator
    the account holds, so where one cannot be opened it says more than is counted, never less.
    A code from any of the account's authenticators is accepted; `code-spent` only when every
    match is spent. A recovery code counts one. A second request from a session whose check is
    under way is `429` `in-flight` before the count is looked at, so it never signs the session
    out (the code review's CR1).
  - `POST /api/admin/import` answers `apiKeyDeadlines` (how many keys of a backup made before
    0069 were given this server's deadline) and, when above 0, `apiKeyDeadline` (`YYYY-MM-DD
    HH:MM UTC`) and a sentence in its message.
- See [Keys Made Before Two-Step Sign-In: the Deadline](authentication-security.md#keys-made-before-two-step-sign-in-the-deadline-card-2772)
  and [Managing Two-Step Sign-In on the Account Page](authentication-security.md#managing-two-step-sign-in-on-the-account-page-card-2772).

**Every action that asks for the current password asks for a code beside it (cards 2770 and
2771, one release). The v1 API does not change by that release**: still version `1.7.1`, and no `/api/v1`
operation, answer or schema is different; no v1 route asks for a password, and a key needs
no code. These are DumpFire's own internal routes, which its pages call; a script that calls
them as a signed-in session must send the code too.

- **`currentCode` is required on every listed internal route**: the thirty-two actions (of that
  release; thirty-seven since card 2772, forty since card 2751) of
  [Step-up Before Destructive Actions](authentication-security.md#step-up-before-destructive-actions-card-2701),
  the import's confirmation (`POST /api/admin/import/confirm`) and the export
  (`POST /api/admin/export`) among them. It is a code from the account's authenticator app, or
  one of its recovery codes, sent beside `currentPassword` as typed. No `currentCode`, an empty
  one or one that is not text is `400` `{ "message": "Enter your password and a code from your
  authenticator app to confirm this. Nothing was changed.", "stepUp": "missing" }`, nothing
  counted; a request without a `currentPassword` gets the same answer.
- **Its form.** At most 64 characters; then, trimmed with every space dropped, exactly six
  digits (`123 456` is read as `123456`), or a recovery code (case does not matter, spaces and
  hyphens are dropped, O is read as 0, I and L as 1, sixteen characters). Anything else is
  `400` `{ "message": "That code is not in the right form. Enter the 6 digits from your
  authenticator app, or choose 'Use a recovery code instead'. Nothing was changed.",
  "stepUp": "code-malformed" }`, not counted.
- **Four new `stepUp` codes** beside the eight of 2026-11-04: `code-malformed` (above);
  `code-spent`, `400` "That code has just been used. Wait for the next code from your
  authenticator app and enter it. Nothing was changed.", for an authenticator code whose
  30-second step was already used, **decided before the password is compared, whatever the
  password**, and not counted; `no-factor`, `403` "This account has no two-step sign-in to
  confirm with, so this cannot be done from it. Nothing was changed.", for an account with no
  second factor (none exists since card 2769); and `factor-unusable`, `503` "Your authenticator
  cannot be checked on this server right now. Use one of your recovery codes, or ask an
  administrator. Nothing was changed.", for an authenticator code when the server cannot open
  the account's factor (its MFA key missing or another), not counted: a recovery code still
  works.
- **One answer for a wrong password or a wrong code**: `403` `{ "message": "Your password or
  code was not right. Nothing was changed.", "stepUp": "wrong" }`, never saying which (it was
  "Password is incorrect. Nothing was changed."). Each counts once toward the session's three,
  whichever part was wrong; only a right password with a right code sets the count back. The
  signed-out answer now reads "Nothing was changed. This session has been signed out, after
  three wrong passwords or codes, or because it had ended: sign in again.".
- **A code is spent once it has confirmed an action**, a recovery code for good; a refusal
  after the check (the `409` "Your password was changed while this was being saved…", a write's
  own `409`) leaves it spent. Two requests sent with the same authenticator code in one step:
  the second is `code-spent`, or `wrong` when both arrive together.
- **The Account routes are listed actions now.** `PUT /api/account/password`,
  `PUT /api/account/email` and `POST /api/account/api-keys` call the same check as every
  other: their bodies are `{ currentPassword, currentCode, newPassword, endApiKeys }`,
  `{ newEmail, currentPassword, currentCode }` and `{ name, expiresAt, currentPassword,
  currentCode }`. **The email and key routes no longer read `password`**: a body with only
  `password` is `400` `missing`. Their own fields are refused first, before the password:
  "New password must be at least 8 characters"; "Email is required" and "Invalid email
  address"; "Key name is required", the `expiresAt` refusals and "Maximum of 10 API keys per
  user". An address another account holds is `409` "Email is already in use" only after the
  password and code are checked, so that refusal leaves the code spent. Their own words for the password ("Password is
  incorrect", "Current password is incorrect", "Password is required", "Current password is
  required") are gone: they answer with the step-up's words and codes above.
- **A right password with a wrong code** raises the account's security banner and, with mail
  set up, mails its owner (at most once an hour); a recovery code used here mails the owner
  with the number left. Neither touches the account's sign-in code pauses or lock.
- No migration, and nothing to set. Reload every DumpFire tab opened before the release: an old
  page sends no `currentCode` and is answered `400` `missing`, with nothing changed.
- **The bulk attach's refusal of a card on another board names its remedy** (card 2860,
  additive; the OpenAPI document is unchanged at `1.7.1` (1.8.0 since card 2772)). On
  `POST /api/v1/milestones/:milestoneId/cards/bulk` to a single-board milestone, the
  `problems[]` reason reads `… Make the milestone cross-board (boardId null on PATCH
  /api/v1/milestones/<id>, or Spans every board on its plan page), or move the card.`, where it
  read `… Make the milestone cross-board, or move the card.` The status (`409`), the shape and
  the top-level `message` are unchanged; the single attach keeps its words.

**A new password over 1,024 characters is refused (card 2888). The v1 API does not change**: no
`/api/v1` route sets a password. Three internal routes, `PUT /api/account/password`
(`newPassword`), `PUT /api/users/{id}/password` and `POST /api/users` (`password`, when one is
sent), answer `400` "Password must be at most 1,024 characters" for one longer, before the
step-up, so nothing is hashed, compared or counted. 1,024 is the most the step-up reads of a
current password (`LONGEST_PASSWORD`), so a password set longer could never confirm an action.
The invite and first-run set-up pages refuse the same. Sign-in is unchanged: it has no maximum
([Password Hashing](authentication-security.md#password-hashing)).

**A user made with a password gets their set-up link in the answer (card 2851). The v1 API does
not change**: `POST /api/users` is the web application's own route, a session's, which a key
cannot reach.

- **With `password`**, the account's enrolment link for two-step sign-in is issued in the
  transaction that makes it, and the `201` adds `enrolmentUrl` (`<base>/enrol/<token>`) and
  `message`, answered with `Cache-Control: no-store`; the link is never mailed. When the
  caller's session has ended, they may no longer manage the account, or the link is no longer
  the account's by the time it is answered, the account stands and `enrolmentUrl` is `null`,
  with a `message` that says to press 🛡️ on the row for a new link. `invited` stays `false`.
- **With no link address** (no App URL, `APP_URL` or `ORIGIN`, on a built server), every create
  is now refused `503` `NO_LINK_ADDRESS` before the caller's password is compared, a create with
  a password included, which used to succeed and make an account nobody could set up.
- Without `password`, nothing changes: the invite, its mail and `inviteUrl` as before.

See [Set-Up Links and Their Page](authentication-security.md#set-up-links-and-their-page).

**The App URL is the superadmin's, and the server's configured address wins (card 2847). The v1
API does not change**: `PUT /api/admin/smtp` is the web application's own route, a session's.

- A save that would store `appUrl` (one that, read as a link reads it, differs from the App URL
  in effect, clearing included) by anyone but the superadmin is refused `403` "Setting the App
  URL needs the superadmin: every link in a mail begins with it. Nothing was saved.", before the
  password is compared, so nothing is counted. `appUrl` sent back unchanged, and every mail
  field, stay every administrator's.
- Where `APP_URL` is set, or `ORIGIN` is set to anything but `http://localhost:3000`, a non-empty
  `appUrl` on another origin is refused `400` "The App URL must be on this server's own address
  (`<origins>`), which its configuration sets. Nothing was saved.", the superadmin's too.
- A stored App URL on another origin is not used: `GET /api/admin/smtp` answers the App URL in
  effect (`APP_URL`'s, or empty) and `appUrlFrom` as if none were stored, and links use the
  configured address. The superadmin's empty save clears it.
- `appUrl` is stored and answered as the address it parses to (origin and path, trailing
  slashes stripped: `HTTPS://Host/` is `https://host`), and one with a user name, password,
  query, fragment, backslash or control character, or a path beginning `//`, is refused `400`
  "The App URL must be a plain web address: …", whoever sends it; such a row stored before is
  not used (the card's code review).

See [Where a Mailed Link's Address Comes From](authentication-security.md#where-a-mailed-links-address-comes-from).

### Changes on 2026-11-13

**Two-step sign-in (card 2769). The v1 API does not change**: still version `1.7.1`, and no
`/api/v1` operation, answer or schema is different. A key never touches a session, so keys,
webhooks and scripts keep working through the release, and the release does not end them. Keys
made before it were made on a password alone: review them, and revoke any nobody recognises
(see [The Release That Turns On Two-Step Sign-In](deployment.md#the-release-that-turns-on-two-step-sign-in-card-2769)).
Making a key still needs a session, which now needs an authenticator code as well as the
password. What changes are the web application's own sign-in forms, which are pages, not API:

- **The login form** (`POST /login`) no longer signs in on a right password. It answers `303`
  to `/login/verify` (an account with an authenticator) or `/login/enrol` (one setting one up),
  with a ten-minute challenge cookie and no session; or `200` with a `notice` (a set-up link was
  emailed, or was earlier, or a set-up from the emailed link is under way); or `400` (the account
  was deleted while its password was checked), `403` (the account needs a set-up link), `409`
  (the password changed while it was checked) or `503` (an account that would set up and no
  MFA key, or a set-up link could not be emailed). An account with an authenticator goes to
  `/login/verify` even with no MFA key, where a recovery code still signs in. A wrong password is
  answered as before.
- **The invite form** (`POST /invite/{token}`) and **the first-run set-up**
  (`POST /setup`) set the password, or make the superadmin, and answer `303` to `/login/enrol`
  with a challenge cookie and no session; both are `503` before any password is hashed when the
  server has no MFA key.
- **Three public pages are new**: `/login/verify` (the code), `/login/enrol` (setting up an
  authenticator) and `/enrol/{token}` (a set-up link's page, which asks nothing and sends its
  holder to sign in). A session is made only by a right code there, or by a confirmed set-up.

See [Two-Step Sign-In](authentication-security.md#two-step-sign-in-card-2769).

**The v1 API: version `1.7.1`, what a token costs (card 2845).** No operation, field or status
changed; `costUsd` on the token answers changed in value:

- **Claude Fable 5.2 and Claude Mythos 5.2 are priced**, `claude-fable-5-2` and
  `claude-mythos-5-2` at $8 / $40 per million tokens with cache reads at $0.20 (0.025x). Their
  tokens were unpriced and counted in `unpricedTokens`.
- **Claude Sonnet 5.5's cache reads are $0.10 per million** (0.05x its input rate), where they
  were priced at $0.20, twice their rate.

Cost is worked out when it is read, so both re-price every past entry. Rates verified against
Anthropic's published table on 2026-11-13.

**One internal route is new and one refuses more, for a lost authenticator (card 2773).** The v1
API does not change: still version `1.7.1`, and no `/api/v1` operation, answer or schema is
different. Both routes are the web application's own, an administrator's with a session, and
neither can be reached with a key. Until card 2769 (above) lets an account set up a second
factor, nobody has one, so the `409` below is not met and the reset removes nothing but
sessions, invites and links. Since card 2769 the reset also takes away the account's leave to
set up on its password alone.

- **`POST /api/users/{id}/mfa/reset` is new**: it resets another account's two-step sign-in.
  Body `{ "currentPassword": "…" }`, the caller's own password, asked every time (it joins the
  step-up list, now twenty-nine). It deletes the account's second factors and recovery codes,
  sets its wrong-code counts back, ends its sessions, unused invites, sign-ins waiting for a
  second factor and enrolment links, and issues one enrolment link, good for seven days; the
  password, API keys, webhooks and report schedules are kept (since card 2894 they are paused,
  and the answer adds `reportSchedulesPaused`; since card 2915 the keys end and the webhooks are
  switched off, and the answer adds `apiKeysEnded` and `webhooksSwitchedOff`). The link is given once, in the
  answer, and never mailed; the account's address, where mail is set up, is sent a notice that
  holds no link. Answered `200` with `Cache-Control: no-store`:

  ```json
  {
    "success": true,
    "enrolmentUrl": "https://dumpfire.example.com/enrol/<token>",
    "mailSent": true,
    "factorsRemoved": 1,
    "recoveryCodesRemoved": 10,
    "sessionsEnded": 2,
    "challengesEnded": 0,
    "invitesEnded": 0,
    "message": "ann's two-step sign-in was reset. Give them the link yourself: it is shown once, and works for seven days. ann was sent a notice that holds no link."
  }
  ```

  `mailProblem` is added, in the words an invite's failure uses, only where mail is set up and
  the notice was not sent; the reset stands either way. `enrolmentUrl` is `null`, with the
  message "`<name>`'s two-step sign-in was reset, but its link cannot be shown to you now. Run the
  reset again to issue a new one.", when, after the notice, the caller's session has ended or is
  no longer an administrator's, the caller may no longer manage the account, or the link is no
  longer the account's. An account with no second factor is reset all the same, which issues a
  fresh link. Refusals, each with nothing changed: `401` not signed in; `400` "Invalid user ID";
  `403` "Manage your own two-step sign-in on the Account page" for the caller's own account,
  whoever they are; `403` "Forbidden" for a caller who is not an administrator; `404` "User not
  found"; `403` "Only the server's host can reset the superadmin's two-step sign-in, with
  scripts/mfa-reset.mjs"; `403` "Only superadmin can reset an admin's two-step sign-in" for an
  administrator's account when the caller is not the superadmin; `503` "This server has no
  address configured to make the link from, so nothing was sent and nothing was saved. …" (as
  the invite's) when the server has no App URL, `APP_URL` or `ORIGIN` (the link's address is
  taken as an invite's is, the App URL setting first); and the step-up's own
  answers (`400` with no `currentPassword` or no body, `403` "Password is incorrect. Nothing was
  changed.", `403` signed out at the third, `429`), each with `stepUp` in its body. See
  [A Lost Authenticator](authentication-security.md#a-lost-authenticator-the-reset-the-hosts-command-and-a-change-of-key-card-2773).
- **`POST /api/users/{id}/invite` refuses an account with a second factor**: `409` "This account
  uses two-step sign-in. Reset it first, then send the invite.", with no invite made, asked
  after who may invite the account and before the mail checks, so before the password. An
  invite made before the account set up a second factor stops working once it has one. Its
  other answers are unchanged.

### Changes on 2026-11-05

**The v1 API: version `1.7.0`, a card's files through a key (card 2754).** Three operations
are new, under the tag Attachments, described in [Attachments](#attachments):
`GET /api/v1/cards/{cardId}/attachments` lists a card's files as the new schema `Attachment`;
`POST /api/v1/cards/{cardId}/attachments` attaches a PNG, JPEG, GIF or WebP image, sent as the
body itself, up to 5 MB; `GET /api/v1/cards/{cardId}/attachments/{attachmentId}` downloads one
file, always as a download. A key deletes no file. The upload's bytes are checked by
allow-list, its metadata is taken out, and an animated image or one with anything after its
end is refused (since card 2761, 1.9.1, a JPEG's trailing data is cut off instead). A key's user may upload 30 images an hour and 100 MB a day, whichever of their
keys is used, and a card holds at most 20 images, however they were attached. (Since card 2761,
1.9.1, the user's image uploads through the card window count against the same hour and day.)

Images of cards closed long ago are now moved to the trash by DumpFire itself: an image on a
card archived, or completed and still in its Complete column, more than `IMAGE_RETENTION_DAYS`
ago (180 unless the server sets it) is deleted with a new action, `attachment_expired`, under
a new `source`, `system`, with no user and the name `DumpFire`. `GET /api/v1/audit-log`
answers `system` in `source` and filters by `?source=system`; `?source=ui` no longer finds
those entries. No webhook is sent for it. An image uploaded through a key to such a card is
`409`. See [Image Retention](backup-reporting.md#image-retention).

The web application's own attachment route changed too: an image is shown in the browser
only when its bytes are the image type it was stored as, and is a download otherwise.

**Two internal routes, for the storage of two-step sign-in (card 2768).** The v1 API does not
change: still version `1.7.0`, and no `/api/v1` operation, answer or schema is different. Both
routes are the superadmin's, and neither can be reached with a key.

- **`POST /api/admin/import` may carry `mfaWithoutFactor`.** Once two-step sign-in is in use (a
  second factor exists after the restore, or the backup's factors for some account were left
  out), its answer names every restored account with no second factor, in one sentence, both
  joined to `message` and as the field: "`<n>` account(s) have no second factor after this restore
  and each needs its two-step sign-in reset before it can sign in: `<names>`. See
  docs/admin-guide.md, Restoring from Backup." The same sentence is written at `WARN` under
  `IMPORT`, and the `500` of a restore that committed and then failed carries it too. The same
  field also carries, when they apply, why the backup's second factors were left out ("Their
  second factors in the backup were left out because `<reason>`: `<names>`.", the reason being
  that the backup was not made by this server or was changed since, was made under a different
  key, or no key is loaded) and, once, a note to have accounts brought back from the backup
  regenerate their recovery codes. When none of these applies the field is absent and the answer
  reads as before, as it does for every restore until card 2769 lets an account set up a second
  factor. See
  [What a Backup Holds](authentication-security.md#second-factors-in-a-backup-the-export-and-a-restore-card-2768).
- **`POST /api/admin/export`'s file holds what a backup holds of two-step sign-in**, as it is
  the same file: every second factor only as AES-256-GCM ciphertext with its nonce and key id,
  every recovery code only as an account-bound hash, and `settings.mfa_key_check`; no pending
  sign-in and no enrolment link; and never the key, which is in a file outside the database. The
  route itself, its body and its answer are unchanged.

### Changes on 2026-11-04

**The v1 API: version `1.6.0`, decision records through a key (card 2682).** Seventeen
operations are new, under the tag Decisions, described in [Decisions](#decisions): the
register, a draft, the editors' read, a save of the working copy, the decider and the
participants of a decision never opened, extend, withdraw and delete of a decision never
opened, supersede, the questions and a drafted answer, the summary, the record, and card
links. **An agent prepares a decision; a person decides what happens to people.** Opening,
re-publishing, a dry run and sending an invitation again (each mails people), closing (it makes
a later ruling early), ruling, releasing, publishing or replacing an agent's answer, a
participant's account and address, the participants and the decider once opened, and
withdrawing or deleting a decision ever opened are not offered to a key: each is a person's, on
the decision's page. The service refuses each by the credential the write came in with as well
as by the route's word. No answer carries a participant's address or account id, an
administrator's key included, and nothing says who asked a question (the record leaves the
question events out); a key extends an open decision only; text people and agents wrote
carries `untrusted: true`. Two changes reach the web application's own routes too:
`POST /api/decisions/{id}/extend` refuses a closing time no later than the current one, `400`
"closesAt must be later than the decision's current closing time: Extend never brings it
earlier", for everyone; and the editor's Open confirmation says how many people it mails.

```mermaid
flowchart LR
    Key["API key"] -->|"/api/v1/decisions…"| V1["17 operations"]
    V1 --> Svc["decision-*-writes.ts (card 2713)<br/>sourceOf(opts), decision-write-shared.ts:<br/>the word or the credential"]
    Svc -->|"draft, edit, never-opened participants,<br/>decider, withdraw, delete; extend later;<br/>questions, answers as drafts; card links"| OK["written, source api"]
    Svc -->|"open, re-publish, dry run, resend, close,<br/>account, address, anything once opened"| No["403: the decision's page"]
    Page["A person on the page"] --> Svc
```

**The v1 API: version `1.5.0`, the people directory and its groups (card 2681).** Six
operations are new, administrators' keys only, described in
[People and Groups (admin)](#people-and-groups-admin): `GET /api/v1/people`,
`PATCH /api/v1/people/{personId}` (`jobTitle` and `groupIds`), `GET /api/v1/people-groups`,
`POST /api/v1/people-groups`, `PATCH /api/v1/people-groups/{groupId}` (`description`) and
`PUT /api/v1/people-groups/{groupId}/members`. No answer carries a person's email address or
account id, and every person and group carries `untrusted: true`. `email`, `userId`, `status`
and `fullName` on a person, and `name` on an existing group, are `403` whatever they hold:
those, and adding, deleting and Add from accounts, are the People page's. Nothing else in the
v1 API changed.

The rest of the day's changes are to the web
application's own routes under `/api/` outside `/api/v1/`, which DumpFire's pages call with a
session and which a key cannot reach (cards 2701, 2697 and 2679): twenty-eight of them now ask
for the caller's current password, card 2701's eighteen every time, card 2697's eight and card
2679's two as listed below.
See [Step-up Before Destructive Actions](authentication-security.md#step-up-before-destructive-actions-card-2701).

- **`currentPassword` in the JSON body** of `POST /api/admin/reset`,
  `POST /api/admin/purge-archived`, `POST /api/admin/boards/{id}/clear-cards` and
  `…/clear-categories`, `POST /api/admin/reset-xp`, `POST /api/users`, `PUT /api/users/{id}`
  when the body carries `role` or `email`, `DELETE /api/users/{id}`,
  `PUT /api/users/{id}/password` (beside `password`, the new one), `POST /api/users/{id}/invite`,
  `DELETE /api/boards/{id}`, `DELETE /api/columns/{id}` when the column holds a card (archived
  ones included), `PUT /api/admin/backup` when the body carries `destinations`,
  `POST /api/admin/backup` (Run Now), `POST /api/admin/backup/gdrive/auth` and
  `PUT /api/admin/smtp`. Every listed request now needs a body: one with none is `400` "The
  request body is missing or is not valid JSON", where the body-less `POST`s and `DELETE`s were
  accepted. Every refusal that needs no password comes first, in the route's own words, and
  costs no guess.
- **`GET /api/admin/export` is now `POST /api/admin/export`** with `{ "currentPassword": "…" }`,
  answered with the file and `Cache-Control: no-store`. `GET` is `405`.
- **`POST /api/admin/import/confirm` is new** (the superadmin's): `{ "currentPassword": "…" }`
  answers `200` `{ "confirmation": "…", "expiresInSeconds": 60 }`, `no-store`. The import,
  `POST /api/admin/import`, now needs it in the `X-DumpFire-Confirmation` header, good for one
  import from the session it was issued to, for 60 seconds. Missing, unknown, used, expired,
  another session's, or no longer good once the upload is in (the account no longer the
  superadmin, or its password changed) is `403` "Confirm the import with your password again:
  the confirmation was not found, was used or has expired. Nothing was changed.", checked
  before a byte of the upload is read.
- **The new answers**, the same on every listed route: `400` "Enter your password to confirm
  this. Nothing was changed." for no `currentPassword`, an empty one or one that is not text
  (at most 1,024 characters); `403` "Password is incorrect. Nothing was changed." for a wrong
  one; `403` "This account has no password to confirm with, so this cannot be done from it.
  Nothing was changed." for an account with no usable hash; `429` "Your password is already
  being checked for this session. Wait for that answer and try again. Nothing was changed."
  for a second check from a session whose first is in flight, not counted; `429` "The server
  is very busy checking passwords right now. Wait a minute and try again." when the account
  already has five checks in flight, not counted either; and `403`
  `{ "message": "Nothing was changed. This session has been signed out, after three wrong
  passwords or because it had ended: sign in again.", "signedOut": true }`, with the session
  cookie cleared, once the session has been ended. Only a password that is compared counts
  toward the three (card 2701's code review, S1). The export and Run Now answer `403` "Your
  password was changed while this was being saved. Nothing was changed. Try again." if the
  password changed between the check and the copy, and every other listed route, and the three
  Account routes, `409` in the same words if it changed between the check and the write, with
  the password not compared again (S2).
- **Every one of these refusals carries a code** beside its message (card 2701's code review,
  F3): `"stepUp"`, one of `missing`, `wrong`, `no-password`, `in-flight`, `busy`, `signed-out`,
  `confirmation` and `changed`. DumpFire's pages act on the code and not the words.
- **The Account routes sign out at the third wrong password.** `PUT /api/account/email`,
  `PUT /api/account/password` and `POST /api/account/api-keys` share the session's count with
  the routes above: the first two wrong ones keep their own words, the third is the signed-out
  `403`. The `429` "Too many wrong passwords. Try again in N minute(s)." and its 15-minute window
  are gone. (Since 2026-11-17 the three are listed actions answering in the step-up's words:
  see [Changes on 2026-11-17](#changes-on-2026-11-17).)
- **Card 2697's eight**, each with every refusal that needs no password made first:
  `PUT /api/decisions/{id}/participants/{participantId}/account` (`{ account, currentPassword }`)
  and `PUT …/address`, always; `PUT /api/people/{id}` when the body carries `email` or `userId`
  (`{ "userId": null }` included), or, since card 3020, `status` other than `'left'` (Mark active); `POST /api/people`, `DELETE /api/people/{id}` (which now
  takes a JSON body) and `POST /api/people/from-accounts`, always (its code review's part B,
  S1: `email` is required on an add, so every add sets an address); and
  `DELETE /api/decisions/{id}` and `POST /api/decisions/{id}/withdraw` once the decision was
  ever opened. A draft never opened is deleted with `{}` and withdrawn with `{ reason }`, asking
  nothing; the delete always takes a JSON body.
- **Card 2679's two**, every time, each with every refusal that needs no password made first:
  `POST /api/decisions/{id}/rule` and `POST /api/decisions/{id}/release` (below).
- **The results, the ruling, the release, concerns and supersede are new** (card 2679), all
  internal, each JSON and same-origin. None is in `/api/v1`, and none can be reached with a key:
  ruling, releasing and raising a concern are also refused `403` by the service for any source
  but the web application ("Ruling is a person's act: it cannot be done with an API key", and
  the same for releasing and a concern). Since card 2682 a key reads the results through
  `GET /api/v1/decisions/{decisionId}/summary`, the decider's and administrators', with nothing
  to rule or release by.
  - `POST /api/decisions/{id}/rule`, the decider's alone, while they can edit the board:
    `{ "optionId": 12 | null, "reason": "…", "conditions": "…", "revision": "…",
    "openQuestionsConfirmed": true, "currentPassword": "…" }`. `optionId` is one of the
    current version's options, or `null` for none of these; `reason` 1 to 4,000 characters,
    `conditions` up to 4,000, neither holding a control character; `revision` the **results
    revision** the results page was given, which moves with every response, participant and
    answered question, so a ruling made on a tally that has changed is `409` in the editor's
    stale words. From stored `open` or `closed` only (`409`); with questions still open,
    `409` "<n> questions are still open: confirm that you rule with them open" unless
    `openQuestionsConfirmed`. Answers `200 { decision, revision }`. Every participant is mailed
    the ruling (option, reason, conditions, and that a concern can be raised for 90 days; no
    figure, no "against", no cut-off).
  - `POST /api/decisions/{id}/release`, the decider's alone: `{ "revision": "…", "omit":
    ["<key>", …], "currentPassword": "…" }`, `omit` optional, the keys of the preview's
    comments to leave out. From stored `ruled` only (`409`, a superseded decision included).
    `409` once released ("This decision's results have already been released"), with fewer
    than 3 consulted people responding in the ruling round ("Fewer than 3 people responded:
    releasing their comments could show who said what"), while any of those responses was
    given before the page said results could be released ("<n> of these responses were given
    before the page said the results could be released: they cannot be released"), and when
    another release in its supersede chain is from 1 or 2 people apart; `409` for a stale
    results revision; `400` for an `omit` key the release would not show. Answers
    `200 { decision, revision }`. It mails nobody, and cannot be undone.
  - `POST /api/decisions/{id}/concerns`, a live participant's, consulted or informed, reached
    through their account: `{ "comment": "…" }`, 1 to 4,000 characters. And
    `POST /api/decision-by-link/concerns`, `{ "token": "…", "comment": "…" }`, public, the
    token deciding as on the link's other two routes: any link that opens no decision, one past
    90 days after the ruling among them, is the one `404`, counted against the caller's address
    (`429` past 20 in 15 minutes). Both answer `200 { "concern": { "comment", "createdAt" } }`,
    with no id. `409` on a superseded ruling ("This ruling has been superseded: raise a concern
    on the decision that superseded it"), on any status but `ruled`, past 90 days after the
    ruling signed in ("A concern about this ruling could be raised for 90 days after it: that
    time has ended"), and on a sixth concern; `429` within 10 minutes of the participant's
    last, saying from when, in UTC. A concern is never a vote, and is never released.
  - `POST /api/decisions/{id}/supersede`, by the decision's decider, the board's Product Owner
    or an administrator, each while they can edit the board: `{ "title": "…" }`, optional, the
    old title when not sent. From stored `ruled` only (`409`); `409` when the board is gone, and
    while another decision superseding it is not withdrawn ("A later decision that supersedes
    this one already exists"). Answers `201 { decision, revision }` of the new draft, whose
    decider is the old decision's while that account can edit the board, and the caller
    otherwise. No password: the draft tells nobody, and its own ruling asks.
  - `/decisions/{id}/results` is the results page, for the decider and administrators; anyone
    else who can view the decision is `403`, and anyone who cannot, `404`.
  - **Changed:** `POST /api/decisions/{id}/responses` and `POST /api/decision-by-link/responses`
    take an optional `statement`, the version of the who-sees words the page showed (now `2`):
    any other number is `409` in the stale-page words; the same answer sent again under the
    current statement, where the last was recorded under none, is recorded anew. Once a
    decision is ruled, the editor's answer and a board's list give `closesAt: null` (an
    administrator's editor answer keeps it), and `DecisionAnswer` gains `supersedesId` and
    `resultsReleasedAt`.
  - **Headers:** the results page, the rule, release and supersede answers carry
    `Cache-Control: no-store` and `X-Robots-Tag: noindex, nofollow`; `POST …/concerns` carries
    the same as the decision page and its other participant routes, which gain `X-Robots-Tag:
    noindex, nofollow`; the link's concern route carries the personal link's headers
    (`Referrer-Policy: no-referrer` among them).
- **Clarification questions and answers are new** (card 2678), four internal routes, each
  JSON and same-origin (`415` or `403` before the body is read). A key reaches none of them;
  card 2682's v1 routes reach the same service (below).
  - `POST /api/decisions/{id}/questions`, a live participant's, consulted or informed, reached
    through their account: `{ "question": "…" }`, 1 to 2,000 characters after trimming, with no
    control, direction or invisible character (`400`). And `POST
    /api/decision-by-link/questions`, `{ "token": "…", "question": "…" }`, public, the token
    deciding as on the link's other routes: any link that opens no decision is the one `404`,
    counted against the caller's address (`429` past 20 in 15 minutes); a valid link's refusals
    are never counted. Both answer `200 { "question": { "question", "askedInVersion",
    "askedAt" } }`, with no id. From stored `open` or `closed` (awaiting a ruling) only: `409`
    "This decision has been ruled: questions are closed. You can raise a concern about the
    ruling instead" on a ruled decision, and "This decision is superseded: questions are
    closed" (or withdrawn) otherwise. `409` on an 11th question from the participant ("You have
    asked 10 questions on this decision: no more can be asked") and on the decision's 201st;
    `429` within 10 minutes of the participant's last, and past 30 from one account in 24 hours
    across decisions, each saying from when, in UTC.
  - `POST /api/decisions/{id}/questions/{questionId}/answer`, the author's or the decider's,
    while they can edit the board: `{ "answer": "…" }`, 1 to 4,000 characters; or
    `{ "answer": "…", "replacesDraft": true }` to put a person's answer in place of an agent's
    draft. `404` for a question not on the decision; `409` after the ruling, superseding or
    withdrawal ("…: its questions cannot be answered"); `409` "This question has been answered"
    for a question already answered, "An agent has drafted an answer to this question: publish
    it or replace it" for a draft without `replacesDraft`, and "No agent's draft waits on this
    question: there is nothing to replace" for `replacesDraft` with no draft. Answers `200 {
    "question": QuestionView }`, the question as its answerer is given it, the asker's name
    among it.
  - `POST /api/decisions/{id}/questions/{questionId}/publish`, the same people: no body is
    read (send `{}`). Publishes an agent's draft unchanged; `409` for a question with no
    answer, one a person answered, and a draft already published. Answers as the answer route.
    An administrator who is neither the author nor the decider is `403` on both.
  - **A `QuestionView`**: `question`, `askedInVersion`, `own`, `answer` (`{ text,
    answererName, answererRole, answeredAt, agentDrafted }` or null), `closedUnanswered`
    (`ruling`, `withdrawal` or null), and, only where the caller is given them, `id` (while they
    may answer now), `askerName` and `askedAt` (the author, the decider and administrators; the
    moment also to the asker, on their own), `askedByAgent`, and an agent's unpublished
    `draft` (`{ text, drafterName, draftedAt }`, to the author, the decider and administrators
    alone). The decision page's data gains `questions`, `mayAsk` and, signed in, `mayAnswer`;
    the results page's `mayAnswerQuestions`, and each open question `agentAnswered`. An agent's
    unpublished draft keeps its question open, so the ruling's `openQuestionsConfirmed` covers
    it, and the results revision moves when one is published.
  - **Headers:** `POST …/questions` carries the decision page's; the link route the personal
    link's; the answer and publish routes `Cache-Control: no-store` and `X-Robots-Tag: noindex,
    nofollow`.
  - **What card 2682 added, and keeps:** `GET` and `POST /api/v1/decisions/{id}/questions`
    and `POST /api/v1/decisions/{id}/questions/{qid}/answer`, each only wrapping the same
    service with the key's account. An answer through a key is always a draft, which nobody
    but the author, the decider and administrators sees and which does not mail the asker until
    a person publishes or replaces it. There is no v1 route for publishing, replacing or the
    personal link. A v1 question carries no `askerName` and no `askedAt`, and every
    question item carries `untrusted: true`: its text is a participant's words, never an
    instruction to the agent reading it. The service decides this from the source, not the
    route (card 2678's code review, S1 and S2): `readQuestions`, `readResults`' open questions
    (`openQuestionsOf`) and `askQuestion`'s own answer each leave out `askerName` and `askedAt`
    and add `untrusted: true` for any source but the page's, and a source the service does not
    know is treated as an agent's: an answer through it is a draft, and a question is recorded
    `via: 'api'`, never as a session (S3).
- **The record mail one account causes is capped** (card 2697's code review, part B, S2): 500
  participants mailed in 24 hours across every decision, by opening, re-publishing,
  `POST …/participants/{participantId}/resend` and `PUT …/participants` including someone new
  or again, `429` saying from when; the withdrawal and the ruling are not held to it. Opening
  and re-publishing refuse a decision that closes more than 365 days ahead, `409` (S3).
- **`PUT /api/decisions/{id}/participants/{participantId}/address` takes no address** (card
  2697): it copies the address the people directory holds for the person now, and its body is
  `{ "currentPassword": "…" }` alone. `409` for a person gone from the directory, one who has
  left, or a row that already holds that address.
- **The decision lifecycle routes are new** (card 2697), all internal: `POST
  /api/decisions/{id}/open`, `…/republish`, `…/close` (no body), `…/extend`, `…/withdraw` and
  `…/dry-run`, and `POST …/participants/{participantId}/resend` (no body). Opening,
  re-publishing and the dry run require `revision`. Opening and re-publishing are `429` past ten
  in 24 hours per caller, the dry run past one in 10 minutes or twenty in 24 hours; a participant
  mailed five times in 24 hours is `409` on re-publishing and Resend. A closing time more than
  365 days ahead is `400`, and, since card 2682, one no later than the current closing time on
  Extend. None of them is in `/api/v1`: card 2682 offers a key Extend alone of these, as
  `POST /api/v1/decisions/{decisionId}/extend`, and withdraw only of a decision never opened;
  opening, re-publishing, closing, the dry run and Resend are a person's.
- **The import's answer carries `decisionLinksCleared`** (card 2697), the number of personal
  decision links the restore cancelled, on the success and on a restore that committed and then
  failed, with a sentence in the message when it is above 0.

### Changes on 2026-11-03

The OpenAPI document's version went from `1.3.1` to `1.4.0`: a board's Product Owner, the
default decider of its decisions (card 2673).

- **Every board answer carries `productOwnerUserId`**, the id of a user or `null`. Every board
  is `null` until someone sets it, and becomes `null` again if that user is deleted.
- **`PUT /boards/:boardId` takes `productOwnerUserId`**: the id of a user who can edit the
  board, or `null` for none. Left out, or sent as the board holds it, it is kept, even when
  that user can no longer edit the board, so a board read with `GET` can still be sent back
  whole. A change is the board's owner's or an administrator's: anyone else is answered `403`
  `Only the board's owner or an administrator can change its Product Owner`, and nothing in
  the request is saved. A user that does not exist is `400` `productOwnerUserId 99 is not an
  account`; one who cannot edit the board, a reader of a public board included, is `400`
  `productOwnerUserId 7 cannot edit this board: a board's Product Owner must be an account that
  can edit it`; a value that is not an id is `400` `productOwnerUserId must be an id`. `PUT`
  counts it among its six fields. The web application's `PUT /api/boards/{id}` takes it the
  same way.

### Changes on 2026-10-27

The OpenAPI document's version went from `1.3.0` to `1.3.1` with these corrections:

- **`GET /reports/activity` decides "never moved" from the activity log** (card 2480): a card
  is `created` when it was raised in the window, not edited since, and no move of it is
  recorded (`card_moved`, `card_moved_in`, `card_moved_away`, `card_sent`, `card_committed`,
  `card_returned_to_options` or `card_reopened`, in either spelling). The board's drag route
  recorded no move before mid-September 2026, so a card raised before 2026-10-01 must also
  still be in the board's first column that is not an Options column. Until this release every
  card had to be, so a card raised in another column and left alone was `progressed`, and one
  moved into the first column `created`.
- **`POST /boards/:boardId/columns` stores the `wipLimit` sent** (card 2520), read as
  `PUT /columns/:columnId` reads it: a whole number, `0` meaning no limit; `null`, a negative
  number or a value that is not a number is stored as `0`, and a fraction loses its fractional
  part. Left out, it is `0`. Until this release a limit sent with a new column was not stored,
  and was set only by a `PUT` after. The web application's `POST /api/columns` reads and
  stores it the same way.
- **`GET /me/stats` leaves archived cards out of `avgLeadTimeDays` and `avgCycleTimeDays`**
  (card 2541), as the board metrics leave them out of theirs. Until this release an archived
  completed card assigned to the user was averaged. `cardsCompleted` and `streak` are unchanged:
  they count the completions the user made, archived cards included, as archiving a card
  afterwards does not undo the work.

### Changes on 2026-10-26

The OpenAPI document's version went from `1.2.0` to `1.3.0` with these (milestone 22, cards
2459 to 2464): **upstream of the commitment point**, the Kanban Method's split between options,
ideas that may or may not be done, and committed work. A card is an **option** when it is in a
board's Options column (a column whose `role` is `"options"`) or in any column of an ideas board
(a board whose `kind` is `"ideas"`); every other card is committed. Every delivery board has
its Options column, made with it, and one made before this release is given an empty one at its
far left when the server starts (card 2527); no board is an ideas board until someone makes
one. Every card made before this release is committed, its `committedAt` its `createdAt`, and a
board answers as before but for its Options column among its columns, the fields named here and
the entry an archive of unfinished work writes (`card_abandoned`, below). Three operations and
two filters are new; these operations, answers and fields are:

- **Every column carries `role`**, `"options"` for the board's Options column and `null` for
  any other. `POST /boards/:boardId/columns` and `PUT /columns/:columnId` take `role`
  (`"options"` or `null`; left out on `PUT`, kept; anything else `400` `role must be "options"
  or null, not "backlog"`). `409`, with nothing written, for `"options"` on any other column
  (`This board already has its Options column.`; on a board that has none yet, made before this
  release or restored from a backup, until the next start, `A delivery board's Options column is
  made with the board; it comes back at the next start.`; or on a column of an ideas board, every
  column of which is upstream), for any other column of a delivery board called Options, in any case
  (`Only the board's Options column is called Options. Choose another name.`), for the Options
  column renamed to anything but Options (`The Options column is always called Options.`) or
  given `role: null`
  (`Every delivery board keeps its Options column.`), for a WIP limit above 0 on it, and for a
  position at or left of it, which stays the leftmost. A value sent back as the column holds it
  changes nothing and is not refused. `PUT` counts `role` among its six fields.
  `DELETE /columns/:columnId` is `409` for the Options column, empty or not, and for a column of
  an ideas board holding ideas that are not archived.
- **Every delivery board has one Options column, made with the board and by a start-up step for
  existing boards; it cannot be renamed to anything but Options, deleted or given away.** `POST /boards` makes a
  delivery board with Options, To Do, On Hold, In Progress and Complete, in that order. When the
  server starts, each delivery board that has none is given one, empty, titled Options, at its
  far left, with no entry and no webhook.
- **Every board carries `kind`**, `"delivery"`, which every board was, or `"ideas"`.
  `POST /boards` takes `kind`, and makes an ideas board with New Ideas, Shaping and Ready for
  Replenishment; a sub-board is always a delivery board (`409`), and none is made under an
  option. `PUT /boards/:boardId` takes `kind`, kept when left out or sent as it is: a change is
  the owner's or an administrator's (`403`), and of an **empty** board only, whose columns are
  then replaced with the other kind's; a board holding cards is `409` (giving it the ideas kind,
  naming the conversion; back to delivery, saying to move the cards to a delivery board, or
  delete them, first). `PUT` counts `kind` among its five fields. A column of an ideas board whose title makes it To
  Do, On Hold or Complete is `409` on create and on rename.
- **`POST /boards/:boardId/convert` is new**: the board's owner or an administrator makes a
  board an ideas board with its cards, `{"kind": "ideas", "cards": N}`, with one
  `api:board_converted_to_ideas` entry and no webhook. It answers the board with its columns.
- **`GET /boards` takes `kind=delivery` or `kind=ideas`**, listing only the boards of that kind
  the key's user can open; anything else is `400` `kind must be "delivery" or "ideas", not
  "backlog"`.
- **Every card answer carries `committedAt` and `committedBy`**, when and by whom the card
  crossed the commitment point (`null` while it is an option), **and `discardedAt` and
  `discardedBy`**, set when it is archived as an option and cleared by its restore. No operation
  takes them in a body.
- **`GET /boards/:boardId/cards` takes `stage=option` or `stage=committed`**, by the column each
  card is in, archived cards included with `archived=true`; anything else is `400` `stage must
  be "option" or "committed", not "backlog"`.
- **`POST /boards/:boardId/cards` commits a card created outside an upstream column** as it is
  created: `committedAt` its `createdAt`, `committedBy` the key's user, with no entry beyond
  `api:card_created`. One created in an Options column or on an ideas board is an option.
- **`PUT /cards/:cardId/move` records the commitment point**: out of an upstream column into a
  committed one it sets `committedAt` and `committedBy` and writes `api:card_committed` in place
  of `api:card_moved`, sending `card.committed`, within one board instead of `card.moved`
  (across boards each board is still sent its own `card.moved`, `card_sent` to the board it left
  and `card_moved_in` to the board it joins, and the board it joins `card.committed` after it);
  back into an upstream
  column it clears both and writes `api:card_returned_to_options`, sending `card.moved`. `409`
  for an archived card crossing either way, for a committed card with a sub-board going
  upstream, and for a card with a sub-board going into another board's upstream. An option moved
  to another board writes `api:card_sent` on the board it leaves, in place of
  `api:card_moved_away`.
- **`POST /cards/:cardId/send` is new**: an option sent to another delivery board's Options
  column, still an option, or its To Do, which commits it. It answers the moved card.
- **`DELETE /cards/:cardId` records what it archives**: an option is **discarded**
  (`discardedAt`, `discardedBy`, `api:card_discarded`, which sends `card.discarded`); committed
  work not in a Complete column is **abandoned** (`api:card_abandoned`, no webhook); and
  `api:card_archived` is written only for a card archived from a Complete column. A live option
  deleted for good writes `api:card_discarded` then `api:card_deleted`, and sends
  `card.discarded` then `card.deleted`. `archivedAt: null` on `PUT /cards/:cardId` restores a
  discarded card as an option, clearing the two marks.
- **The activity vocabulary changes**, for readers of `GET /audit-log`, `GET /reports/activity`
  and `recentActivity` on `GET /me/stats`. Seven actions are new: `card_committed`,
  `card_returned_to_options`, `card_discarded`, `card_abandoned`, `card_sent`,
  `column_converted_to_options`, which nothing writes now (the column conversion it recorded
  went before this release), and `board_converted_to_ideas`, each with `api:` when made through
  the API. Three are written less: **`card_archived` only for work archived from
  Complete**, unfinished committed work being `card_abandoned` and an option `card_discarded`, so
  a filter or a count of `card_archived` alone now misses both; `card_moved` not for a move across
  the commitment point; and `card_moved_away` not for an option leaving its board, which is
  `card_sent`. Entries written before are unchanged.
- **Two webhook events are new, `card.committed` and `card.discarded`**, making ten. **A webhook
  whose `events` list is empty is sent every event, so one made before this release receives
  both.** One that lists `card.moved` and not `card.committed` no longer hears a move out of an
  Options column within one board, as one without `card.completed` hears no completion; a move
  to another board still sends each board its own `card.moved`. `card.moved` also carries
  `data.action` `card_returned_to_options` and `card_sent`.
- **Every delivery measure leaves options out.** `GET /burndown` charts committed cards only,
  each from its `committedAt`, as each card is now (a card returned to options leaves the past
  scope); `GET /reports/activity` puts no option in a bucket or a total, takes the `created`
  bucket's first column to be the board's first column that is not an Options column, and answers
  `upstream` (`null` for a report on one user); `GET /milestones` counts options in
  `optionsCount` and not in `cardCount` or `doneCount`, and `GET /milestones/:milestoneId/summary`
  in `progress.options` alone, each node with `isOption`; `GET /me/stats` leaves options out of
  `activeCards` and of the average.
- **`GET /boards/:boardId/upstream` is new**, with view access to the board: over the last
  `days` days (1 to 365, 30 by default), the board's options now and how long they have waited,
  how many cards were committed from options, returned, discarded, sent on and abandoned, the
  discard rate, and `committedAll`, **Committed (all)**, which credits a card created committed
  to the board it is on now and counts a card created and then returned to options as no
  arrival.
- **`GET /me/stats` answers `avgLeadTimeDays`**, the average days from commitment to done, and
  `avgCycleTimeDays` at the same value: it is a lead time, named cycle time for history, kept so
  that nothing that reads it breaks. For a card made before this release the commitment is its
  creation, so the figure is as it was.

### Changes on 2026-10-14

The OpenAPI document's version went from `1.1.0` to `1.2.0` with these. One operation is
new, `DELETE /comments/:commentId` (card 2283); these operations, answers and fields are:

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
    webhook event names (six at 1.2.0), each trimmed (`events must be a list`, `events[n] must be one of: ...`): text
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
  them too. `dependencies_bulk_added` is written by older versions only (card 2291). Nor
  does a card put in a milestone or taken out, `milestone_card_added` or
  `milestone_card_removed` (card 2289); the card's `updatedAt` still moves, so it can still
  be in the window.
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
  included, where every caller who could view the board was given it. Since card 2154 (item
  57, below) an editor can no longer set a new address either.
- **`recentActivity` on `GET /me/stats` lists only entries on boards the key's user can
  open** (card 2126), the 20 counted after that, where an entry on a board they had been
  taken off was listed, with the card title in its `detail`. The completed count and streak
  beside it are as they were; `activeCards` and `avgCycleTimeDays` count only boards the
  key's user can open since card 2292, below.
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
  kept that board's milestone, and its title and board were given to every viewer of the
  first board, until card 2155 (below) took it out.
- **`GET /milestones` gives in `boardIds` only the boards the key's user can open** (card
  2206), where a card of a milestone on another board gave that board's id. `cardCount`
  and `doneCount` still count such a card, as `GET /milestones/:milestoneId` lists it
  withheld. An administrator's key is given every id as before (item 64).
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
  `board_updated` (naming the fields sent, in this API's order; since card 2345 only those
  that change) and `milestone_created`.
  Accepting a task request with an assignee writes `assignee_added`, by whoever accepted
  it. So `GET /audit-log`, `GET /reports/activity` and `recentActivity` on `GET /me/stats`
  hold them, and the activity report counts a card as touched by, and attributes it to,
  whoever assigned someone to it or edited a comment on it on a page, as it did for the
  same actions through the API. They wrote nothing. None of them starts a webhook. Since
  card 2289 a milestone changed, closed, reopened or deleted, and a card put in one or taken
  out, are recorded alike by both trees too (`milestone_updated`, `milestone_closed`,
  `milestone_reopened`, `milestone_deleted`, `milestone_card_added`,
  `milestone_card_removed`); since card 2343 the last two send the webhook events
  `milestone.card_added` and `milestone.card_removed`.
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

- **Every timestamp DumpFire stores is answered in ISO 8601 with `Z`** (card 2095), as
  `2026-10-14T08:00:00.000Z`, in every answer under `/api/v1/`. Fields that were
  `YYYY-MM-DD HH:MM:SS`, which names no zone and which most languages read in their own
  zone, now come back in ISO 8601: `createdAt` everywhere, `updatedAt` on a row never
  edited, an audit-log entry's `createdAt`, and the `from` and `to` of the activity report's
  `period` and of `GET /cards/:cardId/board-history`. Fields that were ISO 8601
  (`completedAt`, `firstCompletedAt`, `archivedAt`, `updatedAt` after an edit) keep their
  shape, but the fraction of a second is always `.000`, because every stored moment is now
  kept to the whole second (`generatedAt` and a webhook's own `timestamp`, which are not
  stored, carry real milliseconds). Dates (`dueDate`, `targetDate`, `asOf`) are unchanged, and the OpenAPI
  document declares every timestamp field `format: date-time` (item 53). A webhook body's
  own `timestamp` was ISO 8601 already; its `data` holds no stored time, and would hold one
  in the same form. See [Timestamps](#timestamps).
- **`from` and `to` on `GET /audit-log` and `GET /reports/activity` take ISO 8601,
  `YYYY-MM-DD HH:MM:SS` or a date** (card 2095): ISO 8601 with or without a fraction, with
  `Z` or an offset, which is read in UTC; `YYYY-MM-DD HH:MM:SS` in UTC; or a date alone.
  Anything else is `400` `from is not a date` or `to is not a date`. The audit log compared
  what it was sent with the stored time as text, unchecked, so a bound written in the other
  form gained or lost the day at its end, and a date alone as `to` left that whole day out;
  the activity report refused `YYYY-MM-DD HH:MM:SS`. A date alone as `to` is now the whole
  of that day, to 23:59:59 UTC, in both (item 54). A `from` after its `to` is `400`
  `` `from` is after `to` `` in both (card 2217, item 74).
- **An `archivedAt` that is text, on `PUT /cards/:cardId`, is read as the moment it names**
  (card 2095), so the `archivedAt` a `GET` answered, sent back in ISO 8601 with any fraction
  or offset, or as `YYYY-MM-DD HH:MM:SS`, is the stamp the card holds and changes nothing.
  `null` still restores the card, and any other value, `true` and a number included, is
  still `400` (item 55).
- **A webhook's `url` may not point inside the network** (card 2161), on
  `POST /boards/:boardId/webhooks` and `PUT /webhooks/:webhookId`: one that does, as
  written, is `400` `Webhook url points inside the network: <why>`, where it was stored.
  Inside is a loopback, private, shared (carrier NAT), link-local (the cloud metadata service
  at `169.254.169.254` among them), reserved, documentation or multicast address, in IPv4 or
  IPv6, an IPv4 address written another way (`2130706433`, `127.1`) or inside an IPv6 form
  (`::ffff:127.0.0.1`), and the names `localhost`, any name ending `.localhost`, a name with
  no dot, and any name ending `.local`, `.internal` or `.home.arpa`. One that carries a user
  name or password is `400` `Webhook url must not carry a user name or password`. No name is
  looked up then: a name is judged at each delivery by every address it resolves to, and a
  delivery to one that resolves inside is not made. Redirects are not followed. The server's
  operator may let named receivers inside the network be sent to. A stored `url` sent back
  unchanged is accepted, and is refused at each delivery until it is changed or let in
  (item 56).
- **Only the board's owner or an administrator changes a webhook's address or secret, or
  switches one on** (card 2154), on `PUT /webhooks/:webhookId`: an editor who sends `url` or
  `secret` at all, whatever the value, the stored one and `null` included, is `403` `Only the
  board's owner or an administrator can change a webhook's address or secret. Ask the board's owner.`, and one who
  sends `active: true` for a webhook that is off `403` `Only the board's owner or an
  administrator can switch a webhook on. Ask the board's owner.`, with nothing written, where an editor could change
  both and switch one on. An editor still changes `events`, switches a webhook off, and may
  send `active: true` for one already on. A script that sends back a webhook's whole answer
  with a changed `events` is refused for an editor: send only the fields that change (item
  57). Whoever creates a webhook, changes its `url` or `secret`, or switches it on is the one
  whose password reset switches it off, and a `POST` or `PUT` whose key such a reset ends while
  its body is still arriving is `401` `Invalid or expired API key`, with nothing written.
- **A board has at most 10 webhooks** (card 2201), switched-off ones counted:
  `POST /boards/:boardId/webhooks` answers `409` `This board has 10 webhooks, and a board may
  have at most 10: delete 1 before adding another.` after every other check, and creates
  nothing, where any number could be made. A board that already has more keeps them all,
  and every active one is still sent; the `409` gives its own count (`This board has 14
  webhooks, … delete 5 before adding another.`) (item 58).
- **A webhook's answer says what its last delivery came to** (card 2178), as `lastDelivery`,
  to the board's owner and an administrator, on `GET /boards/:boardId/webhooks`,
  `GET /webhooks/:webhookId` and the answer to `PUT /webhooks/:webhookId`:
  `{ "at": "2026-10-14T10:02:11.481Z", "event": "card.moved", "outcome": "answered",
  "status": 500, "reason": "The receiver answered 500" }`. `at` is the moment the event was
  dispatched, the body's `timestamp`; `outcome` is `delivered` (a 2xx), `answered` (any other
  status, a redirect included, which is not followed), `no-answer` or `not-sent` (refused
  before any request); `status` is the receiver's or `null`; `reason` is one of a fixed set
  of sentences that never holds the address, its path or query, the secret or an address a
  name resolved to, and a closed port, a filtered one and a receiver that does not answer
  read alike (`The receiver could not be reached, or did not answer within 10 seconds`), in
  their words and in their timing: such a result is recorded no sooner than the timeout
  after the delivery was given its connection. The 10 seconds count from that connection, so
  a delivery queued behind the 20 already open to one receiver is not timed while it waits.
  It is the latest attempt only, not a history: a failure followed by a success is not
  shown, and the system log keeps each failure. It is `null` until the webhook's first
  delivery since the server last started, and after its `url` changes until the next
  delivery or until the address is changed back; it is `null` in the answer to the `POST`
  that made the webhook, and anyone else is given no `lastDelivery` key, as no `url`. A
  result is kept in the server's memory, never stored, so a restart, a deploy included,
  forgets it. It is read through the API only: no page shows webhooks, and nothing tells
  anyone that a delivery failed. Until then a delivery's result was in the system log only,
  which administrators read (item 59).
- **A move to another board takes the card out of a milestone of the board it left** (card
  2155), on `PUT /cards/:cardId/move`: when the card's milestone belongs to a board other
  than the one it arrives on, `milestoneId` is set to `null` in the same write as the move,
  and the answer has `milestoneId: null` and `leftMilestone` `{ "id", "name" }`, the
  milestone it left (`null` for any other move, and for a third board's, which is not
  named); moving the card back does not put it back in. A milestone across boards (`boardId` `null`) keeps
  the card, and so does one of the board it arrives on. The `api:card_moved_away` entry on
  the board it left ends ` and out of milestone "<name>"`, or ` and out of a milestone of
  another board` for a third board's; no other entry or webhook delivery is added. The card
  kept the milestone, and its title was listed to every reader of the board it left
  (item 60). Cards already in that state were taken out once, at the deploy, by a migration.
- **The completion refusal names only a sub-board the key's user can open** (card 2151), on
  `PUT /cards/:cardId/move` into a Complete column: when the only unfinished sub-boards are
  ones they cannot open, `409` `A sub-board you cannot open still has incomplete cards that
  must be completed first. Ask this board's owner.`, with no name and no count, where the sub-board was named with
  its count of open cards. One they can open is named as before (item 61).
- **The "Unblocked" comment names work on another board by its number only** (card 2152),
  as `GET /cards/:cardId/comments` reads it: `Unblocked: #12, a card on another board,
  completed — nothing is blocking this card now.`, or `Unblocked: a subtask on another board
  completed — …`, where it gave the other board's title. Work on the same board is named by
  its title as before; comments written before are unchanged (item 62). A card moved to
  another board takes its notices in this form too (card 2256, item 71), and is named so in
  other cards' notices on every card not on the board it arrives on (card 2261, item 76).
- **A milestone is given to a board only when every card in it is on that board** (card
  2179), on `PATCH /milestones/:milestoneId` with `boardId`, archived cards included:
  otherwise `400` `Some cards in this milestone are not on that board (archived cards count
  too). Take those cards out of it first, or make the milestone cross-board instead; only its creator or an administrator can change a cross-board milestone afterwards.`, and
  nothing changes. The milestone went to the board with its cards, and the board's readers
  were given the titles of cards of other boards. `boardId: null` is accepted as before. A
  `boardId` that names no board is `404` `Board not found`, where an administrator was
  answered `500` and anyone else `403` `No edit access to that board` (item 63). See
  [`PATCH /api/v1/milestones/:milestoneId`](#patch-apiv1milestonesmilestoneid).
- **A comment mails the people it names only when they can open the card's board** (card
  2198), on `POST /cards/:cardId/comments`: an account named as `@username` is mailed only
  when it is the board's owner, a member, a member of a team the board is shared with,
  anyone for a public board, or an administrator, and then as its Mentions setting says.
  Anyone named was mailed the card's title, the board's name and the start of the comment.
  The comment is saved and answered as before; the author is not told who was not mailed
  (item 65).
- **A mention reaches every username, as it is spelled, in any case** (card 2207). A name is
  the longest username that the text after an `@` begins with, case ignored, where it was
  the letters, digits and `_` after the `@`, lower-cased: `@Greg` reached nobody and
  `@jane.doe` mailed `jane`. An `@` inside a word, as in `bob@example.com`, is not a
  mention. Where two usernames differ only in case, the one typed exactly is mailed, and
  neither when the name is typed in neither spelling. Only the first 200 `@` of a comment
  that could start a name are read (item 66). See
  [`POST /api/v1/cards/:cardId/comments`](#post-apiv1cardscardidcomments).
- **`GET /cards/:cardId/board-history` begins with the board a card started on** (card
  2199), for a card with no recorded creation that has moved: a move writes its departure
  and its arrival in the same second, so that board was left out. The entries are read in
  the order they were written, and no time is compared (item 67).
- **A move to another board names neither board in its activity entries** (card 2181), as
  `GET /audit-log` reads them: `"<title>" moved to another board (<from> → <to>)` on the
  board it left and `"<title>" moved from another board (<from> → <to>)` on the board it
  arrived on, where each named the other board to every reader of its own. Entries written
  before are unchanged (item 68).
- **A token correction takes back no more than was recorded** (card 2220), on
  `POST /cards/:cardId/tokens`, `POST /subtasks/:subtaskId/tokens` and `POST /tokens/bulk`:
  on the same card's own entries or the same subtask's, of the same `model`, a correction
  with no breakdown takes back at most the tokens recorded without one, and one with a
  breakdown no part beyond what is recorded of it; otherwise `400` (a line of the `409` in
  a batch), naming what may be taken back, with nothing written. A correction of measured
  work sent as a bare total was priced at full input rates and took the card's cost below
  zero. `DELETE /tokens/:entryId` refuses, `400`, to remove an entry only when that would
  take what is recorded of its model on its card or subtask below zero, as removing it before
  the negative entries that correct it would. Entries already stored are unchanged (item 70).
- **A card moved to another board takes its "Unblocked" comments without the names of the
  board it left** (card 2256), on `PUT /cards/:cardId/move`, as `GET /cards/:cardId/comments`
  reads them: `Unblocked: #12 "<title>" completed — …` becomes `Unblocked: #12, a card on
  another board, completed — …`, unless card 12 is on the board the card arrives on, and
  `Unblocked: subtask "<title>" completed — …` becomes `Unblocked: a subtask on another
  board completed — …` unless every subtask it names (the finished one, and the waiting
  one) has the title of one of the card's own subtasks, which go with it and can be read on
  it, the rest of each kept and its `updatedAt` unchanged. They went on
  naming the work to readers of the board the card arrived on. Comments of cards moved
  before are unchanged (item 71). Card 2261 (item 76, below) is the other direction.
- **`GET /reports/activity` names a milestone only to a reader who can open it** (card
  2257): a card's `milestoneName` is `null` when the key's user cannot open its milestone
  (`GET /milestones/:milestoneId` would be `403`), with `milestoneId` as before, and
  `milestones` leaves such a milestone out. A goal across boards was named to anyone who
  could open one of its boards (item 72).
- **A subtask made with no `position` goes after the card's last one** (card 2223), on
  `POST /cards/:cardId/subtasks`: one more than the largest position on the card, or 0 for
  its first, as the web application places it. Every subtask sent with no `position` was
  put at 0, so a card filled by a script had them all there. Subtasks already at 0 keep it.
  `GET /cards/:cardId/subtasks` and the `subtasks` of `GET /cards/:cardId` are ordered by
  position, then id, so subtasks at one position read in the order they were made; they had
  no order (item 73).
- **`GET /audit-log` refuses a `from` after its `to`** (card 2217): `400`
  `` `from` is after `to` ``, as `GET /reports/activity` answers, where it was `200` with an
  empty page. Equal bounds name one second and are allowed. Its entries are newest first,
  and by id, newest first, within one second, so paging with `offset` neither repeats nor
  skips an entry of the second a page ends in (item 74).
- **A text field past its length limit is refused in one wording, in both trees** (card
  2218): `400` `<field> must be at most <max> characters`, the field's own name as sent and
  the limit written as a plain number, which is what every route with no wording of its own
  already answered. On the API, `Title too long (max 500 chars)` becomes
  `title must be at most 500 characters` on `POST /boards/:boardId/cards`,
  `PUT /cards/:cardId`, `POST /cards/:cardId/subtasks` and `PUT /subtasks/:subtaskId`;
  `Description too long (max 50000 chars)` becomes
  `description must be at most 50000 characters` on `POST /boards/:boardId/cards` and
  `PUT /cards/:cardId`; `Board name too long (max 200 chars)` (`POST /boards`,
  `PUT /boards/:boardId`), `Name too long (max 200 chars)` (`POST /board-categories`,
  `PUT /board-categories/:categoryId`, `POST /boards/:boardId/categories`,
  `PUT /categories/:categoryId`), `Label name too long (max 200 chars)`
  (`POST /boards/:boardId/labels`, `PUT /labels/:labelId`) and
  `name too long (max 200 chars)` (`POST /milestones`, `PATCH /milestones/:milestoneId`)
  become `name must be at most 200 characters`; `Column title too long (max 200 chars)`
  becomes `title must be at most 200 characters` on `POST /boards/:boardId/columns` and
  `PUT /columns/:columnId`; and `Comment too long (max 50000 chars)` becomes
  `content must be at most 50000 characters` on `PUT /comments/:commentId`, as
  `POST /cards/:cardId/comments` answered. The web application's routes under `/api/` change
  in the same way: the title, description, name and column title texts above on
  `POST /api/cards`, `PUT /api/cards/{id}`, `POST /api/subtasks`, `PUT /api/subtasks/{id}`,
  `POST /api/boards`, `POST /api/board-categories`, `POST /api/categories`, `POST` and
  `PATCH /api/labels`, `POST /api/columns`, `PUT /api/columns/{id}`, `POST /api/milestones`
  and `PATCH /api/milestones/{id}`, the milestone service behind the last two included;
  `Business value too long (max 10000 chars)` becomes
  `businessValue must be at most 10000 characters` on `POST /api/cards` and
  `PUT /api/cards/{id}`; on `POST /api/requests`, `Title too long (max 500 chars)`,
  `Description too long (max 10000 chars)` and `Business value too long (max 5000 chars)`
  become `title must be at most 500 characters`,
  `description must be at most 10000 characters` and
  `businessValue must be at most 5000 characters`; `Key name too long (max 100 chars)`
  becomes `name must be at most 100 characters` on `POST /api/account/api-keys`; and
  `Message too long (max 5000 characters)` becomes `message must be at most 5000 characters`
  on `POST /api/requests/{id}/messages`. Every limit is as it was, and the texts for a field
  that is missing or empty are unchanged. A script that matched one of the old texts no
  longer matches it (item 75).
- **A card moved to another board is no longer named in other cards' "Unblocked"
  comments** (card 2261), on `PUT /cards/:cardId/move`, as `GET /cards/:cardId/comments`
  reads them, on every card not on the board it arrives on: `Unblocked: #12 "<title>"
  completed — …` naming it becomes `Unblocked: #12, a card on another board, completed —
  …`, and `Unblocked: subtask "<title>" completed — …` naming one of its subtasks, on a card
  that waited on that subtask as its dependencies still record, becomes `Unblocked: a
  subtask on another board completed — …`, the rest of each kept and its `updatedAt`
  unchanged. They went on naming the card to readers who may not open the board it moved
  to. A notice on a card of the board it arrives on is left as it is, and so is a subtask
  notice on a card that also waits on a subtask of the same title that is not the moved
  card's, which may have written it. Comments naming cards moved before are unchanged
  (item 76).
- **A write is asked again at the write** (card 2253), every `POST`, `PUT`, `PATCH` and
  `DELETE` of both trees, as the webhook writes alone were (item 57): a write whose key or
  session ended (revoked, expired, a sign-out, or a password reset), or whose account's role
  or access changed, while its body was arriving is refused with nothing written, no webhook
  fired and no mail sent. An ended key is `401` `Invalid or expired API key`, an ended session
  `401` `Not authenticated`, the gate's own words; a role or access lowered is refused as the
  account now is, `403` or `404` in the operation's own words, and `POST /dependencies/bulk`,
  `POST /tokens/bulk`, and `POST` and `DELETE /milestones/:milestoneId/cards/bulk` with their
  `409`, listing every item. In the web application,
  `DELETE /api/report-schedules/{id}`, which asked nothing, asks too: a session a reset had
  ended could still delete a schedule, and is now `401`. Nothing changes for a key or session
  that still holds and an account whose role is as it was (item 77). See
  [Asked Again at the Write](authentication-security.md#asked-again-at-the-write-card-2253).
- **A reopening and a move to another board send `card.moved`** (card 2278), whichever
  route made them, `PUT /cards/:cardId/move` among them: a card moved out of a Complete
  column sends its board's webhooks `card.moved` with `data.action` `card_reopened`, and a
  card moved to another board sends the board it left `card.moved` with `card_moved_away`
  and the board it joined `card.moved` with `card_moved_in`, each with that board's own
  entry as `detail`, which names neither board. Both sent nothing, so a receiver of
  `card.moved` missed them. A move into a Complete column still sends `card.completed`
  instead of `card.moved` (item 78). See
  [Events and Payload](notifications-email.md#events-and-payload).
- **`GET /me/stats` counts `activeCards` and averages `avgCycleTimeDays` only on boards the
  key's user can open** (card 2292), the same boards the web application's dashboard and My
  Tasks count (an open card is still one with no `completedAt` here, where those two go by
  its column). Both counted the cards the user is assigned to on every board, so someone taken off
  a board saw the two figures move as cards there were completed, archived or unassigned. A
  user who can open no board is answered `activeCards` `0` and `avgCycleTimeDays` `null`.
  The shape is unchanged, and `cardsCompleted` and `streak`, which count the user's own
  completions, are as they were. In the web application the dashboard's Velocity window
  (`GET /api/velocity`) counts the same way (item 79). See
  [What a List Gives](authentication-security.md#what-a-list-gives).
- **`GET /reports/activity` reads only the boards the key's user can open** (card 2326), and
  `meta.boardsExcludedForAccess` is always `0`, still in every answer and marked deprecated.
  It counted the boards with activity in the window that the key's user could not open, so
  polling a narrow window told them when such a board was worked on, and naming one in
  `boardIds` whether it had. A board named in `boardIds` is now checked in the order given, as
  `GET /burndown` checks one, administrators included: one that does not exist is `404`
  `Board 7 not found`, and one the key's user cannot open is `403` `No access to board 7`,
  where both were `200` with nothing of the board. A saved list that holds a deleted board
  now fails. A milestone in `milestones` counts `totalCards`, `completedAtStart` and
  `completedAtEnd` over its cards on boards the key's user can open, as its burndown does (an
  administrator's over every board): a card moved onto a board they could not open was
  counted, so moving `from` across its completion told them the second it was completed.
  Every other figure is as it was for the boards the key's user can open (item 80).
  See [Reporting](#reporting).
- **A webhook is sent only while the account that set it up can open its board** (card 2325),
  asked at each event with that account's role as it is then, as mail is sent only to
  assignees who can open the board. One set up by an editor went on sending every event of the
  board to its address after they were taken off the board, out of the team it is shared with,
  or the board was made private, and one an administrator set up went on after they were made
  an ordinary user. **A webhook whose setter cannot open the board, and one nobody is recorded
  as having set up (made before setters were recorded on 2026-10-18/19), is held from the
  deploy on**: nothing is sent, `active` is left as it is, and `lastDelivery` says `Not sent:
  the account that set it up can no longer open this board` or `Not sent: nobody is recorded
  as having set it up`. A webhook answered to the board's owner or an administrator, and the
  answer to the create, carry a new field, `pausedBecause`: `null` unless the webhook is on
  and held, then one of two sentences saying why and what to do. A held webhook is sent again
  when its setter can open the board again. The board's owner or an administrator takes one
  over by switching it off, then on (which makes them its setter), with a new secret, and
  updates the receiver; `{"active": true}` for one already on takes nothing over (item 81).
  See [Webhooks](#webhooks). (Since `1.11.0`, card 2752, such a webhook is switched off for
  good instead, and is not sent again when its setter can open the board again.)
- **`GET /cards/:cardId/comments` lists comments made in the same second the later first**
  (card 2301), by id, in a list that is still newest first. A comment's `createdAt` is kept
  to the second, and comments of one second came back in no set order, in practice the
  earlier first: a request's discussion copied onto its card when it is accepted, and several
  comments posted in a row, read upside down. The discussion is now copied in the order it
  was sent, by id within one second, so its copies list newest first (item 82).
- **`GET /cards/:cardId/comments` answers `userEmoji` `"👤"` for an author with no emoji**
  (card 2302), as `POST /cards/:cardId/comments` and `GET` and `PUT /comments/:commentId`
  already did, where it was `null` against the `Comment` schema, whose `userEmoji` is a
  required string. Only an account restored from an old backup, or changed directly in the
  database, has no emoji; no stored data changes (item 83).
- **`PUT /comments/:commentId` with the comment's own text writes nothing** (card 2284), as
  an update to a card that changes nothing writes nothing (card 2183). Text that is the
  comment's own once both are trimmed keeps its `updatedAt`, logs no `api:comment_edited`
  and sends no live update, and is answered `200` with the comment as it is stored, with its
  author. It wrote the comment again with a new `updatedAt`, which the web application shows
  as "(edited)", and recorded an edit nobody made. A caller who may not edit the comment is
  still refused `403` first, whatever text it sends (item 84).
- **`DELETE /comments/:commentId` is new** (card 2283), where the route answered `405`. Who
  may delete a comment is who may in the web application: its author while they can still
  edit the board it is on, or an administrator; a board's owner may not delete a comment
  somebody else wrote. No body; `200` `{ "success": true }`; `400` `Invalid comment ID`,
  `404` `Comment not found`, `403` `No edit access to this board` and `403`
  `You can only delete your own comments`, the web application's words. It logs
  `api:comment_deleted`, `Deleted a comment on "<card>"`, or
  `Deleted a comment by <author> on "<card>"` when the caller is not the author, never the
  comment's text, and sends a live update. A delete made in the web application,
  `DELETE /api/cards/{id}/comments/{commentId}`, now logs `comment_deleted` in the same words
  and sends the same update; neither was recorded. **No webhook is sent for a delete**: there
  is no `comment.deleted` event, so re-reading `GET /cards/:cardId/comments` is the only way
  to learn that a comment has gone (item 85). See
  [`DELETE /api/v1/comments/:commentId`](#delete-apiv1commentscommentid).
- **`DELETE /cards/:cardId` on a card already archived writes nothing** (card 2285). It is
  still answered `200` `{ "success": true }`, so a retried archive does not fail, but
  `archivedAt` keeps its first value, `updatedAt` is not moved, no second
  `api:card_archived` is logged and no live update is sent. Both stamps were set again to
  the time of the second request, which lost the time the card was archived, and a second
  "Archived card" was recorded. An archive made in the web application,
  `DELETE /api/cards/{id}`, is the same. A restore of a card that is not archived already
  answered so (item 86). See [`DELETE /api/v1/cards/:cardId`](#delete-apiv1cardscardid).
- **Unticking or editing a subtask is recorded, and a save that changes nothing writes
  nothing** (card 2299), on `PUT /subtasks/:subtaskId`. An untick logs
  `api:subtask_updated`, `Reopened <subtask> (on <card>)`, and mails nobody; a change of
  `title`, `description`, `priority`, `colorTag` or `dueDate` logs `api:subtask_updated`
  naming the fields changed, `Updated <subtask> (on <card>): title, dueDate`, after the
  tick's or untick's entry when one request does both. A change of `position` alone is
  written and still not recorded. Neither an untick nor an edit was recorded. A request
  whose every field is the value the subtask holds keeps it as it is, logs nothing and
  sends no live update, and is answered `200` with the subtask; it was written again and
  the board told. The web application's `PUT /api/subtasks/{id}` is the same.
  `api:subtask_updated` is work on the card in `GET /reports/activity`, as
  `api:subtask_completed` is (item 87). See
  [`PUT /api/v1/subtasks/:subtaskId`](#put-apiv1subtaskssubtaskid).
- **`POST /dependencies/bulk` records each link it creates** (card 2291), as
  `POST /cards/:cardId/dependencies` records one: an `api:dependency_added` entry on the
  board of the card that waits (a subtask's card), with that card's id,
  `#1559 now waits on #1686`. It wrote one `api:dependencies_bulk_added` entry for the whole
  batch, with no card, on the first board it touched alone. A link skipped as already
  recorded writes none, and a batch that writes nothing tells no board, as before.
  **`dependencies_bulk_added` is no longer written**: `GET /audit-log?action=dependencies_bulk_added`
  finds older entries only, and `action=dependency_added` now finds the links of a batch
  too. Neither sends a webhook (item 88). See
  [`POST /api/v1/dependencies/bulk`](#post-apiv1dependenciesbulk).
- **The web application's card update no longer sends `card.updated` for a change of
  position within the card's column** (card 2288). `PUT /api/cards/{id}` with a `position`
  and no change of column wrote the card with a new `updatedAt`, logged `card_updated`
  "Updated fields: position" and so sent `card.updated` to the board's webhooks; a drag and
  `PUT /cards/:cardId/move` to the same column never did. It now goes through the drag's
  path: the position alone is written, nothing is logged and no webhook is sent. Sent with
  other fields, it still sends one `card.updated`, whose `detail` names those fields alone.
  That route takes no key and no page sends it a position, so only a request made by hand
  from a signed-in browser saw the delivery. Nothing `PUT /cards/:cardId` accepts or answers
  changes (item 89).
- **Goal changes are recorded, and goal membership sends no `card.updated`** (card 2289).
  `PATCH /milestones/:milestoneId` logs `api:milestone_updated` (naming the fields changed
  among `name`, `description`, `targetDate` and `boardId`) and, for a change of `status`,
  `api:milestone_closed` or `api:milestone_reopened`; `DELETE` logs `api:milestone_deleted`
  with each board's count of cards released. Each has no card and goes on the milestone's
  board, or for one across boards on each board holding its cards (a change of board: the
  boards before and after), naming it as that board's readers knew it before the change, or
  as `milestone #<id>` where it is across boards. Every operation that puts a card in or
  takes it out logs `api:milestone_card_added` or `api:milestone_card_removed` on the card's
  board with its id, the bulk pair one per card, and **`milestoneId` on `PUT /cards/:cardId`
  logs these in place of naming `milestoneId` in `api:card_updated`, so `card.updated` is no
  longer sent when `milestoneId` is the only change**. A card moved between milestones logs
  one `api:milestone_card_added` naming the one it left, and no `api:milestone_card_removed`.
  A change that changes nothing writes, logs and tells nothing, after every refusal. No
  webhook is sent for a change to the goal itself; a card put in or taken out sends
  `milestone.card_added` or `milestone.card_removed` (card 2343, item 102), and the two card
  entries are not work in `GET /reports/activity`. The plan-created mail is still the bulk
  attach's alone (item 90). See
  [`PATCH /api/v1/milestones/:milestoneId`](#patch-apiv1milestonesmilestoneid).
- **`PUT /cards/:cardId` refuses another column, `POST /boards` files a new board under its
  category, and `PUT /boards/:boardId` refuses another parent card** (card 2287). Each was
  ignored without a word. `PUT /cards/:cardId` answers `400` `columnId 12 is not this card's
  column (14): the card has moved since it was read, or a move was meant. Move a card with
  PUT /cards/{cardId}/move` for a `columnId` other than the card's own, and `400` `columnId
  must be an id` for `null` or one that is not an id, where it saved the other fields and
  left the card where it was; the card's own column, sent back, is accepted, so a card read
  with `GET` can still be sent back whole. `position` is still ignored there, whatever is
  sent, now said so: reorder with `PUT /cards/:cardId/move`. `POST /boards` takes
  `categoryId`, as the web application's create does: `404` `Board category not found`,
  `403` `No access to this board category` and `400` `categoryId must be an id`, where each
  made the board unfiled with `201`. `PUT /boards/:boardId` answers `400` `parentCardId 12 is
  not this board's parent card (none): …` for a `parentCardId` other than the board's own,
  `null` on a sub-board included, and `400` `parentCardId must be an id`, where it saved the
  other fields and ignored it (item 91). See
  [`PUT /api/v1/cards/:cardId`](#put-apiv1cardscardid).
- **`DELETE /milestones/:milestoneId/cards/bulk` takes an archived card out** (card 2290),
  logging `api:milestone_card_removed`, as `DELETE /milestones/:milestoneId/cards` and
  `milestoneId: null` on `PUT /cards/:cardId` do, where it refused the whole batch with a
  `409`. An archived card not in the milestone is skipped and counted, and a card that does
  not exist is `Card not found` in the `409` (it was `Card does not exist or is archived`),
  so an archived card on a board the key's user cannot edit is listed as one they cannot
  edit, by its id with no title. `POST …/cards/bulk` still refuses an archived card. A
  milestone whose only cards were archived can now be emptied, and the plan-created mail,
  which counts archived cards when it decides a milestone was empty, is then sent by the next
  bulk attach to it (item 92). See
  [`DELETE /api/v1/milestones/:milestoneId/cards/bulk`](#delete-apiv1milestonesmilestoneidcardsbulk).
- **`GET /boards/:boardId/cards` lists the cards in the board's order** (card 2295): by
  column, in order of column position, ties by column id, and within a column in order of
  card position, ties by card id. It listed the columns in the order they were made in, so a
  column moved or added between two others came in the wrong place. The cards are read in one
  query, and an answer's fields are unchanged (item 93). See
  [`GET /api/v1/boards/:boardId/cards`](#get-apiv1boardsboardidcards).
- **`DELETE /board-categories/:categoryId` takes its boards out of the category** (card
  2293). Every board filed under it, sub-boards included, has `categoryId` `null` once the
  category is deleted, in the same request, where each kept the deleted category's id: every
  board read answered that id, and a category later given the same id would have had those
  boards filed under it. Their `updatedAt` is left as it is and nothing is logged. The web
  application's `DELETE /api/board-categories/{id}` (Manage Categories) is the same. Boards
  already holding the id of a category that no longer exists were cleared once, at the first
  start after the deploy, and are cleared again after every restore. Who may delete one is
  unchanged: the key's user must be able to edit every board filed under it (item 94).
- **`PUT /boards/:boardId` writes, logs and tells only the fields whose value changes**
  (card 2345). A body whose every field is as the board holds it is answered `200` with the
  board as it is, with `updatedAt` not moved, no `api:board_updated` and no live update; it
  was written again, logged naming every field sent, and the board's open pages told. A
  body that changes some fields names only those. `{}` is still `400`
  `No valid fields to update`, and an editor who sends `isPublic`, even the value held, is
  still `403`. The web application's `PUT /api/boards/{id}` is the same, and its `{}`, still
  `200`, no longer writes the row (item 95). See
  [`PUT /api/v1/boards/:boardId`](#put-apiv1boardsboardid).
- **`GET /milestones/:milestoneId` lists the milestone's archived cards in
  `archivedCards`** (card 2346). Giving a milestone to a board counts its archived cards, and
  the refusal names none of them, but the read listed only the cards that are not archived,
  so finding the one in the way meant `GET /boards/:boardId/cards?archived=true` on each
  board. `archivedCards` lists them by card id, each a `cards` item with `archivedAt`; a card
  on a board the key's user cannot open, which a card moved off the milestone's board can
  be, is withheld as in `cards`, with `archivedAt` `null`. `cards` is unchanged, and the web
  application's `GET /api/milestones/{id}` answers neither, as before (item 96). See
  [`PATCH /api/v1/milestones/:milestoneId`](#patch-apiv1milestonesmilestoneid).
- **`GET /audit-log` and the activity reads can return `attachment_added` and
  `attachment_deleted`** (card 2337). A file attached to a card in the web application logs
  `attachment_added`, `Attached "<file name>" to "<card>"`, and one deleted logs
  `attachment_deleted`, `Deleted the file "<file name>" from "<card>"`, the file named as its
  uploader named it, by whoever did it, with `source` `ui`; neither was recorded.
  Attachments were not part of this API then, so neither was written with `api:` (since
  1.7.0 an image uploaded through a key writes `api:attachment_added`, and DumpFire's own
  retention writes `attachment_expired`, source `system`: see
  [Changes on 2026-11-05](#changes-on-2026-11-05)). **No webhook
  is sent for either**: there is no `attachment.*` event, and a receiver could not fetch the
  file (item 97).
- **`PUT /columns/:columnId`, `/labels/:labelId`, `/categories/:categoryId` and
  `/board-categories/:categoryId` write only the fields whose value changes** (card 2359),
  as `PUT /boards/:boardId` does since card 2345. A body whose every field is as the row
  holds it (a name or title that trims to the stored one included) is answered `200` with the
  row as it is: nothing is written, and the board's open pages are not told to re-read, where
  every field sent was written and the board of a column, a label or a category told. `{}` is
  still `400` `No valid fields to update`, and a request that would be refused is still
  refused first (a column holding a card renamed into or out of Complete is still `409`). The
  web application's `PUT /api/columns/{id}`, `PATCH /api/labels`, `PUT /api/categories/{id}`
  and `PUT /api/board-categories/{id}` write and tell the same way, though each keeps its own
  answer to an empty body (`PATCH /api/labels` answers `{}` with `400`
  `Send name or color to change`) (item 98). See
  [`PUT /api/v1/columns/:columnId`](#put-apiv1columnscolumnid).
- **A comment copied from a request's discussion keeps its message's time** (card 2340).
  Accepting a request in the web application copies its discussion onto the new card as
  comments; each copy now has the time its message was sent as its `createdAt` and
  `updatedAt`, as `GET /cards/:cardId/comments` and the reports read it, where every copy had
  the time of the accept. Comments copied before keep their times (item 99).
- **Nobody is mailed about assigning themselves** (card 2286). `POST /cards/:cardId/assignees`
  with the key's own user as `userId` mailed them `Assigned: <card>` about what they had just
  done; it no longer does. They are assigned, and the `api:assignee_added` entry and the live
  update are written, as before, and anyone else assigned is mailed as before. The web
  application's routes that assign do the same: `POST /api/cards/{id}/assignees` (the card
  window, and each person picked on a new card) and accepting a task request onto yourself,
  which still mails the requester (item 100). See
  [`POST /api/v1/cards/:cardId/assignees`](#post-apiv1cardscardidassignees).
- **A board's columns at one position come the older first** (card 2372). `GET
  /boards/:boardId`, `GET /boards/:boardId/columns` and `POST /boards` list a board's
  columns in order of position, ties by column id, as `GET /boards/:boardId/cards` already
  went through them (item 101). Two columns at one position (a column made with a chosen
  `position`, or a reorder that sent one twice) came in no set order, and `POST /boards`
  answered its columns in no stated order. The board page, All Tasks, the inbox, the CSV
  exports and the reports order them the same way.
- **Two webhook events are new: `milestone.card_added` and `milestone.card_removed`** (card
  2343, item 102). A card put in a milestone or taken out, by `POST` or
  `DELETE /milestones/:milestoneId/cards`, the bulk pair (one delivery for each card),
  `milestoneId` on `PUT /cards/:cardId` or the web application's milestone picker and plan
  page, is sent to the webhooks of the card's board once committed, with the body every event
  has: `data.action` `milestone_card_added` or `milestone_card_removed`, `data.detail` the
  entry's words. A card moved between milestones is one `milestone.card_added` naming the one
  it left. **A webhook with an empty `events` list is sent every event, so one made before this
  release starts receiving both**: give it the list of events wanted to receive neither. Both
  can be named in `events`. A change to the milestone itself still sends nothing. See
  [Webhooks](#webhooks).
- **A card that leaves a milestone because of another change logs `api:milestone_card_removed`
  and sends `milestone.card_removed`** (card 2381, item 103), on and to the card's board, with
  a card taken out's words and why in brackets: moved to another board out of its milestone
  (on the board it left, `… (moved to another board)`; an older milestone of neither board
  named `milestone #<id>`); each card a milestone delete
  releases (`… (milestone deleted)`); a card in a milestone deleted for good, alone (beside its
  `card.deleted`), with its column, or by an administrator's clear or purge (`… (card
  deleted)`, `data.cardId` the deleted card's id, the entry's `cardId` null); and a card on
  another board released from a milestone of a deleted board or sub-board (`… (milestone
  deleted with its board)`). Each logged and sent nothing for the milestone. A card deleted
  with its own board still sends nothing: the board's webhooks go with it. **A webhook with an
  empty `events` list receives these from this release.** See [Webhooks](#webhooks).
- **`GET /audit-log` takes a cursor, `before`** (card 2387, item 104): the `createdAt` and `id`
  of the last entry you hold, joined by a comma (`before=2026-10-21T09:00:00.000Z,1234`,
  URL-encoded), and answers the entries older than it, newest first. Paged by `offset`, each
  entry written after the first page moved every later page down by one, so the next page
  began with an entry already given; with `before` none is given twice. With `before`,
  `pagination.total` counts the entries the filters find older than it and `hasMore` says
  whether any follow the page; `offset` still applies, counted from the cursor. A `before`
  that is not a timestamp and an id (a date alone included) is `400`
  `before must be an entry's createdAt and id, as 2026-10-21T09:00:00Z,1234`. `offset` works
  as it did, and an answer without `before` is unchanged. See
  [GET /api/v1/audit-log](#get-apiv1audit-log-admin).

Three more on the same day touch no route of the API, and so not the OpenAPI document, but
reach the keys every caller uses:

- **Making a key asks for the account's password**, on My Account: see
  [Generating a Key](#generating-a-key). Keys made before are kept.
- **Setting a password can end the account's keys.** An administrator's reset and an invite
  used end every key of the account; the holder's own change ends them only if asked. A key
  that has ended is answered `401` `Invalid or expired API key`: see
  [When a Key Ends](#when-a-key-ends). Since card 2168 the webhooks the account set up go
  with its keys, switched off, and a reset or an invite pauses its report schedules; the
  board's owner or an administrator switches a webhook on again with
  `PUT /webhooks/:webhookId` and `{"active": true}`.
- **Wrong passwords at Generate Key are counted.** Ten in 15 minutes from one signed-in
  browser, counted with the Account page's email and password forms, and that browser is
  refused for up to 15 minutes, the right password included: see
  [Generating a Key](#generating-a-key).

These touch only the web application, whose routes under `/api/` the pages use, and not the
API:

- **A report is its reader's** (card 2150). `POST /api/reports`, `POST /api/reports/email`
  and every scheduled report take in only the sub-boards beneath their boards that the
  reader can open, and do not walk through one they cannot; a board whose parent the reader
  cannot open is drawn as a board of its own, the parent not named. The reader is the
  caller, the sender, or the schedule's owner as their account stands at the run; every
  recipient gets that report. The Reports page lists, for an ordinary user, each board they
  can open whose parent board they cannot.
- **The inbox gives a request's desired board only to a reader who can open it** (card
  2153). `GET /api/requests` answers `desiredBoardId`, `desiredBoardName` and
  `desiredBoardEmoji` all `null` for a board the reader cannot open, each member of an
  addressed team judged for themselves; the accept dialog then preselects no board. The
  answer to an accept or a reject, `PATCH /api/requests/{id}`, gives `desiredBoardId`
  `null` likewise.
- **Moving a card to another board says when it left its milestone** (card 2155).
  `PUT /api/cards/{id}` answers the card with `leftMilestone`, `{ "id", "name" }` of the
  milestone of the board it left that the move took it out of, and `null` otherwise; All
  Tasks says `Moved. It left milestone "M"; moving it back does not put it back in.`
- **A move to another board names neither board on the pages either** (card 2181): the
  entries above are what `GET /api/activity` gives, on a board's Activity panel and in All
  Tasks, which lists each under its own board's name; the live `update` events `moved_away`
  and `moved_in` no longer carry `toBoard` and `fromBoard`, which nothing on a page read.
- **An open board stream ends when its reader can no longer open the board** (card 2170).
  `GET /api/boards/{id}/events` asks at each heartbeat, every 30 seconds, whether the board
  is still there and the account as it is now can open it, and if not sends one last
  `update` with `{"type":"access"}` and ends; the board page re-reads and shows its refusal.
  It opens only on a board that is there: `404` `Board not found` for one that is not,
  administrators included, where an administrator was answered `200` for any id.
  `GET /api/events` keeps each board's answer until its next heartbeat, where it kept it
  30 seconds by the clock.
- **The "Unblocked" and "Plan created" mails are each drawn for their recipient** (card
  2152): finished work on a board the recipient cannot open is "A card on a board you
  cannot open", and the plan mail goes only to those who can open the plan.
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
    09:00, where any text was stored; `timeZone` a time zone name this server knows, such as
    `Europe/London`, stored as the server names it (`europe/london` is `Europe/London`), where
    an unknown name, an offset (`+01:00`, `−01:00`) or more than 64 characters is `400`
    `timeZone must be a time zone name, such as Europe/London` (card 2159); `recipients`
    addresses separated by commas, semicolons or lines, as the reports page takes them, and
    stored separated by commas, at most 2,000 characters; `statusFilter` one of its values,
    where another was stored as `all`. The answer is the schedule as it was written.
    Turning the schedule on, or a new `frequency`, `dayOfWeek`, `dayOfMonth`, `timeOfDay` or
    `timeZone`, works its next run out again from now, in its zone (cards 2144 and 2159); any
    other change leaves it. A timing the scheduler cannot date is `400`
    `The schedule was not changed: its time of day "9" is not a time from 00:00 to 23:59`, or,
    turning it on, `400`
    `This schedule cannot be turned on: its time of day "9" is not a time from 00:00 to 23:59. Turn it on with a time, day and zone that can be read, or delete it and make it again.`
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
    (`title must be at most 500 characters`, `description must be at most 50000 characters`
    and `businessValue must be at most 10000 characters`, card 2218); `priority` `low`, `medium`,
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
    `scopeId` an id; no `timeZone` is `UTC`, and a timing that cannot be dated is `400`
    `The schedule was not saved: …`. The board or the grouping is looked for, and the caller checked,
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
    (`assigneeUserId must be a user id`), where `"all"` and `''` were taken for everyone;
    `timeZone`, optional, a time zone name
    (`timeZone must be a time zone name, such as Europe/London`; card 2258, below).
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
    field of a destination is not kept, where each was stored as sent. Since card 2941 a
    `onedrive` destination also holds `drive`, whose OneDrive: a user's sign-in name, a
    user's object ID (a GUID, saved in lower case) or a drive ID (`b!` and up to 200 of
    `A-Za-z0-9_-`), trimmed; any other is `400` `destinations[0].drive must be the sign-in
    name or object ID of the user whose OneDrive holds the backups, or a drive ID beginning
    b!`. One with no `drive` is `400` `destinations[0].drive is required for OneDrive: …`,
    unless it is stored under that name with none and sent at the same place. Its
    `folderPath` is folders separated by `/`, none empty, `.` or `..`, none holding a
    control character or any of `" * : < > ? \ |`, else `400` `destinations[0].folderPath
    must be folder names separated by /, …`. A save that changes where a destination held
    for the superadmin's review sends its copies, under the same name and type, is `409`
    (card 2941, as card 2922 refuses a rename, a type change or a removal of one).
    `POST /api/admin/backup/test` reads its destination the same way, and
    `POST /api/admin/backup/gdrive/auth` its `code` and `destName` as text. Card 2251 adds
    `state`, read as text the same way (`state must be text`): the state of the consent
    address the same session's `GET` built, sent back from the whole address Google's page
    leads to. A missing, unknown, expired (ten minutes) or used one, or one another session,
    account or destination started, is `400` `This connection was not started from this
    session, or has expired or been used. Press Connect again, and paste the whole address
    Google's page leads to.`, with nothing sent to Google; the `GET` puts a PKCE
    `code_challenge` (S256) in the consent address and answers `Cache-Control: no-store`, and
    the code is exchanged with its verifier.
    Card 2250 adds an SFTP destination's `hostKey`, its server's confirmed host key: text,
    either `<type> SHA256:<43 characters>` (the type `ssh-ed25519`, `ecdsa-sha2-nistp256`,
    `ecdsa-sha2-nistp384`, `ecdsa-sha2-nistp521` or `ssh-rsa`) or the line `ssh-keygen -l`
    prints, pasted whole (`256 SHA256:… root@nas (ED25519)`; an RSA key of 1,024 bits or
    more), stored as `<type> SHA256:<43>`, and `''` for none; anything else is `400` `destinations[0].hostKey must be an SSH host key
    fingerprint with its type: the line ssh-keygen -l prints (256 SHA256:… root@nas
    (ED25519)), or the type and fingerprint (ssh-ed25519 SHA256:…), the fingerprint being
    SHA256: and 43 characters` (with no `destinations[0].` on the test route). The `GET` shows
    it as stored. Not a secret, but a save or a test that keeps a masked password or private
    key is refused `400` when it changes, empties or leaves out a stored key (`… this changes
    its host key.`); a save that adds one where none was stored keeps it, but a test keeps a
    masked secret only with exactly the stored key, none for none, so a test cannot send the
    stored secret to a key it names. A field not sent is not kept, so send it with every save
    of an SFTP destination. Without one, no backup is sent to an SFTP destination and nothing
    secret reaches it: a Test's first look connects only as far as the key the server
    presents, and sends nothing. `POST /api/admin/backup/test` of an SFTP destination answers
    `{ success, message }` as before, plus `hostKey`, the key the server presented as `<type>
    SHA256:<43>`, when none is confirmed (nothing secret is sent: the Test only looks at the
    key) or it did not match, and `confirmedHostKey`, the stored key, when a key was refused:
    both for a key that did not match, `confirmedHostKey` alone for a server that no longer
    offers a key of the confirmed type, or that shows the confirmed key but cannot sign with
    it. A refusal writes one `[ERROR] [BACKUP]` line. Every host key failure's message begins
    `SFTP host key not confirmed: ` or `SFTP host key refused: `.
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
    (`name must be at most 200 characters`, `title must be at most 200 characters`). The
    board page says that a column's rename was refused, in the server's words, and keeps
    the old title (card 2134); it showed the new title until the next load.
- **Every id in the path or the query string of those routes is read as an id**: `1.5`,
  `abc`, `0` and `1e3` are `400` `Invalid <thing> ID` (on `GET /api/audit` they were
  `Invalid boardId` and `Invalid userId` until card 2294 gave it `GET /audit-log`'s words,
  `Invalid board ID`, `Invalid user ID` and `Invalid card ID`). That is `DELETE /api/account/api-keys/{id}`, where
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
- **The link of a request nobody confirmed within seven days opens nothing** (card 2243).
  `POST /api/requests/{id}/confirm` with the right token is `404`
  `This confirmation link is not valid.` for an unconfirmed request made more than seven
  days ago, as for a wrong token, where it confirmed it, mailed the team and put it in the
  inbox. `GET /api/requests/{id}`, `GET /api/requests/{id}/messages` and a reply as the
  requester answer its link from a caller with no session `404` `Request not found`, as
  for a request that is not there, so the thread page shows the link as gone where it
  offered "Confirm it"; a signed-in account is answered `404` `Request not found` too, as
  for any unconfirmed request since card 2260 (below), where one the request is not
  addressed to was answered `403`. The request is still deleted by the form when it takes
  the next anonymous request.
- **A request nobody has confirmed is not there for the team** (card 2260). An anonymous
  request waiting for its requester to confirm it is answered `404` `Request not found` to
  every signed-in caller without its link, the user or team it is addressed to and
  administrators included: on `GET /api/requests/{id}` and `GET /api/requests/{id}/messages`,
  where they read it with the requester's address (the inbox never listed it); on
  `PATCH /api/requests/{id}` (accept and reject) and a reply from the team
  (`POST /api/requests/{id}/messages`), where both were `400` `… already resolved`; and to
  a signed-in account it is not addressed to, where it was `403`. Its own link opens it as
  before, without the address, and once confirmed it is read and answered as any pending
  request. `DELETE /api/requests/{id}` (administrators) still deletes one.
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
  mail) and a removal; `{ "type": "comment", "cardId": <the card> }` for a comment edited
  (card 2282; it was `{ "type": "card" }`), as for a comment added on either route, which
  sent none, for a comment deleted on either route, which sent none either (card 2283), and
  for an "Unblocked" notice, beside its `{ "type": "card" }`: a card window
  open on the card reads its comments again; `{ "type": "board" }` to the board, once, for an
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
    `dayOfMonth`, `timeOfDay` or `timeZone` while it is on after the change (`PUT`) takes its
    addresses from the same 100, since each can bring a send forward to any time: `429`
    `Report mail can reach at most 100 addresses a day from one account, and this schedule's 10 would make 104. The schedule was not saved. Try again in 5 hour(s).`
    (`… was not changed.` on the `PUT`), nothing saved. Otherwise a `PUT` that changes
    `recipients` takes the addresses the new list adds, those not in the stored list (one
    address changed to ten takes nine), refused in the same way with
    `this schedule's 9 new addresses would make 109`; the stored list sent back in another
    order or case, or cut down, a change of name or filter, re-timing one that stays off,
    and turning one off take nothing; a delete gives nothing back; a scheduled run takes nothing. The day is 24 hours
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
- **The two password answers say what was switched off and paused** (card 2168).
  `PUT /api/users/{id}/password`, an administrator's reset, answers `{ success,
  sessionsEnded, apiKeysEnded, webhooksSwitchedOff, reportSchedulesPaused }`, where it
  answered the first three: every webhook the account set that was on is switched off, and
  every report schedule of it that was on is paused, in the transaction that sets the
  password. `PUT /api/account/password`, the holder's own change, answers `{ success,
  apiKeysEnded, webhooksSwitchedOff }`: with `endApiKeys: true` the webhooks the account set
  are switched off with its keys, and its report schedules are left on (since card 2894 they
  are always paused, and the answer adds `reportSchedulesPaused`). Both counts are `0`
  where there was nothing to switch off. An invite used switches off and pauses as a reset
  does.
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
  board. Nothing moves and nothing is sent. The board page's drop sends every card that is
  not archived of the column dropped into and of the column the card came from, and moves
  one (card 2213: it
  sent every card of the board, twice); only a bulk move of more than 100 selected cards
  meets the cap, and
  the page now says so in an error toast and keeps the selection
  (`No answer from the server. The cards may not have been moved.` when there is none),
  where it read no answer. So one request sends at most 100 deliveries to each webhook of
  the board.

- **`GET /api/audit` and `GET /api/logs` read `from` and `to` as `GET /audit-log` does**
  (card 2095): ISO 8601, `YYYY-MM-DD HH:MM:SS` in UTC, or a date, a date alone as `to`
  being the whole of that day, and anything else `400` `from is not a date` or
  `to is not a date`, where each was compared as text, unchecked. The Audit page sends the
  last day of its range as the date chosen.
- **`GET /api/audit` and `GET /api/logs` refuse a `from` after its `to`** (card 2262), as
  `GET /audit-log` does: `400` `` `from` is after `to` ``, where each answered `200` with an
  empty page. Equal bounds name one second and are allowed. The Audit page says the
  refusal, and any other failure, under its filters in the server's words
  (`No answer from the server. The audit log was not read.` when there is none). A failed
  Apply empties the list, where it said "No audit entries match these filters." or kept the
  rows of the search before; a failed Load more keeps the rows already shown. An answer to
  an earlier Apply that comes after a newer one's is not shown.
- **`POST /api/account/api-keys` reads `expiresAt` in the same forms** (card 2095),
  `YYYY-MM-DD HH:MM:SS` included, and stores and answers it as `YYYY-MM-DD HH:MM:SS` in UTC,
  where it answered ISO 8601. A date is 00:00 UTC that day, as before; `null` is no expiry;
  anything that is not text is `400`.
- **`POST /api/reports` and `POST /api/reports/email` read `periodStart` and `periodEnd` in
  the same forms** (card 2095), a date alone as `periodEnd` being the whole of that day. The
  Reports page sends a custom range as the dates chosen, so a report from 1 to 14 October
  includes the 14th, where the page sent the end as midnight at its start and the 14th was
  left out.
- **The web application's routes, its pages and the two CSV exports keep
  `YYYY-MM-DD HH:MM:SS` in UTC** (card 2095), the form every timestamp is stored in. Fields
  they answered in ISO 8601 (`completedAt`, `archivedAt`, `updatedAt` after an edit,
  `resolvedAt`, a key's `lastUsedAt` and `expiresAt`, a schedule's `lastRunAt` and
  `nextRunAt`, a log line's `timestamp`) are in that form now, and so is the CSVs'
  "Completed" column, which a spreadsheet opens as a date and time. The pages read every
  one as UTC.
- **`POST /api/reports` and `POST /api/reports/email` take an optional `timeZone`**
  (card 2258): an IANA name, read as a report schedule's `timeZone` is (`europe/london` is
  `Europe/London`) and refused in its words, `400`
  `timeZone must be a time zone name, such as Europe/London`. It is the zone whose day the
  report's Overdue figure counts from: an open card due before that day. Without one the
  day is UTC, so a call that sends none gets the report it got before. The Reports page
  sends the browser's zone. The PDF of a report made by hand prints its period, generated
  date and completion dates in UTC whatever is sent; a scheduled report's PDF prints them
  in its schedule's zone, as its mail writes its period, and counts Overdue from that
  zone's day. A Due Date is printed as the day stored. The dashboard counts its overdue,
  due-soon and Upcoming Deadlines figures in the browser, in the viewer's own day; its page
  data carries the cards due from yesterday (on the UTC day) onward, a count
  (`longOverdue`) of those due earlier (overdue in every zone), and the moment it was
  read, where it carried the three
  figures, counted on the UTC day. No `/api/v1` operation changes.
- **`GET /api/boards/{id}/contents` is new** (card 2280): everything the board page draws,
  for the page to refresh itself with instead of re-running its whole load. It is the page
  load's own reader, so it answers what the load answers, for the caller as they may see it:
  the board row, the breadcrumbs, the caller's `canEdit`, `canManage` and `userBoardRole`,
  the linkable boards, the columns with their cards, the categories, labels, members,
  blocked state, token totals and goals. It refuses as the load does: `401`
  `Not authenticated`, `400` for an id that is not one, `404` `Board not found` for a board
  that is not there (administrators included), then `403`
  `You do not have access to this board`. A `200` carries
  `cache-control: private, no-store`. It is the pages' route, not under `/api/v1/` and not
  in the OpenAPI document; a script reads a board with `GET /api/v1/boards/:boardId` and
  `GET /api/v1/boards/:boardId/cards`.
- **A team keeps at least one owner** (card 2373). `POST /api/teams/{id}/members/{userId}`
  that would make the team's last owner anything but an owner, and
  `DELETE /api/teams/{id}/members/{userId}` of the last owner, are `409`
  `A team needs at least one owner. Make someone else an owner first, or delete the team.`,
  with nothing changed, for an administrator too. Either could leave a team that only an
  administrator could run. With another owner, or for a member of a team that already has
  no owner, they answer as before. A caller who may not manage the team is `403` first, as
  before, and is not told whether it has another owner. No `/api/v1` operation changes: v1
  has no team routes.
- **A team member sent with no `role` keeps the role they hold** (card 2378),
  `POST /api/teams/{id}/members/{userId}`. A body with no `role` set someone already in the
  team to `member`, so an owner sent `{}` was made a member wherever the team had another
  owner (and the last owner was refused `409`). Now it keeps their role; someone not yet in
  the team is added as `member`, `201`, as before. An existing member sent no role, or the
  role they hold, is answered `200 { success: true, action: "updated" }`, as a change is, and
  nothing is written (card 2183's rule). Both team pages always send a role.
- **An account that is the only owner of a team is not deleted** (card 2377),
  `DELETE /api/users/{id}`: `409`
  `This account is the only owner of: Alpha, Beta. Make someone else an owner or delete those teams first.`
  (`… delete that team first.` for one), naming each team in name order, with nothing
  changed. The delete took the account's team memberships with it, so each team it alone
  owned was left with no owner. A team it owns with another owner, or is only a member of,
  does not stop it. Who may delete the account is asked first, as before (`403`, `400` for
  yourself, `404`), so a caller who may not is not told its teams. No `/api/v1` operation
  changes: v1 deletes no user.
- **The board's CSV export names the file of a board with no columns as it names any
  other** (card 2371), `GET /api/boards/{id}/export/csv`: `<name>-<YYYY-MM-DD>.csv` with
  every character but letters, digits, `-` and `_` made `_`. It put the board's name in the
  header as it was, `<name>-export.csv`, so a name with an emoji or another character
  outside Latin-1 was a `500` and a double quote cut the file name short.
- **`GET /api/audit`, the Audit page's log, is read by the same code as `GET /audit-log`**
  (card 2294): `queryAuditLog` in `src/lib/server/audit-log.ts`. The two had come apart in
  seven ways, each now settled. `GET /audit-log` answers exactly as it did. `GET /api/audit`
  now takes `cardId`; refuses an id in `GET /audit-log`'s words, `Invalid board ID`,
  `Invalid user ID` and `Invalid card ID`, where it said `Invalid boardId` and
  `Invalid userId`; gives each row `rawAction` (the stored spelling) and a `source` of `ui` or
  `api` read as `GET /audit-log` reads it (older rows answered `null`); answers
  `GET /audit-log`'s `pagination`, with `total`, `hasMore`, `defaultLimit` and `maxLimit`; and
  reads the board names of a page in one query, where it asked once for each board. Its rows
  keep `action` as stored (`api:card_moved`), which the page shows, and an `api:` in front of
  its action filter still means done through the API, where `GET /audit-log`, whose actions
  are canonical, reads it as a spelling. Its times stay in the stored form.
- **`GET /api/boards/{id}/share` tells the board's owner and an administrator about the
  board's webhooks** (card 2329), for the Share window: each member and each team carries
  `stopsWebhooks`, how many of the board's webhooks that are sent now that share's removal
  would hold (its setter could open the board no other way: their own share as a member, for a
  team's removal, another team, the board being public, having made it, an administrator's
  role), and the answer carries `heldWebhooks`, how
  many are on and held now (a setter who can no longer open the board, or none recorded; see
  `pausedBecause`). Both are worked out at the read (`webhookShareNotes` in
  `src/lib/server/webhooks.ts`, from `holdOf` and `roleOnBoard` with the share left out) and
  never stored. Anyone else is answered as before, with neither key. The Share window asks
  before a removal above 0 and shows the held count. No `/api/v1` operation changes.
- **`GET /api/boards/{id}/share` also gives the board's owner and an administrator
  `privateStopsWebhooks`** (card 2385): on a public board, how many of its webhooks that are
  sent now would be held once it is private, those whose setter opens it only because it is
  public; 0 on a private board. `webhookShareNotes` asks `roleOnBoard` with the board handed
  in as private; never stored, and anyone else is answered no such key. The Share window asks
  before a switch to private above 0, and reads the list again after either switch. No
  `/api/v1` operation changes.
- **`GET /api/audit` takes `before`, as `GET /audit-log` does** (card 2387): the last entry
  held, `<createdAt>,<id>` in the stored form this route answers
  (`before=2026-10-21 09:00:00,1234`) or ISO 8601, refused in the same words. The Audit
  page's **Load more** sends it, and no `offset`, so an entry written while the page is read
  no longer repeats a row.
- **`POST /api/cards` makes a card with its subtasks, labels, assignees and sub-boards in one
  request** (card 2296), for the board's New Task window, which sent each in a request of its
  own after the card, so a refusal or a lost answer left half a card. Four optional lists:
  `subtasks`, objects as `POST /api/subtasks` takes them; `labelIds` and `assigneeIds`, ids,
  each taken once; and `subBoards`, objects as `POST /api/boards` takes them, under the new
  card whatever `parentCardId` they hold. Each is a list of at most 100 entries, read with the
  card's fields (`subtasks must have at most 100 entries`, `subBoards[1] must be an object`,
  `assigneeIds[0] must be an id`). Each part is then written in the card's transaction, in
  that order, by the service its own route calls (`createSubtask`, `toggleCardLabel`,
  `assignToCard`, `createBoard`) with that route's options: the same checks, entries, live
  events and mail (nobody mailed about assigning themselves, card 2286), sent after the one
  commit in the order they were before. Any refusal refuses the whole request with the part's
  status and words, its entry named first (`400` `subtasks[1]: title is required`, `404`
  `labelIds[0]: Label not found`, `400` `assigneeIds[0]: User does not have access to this
  board`, `409` `subBoards[0]: Sub-boards can be nested at most 20 levels deep, …`); no card
  is made and nothing is sent. The entry is named by its place in the list as sent, a
  repeated id counted (in `labelIds: [4, 4, 999999]` the label not found is `labelIds[2]`).
  The cap is per list, so one request can hold up to 400 parts. The New Task window names
  the part as it shows it (`"bob" could not be assigned: User does not have access to this
  board`). `POST /api/v1/boards/:boardId/cards` is unchanged and ignores
  the four lists (its twins' options differ part by part); no `/api/v1` operation changes.
- **The mail and backup settings are every administrator's** (card 2395), where they were the
  superadmin's alone: `GET`, `PUT` and `POST /api/admin/smtp` (the mail settings, the App URL
  and the test mail), `GET`, `PUT` and `POST /api/admin/backup`, `POST
  /api/admin/backup/test`, and `GET` and `POST /api/admin/backup/gdrive/auth`. An
  administrator is answered as the superadmin is; anybody else is `403` `Forbidden`, where it
  was `403` `This belongs to the superadmin. …`, and a request with no session that reaches
  the handler is `403` where it was `401` (the gate answers it `401` first). An administrator
  made an ordinary user while a request is on its way is refused at its save or before it
  sends, as the superadmin made an administrator was. `GET /api/admin/export`, `POST
  /api/admin/import` and `POST /api/admin/reset` are still the superadmin's, and their `403`
  now reads `This belongs to the superadmin. Exporting, importing and resetting the database
  can be used by the superadmin account only`. Three messages that said the superadmin sets
  the mail up say an administrator does: `POST /api/reports/email`'s `503` (`… An
  administrator sets it up on the admin page.`), the refusal of an invite or a link when no
  address is configured (`An administrator sets it as the App URL …`), and the mail-password
  problem (`… an administrator enters it under 📧 Email / SMTP`). No `/api/v1` operation
  changes.
- **Fewer backups are the superadmin's, and settings go with their setter** (cards 2398 and
  2397, migration 0059). `PUT /api/admin/backup` is `403` for anyone but the superadmin where
  the save lowers `retention`, removes a destination (by name and type, so a rename is the old
  one removed) or sets `schedule` to `disabled` where it ran, and since card 2408 where it sets
  `notifyOnFailure` from `true` to `false` or changes who `notifyEmail` sends to (compared as a
  set of addresses, ASCII capitals alone lower-cased; switching the failure mail on stays
  every administrator's):
  `Lowering Keep Last, removing a destination, switching the schedule or the failure mail off,
  or changing who receives the failure mail needs the superadmin. This save would …`, naming
  what it would do, with nothing written. Who moved the mail settings (`host`, `port`,
  `user`, `allowInsecure`) to where they are, set the App URL to its address, and added each
  destination, pointed it where it is or connected it is recorded, by place, so a setting
  changed and changed back is its first setter's again (a sender's name or address, a secret
  typed again for the same place, an App URL cleared or a host key confirmed records nobody);
  demoting that account to user with `PUT /api/users/{id}`, or deleting it with `DELETE
  /api/users/{id}`, removes what is still where it set it in the same transaction, and the
  answer then has `settingsRemoved: { mail, appUrl, destinations }` (`DELETE` answers
  `{ success: true, settingsRemoved }`); an answer that removed nothing has no such field and
  is as before. A new `GET /api/users/{id}`, an administrator's, answers `{ id, settingsSet }`:
  what such a change or delete would remove now, in the same shape, or `null` for nothing, for
  the caller's own account and for any the caller may not manage; `404` for no such account.
  The admin page reads it just before it asks. No `/api/v1` operation changes.

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
  resource is looked for and the caller checked first, `404` (for one on a board they cannot
  open too, card 2719) then `403`, and what the fields
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
| `DELETE /api/v1/cards/:cardId` | Nothing. The card is archived: `archivedAt` is set and one `card_archived` entry is written (`card_discarded`, with `discardedAt`, for an option; `card_abandoned` for unfinished committed work: milestone 22). A card already archived is left as it is, with no entry | Everything: subtasks, comments, attachments, dependency links, sub-boards. Restoring the card brings it back whole |
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
| Archive | `card_archived`, only when the card was not already archived (since 2026-10-14). Since milestone 22 (card 2461), from an upstream column (a board's Options column, any column of an ideas board) `card_discarded` instead, with `discardedAt`/`discardedBy` set; from a committed column that is not Complete `card_abandoned` instead | None; `card.discarded` for a discard |
| Restore (`PUT /api/v1/cards/:cardId` with `archivedAt: null`) | `card_restored`, with the card's title, only when the card was archived (since 2026-10-14); `"<title>": back in <column>` for a discard, whose `discardedAt`/`discardedBy` are cleared | None |
| Card, permanent | `card_deleted`, with `cardId` null because the card is gone; then `milestone_card_removed` for a card in a milestone (since 2026-10-21). A live card in an upstream column writes `card_discarded` first, also with `cardId` null (card 2461); an archived card never does | `card.deleted`, once, for the card asked for, and `milestone.card_removed` for a card in a milestone (since 2026-10-21); `card.discarded` before `card.deleted` for an option. Cards on sub-boards under it go with it and get no `card.deleted` of their own |
| Column | `column_deleted`, once for the column. Its detail names the column and how many cards went with it. Then `milestone_card_removed` for each card that was in a milestone (since 2026-10-21) | None for the column, and no `card.deleted`; `milestone.card_removed` for each card that was in a milestone (since 2026-10-21) |
| Board | None on the board: its own log is deleted with it. A card on another board released from one of its milestones writes `milestone_card_removed` on its own board (since 2026-10-21) | None from the board, whose webhooks go with it; `milestone.card_removed` to the board of each card released elsewhere (since 2026-10-21) |
| Milestone | `milestone_deleted` on each of its boards, then `milestone_card_removed` for each card it released (since 2026-10-21) | `milestone.card_removed` for each card it released (since 2026-10-21) |
| Subtask | `subtask_deleted`, on its card, naming the subtask (since 2026-10-14: there was none) | None |

The milestone entries and events are card 2381's (see [Webhooks](#webhooks)): a card that leaves
a milestone because of another change is recorded as a card taken out, on its board, while that
board is still there.

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
        ConvertBoard["POST /boards/:id/convert"]
        Upstream["GET /boards/:id/upstream"]
        DeleteBoard["DELETE /boards/:id"]
    end

    subgraph Columns["Columns"]
        UpdateColumn["PUT /columns/:id"]
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
        SendCard["POST /cards/:id/send"]
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

    subgraph Attachments["Attachments"]
        ListAttachments["GET /cards/:id/attachments"]
        UploadImage["POST /cards/:id/attachments (image body)"]
        GetAttachment["GET /cards/:id/attachments/:attachmentId"]
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

    subgraph People["People and Groups (admin)"]
        ListPeople["GET /people"]
        UpdatePerson["PATCH /people/:personId"]
        ListGroups["GET, POST /people-groups"]
        UpdateGroup["PATCH /people-groups/:groupId"]
        GroupMembers["PUT /people-groups/:groupId/members"]
    end

    subgraph Decisions["Decisions"]
        Register["GET /decisions"]
        Draft["POST /boards/:id/decisions"]
        Decision["GET, PATCH, DELETE /decisions/:id"]
        Lifecycle["PUT …/decider, …/participants<br/>POST …/extend, …/withdraw, …/supersede"]
        Questions["GET, POST …/questions<br/>POST …/questions/:questionId/answer"]
        Results["GET …/summary, …/record"]
        Links["PUT, DELETE …/cards/:cardId"]
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
| `from`, `to` | last 30 days | Each a date (`2026-10-14`), a timestamp in ISO 8601, or `YYYY-MM-DD HH:MM:SS` in UTC ([Timestamps](#timestamps)); anything else is `400` `from is not a date`. Bare dates are whole days; `to` is inclusive. A timestamp with an offset, or with no zone, is read in UTC. `from` after `to` is `400`. `period.from` and `period.to` are answered in ISO 8601. |
| `boardIds` | all visible | Comma-separated ids; one that is not a whole number of 1 or more is `400` `boardIds must be a comma-separated list of ids`. Each is then checked in the order given, administrators included, as `GET /api/v1/burndown` checks one: a board that does not exist is `404` `Board 7 not found`, and so is one you cannot open, in the same words (card 2719, since 1.10.0; it was `403` `No access to board 7`, and until card 2326 both were `200`). |
| `include` | — | `subtasks`, `comments` |
| `commentLimit` | 3 (max 20) | Most recent comments per card: a whole number, 0 or more. `0` gives each card an empty `comments` list, more than 20 is read as 20, and a negative number or a fraction is `400` `commentLimit must be a whole number of 0 or more`. |

Cards are grouped by board and bucketed `completed`, `closed`, `progressed`,
`on hold`, `created`. **Completion is decided by each card's `completedAt`, never
by audit events**, so a window predating the audit-completeness work still
reports correctly.

A card's `milestoneName` is `null` when it is in no milestone or in one the key's user
cannot open, and `milestones` lists only the milestones they can open (card 2257); a card's
`milestoneId` is given either way. A milestone's counts are of its cards on boards the key's
user can open, as its burndown counts them (card 2326).

Options are no work in the report (milestone 22, card 2462): a card in a board's Options column
or on an ideas board is in no bucket and no total. A card is `created` when it was raised in
the window, its `updatedAt` is still its `createdAt`, and no move of it is recorded in the
activity log (card 2480; until then the `created` bucket's "never moved" read the board's first
column that is not an Options column). A card raised before 2026-10-01, when the board's drag
route recorded no move, must also still be in that first column. `upstream` gives the boards'
upstream figures for the window, as `GET /api/v1/boards/:boardId/upstream` gives one board's
(without `committedAll`), and is `null` for a report on one user.

Only the boards the key's user can open are read (card 2326). `meta` carries the
caveats that make a figure quotable — `closeReasonAssumedCount`,
`completedOutsideWindow`, `missingSummaryCount`, `attribution`. Read it before
quoting a headline number. `meta.boardsExcludedForAccess` is always `0` and marked
deprecated: it counted the boards with activity that were left out, which told a
reader when a board they could not open was worked on. It stays in the answer
because the schema requires it.

Full design rationale: [Management Activity Reporting](management-reporting.md).

### `GET /api/v1/burndown`

How much work was open on each UTC day, and where it is heading, for any slice
of the workspace. Rebuilt from each card's created, completed and archived dates
rather than daily snapshots, so every filter works over any window up to 730
days. Committed work only (milestone 22, card 2462): an option, in a board's Options column
or on an ideas board, is not charted, and a card's scope starts at its `committedAt`, its
creation for a card made before 2026-10-26. Each card is charted as it is now, so a card
returned to options leaves the past days' scope too.

| Param | Default | Meaning |
|---|---|---|
| `boardIds` | — | Comma-separated; view access to each is required. One you cannot open is `404` `Board 7 not found`, as one that does not exist (card 2719; it was `403` `No access to board 7`). |
| `boardCategoryId` | — | Every board in the group that you can see. Not with `boardIds`. A group that holds boards, none of which you can open, is `404` `Board category 3 not found`, as one that does not exist (card 2719; `403` from 2026-10-14, and before that it was charted empty under its name). |
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

Params: `boardId`, `userId`, `cardId`, `action`, `source` (`ui` | `api` | `system`), `from`,
`to`, `limit` (default **100**, max **500**), `offset`, `before`. Any other `source` is `400`
`source must be "ui", "api" or "system"`.

`boardId`, `userId` and `cardId` are ids, read as an id in the path is: one that is not a
whole number of 1 or more is `400` `Invalid board ID` (`Invalid user ID`,
`Invalid card ID`). `limit` and `offset` are never refused: each is rounded down, `limit`
is held between 1 and 500 and `offset` is 0 or more, and text that is not a number is the
default, as `limit=0` is. `limit=-1` is one entry, where it was every entry.

UI and API actions share one vocabulary. `action` comes back canonical (no `api:`
prefix) so one filter matches both sources; `rawAction` keeps the stored
spelling; `source` says which. A completion is logged as `card_completed`
whichever route performed it.

**`source` `system`** (since 1.7.0, card 2754) is an entry DumpFire wrote itself, which no
person made: `userId` is `null` and `userName` is `DumpFire`. The one such action is
`attachment_expired`, `Moved "<file name>" on "<card>" to the trash: the card was closed more
than N days ago`, written by [image retention](backup-reporting.md#image-retention). It is
stored bare, with no `api:`, so `?source=ui` leaves it out by the `source` column and
`?source=system` finds it. `attachment_added` is written by both trees now: `ui` from the
card window, `api:attachment_added` from the v1 image upload.

Since 2026-10-26 (milestone 22) the vocabulary has seven more actions: `card_committed`,
`card_returned_to_options`, `card_discarded`, `card_abandoned`, `card_sent`,
`column_converted_to_options` (which nothing writes now: the column conversion it recorded went
before release, card 2527) and `board_converted_to_ideas`. **`card_archived` is written only
for a card archived from a Complete column**: unfinished committed work archived is
`card_abandoned`, and an option `card_discarded`, so `action=card_archived` alone misses both. A
commitment is `card_committed`, not `card_moved`, and an option leaving its board `card_sent`,
not `card_moved_away`. Entries written before keep their actions.

**Decision records** (cards 2675 to 2680, carried by card 2682, and card 2687) write thirteen
actions, each only for a decision that has been opened, on its board, its detail the title and
the step, never a count, a name or a reason: `decision_opened`, `decision_republished`,
`decision_closed`, `decision_extended`, `decision_withdrawn`, `decision_deleted`,
`decision_ruled`, `decision_superseded` and `decision_results_released`; on the board of the card
linked, naming no decision, `decision_card_linked`, `decision_card_unlinked` and
`decision_card_link_deleted`; and, since `1.15.0` (card 2687), `decision_card_relation_changed`
on the decision's board, naming no card, detail "a card", where a link's relation is changed
(none where the decision's board is deleted). `decision_opened`, `decision_ruled`,
`decision_withdrawn` and `decision_superseded` send their named-only decision events (card 2689);
the rest send none. Through a key (card 2682)
only Extend and the card links write one, stored as `api:decision_extended`,
`api:decision_card_linked`, `api:decision_card_unlinked` and `api:decision_card_relation_changed`
and given here canonical, with `source` `api`; drafting, editing, a draft's withdrawal and
delete, questions and answers write none.

In the `action` filter only a trailing `*` is a wildcard: `card_*` finds `card_moved`,
`card_completed` and the rest, and not `cards_purged` or `cards_cleared`. A `%` or a `_`
in it is matched as itself. Until 2026-10-14 the `_` of a prefix was read as any one
character, and `card_*` found those two as well. An `api:` in front of the action is read
as part of its spelling, so `api:card_completed` asks what `card_completed` asks: filter
by `source=api` for what was done through the API.

`from` and `to` are read as [Timestamps](#timestamps) says: ISO 8601, `YYYY-MM-DD HH:MM:SS`
in UTC, or a date, a date alone as `to` being the whole of that day; anything else is `400`
`from is not a date` or `to is not a date`. Until 2026-10-14 they were compared with the
stored time as text, unchecked, and a date alone as `to` left that day out. A `from` after
its `to` is `400` `` `from` is after `to` ``, as the activity report answers; equal bounds
name one second. Until 2026-10-14 a reversed pair was `200` with an empty page (card 2217).

Entries come newest first, and by id within a second, newest first, so paging with
`offset` neither repeats nor skips an entry of the second a page ends in (card 2217).

`pagination` carries `total` and `hasMore` — check it, because a full default
page of 100 used to be indistinguishable from a complete result.

**Page with `before`** (card 2387, item 104): the `createdAt` and `id` of the last entry you
hold, joined by a comma, `before=2026-10-21T09:00:00.000Z,1234` (URL-encoded). The page is
the entries older than it, so an entry written while you page is never given twice; by
`offset`, each one written after the first page moved every later page down by one, and the
next page began with an entry already given. The cursor is one more filter: with it `total`
counts the entries the filters find older than it, `hasMore` says whether any follow this
page, and `offset`, if sent, counts from it. The time is read as `from` is, but a date alone
names no entry; anything else is `400`
`before must be an entry's createdAt and id, as 2026-10-21T09:00:00Z,1234`. The query is a
keyset on (`createdAt` DESC, `id` DESC), written as the row value
`(created_at, id) < (?, ?)`, which SQLite answers from `idx_activity_log_created_at` (and
the board's and the person's indexes), each of which ends in the id; no index was added.

```mermaid
sequenceDiagram
    participant C as Caller
    participant V as GET /api/v1/audit-log
    C->>V: ?limit=100
    V-->>C: entries 1–100, hasMore true
    Note over V: new entries are written
    C->>V: ?limit=100&before=<entry 100's createdAt>,<its id>
    V-->>C: the 100 entries older than entry 100, none repeated
```

The web application's `GET /api/audit` reads the log through the same code (card 2294), and
answers as this does, but for its actions, which it gives as stored (`api:card_moved`), an
`api:` in front of its action filter meaning done through the API, and its times, in the
stored form.

```mermaid
flowchart LR
    P["Audit page"] --> I["GET /api/audit"]
    X["integration"] --> V["GET /api/v1/audit-log"]
    I -->|"readAuditParams<br/>canonical: false"| Q["queryAuditLog"]
    V -->|"readAuditParams<br/>canonical: true"| Q
    Q --> L[("activity_log, then<br/>one boards read and a COUNT")]
```

### `GET /api/v1/cards/:cardId/board-history`

Which board a card was on, and when — spans oldest first, `to: null` on the
current one. Needed because a card that changes board mid-window appears in the
audit log under two different `boardId`s. A card whose creation was never recorded
begins on the board its first move left, from its `createdAt` (card 2199). A board
the caller cannot open keeps its dates, its `boardId` is `null`, `withheld` is `true`, and its
`boardName` is `Board not visible to you` (card 2719's code review, CS2; until 1.10.0 its id
was given). `withheld` is given only on such a span.

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
  "avgLeadTimeDays": 4.2,
  "streak": 2,
  "activeCards": 5,
  "recentActivity": [
    { "id": 9120, "action": "api:card_updated",
      "detail": "Updated fields: priority on \"Deploy v2.1\"",
      "boardId": 1, "createdAt": "2026-10-13T09:41:07.000Z" }
  ]
}
```

| Field | Meaning |
|-------|---------|
| `cardsCompleted` | Completions the activity log records as this user's, made in the web UI or through the API, on any board: in all, in the last 7 days and in the last 30. A record of what the user did: a card archived afterwards still counts, here and in `streak` |
| `avgLeadTimeDays` | Average lead time, commitment to done (since 2026-10-26, card 2464): mean days from a card's `committedAt` to its completion, to one decimal place, over the completed cards the user is assigned to on boards they can open. Options are never among them, nor archived cards (since 2026-10-27, card 2541), as in the board metrics. `null` when there is none, and `0` when they were completed as they were committed. For a card made before 2026-10-26 the commitment is its creation. Complete is the delivery point, so the customer's lead time and the system's are the same here |
| `avgCycleTimeDays` | Average lead time, commitment to done; named cycle time for history. The same value as `avgLeadTimeDays`, kept so that nothing that reads it breaks. Until 2026-10-26 it was described as from creation to completion, the same figure for every card made before then |
| `streak` | Consecutive UTC days with at least one completion, counted back from today, or from yesterday if there is none today |
| `activeCards` | Cards the user is assigned to that are neither completed nor archived, on boards they can open. An option, a card in a board's Options column or on an ideas board, is not counted: it is not open work |
| `recentActivity` | The user's last 20 activity entries on boards they can open, newest first: an entry on a board they have been taken off is left out. `action` is as stored: one made through the API has the prefix `api:` |

---

### Boards

#### `GET /api/v1/boards`

List all boards accessible to your API key, newest first. Each board carries `kind`,
`"delivery"` or `"ideas"`, and `productOwnerUserId`, the board's Product Owner or `null`
(since 2026-11-03, card 2673).

| Parameter | Type | Description |
|-----------|------|-------------|
| `kind` | string | `delivery` or `ideas` (since 2026-10-26, card 2464): only the boards of that kind, `delivery` being every board that is not an ideas board. Not sent, or empty, every board. Anything else is `400` `kind must be "delivery" or "ideas", not "backlog"`, quoting what was sent (cut short past 60 characters). It filters the list the key's user is already given, so it never lists a board they cannot open |

#### `GET /api/v1/boards/:boardId`

Get a single board with its columns. A board that does not exist is `404`
`Board not found` to everyone, and so is one that is there and the key's user cannot open, in
the same words (card 2719, since 1.10.0; it was `403`). A `403` is for a board they can open
where their role does not allow the operation. Every operation under `/boards/:boardId`
answers so.

#### `POST /api/v1/boards`

Create a new board. Default columns (Options, To Do, On Hold, In Progress, Complete) are created automatically, the Options column first: every delivery board has it, and keeps it (card 2527). An ideas board's are New Ideas, Shaping and Ready for Replenishment.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | ✅ | Board name, trimmed, 1 to 200 characters |
| `emoji` | string | | Board icon, 1 to 32 characters (default: 📋) |
| `parentCardId` | number or null | | Link as sub-board to a card, by its id. Needs edit access to the board that card is on: `404` `Parent card not found` if there is no such card, or it is on a board the caller cannot open (card 2719), `403` if they can open its board and cannot edit it. `409` `Sub-boards can be nested at most 20 levels deep, and a board under this card would be deeper.` if that board is already 20 levels below a board that is not a sub-board, or is in or below a loop, and nothing is created (card 2172) |
| `categoryId` | number or null | | The dashboard grouping to file the new board under, or `null` for none, as the web application's create takes it (card 2287). `404` `Board category not found` for one that does not exist, and for one that holds boards, none of which the caller can open, alike (card 2719; it was `403` `No access to this board category`), and `400` `categoryId must be an id` for a value that is not an id; nothing is created. Until 2026-10-14 it was ignored and the board made unfiled |
| `kind` | string | | `"delivery"` (the default) or `"ideas"` (milestone 22, card 2463): an ideas board, every column of which is upstream, its cards options sent on to delivery boards. `400` `kind must be "delivery" or "ideas", not "portfolio"` for anything else. `409` `A sub-board is a delivery board.` for `"ideas"` with a `parentCardId`; and with any kind, `409` for a `parentCardId` naming an option (`An idea has no sub-boards; send it to a delivery board first.`, or `An option has no sub-boards; commit it first, by moving it out of the Options column.`) |

A new board has nothing to look for, so its fields are read first, and the parent card and
the grouping are looked for after. A new board is private: `isPublic` is not read here, and
its owner sets it with `PUT /api/v1/boards/:boardId`.

A sub-board sends a live update, `{ "type": "board", "action": "created" }`, to the pages
open on the board its card is on, so it shows on the card without a reload (card 2143). A
board made at the top level sends none.

#### `PUT /api/v1/boards/:boardId`

Update the fields sent, at least one of them. Answers the board.

| Field | Type | Who may send it | Description |
|-------|------|-----------------|-------------|
| `name` | string | Anyone with edit access to the board | Board name, trimmed, 1 to 200 characters |
| `emoji` | string | Anyone with edit access to the board | Board icon, 1 to 32 characters |
| `categoryId` | number or null | Anyone with edit access to the board | The dashboard grouping the board is filed under, or `null` for none. One that does not exist is `404` `Board category not found`. Deleting the grouping sets it to `null` (card 2293) |
| `isPublic` | boolean | The board's owner, or an administrator | Whether everyone who is signed in can view the board |
| `kind` | string | The board's owner, or an administrator, when it changes | `"delivery"` or `"ideas"` (milestone 22, card 2463), read with the board's own as the default, so a body without it, or with the kind it has, is any editor's. An **empty** board, no card live or archived, is switched, its columns replaced with the other kind's defaults in the same transaction, `api:board_updated` reading `Updated board "<name>" (fields: kind): now an ideas board; its columns To Do, On Hold, In Progress, Complete were replaced with New Ideas, Shaping, Ready for Replenishment` (or the delivery form). `409` for a sub-board made an ideas board (`A sub-board is a delivery board.`); for a board holding cards made an ideas board, naming the conversion (`POST /api/v1/boards/:boardId/convert`); and for an ideas board holding cards made a delivery board (`… move them to a delivery board, or delete them, first.`) |
| `productOwnerUserId` | number or null | The board's owner, or an administrator, when it changes | The board's Product Owner, the default decider of its decisions (card 2673): the id of a user who can edit the board, or `null` for none. Read with the board's own as the default, so a body without it, or with the value it has, is any editor's, even when that user can no longer edit the board. `403` `Only the board's owner or an administrator can change its Product Owner` for anyone else's change; `400` `productOwnerUserId 99 is not an account` for a user that does not exist, `400` `productOwnerUserId 7 cannot edit this board: a board's Product Owner must be an account that can edit it` for one who cannot edit it, a reader of a public board included, and `400` `productOwnerUserId must be an id` for a value that is not an id |

The board is looked for and the caller checked first (`404`, then `403`), then the fields
are read. A value the board already holds, sent back unchanged, is accepted as it is.

Only the fields whose value changes are written, logged and told (card 2345). A body whose
every field is as the board holds it, a name that trims to the stored one included, is
answered `200` with the board as it is: `updatedAt` is not moved, no `api:board_updated` is
logged and no live update is sent. A body that changes some fields writes them, moves
`updatedAt`, and logs `Updated board "<name>" (fields: name)` naming only those. A request
that would be refused is refused first, as below, whatever it would have changed.

`isPublic` decides who can see the board, as sharing it does, and is the owner's to decide.
Sent by an editor who is not the owner, the whole request is answered `403` with
`Only board owners and admins can change visibility`, and none of its fields is saved, the
name that came with it included, whatever value was sent. An editor leaves `isPublic` out.
From the owner or an administrator it is `true` or `false`: anything else, `null`, `1`
and `"true"` among them, is answered `400` with `isPublic must be true or false` and
nothing is saved.

This operation takes no `parentCardId`. A board is put under a card, or taken out from
under one, on the board page, by the board's owner or an administrator: see
[Changes on 2026-10-14](#changes-on-2026-10-14). The card the board hangs under, or `null`
for a board on the dashboard, is accepted as it is, written as a number or as text, so a
board read with `GET` can be sent back whole (an editor leaves `isPublic` out); it does not
count as a field to update. Any
other is `400` (card 2287), and nothing in the request is saved:
`parentCardId 12 is not this board's parent card (none): the board has been moved since it was read, or a link was meant. A board is put under a card, or taken out from under one, on the board page`,
naming the value sent (`null` on a sub-board) and the board's own (`none` for a board on the
dashboard), and `parentCardId must be an id` for one that is not an id. The card named is not
looked for. Until 2026-10-14 another parent card was ignored and the other fields saved.

#### `POST /api/v1/boards/:boardId/convert`

Make a board an ideas board with the cards it holds (milestone 22, card 2463, ruling i). The
board's owner or an administrator (`404`, then `403`). Body: `kind`, which must be
`"ideas"` (`400` `kind is required`), and `cards`, how many cards the board holds, live and
archived, as the caller counted them (a whole number of 0 or more). The page's **Make this an
ideas board…** sends the same to `POST /api/boards/:id/convert`.

Refused, `409` with nothing written, in this order:

1. `This board is already an ideas board.`
2. A card on it, live or archived, has a sub-board: `Card "<title>" has a sub-board, and a card
   with sub-boards is never an option: move it to another board, or move or delete its
   sub-board, first.` (`Archived card "<title>" … restore it and move it to another board, …`).
3. The board is a sub-board: `A sub-board is a delivery board.`
4. A column whose title makes it To Do or On Hold holds a card, live or archived: `"<title>"
   holds N cards, and an ideas board has no To Do column: rename it first.`; a Complete
   column: `… no Complete column: move them to a delivery board, or delete them, first.`
5. `cards` is not the number the board holds now: `The board now holds K cards; look again.`

Then one transaction clears `committedAt` and `committedBy` on every card of the board,
archived ones included, deletes its empty To Do, On Hold and Complete columns (with their
CFD snapshots), and its Options column with them when it holds no card, live or archived, or
else makes it an ordinary one (card 2527), and sets `kind` to `"ideas"`. A board
holding no card at all is given New Ideas, Shaping and Ready for Replenishment in place of its
own columns, as an empty board's `kind` switch is. One `api:board_converted_to_ideas` entry,
with no card: `"<name>": N cards became ideas; its columns Options, To Do, Complete were removed
(board <id>)` (no clause when no column went; `… were replaced with New Ideas, Shaping, Ready for
Replenishment` for an empty board), ending with the board's id, which the options' aging
reads. No entry, webhook or mail for any card. Answers the board with its `columns`.

#### `GET /api/v1/boards/:boardId/upstream`

What happened upstream of the commitment point on one board over a window, and the options it
holds now (milestone 22, card 2464). View access: `400` `Invalid board ID`, then `404` `Board
not found` to everyone, for a board the key's user cannot open too (card 2719), and only then
`days` is read.
Nothing is written.

| Parameter | Type | Description |
|-----------|------|-------------|
| `days` | number | How many days the window runs back from now, both ends included: a whole number from 1 to 365. Not sent, or empty, `30`. Anything else, `0`, `366`, `1.5` and `abc` among them, is `400` `days must be a whole number from 1 to 365` |

```json
{
  "boardId": 12, "kind": "delivery", "days": 30,
  "period": { "from": "2026-09-26T09:00:00.000Z", "to": "2026-10-26T09:00:00.000Z" },
  "options": 6, "committedFromOptions": 3, "returnedToOptions": 1, "discarded": 1,
  "sentOn": 0, "abandoned": 0, "discardRate": 0.25,
  "oldestOptionDays": 41, "agingOptions": 2, "committedAll": 9
}
```

The figures from `options` to `agingOptions` are `upstreamFigures` in
`src/lib/server/upstream.ts`, which the board's Stats panel reads through
`GET /api/boards/:id/metrics` too: options now (live cards upstream, whatever the window) and
their aging (the oldest option's whole days, and how many are older than 30, each from when the
card became an option: the latest of its creation, its latest return to options and the latest
conversion of its column or board that made it one); and, over the window, distinct cards by
their **last** upstream act among committed from options, returned to options, discarded and
sent on, with abandoned work counted on its own; `discardRate` is `discarded / (discarded +
committedFromOptions + sentOn)`, `null` when all three are 0. `committedAll` is `committedAll`
in the same file, **Committed (all)**: the cards that arrived as committed work in the window,
each once, a card committed out of upstream (a `card_committed` entry on this board) and a card
created in the window straight into a committed column (its `committedAt` equal to its
`createdAt`). It credits a card created committed to **the board it is on now**, wherever it
was made, and counts **a card created and then returned to options as no arrival**, its
`committedAt` having been cleared, until it is committed again. A deleted card's entries have
no card id, and each counts once. An ideas board answers the same figures: every card on it is
an option, and none arrives committed.

```mermaid
flowchart LR
    Q["GET /boards/:boardId/upstream?days=N"] --> G["requireBoard view:<br/>400, then 404 (missing or unopenable)"]
    G --> D["days: 1 to 365, 30 by default, else 400"]
    D --> W["window: now − N days … now,<br/>both ends included"]
    W --> U["upstreamFigures([board], from, to)"]
    W --> C["committedAll([board], from, to)"]
    U --> A["{ boardId, kind, days, period,<br/>…figures, committedAll }"]
    C --> A
```

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

Only the fields whose value changes are written, and the board's open pages told (card
2359). A column sent back as it is answers `200` with the column, writing nothing; so do a
label, a category and a board category sent back to their own `PUT` (item 98).

**`role`** (milestone 22, card 2459), on this operation and on
`POST /api/v1/boards/:boardId/columns`: every column carries it, `"options"` for the board's
Options column, upstream of the commitment point, whose cards are options and not committed
work, and `null` for every other column, whose title still decides whether it is To Do, On Hold
or Complete. It is the sixth field `PUT` counts; left out it is kept, and anything but
`"options"` or `null` is `400` `role must be "options" or null, not "backlog"`. Every delivery
board has one Options column, made with it, titled Options, at its far left (card 2527), and
no write changes which column it is. `409`, with nothing written, in this order after the
`400`s: the Options column renamed to anything but Options (`The Options column is always
called Options.`) or given `role: null` (`Every delivery board keeps its Options column.`); the
completion rule above; an
ideas board's titles (below); then `"options"` on any other column (`This board already has its
Options column.`, or, on a board that has none yet (made before this release, or restored from
a backup), until the next start, `A delivery board's Options column is made with the board; it
comes back at the next start.`;
on an ideas board, every column of which is upstream, `Every column of an ideas board is
already upstream, so it has no Options column.`), any other column of a delivery board called
Options, trimmed and in any case (`Only the board's Options column is called Options. Choose
another name.`; one already so called keeps its title, and is refused only a new title that
still is), a WIP limit above 0 on the Options column (`An Options column has no WIP limit.`),
and a position that would put a column at or left of it. A title or role sent back as the
column holds it changes nothing and is not refused. On an ideas board a column whose title
makes it To Do, On Hold or Complete is `409` on create and rename (card 2463). A v1 column
created with no position still goes after the board's last column.

**`wipLimit`** on `POST /api/v1/boards/:boardId/columns` is read as this operation reads it
and stored, `0` when it is left out (card 2520, version 1.3.1). Until 2026-10-27 a limit sent
with a new column was not stored.

`POST /api/v1/columns/:columnId/convert`, which made a column holding cards the Options column,
was removed before it was released (card 2527): every delivery board has its Options column
from the start. A request to it is `404`.

#### `DELETE /api/v1/columns/:columnId`

Permanently delete a column **and every card in it**. Requires edit access to the board.
Answers `{ "success": true }`.

The cards are deleted for good, not archived, each with its subtasks, comments, dependency
links and sub-boards. Move the cards to another column first if they are to be kept. One
`column_deleted` entry is written to the board's activity log, naming the column and how
many cards went with it. No `card.deleted` webhook is sent for the cards.

A delivery board's Options column is `409`, empty or not (`Every delivery board keeps its
Options column. Fold it away with the arrow on its strip instead.`, card 2527). A column of an
ideas board holding cards that are not archived is `409` (`This column of an ideas board still
holds 2 ideas: move them out, or archive them to discard them, first.`), with nothing deleted:
ideas are moved out, or archived to discard them. Archived cards in it are deleted with it, as
before (milestone 22).

---

### Cards

Each card has a unique numeric ID shown in the UI as `#N`. You can search for cards by ID in both the board view and All Tasks view.

#### `GET /api/v1/boards/:boardId/cards`

List cards on a board, in the board's order (card 2295): column by column in order of column
position, ties by column id, and within a column in order of card position, ties by card id.
An archived card, with `archived=true`, takes its place by position. The cards are read in
one query joined to their columns, and the subtask counts for the cards listed alone. Until
2026-10-14 the columns came in the order they were made in, and each column was read on its
own. Every card carries `committedAt` and `committedBy` (`null` for an option) and
`discardedAt` and `discardedBy` (set on an option archived from upstream), as every card answer
does (milestone 22).

| Parameter | Type | Description |
|-----------|------|-------------|
| `columnId` | number | Filter to specific column. A whole number of 1 or more, or `400` `Invalid column ID`. A column of another board gives `[]`: the board in the path always bounds the list |
| `archived` | boolean | Include archived cards |
| `stage` | string | `option` or `committed` (since 2026-10-26, card 2464): only the options, the cards in the board's Options column or every card of an ideas board, or only the others, so an ideas board gives `[]` for `committed`. Decided by the column each card is in, archived cards included with `archived=true`, so a discarded card is an option. A third condition beside the others, in the same one read. Not sent, or empty, every card. Anything else is `400` `stage must be "option" or "committed", not "backlog"`, read after the board is looked for and the caller checked |

The stage is the board's kind, known from the board in the path, and the column's `role`,
asked with `IS` (`columns.role IS 'options'`, and `NOT (…)` for `committed`): an ordinary
column's role is `NULL`, and `NOT (NULL = 'options')` would drop every committed card.

```mermaid
flowchart LR
    Q["GET /boards/:boardId/cards<br/>?columnId, ?archived and ?stage"] --> G["requireBoard view: 404 (missing or unopenable)"]
    G --> R["one read: cards JOIN columns<br/>WHERE columns.board_id = :boardId<br/>AND the filters"]
    R --> O["ORDER BY column position, column id,<br/>card position, card id"]
    O --> S["subtask counts, same WHERE,<br/>grouped by card"]
    S --> A["each card + columnTitle,<br/>subtaskCount, subtaskCompleted"]
```

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

A card created outside an upstream column is committed as it is created (milestone 22): its
`committedAt` is its `createdAt` and its `committedBy` the key's user, with no entry beyond
`api:card_created`. One created in the board's Options column, or on an ideas board, is an
option, `committedAt` and `committedBy` `null`.

#### `GET /api/v1/cards/:cardId`

Get a card with subtasks (ordered by position, then id), labels, and assignees, and what it
waits on and what waits on it (`isBlocked`, `blockedBy`, `blocks`, as under
[Dependencies](#dependencies)).

`waitingOnDecisions` (since 1.15.1, card 3059) lists the decisions the card waits on, each a
`PlanDecisionWait` (`id`, `title`, `shownStatus` `open` or `awaiting_ruling`, `closesAt`): only
decisions linked to the card as `waits`, open or awaiting a ruling, that the key's user may view.
It is `[]` when there are none, and for a card that is archived, complete or an option.
`isBlocked` and `blockedBy` are unchanged and count unfinished dependencies alone, so **a card is
free to start when `isBlocked` is false and `waitingOnDecisions` is empty**. Keys of two users
may be given different lists for one card, so the answer carries `Cache-Control: no-store`. The
headers are set by route, not by method: `/api/v1/cards/:cardId` sends `Cache-Control: no-store`
and `X-Robots-Tag: noindex, nofollow` on every method (`GET`, `PUT` and `DELETE`), as
`/api/v1/cards/:cardId/dependencies` does on its `GET`, `POST` and `DELETE`. The
decisions are read only after the card's own check: a key that cannot open the card gets the
`404` and causes no decision read.

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
  which takes it out of this one. A milestone named that the key's user cannot see is `404`
  `Milestone not found`, as one that is not there; the milestone the card is in, when they
  cannot see it, is `403` `No access to the milestone this card is in` (card 2911): its id
  is on the card already. `archivedAt: null` sent with a `milestoneId` restores the
  card first. A change logs `api:milestone_card_added` or `api:milestone_card_removed`, as
  the milestone routes do, and is not named in `api:card_updated`, so a milestone alone
  sends no `card.updated` webhook; until 2026-10-14 it was "Updated fields: milestoneId"
  with `card.updated` (card 2289).
- **`columnId`** is not changed here: this operation does not move a card (card 2287). It
  is accepted only as the column the card is in, as a number or as text (`"14"`), so a card
  read with `GET /cards/:cardId` can be sent back whole. Any other is `400`
  `columnId 12 is not this card's column (14): the card has moved since it was read, or a move was meant. Move a card with PUT /cards/{cardId}/move`,
  naming the value sent and the card's column, and nothing in the request is saved; `null`
  or a value that is not an id is `400` `columnId must be an id`. The column named is not
  looked for, and the refusal comes after every other field is read and before the check
  for a body with no field. Until 2026-10-14 another column was ignored and the other fields
  saved.
- **`position`** is ignored here, whatever is sent, as it always was; reorder with
  [`PUT /api/v1/cards/:cardId/move`](#put-apiv1cardscardidmove). A drag renumbers every card
  in the columns it touches, so a card read a minute ago is often sent back with an old
  position. Neither `columnId` nor `position` counts as a field to update.
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
  links and sub-boards, and has them all when it is restored. No webhook is sent, except
  `card.discarded` for an option. A card already archived is answered `200` as it is, with nothing written and no live update:
  `archivedAt` keeps its first value and no second entry is logged (card 2285).
- **What the archive is** (milestone 22, card 2461) decides its one entry, in place of
  `card_archived`. A card in an upstream column (a board's Options column, or any column of an
  ideas board) is **discarded**: `discardedAt` and `discardedBy` are set with `archivedAt`, and
  `card_discarded`, `"<title>": discarded from <column>`, is written, which sends
  `card.discarded`. A card in a committed column that is not Complete is **abandoned**:
  `card_abandoned` (labelled "Archived unfinished card"), `"<title>": archived unfinished,
  from <column>`, with no webhook and no field on the card. A card in Complete is
  `card_archived`, as before. A restore (`archivedAt: null`) clears `discardedAt` and
  `discardedBy`, and its entry reads `"<title>": back in <column>`.
- **A permanent delete of an option** (a live card in an upstream column; an archived card is
  not an option in play, whether it was discarded or archived before its column became the
  Options column)
  writes `card_discarded`, `"<title>": deleted from <column>`, with `cardId` null, and sends
  `card.discarded` before the `card_deleted` entry and its `card.deleted`.
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
- out of a Complete/Done column: `completedAt` is cleared and `card_reopened` is logged,
  which sends the board's webhooks `card.moved` (card 2278).
- out of an On Hold column: a move from a column titled On Hold, Hold, Blocked, Parked or
  Waiting to one that is not clears the card's `onHoldNote` to `''`, in the same write as
  the move, with no entry of its own. The note stays on a move into such a column, between
  two of them, and between two working columns. Until 2026-10-14 only a drag on the board
  page cleared it (card 2208).
- to another board: the source board's labels are removed from the card, and so is
  a category that belongs to another board (a category with no board stays), and so is a
  milestone that belongs to a board other than the one it arrives on, so the answer has
  `milestoneId: null` and names the milestone it left as `leftMilestone` (`{ "id", "name" }`,
  otherwise `null`) (card 2155); a milestone across boards keeps the card.
  `card_moved_away` and `card_moved_in` are logged, one on each board, and neither names
  the other board (card 2181): `"<title>" moved to another board (<from> → <to>)` on the
  board it left and `"<title>" moved from another board (<from> → <to>)` on the board it
  arrived on, because each is read by everyone who can open its board. `card_moved_away`
  ends ` and out of milestone "<name>"` when the move took the card out of one of that
  board's milestones. Each sends its own board's webhooks `card.moved`, with that entry as
  `detail` (card 2278). The card's "Unblocked" comments that name work of the board it left
  by its title are rewritten to name it by its number, or as "a subtask on another board",
  with `updatedAt` unchanged (card 2256; see `GET /cards/:cardId/comments`), and so are
  other cards' notices naming it or one of its subtasks, on every card not on the board it
  arrives on (card 2261).
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
- across the commitment point (milestone 22, card 2460): out of an upstream column (a board's
  Options column, or any column of an ideas board) into a committed one, the card's
  `committedAt` becomes now and `committedBy` the key's user, and `api:card_committed` is
  logged in place of `api:card_moved`, `"<title>": <from> → <to> (column <to id>, from column
  <from id>)`, the ids naming the column it went into and the column it left (an entry written
  before card 2462 names only the first, `(column <to id>)`), which sends `card.committed`; straight into Complete,
  `api:card_completed` follows it. A committed card moved into an upstream column has both
  cleared, with `api:card_returned_to_options` (`card.moved`); from Complete,
  `api:card_reopened` comes first and sends nothing. A move within upstream, or between
  committed columns on one board or two, leaves both as they were. Refused with 409, nothing
  moved, after the loop and depth checks: an archived card across the commitment point,
  either way, `Card "<title>" is archived: restore it before moving it out of or back into
  Options`; and a committed card with a sub-board into an upstream column, `Card "<title>" has
  a sub-board, so it cannot go into the Options column: a card with sub-boards is committed
  work. Keep it in a committed column, or archive it if it is no longer wanted.` (`onto an
  ideas board` in place of `into the Options column`). A card already upstream with a
  sub-board may still move within upstream.
- an option to another board (milestone 22, card 2463, the S5a review's L5): a card in an
  upstream column moved to another board is sent on. The board it leaves logs
  `api:card_sent` in place of `api:card_moved_away`, `"<title>" sent to another board's
  Options (<from> → <to>)`, `… To Do (…)` or `… "<column>" column (…)`, with
  `api:card_sent`, `api:card_moved_in` and `api:card_committed` at the move's one moment (the
  goal's `api:milestone_card_removed` takes the database's clock), so that it pairs with the
  `api:card_moved_in` for the upstream figures; it sends `card.moved`. A card with sub-boards does not go into another board's
  upstream (409, the message above). `POST /cards/:cardId/send` is the way to send one.
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

#### `POST /api/v1/cards/:cardId/send`

Send an option on to another delivery board (milestone 22, card 2463, rulings b and l): from
any upstream column, a board's Options column or any column of an ideas board, to the other
board's Options column, where it stays an option and keeps its age, or to its To Do, which
commits it on arrival. Edit access to both boards. The web application's **Send to board…**
sends the same to `POST /api/cards/:id/send`, and lists the boards it can go to with `GET
/api/cards/:id/send` (page only: every delivery board the caller can edit but the card's own,
each with `options`, whether it has an Options column, and `todo`, the column a Send to To Do
commits into, or null).

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `boardId` | number | ✅ | The delivery board it goes to |
| `to` | string | ✅ | `"options"` or `"todo"` (`400` `to must be "options" or "todo", not "backlog"`) |
| `position` | number | | Where in the column it goes |

To Do is the first column titled To Do, or failing that the first column that is neither the
Options column, Complete nor On Hold: it never lands in On Hold. In this order: `401`; the card
looked for and edit access to its board (`404`, `403`); the fields (`400`); the board looked
for and edit access to it (`404`, `403`); `400` `A committed card is moved, not sent`; `400`
`"<board>" is an ideas board: a card is sent to a delivery board, and moved onto an ideas
board`; `400` `The card is already on "<board>": move it within the board instead`; `409` for
an archived card (`Card "<title>" is archived: restore it before moving it out of or back into
Options`); `409` `"<board>" has no Options column`; `409` `"<board>" has no column to commit
into: add a To Do column`; then every refusal of a move (a card with sub-boards into another
board's Options column is `409`).

The move is a move to another board's in every other way: labels, a board's category and a
milestone of the board it left are shed, and the answer is the card with `columnTitle`,
`boardId` and `leftMilestone`, as `PUT /cards/:cardId/move` answers. Entries, all at one
moment: `api:card_sent` on the board it left, `"<title>" sent to another board's Options
(<from> → <to>)` or `… To Do (…)`, in place of `api:card_moved_away`; `api:card_moved_in` on
the board it joined, then `api:card_committed` for To Do. Neither names the other board.
Webhooks: `card.moved` to each board, and `card.committed` to the board it joined for To Do.

---

### Assignees

#### `GET /api/v1/cards/:cardId/assignees`

List users assigned to a card. Needs view access to the card's board, as reading the card
does: `404` `Card not found` otherwise, as for a card that is not there (card 2719; it was
`403` `No access to this card's board`).

#### `POST /api/v1/cards/:cardId/assignees`

Assign a user: `{ "userId": 2 }`. The card is looked for and the caller checked first, then
`userId` is read: a whole number of 1 or more, `400` `userId must be an id` otherwise. A
user who does not exist is `404` `User not found`, and one who cannot open the card's board
`400` `User does not have access to this board`. The user assigned is mailed
`Assigned: <card>`, as their settings allow, unless they are the key's own user: nobody is
mailed about assigning themselves (card 2286).

#### `DELETE /api/v1/cards/:cardId/assignees`

Remove an assignee: `{ "userId": 2 }`. Removing someone who is not assigned to the card is
`404` `User is not assigned to this card`, writes nothing and sends no live update; until
2026-10-14 it was `200`, with an activity entry that said they had been removed.

---

### Subtasks

#### `GET /api/v1/cards/:cardId/subtasks`

List subtasks for a card, ordered by position, then id: subtasks at one position in the
order they were made. Until 2026-10-14 they had no order (card 2223).

#### `POST /api/v1/cards/:cardId/subtasks`

Create a subtask.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `title` | string | ✅ | Subtask title, trimmed, 1 to 500 characters |
| `description` | string | | Details, at most 50,000 characters |
| `priority` | string | | `low` / `medium` / `high` / `critical`, in any case, stored in lower case |
| `colorTag` | string | | A colour written `#rrggbb`, or `''` for none |
| `dueDate` | string or null | | A day of the calendar written `YYYY-MM-DD`; `''` is none |
| `position` | number | | Position in the card's list, lowest first. Not sent: after the card's last one (one more than the largest position, or 0 for its first), as the web application places it. Until 2026-10-14 it was 0 (card 2223) |

#### `PUT /api/v1/subtasks/:subtaskId`

Update a subtask: any of the fields above, and `completed`; a field not sent, `position`
included, is left as it is (only a new subtask is placed after the last). Set `"completed": true` to mark
done; it is `true` or `false`, and `"false"` is `400`, where it was stored as true. A value
the subtask already holds, sent back unchanged, is accepted as it is, and a body with none
of the fields is `400` `No valid fields to update`. The card or subtask is looked for, and
the caller checked, before a field is read, on both operations.

Completing a subtask writes an `api:subtask_completed` entry, `<subtask> (on <card>)`, then
the "Unblocked" notices, and mails whoever asked for the card when it came from a task
request, as ticking it in the web UI does. A notice on a card of another board names the
subtask only as `a subtask on another board` (card 2152). A subtask already complete, sent
`"completed": true` again, writes none of it. Until 2026-10-14 this wrote no entry and
mailed nobody.

Unticking a subtask writes an `api:subtask_updated` entry, `Reopened <subtask> (on <card>)`,
and mails nobody. A change of `title`, `description`, `priority`, `colorTag` or `dueDate`
writes an `api:subtask_updated` entry naming the fields changed,
`Updated <subtask> (on <card>): title, dueDate`, after the tick or untick when one request
does both. A change of `position` alone is written and not recorded. A request that
changes nothing writes nothing, records nothing and sends no live update, and is answered
`200` with the subtask as it is (card 2299).

#### `DELETE /api/v1/subtasks/:subtaskId`

Permanently delete a subtask, together with every dependency link that has it at either
end. The subtask and its links go together or not at all, with an `api:subtask_deleted`
entry naming the subtask. Until 2026-10-14 no entry was written.

---

### `PATCH /api/v1/milestones/:milestoneId`

Change a milestone's `name`, `description`, `targetDate`, `status` or `boardId`. The
milestone is looked for and the caller checked first (`404` for one that is not there or
that the key's user cannot see, in the same words, card 2911; then `403` for one they can see
and may not change), then each field is read. A `boardId` gives the milestone to a board only when every card in it, archived
cards included, is on that board (card 2179): the board is looked for (`404`
`Board not found`), the caller must be able to edit it (`403`
`No edit access to that board`), and a card of the milestone on another board is `400`
`Some cards in this milestone are not on that board (archived cards count too). Take those cards out of it first, or make the milestone cross-board instead; only its creator or an administrator can change a cross-board milestone afterwards.` A refusal changes
nothing and names no card and no board; `GET /api/v1/milestones/:milestoneId` lists the
milestone's archived cards in `archivedCards` (card 2346): take each out with
`DELETE /api/v1/milestones/:milestoneId/cards` and the change goes through. `boardId: null`,
a goal across boards, is always accepted, and the milestone's own board sent back is no
change.

Who may change the goal follows its board (card 2860). Before, a goal of one board is
changed by anyone who can edit that board, so any of its editors may make it cross-board
with `boardId: null`. After, only its creator or an administrator can change it, and only
someone who can open every board its cards are on can see it (with no cards, only its
creator). To anyone else it is `404 Milestone not found`, its creator included once it holds a
card on a board they cannot open (card 2911). The plan page does the same with its Board select, asked first in a dialog that
says so; the wrapper with `update-milestone -MilestoneId N -BoardId none`. A goal made
cross-board is no longer listed by `GET /api/v1/milestones?boardId=N`; since card 2891 it is
with `&touching=true`, while it has a card on N that is not archived.

```mermaid
flowchart TD
    P["PATCH with boardId"] --> M{"milestone there,<br/>caller may change it?"}
    M -->|no| R1["404 or 403"]
    M -->|yes| N{"boardId null, or<br/>the milestone's own?"}
    N -->|yes| W["200, written"]
    N -->|no| E{"board there?"}
    E -->|no| R3["404 Board not found"]
    E -->|yes| O{"caller can open it?"}
    O -->|no| R3
    O -->|yes| A{"caller can edit it?"}
    A -->|no| R4["403 No edit access to that board"]
    A -->|yes| C{"a card of the milestone,<br/>archived included,<br/>on another board?"}
    C -->|yes| R5["400 Some cards in this milestone<br/>are not on that board"]
    C -->|no| W
```

**What a goal change records** (card 2289). A change logs `api:milestone_updated` naming
the fields changed (`Updated milestone "Launch": name, targetDate`), and a change of status
`api:milestone_closed` or `api:milestone_reopened`; `DELETE /api/v1/milestones/:milestoneId`
logs `api:milestone_deleted`, `Deleted milestone "Launch"; 2 cards on this board released`.
A request whose every field is as stored writes, logs and tells nothing and is answered
`200` with the milestone as it is, after every refusal above. A card put in or taken out
(`POST`/`DELETE /milestones/:milestoneId/cards`, the bulk pair, `milestoneId` on
`PUT /cards/:cardId`) logs `api:milestone_card_added` or `api:milestone_card_removed` on the
card's board with its id; a card put into the milestone it is in changes nothing. A change to
the goal sends no webhook; a card put in or taken out sends `milestone.card_added` or
`milestone.card_removed` to its board's webhooks (card 2343), and goal membership sends no
`card.updated` on any route.

```mermaid
flowchart TD
    G{"what changed?"} -->|"nothing"| N["200 as it is:<br/>nothing written, logged or told"]
    G -->|"the goal"| B{"the goal's boards,<br/>before and after"}
    B --> E1["on a board it stays on or leaves:<br/>named as it was"]
    B --> E2["on a board it joins:<br/>named as it is"]
    E1 & E2 --> X["milestone #id where it is<br/>across boards in that state"]
    G -->|"a card in or out"| C["milestone_card_added / _removed<br/>on the card's board, with its id"]
    X --> L["live update; no webhook"]
    C --> LC["live update; milestone.card_added /<br/>milestone.card_removed to the card's board"]
```

### Milestones: Many Cards at Once

#### `POST /api/v1/milestones/:milestoneId/cards/bulk`

Put many cards in a milestone: `{ "cardIds": [1686, 1559, 1444] }`, up to 500.

#### `DELETE /api/v1/milestones/:milestoneId/cards/bulk`

Take many cards out of a milestone, with the same body. The cards themselves are untouched.

Both are all or nothing:

- The whole list is checked first. If any card does not exist, is archived (for an attach),
  is on a board the caller cannot edit or (for an attach) is on another board than a
  single-board milestone, the answer is `409` with every problem listed, and no card is
  changed. The attach says `Card does not exist or is archived`; the detach says
  `Card not found` for a card that does not exist (card 2290). A card on another board than
  a single-board milestone's names the remedy (card 2860): `This milestone belongs to a
  single board; card #2856 is on another. Make the milestone cross-board (boardId null on
  PATCH /api/v1/milestones/39, or Spans every board on its plan page), or move the card.`
  Make it cross-board, then send the same list again.
- **The detach takes an archived card out** (card 2290), as the single-card `DELETE` and
  `milestoneId: null` on `PUT /cards/:cardId` do, with its entry and a live update to its
  board, and skips and counts one that is not in the milestone. An archived card on a board
  the caller cannot edit is `No edit access to the board holding card #<id>`, with no title.
  Until 2026-10-14 the detach refused the whole batch over an archived card, which still
  holds its milestone to its board.
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
- Each card attached or detached logs `api:milestone_card_added` or
  `api:milestone_card_removed` on its board, with its id, in the same transaction; a card
  skipped logs nothing (card 2289). Each card attached or detached sends one
  `milestone.card_added` or `milestone.card_removed` to its board's webhooks once the batch
  commits (card 2343); a batch that is refused or fails sends none.
- The attach alone sends the plan-created mail, when the milestone held no card before and at
  least one was attached. A card put in one at a time, by any route or page, sends none.
  Archived cards count when it decides the milestone held a card, so a milestone emptied of
  its archived cards by the detach mails on the next bulk attach.
- Each recipient is mailed the plan's counts as they would read it (card 2687): the work is
  worked out once for each set of boards the recipients can open, and which cards a decision
  holds once for each recipient, as two people with the same boards may view different
  decisions. The mail names no decision.

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
  "waitingOnDecisions": [],
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
      "createdAt": "2026-10-13T09:41:07.000Z"
    }
  ],
  "blocks": []
}
```

`id` is the id of the link. `kind` says what `cardId` is the id of: for a subtask it is the
subtask's id, and `parentCardId` is the card it belongs to. `resolved` is true once that work
is finished.

`isBlocked` is true when an unfinished dependency is in `blockedBy`; a decision the card waits on
is not counted there but listed in `waitingOnDecisions` (since 1.15.1, card 3059), given whatever
`direction`, exactly as on `GET /cards/:cardId`: the open decisions the key's user may view, `[]`
for none. The answer carries `Cache-Control: no-store`, and the decisions are read only after
the card is found and checked and `direction` is read, so a `404` or `400` reads none. The
headers are the route's, set on every method: the `POST` and `DELETE` answers below carry
`Cache-Control: no-store` and `X-Robots-Tag: noindex, nofollow` too, as every method of
`/api/v1/cards/:cardId` does; the subtask routes do not.

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
| The waiting end's board | Removed | Removed, if they can view that end's board; `404` `Card not found` if they cannot open it (card 2719) |
| Only the board of the end it waits on | `403` if they can open the waiting end's board; `404` `#N not found` if they cannot (card 2719) | The same |
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
    C -->|no| N1
    C -->|yes| D{"The end that waits exists,<br/>on a board the caller can open?"}
    D -->|no| N2["404 #42 not found"]
    D -->|yes| E{"The caller can edit<br/>the waiting end's board?"}
    E -->|no| F2["403 No edit access to the board<br/>holding #10, the end that waits"]
    E -->|yes| G{"The link is there?"}
    G -->|no| N3["404 Dependency not found"]
    G -->|yes| OK["200, the link is removed"]
```

A card, subtask or end on a board the caller cannot open is answered as one that is not
there, in the same words (card 2719). The `403` is decided before the link is looked for,
so a caller who is refused is answered the same whether the link exists or not. `Dependency not found` is answered only to a
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
| `403` | `POST`: no edit access to the board at one of the ends, a board the key's user can open | `{ message }` |
| `403` | `DELETE`: no edit access to the board of the end that waits, a board the key's user can open. Answered before the link is looked for | `{ "message": "No edit access to the board holding #10, the end that waits" }` |
| `404` | The card or subtask in the path, or the one named in the body, does not exist, or is on a board the key's user cannot open: the two are answered alike (card 2719) | `{ "message": "#42 not found" }` (`Card not found` or `Subtask not found` for the one in the path) |
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

A node of the loop on a board the key's user cannot open is withheld (card 2719, D12): it is
`{ "kind": "card", "id": null, "withheld": true }` in `cycle` (the schema `CycleNode`), and
`A card on a board you cannot open` (or `A subtask on a board you cannot open`) in the
message, so the loop still reads as one and no id of the hidden work is given:

```json
{
  "message": "#10 waiting on #12 would create a cycle: #10 → A card on a board you cannot open → #12 → #10",
  "cycle": [
    { "kind": "card", "id": 10 },
    { "kind": "card", "id": null, "withheld": true },
    { "kind": "card", "id": 12 }
  ]
}
```

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

Each link written is recorded as a single add records one: an `api:dependency_added` entry
on the board of the card that waits (a subtask's card), with that card's id,
`subtask #3471 now waits on #1559`. A link skipped as already recorded writes none, and a
batch that wrote nothing tells no board. Until card 2291 a batch wrote one
`api:dependencies_bulk_added` entry with no card, on the first board it touched alone; that
name is no longer written (item 88).

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
| `missing-blocked`, `missing-blocker` | That end does not exist or is archived, or is on a board the key's user cannot open (card 2719): the words are the same |
| `cycle` | The link would close a loop, with the stored links or with earlier links of the batch. `cycle` holds the chain |
| `duplicate-in-batch` | The batch has the same link twice |

The boards of every link's ends are looked at first (card 2719, D12). A link with an end
that does not exist, or is on a board the key's user cannot open, is rejected as
`missing-blocked` or `missing-blocker` in the same words, and goes no further: it is never
counted a duplicate or judged part of a loop. `forbidden` lists the links whose ends are all
on boards the user can open and one is on a board they cannot edit. Only the links whose
ends they can edit are checked for `self`, duplicates and loops, so `wouldSkipAsDuplicate`
and `wouldCreate` count only those, and a loop's node they cannot open is withheld, as
above. An end that does not exist and a board the user may not edit are lines in the `409`:
this route answers no `404` and no `403`. A `400` means the batch could
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
  twice adds the tokens twice. To correct an over-report send a negative `tokens`; when the
  entries it corrects were measured, send the breakdown of what is taken back.
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
  sent as a bare total is priced at full input rates, and measured work is mostly cache
  reads at a tenth of that or less, so it took the card's cost below zero.
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
Claude 5.5, 5.2, 5.1, 5, 4.x and 3.5 models, rates verified 2026-11-13), or one of them
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
negative entry is the better correction, because it leaves the first to be seen. An entry
is refused only when removing it would take what is recorded of its model on its card or
subtask below zero, as removing it before the negative entries that correct it would:
`400` `Removing entry #312 would leave the claude-opus-5-5 entries on this card below zero:
remove the negative entries that correct it first.` (card 2220).

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
`404` and no `403`. A correction is held to what is recorded and to the entries before it in
the same batch, so `+10000` then `-10000` on a new card is written, and an over-correction is
a line in the `409` (card 2220). A `400` means `entries` is not an array, is empty or has
more than 200 entries, or holds an entry that is not an object (`entries[1] must be an
object`, which was a `500`).

**Not safe to send twice.** Unlike the dependency and milestone batches, which skip what is
already there, entries add: the same batch sent again adds the tokens again.

---

### Attachments

Since `1.7.0` (card 2754) a key lists a card's files, downloads one, and attaches an image.
It deletes none: a file is deleted in the web application alone. Files are kept on the
server's disk, in the uploads folder beside the database, with a small row each in
`card_attachments`; never in the database itself (see
[Attachment files](deployment.md#attachment-files)).

| Operation | Access | Limits |
|---|---|---|
| `GET /api/v1/cards/:cardId/attachments` | View access to the card's board | The key's 60 a minute |
| `POST /api/v1/cards/:cardId/attachments` | Edit access, asked before the body is read and again at the write | 5 MB a body; 30 uploads an hour and 100 MB a day for the key's user, whichever of their keys, every file they upload through the card window counted too (card 2761 for images, card 2910 for every file); 3 uploads in progress for the user and 6 for the server (card 2910); 20 images a card |
| `GET /api/v1/cards/:cardId/attachments/:attachmentId` | View access to the card's board | The key's 60 a minute |

An **`Attachment`** is the row without the name the file is kept under on the server:

```json
{
  "id": 412,
  "cardId": 2754,
  "originalName": "login page.png",
  "mimeType": "image/png",
  "sizeBytes": 183214,
  "uploadedBy": 3,
  "createdAt": "2026-11-05T10:12:44.000Z"
}
```

`mimeType` is, for an image uploaded through a key, the type its bytes are; for a file
attached in the web application, the type the browser named. `sizeBytes` is the size kept:
for an image uploaded through a key, once its metadata was taken out.

#### `GET /api/v1/cards/:cardId/attachments`

Every file on the card, the web application's and the API's, oldest first and, within one
second, by id. Errors, in order: `401`, `429` (the gate); `400` `Invalid card ID`; `404`
`Card not found`, for a card on a board the key's user cannot open too (card 2719).

#### `POST /api/v1/cards/:cardId/attachments`

Attaches one image. The body is the image itself, not JSON and not a form, sent with its type
as `Content-Type`: `image/png`, `image/jpeg`, `image/gif` or `image/webp` (parameters and case
are ignored). `Content-Length` may be left out: a body sent in chunks is counted as it is read.
`?name=` is the name it is shown and downloaded under, optional.

```bash
curl -X POST "https://dumpfire.example.com/api/v1/cards/2754/attachments?name=login%20page" \
  -H "Authorization: Bearer df_..." -H "Content-Type: image/png" --data-binary @login.png
```

```powershell
Invoke-RestMethod -Method Post -Uri "$base/api/v1/cards/2754/attachments?name=login%20page" `
  -Headers @{ Authorization = "Bearer $key" } -ContentType 'image/png' -InFile .\login.png
```

`201` is the `Attachment`. What is kept:

- **The bytes are checked, by allow-list.** The magic bytes must be the type declared, and the
  file is walked structure by structure to the format's end. Kept are only the structures an
  image needs: PNG `IHDR`, `PLTE`, `IDAT`, `IEND` and the colour chunks `tRNS`, `gAMA`,
  `cHRM`, `sRGB`, `iCCP`, `cICP`, `sBIT`, `pHYs`; JPEG frames `SOF0` to `SOF2`, tables, `DRI`,
  scans, `APP0` `JFIF` (written again with no thumbnail), `APP2` `ICC_PROFILE` and `APP14`
  `Adobe`; WebP `VP8X`, `ICCP`, `ALPH`, `VP8 `, `VP8L`; GIF graphic control and
  `NETSCAPE2.0` blocks. **Metadata is taken out**: text chunks, EXIF, XMP, IPTC, comments,
  thumbnails and every other application segment or extension. Nothing is decoded or
  re-encoded: the pixel data is kept as sent.
- **A JPEG's orientation is kept** (card 2761, 1.9.1), so a photo taken upright shows upright:
  read from the first EXIF `APP1` alone, from IFD0 alone (tag `0x0112`, once, `SHORT`, count 1,
  a value of 2 to 8; no pointer followed, so nothing of the thumbnail, the Exif sub-IFD or GPS
  is read), and written again in that segment's place as a 36-byte `APP1` of DumpFire's own
  that holds the value and nothing else. Anything else about it drops it, as before, and never
  refuses the image. A PNG's or a WebP's EXIF is still dropped whole.
- **A JPEG's trailing data is cut off** (card 2761, 1.9.1): whatever follows the `EOI` of its
  image, a gain map (Ultra HDR, MPF), a motion photo's video or a trailer, is never kept and
  never read, and the image is stripped as above. An MPF `APP2` index in the image is dropped
  with every other application segment.
- **Refused** (`400`): anything after the end of a PNG, GIF or WebP (`IEND`, the GIF trailer,
  the RIFF size), any animation (APNG, a GIF of more than one image, an animated WebP), a structure the
  format does not allow to be dropped, a file cut short or malformed, and more than 8000 pixels
  on a side or 40 megapixels in all.
- **The name** is `?name=` cleaned: only what follows its last `/` or `\`, with control and
  format characters and `<>:"|?*` taken out, trimmed, cut to 100 characters, and then its
  extension (a dot and one to five letters or digits) replaced by the bytes' own: `.png`,
  `.jpg`, `.gif` or `.webp`. `Fig. 3 login page` is `Fig. 3 login page.png`. Left out, or with
  nothing left, it is `image-<UTC date>-<time>`, as `image-2026-11-05-143000.png`. The file
  on disk is named by the server, `<uuid>.<extension>`.
- **Recorded** as `api:attachment_added`, `Attached "<name>" to "<card>"`, with the live board
  update the card window's upload sends. No webhook.

Errors, in the order they are asked:

1. `413` with `limitBytes` (5242880): a `Content-Length` over 5 MB, from the gate, before the
   key is looked at.
2. `401` no key or a bad one; `429` the key's 60 a minute.
3. `400` `Invalid card ID`.
4. `404` `Card not found`; `403` `No edit access to this board`.
5. `415` the `Content-Type` is not one of the four. Nothing has been read. Since 1.13.1 every
   refusal up to here, and at 5a, 6 and 7, closes the connection (`Connection: close`), the gate's
   `413` at 1 included.
5a. `507` (since 1.15.0, card 2920): the server's uploads volume has too little free space (less
   than 1 GB plus twice the database's size would be left after a 25 MB upload), or its free
   space cannot be read: `{"message": "Uploads are paused: the server has too little free disk
   space, or cannot read how much it has. Nothing was written. An administrator can see which on
   the admin page."}`, the card window's words, with `Connection: close`. Nothing has been read,
   taken or counted.
6. `429` uploads in progress (since 1.13.1, card 2910): the key's user already has 3, through
   a key or the card window, or the server 6, with `Retry-After: 5`, `retryAfterSecs` 5 and
   `Connection: close`. Nothing has been read or counted. The place taken here is given back
   however the upload ends, and lapses after 10 minutes.
7. `429` the upload count: the key's user has uploaded 30 files in the hour, through a key
   or the card window (card 2761; every file since card 2910), with `Retry-After`,
   `retryAfterSecs` and `Connection: close` (since 1.13.1). Nothing has been read.
8. `413` while the body is read: one sent in chunks, or one running past its declared length,
   passes 5 MB; `408` (since 1.13.1) when it has not arrived within 120 seconds of its read
   beginning, with `Connection: close`, the read stopped. Since 1.13.1 what was read of a body
   whose read fails, for these or because the client went away, is counted against the day
   before the failure is answered; until then it was not.
9. The bytes read are counted against the day: `429` when they would take the key's user past
   100 MB in 24 hours, every file of theirs through the card window counted too (then nothing is counted), with `Retry-After`; `401` if the key or its
   account changed while the body was read. Counted before the check, so a body refused at 10
   still counts what was sent.
10. `415` the bytes are not one of the four, or are another of them than declared; `400` they
   are not a valid image of their type, as above. The message says which.
11. As the image is written, in one transaction: `401` the key or its account changed; `404`
    and `403` again; `409` the card was closed more than `IMAGE_RETENTION_DAYS` ago, so retention
    is moving its images to the trash (`This card was closed more than 180 days ago, so its
    images are moved to the trash: reopen or restore it to attach one`; not asked when
    retention is `off`); `409` `This card already has 20 images`, counting every image row on
    the card whichever tree attached it. And `507` with the words of 5a (since 1.15.0), without
    `Connection: close`, when the file's write finds the disk full after all (something else
    filled it while the body arrived).

Nothing is written on any refusal: a file written before a refused row is removed, and the
card's folder if this request made it. An upload counted against the hour or the day (7, 9)
stays counted when a later step refuses it.

```mermaid
sequenceDiagram
    autonumber
    participant C as Client (key)
    participant G as Gate (hooks.server.ts)
    participant R as POST /api/v1/cards/:cardId/attachments
    participant A as upload-allowance.ts
    participant I as image-check.ts
    participant D as uploads/cardId/
    participant S as attachImage (card-attachments.ts)

    C->>G: POST, Content-Type image/png, raw bytes
    G->>G: Content-Length over 5 MB: 413 (before the key)
    G->>G: key 401, 60 a minute 429
    G->>R: request, body held to 5 MB
    R->>R: card id 400, card 404, edit access 403
    R->>R: Content-Type one of four, else 415
    R->>R: requireUploadRoom (upload-space.ts): free space below the floor, or unreadable, 507, Connection close
    R->>A: takeUploadPlace (3 per user, 6 on the server): 429, Connection close
    R->>A: takeUploadCount (30 an hour, per user): 429, Connection close
    R->>R: read the body (413 past 5 MB)
    R->>A: takeUploadBytes(bytes read) in writeAs (100 MB a day, per user): 429
    R->>I: checkImage: 415 type, 400 structure, trailing data, animation, size
    I-->>R: bytes without metadata, type, extension
    R->>D: writeUploadFile uuid.ext (no space left: removed, 507)
    R->>S: writeAs: key 401, card 404, edit 403, retention 409, 20 images 409
    S-->>R: row, api:attachment_added, live event (no webhook)
    R->>A: release the place, in finally, on every exit
    R-->>C: 201 Attachment
    Note over R,D: on a refusal at the write, removeUploadFile removes the file and a folder it made
```

#### `GET /api/v1/cards/:cardId/attachments/:attachmentId`

The file's bytes, not JSON, always as a download, whatever the file is:

| Header | Value |
|---|---|
| `Content-Type` | `image/png`, `image/jpeg`, `image/gif` or `image/webp` only when the stored type is that image and the bytes' magic is it; anything else, a `.txt` or a PDF among them, `application/octet-stream` |
| `Content-Disposition` | `attachment; filename="<ASCII name>"; filename*=UTF-8''<name>` |
| `X-Content-Type-Options` | `nosniff` |
| `Content-Security-Policy` | `sandbox` |
| `Cache-Control` | `no-store`, so no cache between keeps a file the key's user may later lose access to |
| `Content-Length` | The file's size |

Errors, in order, as JSON: `401`, `429` (the gate); `400` `Invalid card ID` or
`Invalid attachment ID`; `404` `Card not found` for a card that is not there or is on a board
the key's user cannot open, whatever attachment id follows it (cards 2719 and 2762, since
1.10.0); `404` `Attachment not found` for a file that is not on this card, another card's
among them (as the card window's route answers it, card 2361); `404` `File not found on
disk`.

#### In the web application

The card window uploads and serves files through its own routes, with a session and not a
key. What a browser gets when it opens one by its address:

| The file | Answered as |
|----------|-------------|
| A PNG, JPEG, GIF or WebP whose stored type and file name's extension agree and whose bytes are that image, or a `.txt` file whose stored type and extension agree | Shown in the browser (`Content-Disposition: inline`), with the type DumpFire names for it |
| Anything else: PDF, HTML, SVG, Office documents, archives, a file whose name and stored type disagree, or an image whose bytes are not the type stored (since 2026-11-05, card 2754) | A download (`Content-Disposition: attachment`, `application/octet-stream`) |

Every answer carries `Content-Security-Policy: sandbox` and `X-Content-Type-Options: nosniff`.

On a card, the four image types have a thumbnail that opens the image. Every other
attachment is saved to disk, and so is an image when its name is clicked.

Images of cards closed long ago are moved to the trash by DumpFire, whichever tree attached
them: see [Image Retention](backup-reporting.md#image-retention).

---

### Comments

#### `GET /api/v1/cards/:cardId/comments`

List all comments on a card, newest first. A comment's `createdAt` is kept to the second;
comments made in the same second are listed the later first, by id (card 2301). Each has
its author's `username` and `userEmoji`, which is `"👤"` for an author with no emoji, as in
every other comment answer (card 2302).

#### `POST /api/v1/cards/:cardId/comments`

Add a comment: `{ "content": "Your message here" }`. The card is looked for and the caller
checked first (`404`, then `403`), then `content` is read: text, trimmed, of 1 to 50,000
characters (`content must be text`, `Comment cannot be empty`,
`content must be at most 50000 characters`).

The board's members are told by email. Anyone it names as `@username` who can open the
card's board is also told by email, and nobody else (card 2198); the answer is the same
whoever was mailed. A name is the longest username that the text after `@` begins with, in
any case, and it must end there (card 2207): `@jane.doe` is the account `jane.doe`, and
never `jane`; `@Greg` is `Greg`. An `@` inside a word, as in an email address, is not a
mention. Where two usernames differ only in case, the one typed exactly is mailed. Only the
first 200 `@` of a comment that could start a name are read (one at the end, or before a
space or another `@`, cannot), so a mention after them mails nobody.

#### `GET /api/v1/comments/:commentId`

Fetch a single comment (requires view access to the card's board).

#### `PUT /api/v1/comments/:commentId`

Edit a comment's text: `{ "content": "Replacement text" }`. Only the comment's author or an admin may edit, and the author only while they can still edit the board the comment is on, which is what posting a comment asks for: someone taken off a board, or left on it as a viewer, is answered `403` with `No edit access to this board` for a comment they wrote there. A viewer can still read it. Sets `updatedAt`, logs `api:comment_edited` to the activity feed and pushes a live board update. The comment is looked for and the caller checked before `content` is read, which is held to the rule of a new comment, `content must be at most 50000 characters` past it (card 2218; it was `Comment too long (max 50000 chars)`). The text is stored trimmed and otherwise as sent (no tag prefixing).

Text that is the comment's own once both are trimmed changes nothing (card 2284): nothing is
written, `updatedAt` is kept, no `api:comment_edited` is logged and no live update is sent,
and the answer is `200` with the comment as it is stored, outer spaces and all. The caller is
checked first, so one who may not edit the comment is refused `403` whatever text it sends.

#### `DELETE /api/v1/comments/:commentId`

Delete a comment (card 2283; new on 2026-10-14, item 85). No body. Who may is who may edit
it, and who may in the web application: the comment's author while they can still edit the
board it is on, or an admin. A board's owner may not delete a comment somebody else wrote.
Answers `200` `{ "success": true }`; `400` `Invalid comment ID`, `404` `Comment not found`
(for a comment on a board the caller cannot open too, someone off the board or an author
taken off it among them, card 2719), `403` `No edit access to this board` (a viewer, or the
author once they are only a viewer) and `403` `You can only delete your own comments`. Nothing is
deleted on a refusal.

The delete logs `api:comment_deleted` to the activity feed, `Deleted a comment on "<card>"`,
or `Deleted a comment by <author> on "<card>"` when the caller is not the author (an admin
removing someone's words), and never the comment's text: the log is read by everyone on the
board. It pushes a live board update, `{ "type": "comment", "cardId": <the card> }`, so a
card window open on the card loses it. **No webhook is sent**: there is no
`comment.deleted` event (nor `comment.edited`), so a receiver mirroring a card's comments
learns that one has gone only by reading
[`GET /api/v1/cards/:cardId/comments`](#get-apiv1cardscardidcomments) again.

### Webhooks

A webhook sends each event of its board that it asks for (`card.created`, `card.updated`,
`card.moved`, `card.completed`, `card.deleted`, `comment.added`, `milestone.card_added`,
`milestone.card_removed`, `card.committed`, `card.discarded`) to its `url` as a `POST`, after
the change is committed, signed with its `secret`. An empty `events` list, or none, is every
event. What is sent: [Notifications & Email](notifications-email.md#webhooks).

An option sent on to another board (milestone 22, card 2463), by `POST /cards/:cardId/send`
or by any move of a card in an upstream column to another board, sends the board it left
`card.moved` with `data.action` `card_sent` (in place of `card_moved_away`) and `data.detail`
`"<title>" sent to another board's Options (<from> → <to>)`, `… To Do (…)` or `… "<column>"
column (…)`; the board it joined gets `card.moved` (`card_moved_in`), and `card.committed`
for one that arrives in To Do. A board converted to an ideas board sends nothing.

`milestone.card_added` and `milestone.card_removed` (card 2343, since 2026-10-21) are a card
put in a milestone or taken out, by every route and page that does it (the single and bulk
milestone operations, one delivery for each card, `milestoneId` on `PUT /cards/:cardId`, and
the web application's picker and plan page), sent to the webhooks of the card's board with the
entry's words in `data.detail`. A card moved between milestones is one `milestone.card_added`
naming the one it left; a change to a milestone itself sends neither. **A webhook with an empty
`events` list receives both from 2026-10-21.**

A card that leaves a milestone because of another change sends `milestone.card_removed` too
(card 2381, since 2026-10-21), one delivery a card, to the card's board, `data.detail` a card
taken out's words with why in brackets:

| What happened | `data.detail` ends | Board | `data.cardId` |
|---|---|---|---|
| Moved to another board out of its milestone (`PUT /cards/:cardId/move`, or the web application; an older milestone of neither board named `milestone #<id>`) | `(moved to another board)`, or `(sent to another board)` for an option sent on (milestone 22, card 2463) | The board it left, beside its `card.moved` | The card |
| Its milestone deleted | `(milestone deleted)` | Its own | The card |
| Deleted for good alone (beside its `card.deleted`), with its column, or by an administrator's clear of a board's cards or purge of archived cards | `(card deleted)` | Its own | The deleted card's id; the entry's `cardId` is null |
| On another board, released from a milestone of a deleted board or of a sub-board deleted with its parent card | `(milestone deleted with its board)`, the milestone named `milestone #<id>` | Its own | The card |

A card deleted with its own board (the board deleted, or a sub-board under a deleted card)
sends nothing: the board's log and webhooks are deleted with it. For a card deleted for good,
`card.deleted` and `milestone.card_removed` are separate deliveries and may arrive in either
order: a receiver treats a `milestone.card_removed` for a card it does not know, or has already
deleted, as harmless.

```mermaid
flowchart LR
    M["moved to another board"] --> L
    G["milestone deleted"] --> L
    D["card deleted: alone, column,<br/>clear, purge"] --> L
    R["released: its milestone's<br/>board deleted"] --> L
    L["logCardLeftGoal:<br/>milestone_card_removed"] --> Q{"card's board<br/>still there?"}
    Q -->|"yes"| S["afterCommit:<br/>milestone.card_removed"]
    Q -->|"no: gone with it"| N["nothing written or sent"]
```

There are fourteen events: `card.created`, `card.updated`, `card.moved`, `card.completed`,
`card.deleted`, `comment.added`, `milestone.card_added`, `milestone.card_removed`,
`card.committed`, `card.discarded`, and since 1.15.1 `decision.opened`, `decision.ruled`,
`decision.withdrawn` and `decision.superseded`; a webhook with an empty `events` list is sent
every one but the four decision events, which are sent only to a webhook that names them
([Decision events](#webhooks), below).
`card.moved` is every column change but a completion and a commitment, told apart by
`data.action`:

| `data.action` | The column change | Sent to |
|---|---|---|
| `card_moved` | A move within the board | The board |
| `card_reopened` | Out of a Complete column (card 2278) | The board |
| `card_moved_away` | To another board, a committed card | The board it left |
| `card_moved_in` | From another board | The board it joined |
| `card_returned_to_options` | A committed card moved back into an upstream column (since 2026-10-26); the one delivery of a move from Complete into Options | The board it is on |
| `card_sent` | An option sent, or moved, to another board, in place of `card_moved_away` (since 2026-10-26) | The board it left |

Each carries its own board's entry, which names neither board. A move into a Complete column
sends `card.completed` instead; one into another board's Complete column sends the joined board
both, the arrival and the completion. A move out of an upstream column into a committed one
within one board sends `card.committed` instead, so a webhook that asks for `card.moved` and
not `card.committed` does not hear it (milestone 22); across boards each board is sent its own
`card.moved` (`card_sent` to the board it left, `card_moved_in` to the board it joins), and the
board it joins `card.committed` after it.

`card.committed` (milestone 22, card 2460) is a card moved across the commitment point: out of
an upstream column, a board's Options column or any column of an ideas board, into a committed
one, by any route that moves a card. Within a board it is sent **instead of** `card.moved`; a
move to another board also sends each board its `card.moved`, the departure and the arrival. Its
`data.action` is `card_committed` and its `data.detail` the entry's words, `"<title>": <from> →
<to> (column <to id>, from column <from id>)`, the ids naming the column it went into and the
column it left (before card 2462, only ` (column <to id>)`); straight into a Complete column it
is followed by `card.completed`. A committed card moved back into an upstream column sends
`card.moved` with `data.action` `card_returned_to_options`; within a board that is the move's
only delivery from Complete (the `card_reopened` entry written before it sends none), and a move
from another board sends the joined board two `card.moved`, the arrival and the return. So to hear
every column change, ask for `card.moved`, `card.completed` and `card.committed`. **A webhook
with an empty `events` list receives `card.committed` from the deploy that adds it.**

`card.discarded` (milestone 22, card 2461) is an option dropped: a card in an upstream column
archived, by `DELETE /cards/:cardId` or the web application (the card window, the card menu, a
bulk archive), or deleted for good. Its `data.action` is `card_discarded` and its
`data.detail` `"<title>": discarded from <column>` for an archive, or `"<title>": deleted from
<column>` for a delete, which then sends `card.deleted` too, both naming the card in
`data.cardId` (the entries' `cardId` is null, the card being gone). An archived card deleted
for good, a discarded one included, sends `card.deleted` alone. Any other archive sends nothing, as before: a
committed card archived unfinished is recorded as `card_abandoned`, with no event. A restore
sends nothing. Deleting a column or a board, an administrator's clear of a board's cards and
purge of archived cards send no `card.discarded`. **A webhook with an empty `events` list
receives `card.discarded` from the deploy that adds it.**

```mermaid
flowchart LR
    A["archive an option"] --> D["card_discarded → card.discarded"]
    X["delete a live option"] --> D2["card_discarded → card.discarded,<br/>then card_deleted → card.deleted"]
    Y["delete an archived card"] --> E["card_deleted → card.deleted"]
    W["archive unfinished committed work"] --> N["card_abandoned: no event"]
```

**Decision events** (since 1.15.1, card 2689). `decision.opened`, `decision.ruled`,
`decision.withdrawn` and `decision.superseded` tell a receiver that a decision on the board was
opened, ruled, withdrawn, or replaced by a later ruling (`decision.superseded`, sent for the
earlier decision only when the ruling that replaces it marks it superseded, which it does only
when its ruler may supersede it).

- **Only a webhook that names them hears them.** An empty `events` list, or none, is every event
  but these four, so no webhook made before them receives one; add them to `events` with
  `POST /boards/{boardId}/webhooks` or `PUT /webhooks/{webhookId}` like any other event (a change
  of `events` keeps the webhook's setter and key).
- **The decision's own board alone**: never the board of a card linked to it, and nothing for a
  draft or for a decision whose board was deleted.
- **Only while the webhook's setter may view the decision**, asked at each event after the
  setter's access to the board; if not, it is not sent (`lastDelivery` "Not sent: its setter may
  not view this decision") and the webhook stays on for its other events.
- **Its `data` is exactly** `decisionId`, `action` (`decision_opened`, `decision_ruled`,
  `decision_withdrawn` or `decision_superseded`), `source` (`ui` or `api`), `title` and `status`
  (the decision's status after the act: `open`, `ruled`, `withdrawn` or `superseded`), and for
  `decision.superseded` `supersededByDecisionId`, the decision whose ruling replaced it, on the same
  board. No `cardId`, `user` or `detail`; never a name, count, option, reason or moment (no
  closing time, survey answer, objection, request to talk or group figure). Read the decision
  with your key for more.
- **No order is guaranteed** between events, a ruling's `decision.ruled` and the
  `decision.superseded` it causes included: use `data.status` and `timestamp`.

```json
{
  "event": "decision.ruled",
  "timestamp": "2026-11-24T10:00:00.000Z",
  "boardId": 6,
  "data": { "decisionId": 41, "action": "decision_ruled", "source": "ui", "title": "Budget for Q3", "status": "ruled" }
}
```

```mermaid
flowchart LR
    A["open, rule, withdraw,<br/>supersede"] --> B{"webhook on the decision's<br/>board names the event?"}
    B -->|"no, or events []"| N["not sent"]
    B -->|"yes"| S{"setter can open the board,<br/>and may view the decision?"}
    S -->|"no"| NS["not sent (lastDelivery says why)"]
    S -->|"yes"| P["POST: decisionId, action, source,<br/>title, status"]
```

| Route | Does | Needs | Answers |
|-------|------|-------|---------|
| `GET /api/v1/boards/:boardId/webhooks` | Lists the board's webhooks | View access | `200` |
| `POST /api/v1/boards/:boardId/webhooks` | Creates one: `url` (required), `secret`, `events` | Edit access | `201`, `400`, `409` |
| `GET /api/v1/webhooks/:webhookId` | Reads one | View access | `200` |
| `PUT /api/v1/webhooks/:webhookId` | Changes `url`, `secret`, `events` or `active` | Edit access; the board's owner or an administrator for `url`, `secret`, or switching it on | `200`, `400`, `403`, `404` |
| `DELETE /api/v1/webhooks/:webhookId` | Deletes one | Edit access | `200` |

```mermaid
flowchart TD
    Post["POST /boards/:boardId/webhooks"] --> G{"Board there, and edit access?"}
    G -->|"No"| R4["404 or 403"]
    G -->|"Yes"| U{"url an http or https address, not inside<br/>the network, with no user name or password?"}
    U -->|"No"| B400["400 naming why"]
    U -->|"Yes"| C{"Fewer than 10 webhooks on the board?"}
    C -->|"No"| C409["409: delete N before adding another"]
    C -->|"Yes"| W["201, set_by the key's user"]
```

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
  reason, with what to do about each: [Last Delivery](notifications-email.md#last-delivery).
- **A webhook is sent only while the account that set it up can open the board** (card
  2325), and **one whose setter loses the board is switched off for good** (card 2752, since
  `1.11.0`). The setter is the account that created it, or last set its `url` or `secret`, or
  switched it on. One whose setter was taken off the board, out of the team it is shared with,
  lost it with the team deleted or the board made private, or was an administrator made an
  ordinary user, is switched off at that change: `active` becomes `false`. So is one nobody is
  recorded as having set up (made before setters were recorded on 2026-10-18/19, or brought
  back by restoring an older backup), at the first start; and one whose setter's password or
  two-step sign-in (since 1.14.0) was reset, who used an invite, or whose account was disabled
  (since 1.13.0) or deleted. Every start, every restore and every
  event switch off what the changes did not see, and a restore never switches back on one
  switched off here. **It stays off when the setter is given the board back.**
  `pausedBecause`, given with the address (and `null` in the answer to the `POST`), says why,
  as history, word for word: "This was switched off because the account that set it up could
  no longer open this board. It stays off if that account is given the board back. The address
  was chosen by that account: delete the webhook unless you recognise it; to keep it, switch it
  on with your own key, which makes you its setter and gives it a new secret, given in that
  answer and readable by the board's owner or an administrator, and update the receiver.",
  "This was switched off because the account that set it up, or an account that could read its
  secret as the board's owner or an administrator, had its password or its two-step sign-in
  reset, ended its API keys when changing its own password, used an invite, was disabled, or was
  deleted, or, for one that could read it, lost that role; one already switched off then, or
  found switched off with its setter disabled or not recorded, is held the same way. Delete the
  webhook unless you recognise its address; …" (the same advice; since 1.15.0, card 2923, also
  for one switched off by a `PUT` before its setter's access ended, and card 2935, for one whose
  secret an owner or administrator who lost that access could read) or "This was switched off because nobody is
  recorded as having set it up. Delete it unless you recognise the address; to keep it, switch
  it on with your own key, which makes you its setter and gives it a new secret, given in that
  answer and readable by the board's owner or an administrator, and update the receiver." (since
  1.15.0; it said "and set a new secret" before), or "This was switched off because it came in
  with a backup whose seal did not verify, so its address, its secret and who set it up are only
  the file's word, and its secret was discarded. Delete it unless you recognise the address; to
  keep it, switch it on with your own key, which makes you its setter and gives it a new secret,
  given in that answer and readable by the board's owner or an administrator, and update the
  receiver." (since 1.15.0, card 3012). For one still on
  and held by a change made outside DumpFire's own writes it begins "Nothing is sent: " until its
  next event switches it off; it is `null` for one that is sent, and for one switched off by a
  `PUT` whose setter's access has not ended since, or ended keeping their keys. **Switching it on**: the board's owner or an administrator sends `{"active": true}`
  alone; for every reason (since 1.15.0, no recorded setter included) the answer's `secret` is a new one, 64
  hexadecimal characters, to give the receiver, and a `secret` sent with it is `400` `A webhook
  switched off this way is given a new secret when it is switched on: send active true alone,
  and read the new secret from the answer.`
  **Deleting it** is the board's owner's or an administrator's too: an editor's `DELETE` is
  `403` `Only the board's owner or an administrator can delete a webhook that was switched off
  this way. Ask the board's owner.` **The same receiver**: while one is switched off this way,
  a `POST` by anyone but the board's owner or an administrator to its receiver on its board,
  the same scheme, host and port whatever the path, query, fragment, case or default port, is
  `409` `A webhook to this receiver (the same scheme, host and port) on this board was switched
  off. Only the board's owner or an administrator can switch it on again, or add another webhook
  to it.`, asked after every other check. The board's owners are mailed when webhooks are
  switched off for lost access, naming the change and who made it, and when someone else makes
  one on their board. See
  [A Webhook Switched Off When Its Setter Loses the Board](authentication-security.md#a-webhook-switched-off-when-its-setter-loses-the-board-card-2752)
  and [When Nobody Who Can Open the Board Set It Up](notifications-email.md#when-nobody-who-can-open-the-board-set-it-up).
- **A webhook is switched off for good when the API key that set it up ends** (card 2893,
  since `1.11.0`): the key that created it, last set its `url` or `secret`, or switched it on,
  recorded with the setter and given in no answer. Revoked by its holder (in the same change),
  expired, past its deadline, deleted any other way, or another account's key: the webhook is
  switched off at the revoke, or at the next start, restore or event, as above, and its
  `lastDelivery.reason` is `Not sent: the API key that set it up has ended`. `pausedBecause`
  reads "This was switched off because the API key that set it up ended: it expired, passed its
  deadline, was deleted or is not the setter's; or, for a webhook set up before keys were
  recorded, the account that set it up has no working key from then. To keep it, switch it on
  with your own key, which makes you its setter and gives it a new secret, given in that answer
  and readable by the board's owner or an administrator, and update the receiver." A change of
  `events` alone keeps the key. One made before `1.11.0` records none, and keeps sending while
  its setter holds a working key made before then; the board's owner or an administrator
  re-saves it with their key (`{"active": false}`, then `{"active": true}`) to bind it. A `PUT`
  or `DELETE` of one that is on and held now records the hold first, and is judged so. **Rotating
  a key**: preferred, make the new key, have the board's owner or an administrator re-save each
  webhook with their new key (`{"active": false}`, then `{"active": true}`), which binds it and
  keeps its secret, and only then revoke the old one; otherwise revoke the old key first, and the
  board's owner or an administrator switches each webhook on with their key and gives its
  receiver the new `secret`. See
  [A Webhook Switched Off When Its API Key Ends](authentication-security.md#a-webhook-switched-off-when-its-api-key-ends-card-2893).
- **Only the board's owner or an administrator changes the address or the secret, or
  switches a webhook on.** An editor who sends `url` or `secret` at all, whatever the value,
  is `403` `Only the board's owner or an administrator can change a webhook's address or
  secret. Ask the board's owner.`, and one who sends `"active": true` for a webhook that is off `403` `Only the
  board's owner or an administrator can switch a webhook on. Ask the board's owner.`. An editor changes `events`,
  switches a webhook off, and deletes one. **Send only the fields that change**: the answer of
  the `POST` carries `url` and `secret`, and sent back whole by an editor it is refused.
- **Where a webhook may send.** Not inside the network: an address that is loopback,
  private, shared, link-local (the cloud metadata service among them), reserved,
  documentation or multicast, in IPv4 or IPv6, and the names `localhost`, `*.localhost`, a
  name with no dot, `*.local`, `*.internal` and `*.home.arpa`, are `400` `Webhook url points
  inside the network: <why>` when the webhook is created or its `url` changed; an address
  with a user name or password is `400` `Webhook url must not carry a user name or password`.
  A name is judged again at each delivery by every address it resolves to, and a delivery to
  one that resolves inside is not made. Redirects are not followed. The server's operator may
  let named receivers inside the network be sent to (`WEBHOOK_ALLOW_INSIDE`). The stored
  `url` sent back unchanged is accepted.
- **At most 10 webhooks a board**, switched-off ones counted: the 11th `POST` is `409` `This
  board has 10 webhooks, and a board may have at most 10: delete 1 before adding another.`,
  after every other check. Deleting one makes room.
- **A key ended while the request is arriving.** A `POST` or a `PUT` whose key a password reset
  ends while its body is still arriving is `401` `Invalid or expired API key`, with nothing
  written: the key is asked again in the transaction that writes.
- **A webhook switched off by a password reset** (the account that set its address or secret, or switched it on, was taken back) is switched on again with `PUT /api/v1/webhooks/:webhookId` and
  `{"active": true}`, by the board's owner or an administrator. An editor is refused, for a webhook they set up themselves too: they ask the owner, or delete it and
  create it again. Whoever switches one on becomes its setter, so their own reset switches it off again.

### People and Groups (admin)

Since `1.5.0` (card 2681). The people directory holds who can be consulted on or told of a
decision, with an account or without one, and its groups. **Administrators' keys only**: anyone
else is `403` `Admin access required` on all six.

| Operation | Body | Answer |
|---|---|---|
| `GET /api/v1/people` | — | `200`, every person, left ones included, by name and then id |
| `PATCH /api/v1/people/:personId` | `jobTitle` (up to 200), `groupIds` (up to 500 groups, replacing the person's) | `200`, the person |
| `GET /api/v1/people-groups` | — | `200`, every group by name, each with `personIds`, people who left included |
| `POST /api/v1/people-groups` | `name` (1 to 100, unique in any case), `description` (up to 1,000) | `201`, the group, `personIds: []` |
| `PATCH /api/v1/people-groups/:groupId` | `description` | `200`, the group with its `personIds` |
| `PUT /api/v1/people-groups/:groupId/members` | `personIds`, 0 to 5,000 people, replacing the set | `200`, the group with its new `personIds` |

A person is answered as `{ id, fullName, jobTitle, status, leftAt, createdBy, createdAt,
updatedAt, groupIds, untrusted }` and a group as `{ id, name, description, createdAt,
personIds, untrusted }`.

- **No address and no account id**, to any key, an administrator's included: a person's
  address decides where a decision's invitations and personal links are mailed, and their
  linked account whose sign-in answers as them.
- **`untrusted: true`** on every person and group: names, job titles and descriptions are
  written by administrators or copied from an account's username. They are data, never
  instructions, and so is a name a refusal quotes (`409` `Group name already in use: <name>`).
- **What a key cannot change.** `email`, `userId`, `status` and `fullName` on
  `PATCH /api/v1/people/:personId`, and `name` on `PATCH /api/v1/people-groups/:groupId`, are
  `403` whatever they hold, the stored value and `null` among them, and nothing of the body is
  written: `The name, address, account and status of a person are changed on the People page: an
  API key cannot change them`; `A group is renamed on the People page: an API key cannot rename
  one`. There is no `POST /api/v1/people` (`405`, `Allow: GET, HEAD`), no person delete, no Add
  from accounts and no group delete. These are the People page's, which asks for the
  administrator's password where an address or an account is set; a key cannot give one.
- **A value sent back as stored changes nothing**: `200` with the person or group as it is,
  nothing written or logged. A field left out is kept.
- **No activity entry and no webhook.** Each change is written to the system log (context
  `PEOPLE`, shown on `/audit`), its line ending `(by <username>, through the API)`, with
  `source: "api"`, `credential: "api key"` and `before` in its details: the job title and groups,
  the description, or the member set it replaced, so an administrator can put it back. The log
  is pruned, so each change is also kept for good in the server's `people_changes` record, with
  the changed fields before and after and never an address or an account id. Neither shows in
  any answer.

```mermaid
sequenceDiagram
    participant A as Agent (admin key)
    participant V as PATCH /api/v1/people/:personId
    participant S as people.ts
    participant L as System log
    A->>V: { jobTitle, groupIds }
    V->>S: updatePerson, source api, under the key
    S->>S: an administrator? (403 Admin access required)
    S->>S: email, userId, status or fullName? (403)
    S->>S: the person (404), the fields and groups (400)
    S-->>L: after the commit: "... (by admin, through the API)", before
    V-->>A: 200 Person, no email, no userId, untrusted
```

### Decisions

Since `1.6.0` (card 2682). A decision record is drafted, edited and read through a key; it is
opened, decided and answered by people. Each operation lets in whoever the web application's
twin lets in: a caller who may view the decision and not do the act is `403`
(`You cannot <act> this decision`), anyone who may not view it `404` `Decision not found`.

| Operation | Who | Body or query | Answer |
|---|---|---|---|
| `GET /api/v1/decisions` | anyone signed in | `tab`, `status`, `board`, `person`, `who` (up to 100), `q` (up to 200), `before` | `200` a register page; a malformed filter `400` naming it |
| `POST /api/v1/boards/:boardId/decisions` | the board's editors | `title` | `201 { decision, revision }` |
| `GET /api/v1/decisions/:decisionId` | its editors: author, decider, board owner, administrators | — | `200 { decision, options, surveyQuestions, participants, revision, readiness, actions, people, groups, deciderCandidates, untrusted }` (`surveyQuestions` since `1.15.0`) |
| `PATCH /api/v1/decisions/:decisionId` | its editors | `revision`, and any of `title`, `closesAt`, `voteMode`, `content` (whole, but `surveyQuestions`, kept when not sent) | `200 { decision, options, surveyQuestions, revision, readiness }` |
| `DELETE /api/v1/decisions/:decisionId` | its author, administrators | — | `200 { success: true }`; a decision ever opened `403` |
| `PUT …/decider` | its author, board owner, administrators | `deciderUserId`, `revision` | `200 { decision, revision }`; ever opened `403` |
| `PUT …/participants` | its editors | `participants` (`{ personId, role }`, up to 5,000), `revision` | `200 { participants, revision }`; ever opened `403` |
| `POST …/extend` | its decider | `closesAt`, later than the current one, at most a year ahead | `200 { decision, revision }`; a decision closed for input `403` |
| `POST …/withdraw` | its author, decider, administrators | `reason` | `200 { decision, revision }`; ever opened `403` |
| `POST …/supersede` | its decider, the board's Product Owner, administrators | `title` (optional) | `201 { decision, revision }` |
| `GET …/questions` | participants, author, decider, administrators | — | `200` the questions |
| `POST …/questions` | a participant, as their own row | `question` (up to 2,000) | `200 { question }`, no id |
| `POST …/questions/:questionId/answer` | author, decider | `answer` (up to 4,000) | `200 { question }`, always a draft |
| `GET …/summary` | decider, administrators | — | `200` the results |
| `GET …/record` | decider, administrators | `limit` (1 to 5,000, 500 by default), `after`, `participant` | `200` a page of the record |
| `PUT …/cards/:cardId` | editors of the decision's board and the card's | optional, since `1.15.0`: `{ "relation": "relates" \| "waits" }` | `200 { outcome, linkedCards }`, each card with its `relation` |
| `DELETE …/cards/:cardId` | the same | — | `200 { linkedCards }` |

- **What a key does not do** (D2 to D6, D29), each a person's on the decision's page, with no v1
  route: open, re-publish, send a dry run or an invitation again (each mails people; a leaked
  key could otherwise mail up to 500 people a day, personal links included); close for input (a
  close before the closing time makes a later ruling early and cuts off whoever had not
  responded); rule, release, respond, be recorded as having seen, raise a concern; publish or
  replace an agent's answer; change a participant's account or address (both ask a password);
  and, once the decision has ever been opened, change its participants or decider (`403` "This
  decision has been opened: who is included in it, and who decides it, are changed on the
  decision's page. An API key cannot") or withdraw or delete it (`403` "This decision has been
  opened: withdrawing or deleting it asks for your password on the decision's page. An API key
  cannot"). A `currentPassword` sent is not read. `POST /api/v1/decisions/{id}/open` and
  `…/close` are `404`.
- **The credential decides as well as the route.** Every key refusal is made in the service,
  which treats a write as a key's when the route says `source: 'api'` **or** the write was let
  in with a key (`writingWithKey()`), so a later route that passed the wrong word opens nothing.
- **Extend never brings a closing time earlier**, for anyone: a time no later than the current
  one is `400` "closesAt must be later than the decision's current closing time: Extend never
  brings it earlier", on the web application's `POST /api/decisions/{id}/extend` too. **A key
  extends an open decision only**: one closed for input is reopened by Extend on the decision's
  page, and a key is answered `403` "This decision is closed for input: reopening it by Extend is
  done on the decision's page. An API key cannot". Extending a decision past its closing time
  reopens it for input, which sends the invitation to each consulted participant not yet asked
  for their view in the current round (card 2744); where there is anyone to ask, a key is
  answered `403` "This Extend reopens the decision for input and would ask people consulted on it
  for their view by mail: a person does that on the decision's page. An API key cannot". With
  nobody to ask, or only people no mail can reach (one who has left, or whose address changed,
  recorded `mail_skipped` and not mailed), the key's Extend is taken and nobody is mailed.
- **The revision.** `GET` answers the decision's `revision`; `PATCH`, `…/decider` and
  `…/participants` require it, and a stale one is `409`. It moves with a change to what an
  editor writes (the title, closing time, vote mode, content, options, decider, participants and
  their roles, the status and version), and not with a Resend or an administrator's change to a
  participant's account or address, which `updatedAt` still shows (card 2706).
- **`content` is whole.** `PATCH` reads `content` strictly: a section not sent is emptied, but
  `surveyQuestions` (since `1.15.0`), which is kept when not sent and removed by `[]`. Each
  section a key changes is flagged as drafted by an agent until a person marks it reviewed on
  the page. Once opened, only the content changes, and nobody is told until a person
  re-publishes; the vote mode may still change while the current version puts no option to a
  vote (a survey), and the re-publish that adds the first options publishes them in that mode.
- **Survey questions** (since `1.15.0`, card 2683). `content.surveyQuestions` is a list of up to 20
  `{ questionId?, kind, prompt, help, required, choices?, scale? }`: `kind` `choice`, `scale` or
  `text`, and only that kind's keys (`choices`, 2 to 20 one-line items up to 200, a choice
  question's alone; `scale`, `{ max: 2..10, lowLabel, highLabel }`, a scale question's alone;
  either on another kind is `400` naming the path); `prompt` one line up to 300; `help` markdown up
  to 2,000; `required` false when not sent. An entry with no `questionId` is a new question; a
  `questionId` that is not a live survey question of this decision is `400`. A published
  question's kind is fixed (`400` "Survey question N has been published: its kind is fixed. Remove
  it and add a new question"); any other change but its help reaches people only by a person's
  re-publish asking everyone again. The answers give each question's row as `surveyQuestions`,
  `{ id, position, addedInVersion, retiredInVersion }`, as options are given; its words are in the
  content. A decision with no live option and at least one survey question is a survey: the
  readiness refusal `too_few_options` refuses one option, or none with no survey question, and
  `survey_incomplete` a question with no prompt or a choice question with fewer than two choices.
  Each question a key writes is flagged `survey.<questionId>` until a person marks it reviewed.
- **An agent may remove survey questions.** Sending `"surveyQuestions": []` removes every question
  from the working copy, of a draft or of an opened decision. A question never published goes at
  once; a published one is retired only when a person re-publishes on the page, asking everyone
  again, and the re-publish names each question it would retire. A removal carries no agent flag,
  as removing an option does not (a flag names a question still there). Leaving the key out keeps
  them, so an older client that has never heard of survey questions cannot wipe them.
- **Answers are a person's.** No v1 operation answers a survey: answers are given on the
  decision's page or by personal link, never with a key. The summary (decider and administrators)
  gives each response row's `answers`, keyed by question id (a choice counted from 0, a scale's
  number, a written answer), labelled by the questions of its `versionNumber`; each tally's
  `survey`, the figures per version answered under; and the current version's `surveyQuestions`.
  A response row may be of kind `answered`, a survey answered in a round with no options. Answers
  and survey figures are never released.
- **Objections and requests to talk are a person's** (card 2684). A participant objects to a
  decision, or asks to talk to its decider, on the decision's page or by personal link, and the
  current decider replies there; no v1 operation raises, replies to or reads one, and a key that
  reached the service would be refused (`403`). The summary is unchanged and holds no flag, its
  text or a count. `GET …/record` leaves the four flag events (`objection_raised`,
  `talk_requested`, `objection_answered`, `talk_outcome`) out of every page, filtered by
  `participant` or not, as it leaves out the question events: one list, `KEY_HIDDEN_EVENTS`.
  Nothing a key can read says whether anyone objected. A ruling made on the page may be refused
  while an objection has no answer; that refusal is the page's alone. This changed no operation,
  field or schema, so `1.15.0` gains no point: only the record operation's description and
  `DecisionRecordEntry.kind`'s description name the four events among those never given to a key.
- **A full record taken as a PDF is on the record** (card 2688, 1.15.1 point (10)). The decider and
  administrators can download a decision's full record as a PDF on its page (and anyone who may
  view it a shareable copy); no v1 operation gives either PDF. Each full record taken writes one
  entry of kind `record_exported`, which `GET …/record` gives a decider's or administrator's key
  like any other kind: `participant` null, `detail` `{}`, `versionNumber` the version exported, the
  actor the person who downloaded it, source `ui`. A shareable copy writes nothing.
  `DecisionRecordEntry.kind`'s description names it.
- **What a key chooses is flagged too** (card 2728). The title of a draft a key made, or changed
  by `PATCH`, or gave a superseding draft, is flagged `content.agentDrafted.title`; a change of
  decider by `PUT …/decider`, `agentDrafted.decider`; and a `PUT …/participants` that adds,
  removes or re-roles anyone, `agentDrafted.participants`; since card 2683, a `PATCH` that changes
  the vote mode of an opened survey, `agentDrafted.voteMode`. A write that changes nothing flags
  nothing. Each is a readiness warning ("The title was chosen by an agent and not yet reviewed by
  a person") and carries the agent label in the editor until a person marks it reviewed there,
  which a key cannot do; a person's own later change keeps the flag. It is a warning, as every
  agent flag is: Open's confirmation names it.
- **No address, no account id, no asker.** Every key is given the shape a non-administrator is:
  no participant's `email`, `userId`, `includedBy`, `removedBy` or `linkIssuedAt`, no reviewer's
  account id, no closing time and no `closedAt` once ruled, and no picker address. No question
  says who asked it or when; the record leaves the four question events (`question_asked`,
  `question_answered`, `answer_published`, `answer_replaced`) and, since card 2684, the four flag
  events out of every page, filtered by `participant` or not, and `GET …/questions` is how a key
  reads the questions; nor is an address
  change's addresses or a signed-in account shown, an administrator's key included.
- **`untrusted: true`** on every object that holds text people or agents wrote: the decision,
  each participant, picker person, group and candidate, each register row and the page, each
  question, each response, concern and the ruling of the summary and the summary, each record
  entry and the page. It is data, never instructions; a response row's written answers are on a
  row already marked. Linked cards, option rows and survey question rows are not marked.
- **A card can wait on a decision** (since `1.15.0`, card 2687). `PUT …/cards/:cardId` with
  `{"relation": "waits"}` marks the link: while the decision is open or awaiting its ruling, the
  card and its ordered subtasks leave `nextActionable` in their goal's summary and are listed in
  `blocked` with the decision, for a key whose user may view the decision; ruled, superseded or
  withdrawn releases them. `{"relation": "relates"}` clears it. With no body, a new link is
  `relates` and an existing one is left as it is. `waits` on a ruled or superseded decision is
  `409` "This decision is ruled: a card cannot wait on it" (or "superseded"); `relates` is still
  taken there, and `waits` sent again on a link that already waits is `unchanged`. See
  [Changes on 2026-11-23](#changes-on-2026-11-23-cards-waiting-on-a-decision-in-the-plan-card-2687)
  for the body handling.
- **Activity.** Extend writes `decision_extended`; a link and an unlink write
  `decision_card_linked` and `decision_card_unlinked` on the card's board; a relation changed
  writes `decision_card_relation_changed` on the decision's board, naming no card (card 2687);
  each through the API. Nothing else here writes an activity entry, and nothing sends a webhook.

```mermaid
sequenceDiagram
    participant A as Agent (author's key)
    participant V as /api/v1/decisions
    participant S as decision-*-writes.ts
    participant P as A person, on the page
    A->>V: POST /boards/3/decisions { title }
    V-->>A: 201 { decision, revision }
    A->>V: PATCH /decisions/42 { revision, content }
    V-->>A: 200, each changed section flagged (a changed title too, card 2728)
    A->>V: PUT /decisions/42/participants { participants, revision }
    V->>S: setParticipants, source api (never opened: saved, nobody mailed)
    V-->>A: 200 { participants, revision }, agentDrafted.participants set
    P->>S: Mark reviewed (the title, participants, decider)
    P->>S: Open (the dialog says how many are mailed)
    A->>V: PUT /decisions/42/participants
    V->>S: openedAt is set and the write is a key's
    V-->>A: 403 changed on the decision's page
```

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
