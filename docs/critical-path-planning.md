---
title: "Critical-Path Planning"
category: Architecture
version: 1.4
status: As-Built
date: 2026-09-11
tags:
  - planning
  - dependencies
  - milestones
  - critical-path
  - graph
  - scheduling
description: "How DumpFire derives critical path, next-actionable work and blocked state from two recorded facts, and where the planning view sits relative to the Kanban board"
---

# Critical-Path Planning

## The problem

A Kanban board is good at "what is the state of this card" and has nothing to say about
"in what order does this have to happen". A board with 69 To Do, 13 On Hold and 10 In
Progress cards has no structure beyond priority. A goal such as *migrate all environments
to Azure VMs* has prerequisites that must land in a particular order — cloud test
environment, secrets management, network segmentation, backup restore drills, DNS cutover,
decommissioning — and without somewhere to record that order it lives in people's heads and
in markdown plans that go stale.

## The principle

**Record only facts that are cheap to keep true.** DumpFire stores exactly two planning
facts by hand:

1. **Which card blocks which** — `card_dependencies`
2. **Which milestone a card belongs to** — `cards.milestone_id`

Everything else — the critical path, what is startable today, what is blocked and by what,
how much finishing a card would unblock, percent complete — is **computed on read** in
`src/lib/server/planning.ts`. Nothing derived is stored, so nothing derived can drift.

There are deliberately **no start or end dates on cards** and no estimates. A chain of cards
is enough to say what cannot slip. Per-card dates, resource levelling, hours tracking and
drag-to-reschedule Gantt charts are the features that make planning tools go stale for a
one- or two-person team, and they are out of scope.

## Where it sits

The planning view at `/plan` is a **separate view**, not a mode of the board. Same cards,
different question. The Kanban board is untouched apart from two chips on the card face and
one filter.

```mermaid
flowchart LR
    dev(["Developer<br/>plans and does the work"])
    agent(["Assistant<br/>plans over the API"])

    subgraph DumpFire
        direction LR
        board["Kanban board<br/><i>/board/[id]</i><br/>What is the state of this card"]
        plan["Planning view<br/><i>/plan, /plan/id</i><br/>In what order, what can I start"]
        api["v1 API<br/><i>milestones/:id/summary</i><br/>The whole plan as JSON"]
        engine["Planning engine<br/><i>lib/server/planning.ts</i><br/>Derives everything on read"]
        db[("SQLite<br/>card_dependencies<br/>milestones, cards")]
    end

    dev --> board
    dev --> plan
    agent --> api
    board -- "blocked state,<br/>one pass per board" --> engine
    plan --> engine
    api --> engine
    engine -- "reads the two<br/>recorded facts" --> db

    style engine fill:#6366f1,stroke:#4f46e5,color:#fff
    style plan fill:#8b5cf6,stroke:#7c3aed,color:#fff
```

## Cards and subtasks are both nodes

A "piece of work" is a card **or** a subtask, and both are nodes in one graph
keyed as `card:123` / `subtask:456`. Ordering genuinely exists at both levels —
step two of a card cannot start before step one, and sometimes a whole card
waits on one specific step of another. Before this, the only way to express that
was to promote the subtask to a card, which distorts the board to satisfy the
planning tool.

**One polymorphic table, not three.** `work_dependencies` carries
`(blocked_type, blocked_id, blocker_type, blocker_id)` rather than separate
tables for card→card, subtask→subtask and the two mixed directions. The planning
engine then walks a single graph regardless of node type; three tables would
mean three near-identical traversals that can drift apart, which is exactly what
this feature exists to prevent. The cost is losing foreign keys on the
polymorphic ids, so deleting a card or subtask clears its edges explicitly via
`removeWorkNodeEdges` — nothing cascades.

**Done means different things.** A card is complete when it reaches a Complete
column; a subtask when it is ticked. Both resolve through the same `isComplete`
field, decided per type at load.

**A subtask belongs to its parent card's milestone**, never to one directly, and
inherits its parent's board for access checks.

**Only subtasks that carry an edge become nodes.** Every subtask of every card
would swamp the graph, and most carry no ordering at all.

**Progress still counts cards.** Adding an ordering to a subtask must not
silently change how big a goal looks, so `progress.total` covers the milestone's
cards and subtasks stay in `openSubtasks` as before.

