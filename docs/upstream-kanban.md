---
title: "Upstream Kanban: Options, the Commitment Point and Ideas Boards"
category: Workflow
version: 1.1
status: As-Built
date: 2026-10-27
tags:
  - upstream
  - downstream
  - kanban-method
  - options
  - options-column
  - commitment-point
  - ideas-board
  - send-to-board
  - discard
  - abandoned
  - replenishment
  - lead-time
  - cycle-time
  - migration-0060
  - api-v1
  - webhooks
  - milestone-22
  - card-2527
description: "How DumpFire keeps ideas (options) apart from committed work: the Options column, ideas boards, the commitment point recorded on each card, discards and abandoned work, how options are kept out of every delivery figure and counted in their own, the data model of migration 0060, the rules, the activity entries, the API (1.3.0), the webhooks and the tracking wrapper, with guidance on when to use options"
---

# Upstream Kanban: options, the commitment point and ideas boards

Since milestone 22 (cards 2459 to 2465, 2026-10-26) DumpFire follows the Kanban Method's split
between **upstream**, the ideas that may or may not be done (**options**), and **downstream**,
the work a team has committed to. The **commitment point** between them is recorded on every
card that crosses it. Choosing options to commit is **replenishment**; dropping one is a
**discard**.

Every delivery board has an **Options column** (card 2527): made with the board, and given to
every board made before by a start-up step, empty and folded to a strip at the far left.
Nothing else changes on a board until someone puts an idea there or makes an ideas board. Every
card made before the release counts as committed from the moment it was created, so no figure
moved at the deploy but one: a cycle time can no longer be negative or start after the card's
completion (the S4a review's H5), so a card moved between two Complete columns after it was
completed now shows 0 where it showed a negative cycle time.

This page is the one place that describes the feature whole. The detail of each part lives
where it belongs: [Feature Overview](feature-overview.md#the-options-column) (what users see),
[Admin Operations Guide](admin-guide.md#the-options-column) (operating it),
[Data Model](data-model.md#the-options-column-milestone-22) (fields and entries),
[Architecture](architecture.md#upstream-and-the-commitment-point) (the code),
[Management Activity Reporting](management-reporting.md#options-upstream-of-the-commitment-point),
[Burndown Charts](burndown-charts.md), [Critical-Path Planning](critical-path-planning.md#options-in-a-goal)
and `DUMPFIRE_API.md`, "Changes on 2026-10-26". The plan, with every review ruling, is
[`planning/milestone-22-upstream-kanban.md`](planning/milestone-22-upstream-kanban.md); the
Options column on every delivery board is
[`planning/2527-options-on-every-board.md`](planning/2527-options-on-every-board.md).

## Part one: the high level

### What counts as upstream

A card is **upstream**, an option, when its column is the board's **Options column** or any
column of an **ideas board**. Every other card is **committed**. One predicate decides it
everywhere, in the browser and on the server: `isUpstreamColumn(column, boardKind)` in
`src/lib/column-role.ts`, which is `role === 'options' || boardKind === 'ideas'`. Nothing takes a
card's empty `committed_at` to mean upstream: the column and the board decide.

```mermaid
flowchart LR
    subgraph IDEAS["Ideas board (boards.kind = 'ideas'): every column upstream"]
        I1["New Ideas"] --> I2["Shaping"] --> I3["Ready for Replenishment<br/>(a WIP limit makes it a replenishment queue)"]
    end
    subgraph DELIVERY["Delivery board (boards.kind = 'delivery')"]
        O["Options<br/>columns.role = 'options', on every delivery board<br/>leftmost, folded strip, no WIP limit"]
        CP{{"COMMITMENT POINT<br/>committed_at / committed_by<br/>card_committed"}}
        T["To Do"] --> P["In Progress"] --> H["On Hold"]
        P --> C["Complete<br/>(the delivery point)"]
        O --> CP --> T
    end
    I3 -- "Send to board: To its Options<br/>(still an option, card_sent)" --> O
    I3 -- "Send to board: Commit to its To Do<br/>(card_sent, then card_committed)" --> CP
    O -. "archive = discard (discarded_at, card_discarded)<br/>delete = card_discarded, then card_deleted" .-> X(("Discarded"))
    I1 -. "archive or delete = discard" .-> X
    T -. "moved back: returned to options<br/>commitment cleared" .-> O
    P -. "archived before Complete<br/>card_abandoned" .-> A(("Abandoned"))
    classDef up fill:#eef2ff,stroke:#6366f1;
    classDef down fill:#ecfdf5,stroke:#10b981;
    class I1,I2,I3,O up;
    class T,P,H,C down;
```

### The pieces

| Piece | What it is | Who can do it |
|---|---|---|
| **Options column** | One column of every delivery board, sub-boards included, titled **Options**, always the leftmost, with no WIP limit, folded by default to a strip showing how many options it holds, the oldest one's age and how many are over 30 days. Each viewer's open or folded choice is kept per board in their browser. It cannot be renamed, deleted or given away, and no other column can be called Options (card 2527) | Made with the board; nobody adds or removes one. Anyone who can edit the board folds it, colours it and sorts it |
| **Ideas board** | A board whose every column is upstream, made with New Ideas, Shaping and Ready for Replenishment. No Complete column, no burndown, no sub-boards, no delivery figures | Anyone who makes a board chooses the kind; the owner or an administrator changes it |
| **Converting a board** | A delivery board holding cards becomes an ideas board with its cards, in one recorded step | The board's owner or an administrator |
| **The commitment** | Moving an option into a committed column records when and by whom (`committed_at`, `committed_by`) | Whoever moves it |
| **Send to board** | An option goes to another delivery board: to its Options column, still an option, or to its To Do, which commits it | Anyone who can edit both boards |
| **Discard** | Archiving or deleting an option records it as discarded | Whoever archives or deletes it |
| **Abandoned** | Archiving committed work before it reached Complete records it as abandoned | Whoever archives it |

### The commitment point on a card

Every way a card changes column goes through one function (`moveCard`), so every route records
the commitment point the same way: a drag, the card menu's Move to, a bulk Move, the On Hold
confirmation, All Tasks' Move window, the card window's board picker, the API's move and Send.
Creation does too: a card created outside an upstream column is committed as it is created,
at its `created_at`, by its creator.

```mermaid
stateDiagram-v2
    Option: Option (committed_at NULL)
    Committed: Committed, not finished
    Completed: Completed (in a Complete column)
    Discarded: Discarded (archived_at and discarded_at)
    Abandoned: Abandoned (archived, no mark)
    Archived: Archived from Complete
    [*] --> Option: created in an Options column or on an ideas board
    [*] --> Committed: created in a committed column, committed_at = created_at
    [*] --> Completed: created in a Complete column, committed and completed at created_at
    Option --> Option: moved within upstream, or sent to another delivery board's Options (card_sent)
    Option --> Committed: moved out of upstream, or sent to a To Do (card_committed, card.committed)
    Option --> Completed: moved straight to Complete (card_committed then card_completed)
    Committed --> Option: moved back into upstream (card_returned_to_options, card.moved)
    Committed --> Option: its board converted (one summary entry, no webhook)
    Committed --> Completed: moved to Complete (card_completed)
    Completed --> Committed: reopened (card_reopened)
    Completed --> Option: moved into upstream (card_reopened then card_returned_to_options, one card.moved within one board)
    Option --> Discarded: archived (card_discarded, card.discarded)
    Discarded --> Option: restored, discard mark cleared (card_restored)
    Option --> [*]: deleted while live (card_discarded then card_deleted)
    Discarded --> [*]: deleted (card_deleted alone)
    Committed --> Abandoned: archived before Complete (card_abandoned, no webhook)
    Abandoned --> Committed: restored (card_restored)
    Abandoned --> Option: restored after its board was converted (card_restored)
    Completed --> Archived: archived (card_archived, no webhook)
    Archived --> Completed: restored (card_restored)
```

Moves the diagram does not show are refused with `409` and write nothing:

- An **archived** card never crosses the commitment point, either way (ruling n): `Card "<title>"
  is archived: restore it before moving it out of or back into Options`. A Send of an archived
  card is refused with the same `409` whichever column it is sent to, Options or To Do. A move of
  an archived card may still stay within one side.
- A **card with sub-boards is never an option** (ruling o, the S5a review's L6). A committed card
  with a sub-board cannot be moved into an upstream column, and a card with a sub-board cannot
  enter another board's upstream (Send to Options, or a move into another board's upstream
  column). A card already upstream with a sub-board, made before the rule, may still move within
  one board's upstream and out of it (the S2 review's C1). A conversion refuses such a card, and
  no sub-board is made under an option.

### How it shows in the figures

One rule: **a delivery measure counts committed cards on delivery boards only.** Options are
counted in figures of their own.

| Where | What changed |
|---|---|
| Board Statistics, delivery metrics | **Lead time (commitment to done)**, from `committed_at` to Complete (Complete is the delivery point, so customer and system lead time are the same here). **Cycle time**, start of work to done, never longer than the lead time. **Throughput** beside **Committed (all)**, the cards that arrived as committed work. **Abandoned**, committed work archived before Complete. The **Upstream** block: Committed from options, Options now, Returned to options, Discarded, Sent to other boards, Discard rate, Oldest option (days), Options over 30 days, Time in options. It shows, as **Show upstream** does, only where there is something to show: the Options column holds a card now, or a figure of the period is not zero (card 2527) |
| Board Statistics totals, average age, bars | Committed cards only, aging from `committed_at`; a line `Options N · discard rate X%` |
| Cumulative flow diagram | A delivery board's upstream columns are left out unless the viewer ticks **Show upstream**, which draws the Options band at the bottom with its top edge marked **commitment point**. The tick is offered only where there is something upstream to show, as above. An ideas board draws its own columns |
| Burndown | Committed cards only, each in scope from its `committed_at` |
| Dashboard, All Tasks, My Tasks | Committed cards only; a delivery board row gains its options count; All Tasks puts every board's options in one **Options** column, first, marked **not committed**, shown only while it holds cards |
| Goals and plans | Options counted apart (`optionsCount`, `progress.options`); an option is never startable or blocked, and still holds up what waits on it |
| Sub-board progress | An option on a sub-board does not hold back completing its parent card |
| Reports (PDF, mail, schedules) and the activity report | Options in no bucket or total; an **Upstream** line and an **Abandoned** line; neither in a report about one person |
| CSV exports | Two more columns at the end, **Stage** (Option or Committed) and **Committed** |
| Velocity, XP | Unchanged: completions only. An option moved straight to Complete is committed first, then completed |

### When to use options, and when not

These three points come from the plan review (ruling w):

- **Park ideas in Options, not in On Hold.** On Hold is committed work that is paused: every
  delivery figure counts it, its age included. An idea parked there reads as committed work going
  stale, and lengthens lead time when it is finally done. In the Options column it is counted as
  an option, aged as one, and committed only when someone moves it out.
- **An idea closed as not needed is discarded, not completed.** Moving an option straight to
  Complete is allowed (decision M22-7), for an idea that was done there and then. It is then
  committed and finished work, and throughput, lead time and the burndown count it as done. An
  idea that turned out not to be needed is archived instead, which records it as discarded and
  counts it in the discard rate.
- **Burndown is worked out from each card's current state.** A card moved back into the Options
  column leaves the scope of every past day as well, not only from today, and one committed today
  joins from today. A burndown already shared reads differently afterwards. Return work to options
  only when it really is no longer committed to.

## Part two: the low level

### Data model (migration 0060)

One migration, `drizzle/0060_add_upstream_options.sql`, carries the whole data model. `role`
and `kind` are free text checked in code, not a `CHECK`: `columns` and `boards` are tables the
start-up rebuilds from the model, and a `CHECK` would stop that rebuild.

```mermaid
erDiagram
    users ||--o{ cards : "created_by, committed_by, discarded_by (SET NULL)"
    boards ||--o{ columns : "board_id (CASCADE)"
    columns ||--o{ cards : "column_id (CASCADE)"
    boards ||--o{ activity_log : "board_id (CASCADE)"
    cards |o--o{ activity_log : "card_id (SET NULL)"
    boards {
        integer id PK
        text name
        integer parent_card_id FK "a sub-board is always delivery"
        text kind "NOT NULL DEFAULT 'delivery', or 'ideas'"
    }
    columns {
        integer id PK
        integer board_id FK
        text title "still decides Complete, On Hold and To Do"
        real position "the Options column is the lowest"
        integer wip_limit "0 on an Options column"
        text role "NULL, or 'options'"
    }
    cards {
        integer id PK
        integer column_id FK
        text created_at
        text completed_at "the delivery point"
        text archived_at
        text committed_at "NULL while an option, the column decides"
        integer committed_by FK
        text discarded_at "set with archived_at for an option"
        integer discarded_by FK
    }
    activity_log {
        integer id PK
        text action "card_committed, card_returned_to_options, card_discarded, card_abandoned, card_sent, column_converted_to_options, board_converted_to_ideas"
        text detail "ends (column to, from column from) on a commitment"
        text created_at
    }
```

| Field | Meaning |
|---|---|
| `columns.role` | `NULL`, an ordinary column whose title decides what it is, or `'options'`, the board's Options column: exactly one on every delivery board, titled Options, at its lowest position (card 2527) |
| `boards.kind` | `'delivery'` (every board before 0060, and the default) or `'ideas'`; any other value would count as delivery everywhere |
| `cards.committed_at`, `committed_by` | When and by whom the card crossed the commitment point; `NULL` while it is an option. `committed_by` is `SET NULL` when the account is deleted, as `created_by` is |
| `cards.discarded_at`, `discarded_by` | Set when an option is archived, in the same `UPDATE` as `archived_at`; cleared by a restore |
| `idx_cards_committed_by`, `idx_cards_discarded_by` | The indexes every foreign key column leads (card 2106) |

0060's one-off commits every card at its `created_at` by its `created_by`: before 0060 nothing
was upstream. `runBackfills` repeats three repairs at every start and after every restore: commit
a card not upstream that has no commitment, clear the commitment of an upstream card, and clear
the discard mark of a card that is not archived. At a start each has its own `WARN` line when it
changes anything (`Committed N card(s) that are not upstream …`, `Cleared the commitment on N
card(s) …`, `Cleared the discard mark on N card(s) …`); after a restore each has its own clause in
the restore's report (`committed_at and committed_by on N card(s) not upstream` in its "Filled
in" line, and `Cleared: the commitment of N upstream card(s), the discard mark of N card(s) that
are not archived.`, each part only when there were any). Each finds nothing at an ordinary
start; a count there means a write path forgot, or an older image was used meanwhile. Abandonment has no field: it is recorded in the activity log alone (decision
M22-21).

**Every delivery board's Options column** (card 2527) comes from a step that runs first in
`runBackfills`, at every start and after every restore, with no migration file: `columns.role`
exists from 0060. On a delivery board (`kind IS NOT 'ideas'`) it makes a second Options column
an ordinary column, the leftmost (lowest position, then lowest id) keeping the role, and clears
its cards' discard marks so that the backfill after it commits them; renames an Options column
with another title to Options; moves one that is not leftmost to one less than the lowest other
position; and gives a board with none one titled Options, colour `#8b5cf6`, at `MIN(position) -
1`, or 0 on a board with no columns. It writes no activity entry, webhook or mail. Its counts,
`optionsDemoted`, `optionsRenamed`, `optionsMoved` and `optionsAdded`, each have their own `WARN`
line at a start (`Added an Options column at the far left of N delivery board(s) that had none`,
and the like) and their own clause in the restore's report: the added, renamed and moved ones in
its "Filled in" line, the demoted ones in its "Cleared:" sentence (`the Options role of N second
Options column(s), each board keeping its leftmost`). The first start of the
image adds one to every delivery board; at any later start each count is 0.

```mermaid
flowchart TD
    Start["runBackfills, first step<br/>(every start, every restore)"] --> D{"two or more Options<br/>columns on a board?"}
    D -->|"yes"| Demote["the leftmost keeps the role,<br/>the others become ordinary columns,<br/>discard marks cleared (optionsDemoted)"]
    D -->|"no"| R
    Demote --> R{"titled other than Options?"}
    R -->|"yes"| Rename["renamed Options (optionsRenamed)"]
    R -->|"no"| M
    Rename --> M{"another column at or left of it?"}
    M -->|"yes"| Move["position = MIN(other positions) - 1<br/>(optionsMoved)"]
    M -->|"no"| A
    Move --> A{"a delivery board with none?"}
    A -->|"yes"| Add["Options, violet, role 'options',<br/>at MIN(position) - 1, or 0 (optionsAdded)"]
    A -->|"no"| Done["the commitment backfills run next"]
    Add --> Done
```

### The rules, where they live

| Rule | Where |
|---|---|
| Upstream predicate; `columnRoleOf` (role before title, so the Options column is never To Do, On Hold or Complete); `firstOpenColumn` skipping the Options column; `isQueueColumn` | `src/lib/column-role.ts` (browser-safe) |
| SQL fragment `UPSTREAM` / `notUpstream()` (with `IS`, so its negation keeps ordinary columns), `boardKinds`, `upstreamColumnIds`, `isUpstreamColumnId`, `commitmentOnCreation`, `optionsSince`, `upstreamFigures`, `committedAll`, `timeInOptions`, `cycleStarts`, `flowTimes`, `stageOf`, the entry suffixes | `src/lib/server/upstream.ts` |
| Column role on create, update and reorder; leftmost placement; the fixed Options column's rename, role, WIP and delete refusals (`fixedOptionsRefusal`, `optionsRoleRefusal`, `optionsPlacement`) | `src/lib/server/columns.ts` |
| Kind on create and update; the default columns, Options first on a delivery board (`DEFAULT_COLUMNS`, `makeDefaultColumns`); the empty switch; `convertBoardFor`; the sub-board refusals | `src/lib/server/boards.ts` |
| The start-up step that gives every delivery board its Options column | `src/lib/server/db/migrate.ts` (`runBackfills`) |
| The commitment on a move; the archived and sub-board refusals; `card_sent` on every cross-board move out of upstream | `src/lib/server/card-moves.ts` (`moveCard`) |
| Commitment on creation | `src/lib/server/card-create.ts` (`recordCardCreated`) |
| Send, and the boards it can go to | `src/lib/server/cards.ts` (`sendCard`, `sendTargetsFor`) |
| Discard and abandoned on archive and delete; the restore | `src/lib/server/deletes.ts`, `src/lib/server/card-restore.ts` |

**The Options column.** Every delivery board has exactly one, a fixed part of the board (card
2527, rulings O4 and O5). `role` is read with the column's own as `keep`, so an update that leaves
it out keeps it; anything but `'options'` or `null` is `400 role must be "options" or null, not
"<sent>"`. Each refusal is `409` with nothing written, after the `400` field reads, in this order:

1. On the Options column: a rename to anything but Options (`The Options column is always called
   Options.`), and `role: null` (`Every delivery board keeps its Options column.`).
2. A rename into or out of Complete while the column holds cards (card 2134).
3. On an ideas board, a title that means To Do, On Hold or Complete.
4. The role on any other column (`This board already has its Options column.`; on a board that
   has none yet, `A delivery board's Options column is made with the board; it comes back at the
   next start.`); any other column of a delivery board titled Options, trimmed and in any case
   (`Only the board's Options column is called Options. Choose another name.`); a WIP limit above
   0 on it; another column at or left of it.

A value sent back as the column holds it (" Options " included, compared trimmed) writes nothing
and is not refused. A column titled Options before this rule, with no role, is left as it is, and
refused only when its title is changed to something that still clashes. Deleting the Options
column is refused whether it is empty or not (`Every delivery board keeps its Options column.
Fold it away with the arrow on its strip instead.`); on the board page its menu offers neither
Rename nor Delete column, and its title is not renamed by a press. A column made on the board page
with no position goes straight after it (the board's columns renumbered first when no number is
left between); through the API it goes after the last. Nothing in the code assumes a delivery
board has one (a direct insert, or a board restored from an older backup, has none until the next
start): `firstOpenColumn` and the list view's default column never pick it, and answer none when
it is the only column.

**Ideas boards.** Made with New Ideas, Shaping and Ready for Replenishment. No column whose
title means To Do, On Hold or Complete, by `columnRole` (so Todo, Blocked, Parked, Waiting, Done
and the rest): create and rename are `409` (the S5a review's L1). WIP limits are allowed. A
column holding live ideas is not deleted (L2). A sub-board is a delivery board (`409 A sub-board
is a delivery board.`, on create and on re-parenting), and no sub-board is made under an option.
`PUT kind` changes an **empty** board only (no card, live or archived), the owner's or an
administrator's, replacing its columns with the other kind's (ruling j, decision M22-18).

**The board conversion** (ruling i). The body carries the count of live and archived cards the
caller saw; a different count now is `409 The board now holds K cards; look again.`. One
transaction clears `committed_at` and `committed_by` on every card on the board, archived ones
included, and writes one summary entry, with no entry, webhook or mail for each card. The empty
To Do, On Hold and Complete columns go, and so does the Options column when it holds no card,
live or archived (card 2527, ruling O7); one holding cards stays, its role cleared, an ordinary
column of the ideas board. The column conversion milestone 22 built (`POST /columns/:id/convert`)
went before release with card 2527: no column needs to become the Options column, since every
delivery board has one. Its entry, `column_converted_to_options`, is still read, so a dev
database's history still reads and ages its options, but nothing writes it.

```mermaid
flowchart TD
    Ask["count live + archived cards"] --> CB["POST /boards/:id/convert<br/>{kind: 'ideas', cards}"]
    CB --> RB{"409 checks in order:<br/>ideas already, card with sub-board,<br/>a sub-board, titled column holding cards,<br/>stale count"}
    RB -->|"pass"| TB["commitments cleared, empty titled columns<br/>and an empty Options column removed,<br/>Options role cleared, kind = ideas<br/>(no cards at all: ideas defaults)"]
    TB --> EB["board_converted_to_ideas"]
```

The summary entries' details, each ending with the id the option's age is read by:

| Entry | Detail |
|---|---|
| `board_converted_to_ideas` | `"<board>": N cards became ideas; its columns Options, To Do, On Hold, Complete were removed (board <id>)` (`its column Complete was removed` for one; no clause when none went; `1 card became an idea`). A board holding no card at all: `"<board>": 0 cards became ideas; its columns A, B were replaced with New Ideas, Shaping, Ready for Replenishment (board <id>)`, or `it was given the columns …` for a board with none |
| `column_converted_to_options` | Written only by milestone 22 builds before card 2527: `"<column>": N cards became options (column <id>)`, or `1 card became an option` |

Going back needs an empty board: making an ideas board a delivery board is refused while any card
is there.

**Send** (ruling l). Only an option is sent, to **another delivery board**. `to: 'options'` puts
it in that board's Options column (409 if it has none, a board not yet given one); `to: 'todo'` in its first column titled To
Do, else its first committed column that is neither Complete nor On Hold (`sendToTodoColumn`:
never On Hold; 409 if there is none). It is then a move in every way, with all of a move's
refusals, and the option's age kept. As any move to another board, it sheds the labels of the
board it leaves and a category or goal that belongs to another board; a category of no board,
and a goal across boards, stay.

```mermaid
sequenceDiagram
    participant U as Caller
    participant S as sendCard
    participant M as moveCard
    participant L as activity_log
    participant W as webhooks
    U->>S: POST /cards/:id/send {boardId, to: "todo"}
    S->>S: edit access to the card's board, fields, edit access to the target
    S->>S: 400 committed card, ideas board, own board. 409 archived, no column
    S->>M: applyCardMove(card, To Do of the target)
    M->>M: refusals of a move (sub-boards, loops, depth)
    M->>M: committed_at = now, committed_by = caller
    M->>L: card_sent on the board it left (one stamp)
    M->>L: card_moved_in on the board it joined (same stamp)
    M->>L: card_committed on the board it joined (same stamp)
    L->>W: card.moved to each board, card.committed to the board it joined
    S-->>U: the moved card (columnTitle, boardId, leftMilestone)
```

`card_sent` is written for **every** move of an option to another board, by Send or by an
ordinary move (the S5a review's L5), so "Sent to other boards" and the discard rate see every way
an option leaves. It sits in place of `card_moved_away`, and names neither board (card 2181).

### Activity entries and webhooks

| Entry | Written when | Detail | Label | Webhook |
|---|---|---|---|---|
| `card_committed` | A card leaves upstream for a committed column, by a move or a Send to To Do | `"<title>": <from> → <to> (column <to id>, from column <from id>)` | Committed card | `card.committed` |
| `card_returned_to_options` | A committed card is moved into an upstream column | `"<title>": <from> → <to>` | Returned card to Options | `card.moved` (the only webhook for that move, ruling q) |
| `card_discarded` | An option is archived, or deleted while live | `"<title>": discarded from <column>`, or `"<title>": deleted from <column>` | Discarded card | `card.discarded` |
| `card_abandoned` | Committed work not in a Complete column is archived, in place of `card_archived` | `"<title>": archived unfinished, from <column>` | Archived unfinished card | none |
| `card_sent` | An option moves to another board, on the board it leaves, in place of `card_moved_away` | `"<title>" sent to another board's Options (<from> → <to>)`, `… To Do (…)` or `… "<column>" column (…)`, ending ` and out of milestone "<name>"` (or ` and out of a milestone of another board`) when it left a goal | Sent card to another board | `card.moved` |
| `column_converted_to_options` | Nothing now: a column conversion of a milestone 22 build, before card 2527 took it out; still read and labelled | as in *The board conversion* above | Converted column to Options | none |
| `board_converted_to_ideas` | A board conversion, one per conversion | as in *The board conversion* above | Converted board to an ideas board | none |
| `card_restored` (unchanged action) | A discarded card is restored | `"<title>": back in <column>` | Restored card | none |

Within one board a move out of upstream sends `card.committed` **instead of** `card.moved`: a
receiver that lists only `card.moved` no longer hears it, as one without `card.completed` hears
no completion. Across boards each board is sent its own `card.moved` (`card_sent`,
`card_moved_in`), and the board it joins `card.committed` too. A webhook with an empty event list
receives everything, the two new events included. There are ten events.

### The upstream figures

`upstreamFigures(boardIds, from, to)` reads the activity log over a window that includes both
ends (the S3 review's E4), in four reads however many boards (E3). `null` for the boards means
every board.

| Figure | What it counts |
|---|---|
| `options` | Live cards in an upstream column now |
| `committedFromOptions`, `returnedToOptions`, `discarded`, `sentOn` | Distinct cards whose **last** upstream act in the window was a commitment, a return, a discard or a Send (ruling c). A deleted card's entries each count once. A Send whose target board is in scope is dropped, paired by the `card_moved_in` with the same card and stamp (ruling b) |
| `abandoned` | Distinct cards with a `card_abandoned` in the window, counted on their own (E1): a card committed and then abandoned counts as both |
| `discardRate` | `discarded / (discarded + committedFromOptions + sentOn)`, `null` when that is 0; abandoned work is not in it |
| `oldestOptionDays`, `agingOptions` | The oldest option's age in whole days, and how many are older than 30 days. An option's age runs from the latest of its creation, its latest return to options, and the latest conversion of its board (or of its column, in an entry written before card 2527) that made it one, counted only if the card has not arrived on the board since (`optionsSince`, decision M22-20, the S1b review's B2, the S4a review's H3). A Send keeps the age |

Beside them, for the board's metrics and the API: **Committed (all)** (`committedAll`), distinct
cards with a `card_committed` in the window plus cards created in it straight into a committed
column; and **Time in options** (`timeInOptions`), for each card whose last upstream act in the
window was a commitment, the commitment's moment minus when it became an option.

The time measures (`flowTimes`, `cycleStarts`):

| Measure | Rule |
|---|---|
| Lead time (commitment to done) | `completed_at − (committed_at ?? created_at)` |
| Cycle time (start of work to done) | From the earliest `card_moved`, or `card_committed` into a column that is not a queue, at or after the current `committed_at` and not after `completed_at`, clamped to [0, lead time] (ruling a, the S4a review's H1 and H5). A queue is the board's first committed column, a To Do or On Hold column, or a queue title (Backlog, Ready, Selected, Next and the like). A card created straight into a working column has no start at its creation: its cycle time runs from its first move after it, and it has none if it goes from there straight to Complete |

### API (version 1.3.0)

Every answer carries the new fields: `role` on columns, `kind` on boards, and `committedAt`,
`committedBy`, `discardedAt`, `discardedBy` on cards (read-only). New and changed operations:

| Operation | Body or query | Notes |
|---|---|---|
| `POST /api/v1/boards/{boardId}/columns`, `PUT /api/v1/columns/{columnId}` | `role` | The Options column's rules above: made with the board, it is never created, given or taken away |
| `DELETE /api/v1/columns/{columnId}` | | `409` for the Options column, empty or not |
| `POST /api/v1/boards`, `PUT /api/v1/boards/{boardId}` | `kind` | A change is the owner's or an administrator's, of an empty board only |
| `POST /api/v1/boards/{boardId}/convert` | `{"kind": "ideas", "cards": N}` | Owner or administrator; answers the board with its columns |
| `GET /api/v1/boards` | `?kind=delivery` or `?kind=ideas` | `kind=delivery` is every board that is not an ideas board |
| `GET /api/v1/boards/{boardId}/cards` | `?stage=option` or `?stage=committed` | By the column each card is in; with `archived=true`, archived cards too |
| `POST /api/v1/cards/{cardId}/send` | `{"boardId": N, "to": "options" \| "todo", "position"?: N}` | Answers the moved card |
| `GET /api/v1/boards/{boardId}/upstream` | `?days=N`, 1 to 365, 30 by default | View access; `{boardId, kind, days, period, …figures, committedAll}` |
| `PUT /api/v1/cards/{cardId}/move`, `DELETE /api/v1/cards/{cardId}`, `PUT … archivedAt: null` | as before | Record the commitment, the discard, the abandonment and the restore |
| `GET /api/v1/me/stats` | | `avgLeadTimeDays` added; `avgCycleTimeDays` the same value, kept for history |

### The tracking wrapper

`.agent/scripts/dumpfire-api.ps1` (card 2465) covers all of it, and its reference
(`.agent/workflows/dumpfire-api-reference.md`, *Upstream*) lists each request:
`create-board -Kind ideas`, `update-board -Kind delivery|ideas`, `convert-board -BoardId N
-Cards N`, `send-card -CardId N -BoardId N -To options|todo [-Position N]`, `upstream -BoardId N
[-Days N]`, `boards -Kind delivery|ideas` and `cards -Stage option|committed`. Card 2527 took
`convert-column` and `-Role` out before release: every delivery board has its Options column, so
the wrapper neither makes nor converts one. `-Cards` is checked to be a whole number, and
`send-card`'s `-BoardId` and `-To` to be there, before any request. `convert-board` is a
destructive action, as every `delete-*` is: a typed `yes` in a terminal, refused
non-interactively and through from-file, since it clears commitments for good and is the board
owner's step. `-Compact` keeps `committedAt`,
`discardedAt`, `role` and `kind`; `upstream` ignores it and prints its figures whole.

The tracking workflow (`dumpfire-tracking.md`, *Upstream*) gives the guidance above to the
agents that keep the board, with one rule of its own: **a discard is the owner's step**.
`delete-card` is destructive and the API refuses an archive by `PUT`, so an agent asks the user
to discard an idea (Archive on the board page, or `delete-card` typed in a terminal) and never
moves an option to Complete in its place, which would commit it and count it as finished work.

Against a server older than 1.3.0 the three new operations answer `404`; `update-board -Kind`
sent alone answers `400 No valid fields to update`, and with other fields the kind is dropped;
`-Kind` on `create-board` and `boards`, and `-Stage` on `cards` are ignored; and its boards have
no Options column.

### Restores and older images

A backup made before 0060 restores with every board a delivery board, nothing discarded and
every card committed from its creation: the same boards, no figure changed, and the start-up step
that runs after the restore gives each delivery board its empty, folded Options column (card
2527). A
backup made after 0060, put into an older image, keeps the new columns but the older image does
not keep them up to date: cards it creates get no commitment, and cards it moves out of Options
are not stamped, so going forward again the start-up backfill commits them from `created_at`,
which lengthens their lead time.

An image from before 0060, the live image before milestone 22's deploy, shows the Options column
as an ordinary column called Options at the far left of every board, and anything it puts "in the
first column" lands there. Coming forward again, cards left in it are uncommitted options, out of
sight in the folded strip. A milestone 22 build from before card 2527 let the role be taken off an
empty Options column: going back to one, doing that, and coming forward leaves a second, plain
column called Options beside the new one. [Deployment](deployment.md) says what to check either
way.

### Not built in this milestone

Recorded in the plan for later cards: a replenishment view and minimum limits (a replenishment
cadence, a minimum on Ready for Replenishment); a per-board rule on who may commit; discard
reasons, as `close_reason` is for completions.