## Data model

Two tables and one column carry every planning fact.

```mermaid
erDiagram
    BOARDS ||--o{ COLUMNS : has
    COLUMNS ||--o{ CARDS : contains
    BOARDS ||--o{ MILESTONES : "may scope"
    MILESTONES ||--o{ CARDS : "groups (0..1 per card)"
    CARDS ||--o{ WORK_DEPENDENCIES : "either end"
    CARDS ||--o{ SUBTASKS : "broken into"
    SUBTASKS ||--o{ WORK_DEPENDENCIES : "either end"
    USERS ||--o{ WORK_DEPENDENCIES : recorded

    MILESTONES {
        int id PK
        int board_id FK "NULL = cross-board goal"
        text name
        text description
        text target_date "nullable"
        text status "open | closed"
        int created_by FK
    }

    WORK_DEPENDENCIES {
        int id PK
        text blocked_type "card | subtask - the WAITING end"
        int blocked_id
        text blocker_type "card | subtask - what it waits ON"
        int blocker_id
        int created_by_user_id FK
        text created_at
    }

    CARDS {
        int id PK
        int column_id FK
        int milestone_id FK "nullable, ON DELETE handled in code"
        text title
        text priority
        text archived_at
    }

    SUBTASKS {
        int id PK
        int card_id FK "inherits board and milestone"
        text title
        bool completed "done means ticked, not a column"
    }
```

### Edge direction

Stated once, because getting it backwards is the easiest mistake here:

- `work_dependencies.blocked_*` is the work that is **waiting**
- `work_dependencies.blocker_*` is what it is **waiting on**

An edge points **blocker → blocked**, which is also the left-to-right reading order of the
milestone graph. The API accepts both spellings (`dependsOnCardId` / `dependsOnSubtaskId`
and `blocksCardId` / `blocksSubtaskId`) so a caller never has to work out which end owns
the row. In bulk, a bare number means a card and `"subtask:42"` means a subtask, so
card-only lists written before subtasks existed are untouched.

### Constraints worth knowing

| Constraint | Why |
|------------|-----|
| `UNIQUE (card_id, depends_on_card_id)` | The duplicate check used to be handler-only. Migration `0042` de-duplicates to `MIN(id)` per pair before creating the index, or it fails on live data. |
| `cards.milestone_id` has no `REFERENCES` clause | SQLite cannot add a column with `ON DELETE` to an existing table. The delete handler nulls it instead — which is the wanted behaviour anyway: **deleting a goal must never delete the work.** |
| `milestones.board_id` nullable | A goal can span several projects. A migration touches more than one board. |
| Archived cards are excluded everywhere | An archived blocker is not a live dependency. |

### What counts as "done"

A dependency is resolved when its blocker sits in a **Complete** column, decided by
`isCompleteColumnTitle()` in `card-completion.ts` — the same strict helper the rest of the
app uses for XP and completion blocking. One definition of done across the whole app; two
would be exactly the drift this feature exists to remove.

## How a milestone summary is computed

```mermaid
flowchart TD
    A["getMilestoneSummary(id)"] --> B["Load milestone cards<br/>(archived excluded)"]
    B --> C["Load ALL dependency edges<br/>in one query"]
    C --> D["Add direct external blockers<br/>as nodes, flagged external"]
    D --> E["Keep edges with both ends<br/>in the node set"]
    E --> F["Kahn topological sort<br/>→ layers, left to right"]
    F --> G{"Nodes stranded?"}
    G -->|"yes: legacy cycle"| H["Park in a final layer<br/>+ log a warning"]
    G -->|no| I["Reverse topological pass<br/>→ downstream reach per node"]
    H --> I
    I --> J["Longest path over OPEN cards<br/>→ criticalPath"]
    J --> K["Zero open blockers<br/>→ nextActionable<br/>sort: downstream, priority, id"]
    J --> L["Open blockers remain<br/>→ blocked"]
    K --> M["Progress: by column, done/total,<br/>open subtasks, boards"]
    L --> M
    M --> N["MilestoneSummary"]
```

### Design decisions inside that flow

**External blockers are included.** The node set is the milestone's cards *plus* any card
outside it that directly blocks one of them, marked `external: true`. Without them, a card
whose only blocker sits on another board would appear startable when it is not — precisely
the mistake the feature exists to prevent. Direct blockers only: one level is exactly what
"can I start this" depends on. External nodes are never offered in `nextActionable`; they
are context, not scope.

**The critical path covers open work only.** It is the longest chain of dependencies among
cards that are not yet complete. A finished prerequisite adds no risk, so it drops out and
the chain shortens as work lands. Ties break on accumulated priority, then on the lowest
card id, so the highlighted chain does not jitter between reloads. A chain of one card is
not reported — that is just the next thing to do, and it shows up in `nextActionable`.

**Next-actionable is sorted by how much it unblocks.** `downstreamCount` is the number of
open cards transitively reachable from a card. On a one- or two-person team, the card that
frees the most downstream work is the one worth starting, ahead of raw priority.

**The whole edge table is read in one query.** It is small — one row per ordering decision
somebody actually made, not one per card — and cycle detection, downstream counts and the
critical path all walk it repeatedly. Paging it would cost more queries than it saves rows.

**Complexity.** Layering, reach and longest-path are each a single pass over nodes and
edges: O(V + E) per summary, with one bounded query for cards, one for columns, one for
boards and one for the edge table.

### Cycle detection

Adding "blocker B blocks card A" closes a loop exactly when B is already reachable
*downstream* of A. `findDependencyCycle(blockedId, blockerId)` walks forward from A over
blocker → blocked edges looking for B, and returns the offending chain as card ids rather
than a boolean — so the API can name the cycle it rejected:

```json
{ "error": "That dependency would create a cycle",
  "cycle": [1559, 1686, 1198],
  "message": "Cycle: #1559 → #1686 → #1198 → #1559" }
```

"Rejected" on its own is not useful when the loop runs through five cards on three boards.

## Unblock notification

When a card reaches a Complete column, anything that was waiting only on it becomes
startable. Three code paths complete a card, so the reaction lives in one helper,
`applyUnblockEffects()`, and each of them calls it in one line.

```mermaid
sequenceDiagram
    actor User
    participant Route as "Move path<br/>(reorder | card PUT | v1 move)"
    participant Plan as "planning.ts"
    participant DB as SQLite
    participant Notify as "notifications.ts"
    participant SSE as "events.ts"

    User->>Route: Move card #1686 to Complete
    Route->>DB: Update column, set completedAt
    Route->>Plan: applyUnblockEffects(1686, actor, baseUrl)
    Plan->>DB: Load dependency edges
    Plan->>Plan: Find dependents of #1686
    loop each dependent
        Plan->>Plan: Any other blocker still open?
        alt all blockers complete
            Plan->>DB: Insert system comment<br/>"Unblocked: #1686 … completed"
            Plan->>Notify: notifyCardUnblocked(...)
            Notify-->>User: Email the assignees
            Plan->>SSE: emit(boardId, 'update')
        else still blocked
            Plan->>Plan: Skip — not unblocked yet
        end
    end
    Route-->>User: 200 OK
```

The helper swallows its own errors. A card that has genuinely been completed must not fail
to move because an email bounced.

The email reuses the existing `email_moved` preference rather than introducing a new
toggle: being unblocked is a column change on somebody else's card, and a user who muted
move notifications does not want this one either.

## Upgrading a live system

This feature adds a migration, so it is worth being explicit about what it does to a
populated database.

**Additive by default.** Migration `0042` creates the `milestones` table, adds two nullable
columns (`cards.milestone_id`, `card_dependencies.created_by_user_id`) and three indexes.
SQLite adds a nullable column as a schema change, not a table rewrite, so no existing row is
read or written.

**One statement removes anything.** Before this migration the duplicate check for
dependencies lived in the request handler rather than the database, so identical
`(card_id, depends_on_card_id)` pairs were possible and `CREATE UNIQUE INDEX` would fail on
them. The de-dupe keeps `MIN(id)` of each pair and groups on exactly the two columns the
index covers, which makes losing a dependency unrepresentable: a row can only be deleted
when another row with the same pair survives.

**Legacy table shapes are repaired in code, not SQL.** `repairLegacyCardDependencies()` in
`migrate.ts` runs before the migration loop. It inspects `card_dependencies`, does nothing
when the columns are already current, refuses to touch a shape it does not recognise, and
converts a genuinely legacy table inside a transaction that compares row counts and rolls
back rather than dropping the original if they disagree.

That check exists in code because plain SQL cannot ask "which shape is this table?" — the
assumption that it could is precisely what made migration `0036` destructive (see the
comment in that file). Putting it where it can be guarded, counted and rolled back is the
difference between a conversion and a data-loss bug.

**Migration 0043** adds `work_dependencies` and copies every `card_dependencies` row across
as a `(card, card)` pair with `INSERT OR IGNORE`, so it is safe to re-run. The old table is
deliberately **left in place** rather than dropped: this is the migration that could lose
the ordering decisions already recorded, and a table nothing reads costs nothing. A later
migration can drop it once `work_dependencies` has been in production long enough to trust.
(Migration `0036` is the cautionary tale — see the comment in that file.)

**Verified, not assumed.** The upgrade was run against three populated databases — one at
`0041` with several hundred cards, comments, subtasks and assignees; the same database
forced into the legacy dependency shape; and a real working database already upgraded. In
every case cards, comments, subtasks and assignees were preserved, every distinct dependency
survived (with blocker/blocked mapped the right way round on conversion), and two further
simulated restarts re-ran no migration and changed no row.

That last property matters most: a migration that does work on every boot rather than once
is exactly the failure mode `0036` had, and it went unnoticed for months because the table
it emptied was never read.

## The planning view

`/plan` lists the goals. `/plan/[id]` is one milestone, rendering five blocks in the order
they answer a real question:

| Block | Question it answers |
|-------|---------------------|
| Progress | How far along is this goal |
| Critical path | Which chain cannot slip |
| Next actionable | What can I start today |
| Blocked | What is waiting, and on what |
| Dependency graph | What is the overall shape |

Nothing is computed in the browser. The server hands over a `MilestoneSummary` and the page
draws it, so the page and the API can never disagree about what the critical path is.

### Why the graph is hand-laid-out SVG

The milestone graph is inline SVG positioned in topological layers, **not** the existing
`ForceGraph` component used by `/graph`. The point of this graph is that reading left to
right is reading the order the work happens in, and a force layout scrambles exactly that.

Nodes keep a fixed size (190×58) and the container scrolls horizontally; shrinking nodes to
fit thirty cards on one screen produces a picture nobody can read. The page body itself
never scrolls sideways.

**Subtasks are collapsed under their card by default.** A card with ordered subtasks shows
a `+n` badge and expands inline on click. This was chosen over drawing them always-inline
because node count is the real readability risk at this scale — and it costs nothing in
accuracy: the critical path is computed over the **full** graph either way, so collapsing
is purely a display choice. A collapsed subtask's edges roll up to its card, so nothing
dangles; the client re-layers the rolled-up graph with the same Kahn pass and
stranded-node fallback the server uses, because rolling up can produce a cycle the full
graph does not have.

| Node state | Appearance |
|------------|------------|
| On the critical path | Red border, heavier stroke; its edges drawn red and thicker |
| Complete | Green, text dimmed so finished work recedes |
| Blocked | Amber |
| Startable | Indigo |
| Outside the milestone | Dashed grey border |

Cards with no dependencies recorded in either direction appear in a **Parallel / unordered**
group beneath the graph, so a card is never invisible just because nobody sequenced it.

## Board integration

The board picks up exactly three things:

- A **Blocked** chip on the card face when any blocker is not in a Complete column, with a
  tooltip listing each blocker, its column, and its board when it lives on another one.
  Amber, not red — On Hold already owns red, and *waiting* must stay distinguishable from
  *stopped*.
- A **milestone** chip linking through to the planning view.
- A **Hide blocked** filter, which also adjusts the per-column counts so a filtered column
  reads `3/12` rather than silently under-reporting.

Blocked state is computed once per board by `getBoardBlockedState()` and shipped with the
page payload — one query for the whole board rather than one request per card face.

Moving a blocked card to In Progress **stays allowed**; it raises a warning toast naming the
outstanding blockers rather than a modal. A dialog that interrupts the drag would make the
common case — the graph is out of date and you know what you are doing — annoying enough to
stop people recording dependencies at all.

## Planning over the API

`GET /api/v1/milestones/:id/summary` returns the whole plan in one payload, and is the call
to make to answer *"what should I work on next for milestone X"*. Add `?compact=true` to
drop the graph (the bulky part, only needed for drawing) and get a `cardTitles` map instead.

### Recording a plan

Goals are recorded in bulk, not link by link. On a board of any size, entering dependencies
one at a time is the thing that stops them being entered at all, so the batch endpoints are
the intended path:

```powershell
$ms = & $API -Action create-milestone -ApiKey $KEY -Name "Azure VM migration" | ConvertFrom-Json
& $API -Action add-milestone-cards -ApiKey $KEY -MilestoneId $ms.id -CardIds "1198,1686,1559,1444,1201"
& $API -Action add-chain          -ApiKey $KEY -Chain "1198,1686,1559,1444,1201"
```

`add-chain` exists because a critical path *is* a linear chain; writing it out as pairs is
where transcription mistakes come from. Branches go in with `add-dependencies -Links
"1444:1320"`, where each entry reads `blocked:blocker`.

A subtask end is written `s<id>` (or `subtask:<id>`); a bare number stays a card:

```powershell
& $API -Action add-chain -ApiKey $KEY -Chain "1686,s4821,s4822,1559"
& $API -Action add-subtask-dependency -ApiKey $KEY -SubtaskId 4821 -SubtaskDependsOn 1686
```

A batch is validated as a whole and written all-or-nothing, reporting every problem at once
rather than one per attempt. Two details matter:

- **Duplicates are skipped rather than rejected**, so a batch can live in a file and be
  replayed as the plan changes.
- **Cycle detection covers the batch itself.** Two links can each be safe against the stored
  graph and still close a loop between themselves; a per-link check would write both and
  strand nodes in the milestone view. The proposed edges are layered on the stored graph and
  added one at a time instead.

From the wrapper script:

```powershell
.\.agent\scripts\dumpfire-api.ps1 -Action milestone-summary -ApiKey <KEY> -MilestoneId 4 -NoGraph
```

Use `-NoGraph`, never `-Compact`: the wrapper's `-Compact` trims responses to
`id`/`title`/`status` fields, which would discard the plan itself.

See [External API Reference](api-reference.md) and `.agent/workflows/dumpfire-api-reference.md`
for the full endpoint contracts.

## Getting a plan out of the app

A plan is only useful if it can leave the screen. `GET /api/v1/milestones/:id/pdf` (and the
download button on the milestone view) produces the plan as a PDF for a stakeholder pack:
progress, the chain that cannot slip, what can be started today, what is waiting and on
what, and the full list of work.

It is drawn with the palette and helpers exported from `reports.ts` rather than its own
look. These documents land in the same packs as the board reports, and a second visual
language would read as coming from somewhere else. The `[Claude]` tag is stripped from
every title — these go to people who do not need that bookkeeping.

The dependency graph is drawn **only when it fits at a readable size**. Past that, the
document prints how many items and stages there are and points at the planning screen. A
picture nobody can read is worse than a sentence admitting it does not fit.

Because it takes the same `MilestoneSummary` the screen renders, the document and the view
cannot disagree about what the critical path is.

## Files

| File | Responsibility |
|------|----------------|
| `drizzle/0042_add_milestones_and_planning.sql` | Milestones table, `cards.milestone_id`, unique dependency pair index |
| `drizzle/0043_add_work_dependencies.sql` | Polymorphic `work_dependencies`; carries every card dependency across |
| `src/lib/server/work-access.ts` | Which board a piece of work lives on |
| `src/lib/server/subtask-dependencies.ts` | Shared handler body for both subtask dependency routes |
| `src/lib/server/planning.ts` | Every derived planning fact — graph, cycles, critical path, actionable, unblock hook |
| `src/lib/server/milestones.ts` | Milestone CRUD, card assignment, access rules |
| `src/routes/api/v1/milestones/**` | Bearer-token API |
| `src/routes/api/milestones/**`, `src/routes/api/cards/[id]/dependencies` | Session-cookie siblings for the UI |
| `src/routes/plan/**` | The planning view |
| `src/lib/server/milestone-report.ts` | The plan as a PDF, in the board-report house style |
| `src/lib/components/CardModal.svelte` | Dependency editor and milestone picker |

## Out of scope

Per-card start and end dates, estimates, duration-weighted critical path, resource
levelling, hours tracking, and Gantt charts with drag-to-reschedule. Estimates and a
duration-weighted path may be worth revisiting once the card-count critical path has been
used in anger for a while — but only then.
