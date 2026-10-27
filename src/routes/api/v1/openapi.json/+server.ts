import { json } from '$lib/server/v1-json';
import type { RequestHandler } from './$types';

const spec = {
	openapi: '3.1.0',
	info: {
		title: 'DumpFire API',
		version: '1.3.1',
		description:
			'REST API for the DumpFire Kanban board. Automate card creation, movement, assignments, and more.\n\n' +
			'**Failures.** Every failure DumpFire answers under /api/v1/ is JSON with a `message` that says why, as in ' +
			'{"message": "Card not found"}, whatever Accept header the request sent. That includes a path that is no route ' +
			'(404, {"message": "Not found"}) and a method the route does not have (405, with an Allow header naming the ones it has). ' +
			'Some failures carry more beside the message: a 429 has `retryAfterSecs`, the 409 for a dependency that would close a loop has `cycle`, ' +
			'and the 409 for a batch that was refused lists every item of it that was at fault.\n\n' +
			'**Changed on 2026-10-27 (version 1.3.1).** Corrections to answers: (1) GET /api/v1/reports/activity puts a card in the created bucket when it was raised in the window, not edited since and no move of it is recorded in the activity log ' +
			'(card_moved, card_moved_in, card_moved_away, card_sent, card_committed, card_returned_to_options or card_reopened, in either spelling); a card raised before 2026-10-01, when the board\'s drag route recorded no move, must also still be in the board\'s first column that is not an Options column. ' +
			'Until this release every card had to be, so a card raised in another column and left alone was progressed (card 2480); ' +
			'(2) POST /api/v1/boards/{boardId}/columns stores the wipLimit sent, read as PUT /api/v1/columns/{columnId} reads it, and 0 when it is left out. Until this release a limit sent with a new column was not stored (card 2520); ' +
			'(3) GET /api/v1/me/stats leaves archived cards out of avgLeadTimeDays and avgCycleTimeDays, as the board metrics leave them out of theirs. Until this release an archived completed card assigned to the user was averaged. ' +
			'cardsCompleted and streak are unchanged: they count the completions the user made, archived cards included, as archiving a card afterwards does not undo the work (card 2541).\n\n' +
			'**Changed on 2026-10-26 (version 1.3.0).** Upstream of the commitment point: options, committed work and ideas boards (milestone 22). Three operations and two filters are new, and these answers and fields changed: ' +
			'(1) a card is an **option**, upstream of the commitment point, when it is in a board\'s Options column (a column whose role is options) or in any column of an ideas board (a board whose kind is ideas); every other card is committed work. ' +
			'Every delivery board has its Options column, made with it, and one made before this release is given an empty one at the far left when the server starts (item 3); no board is an ideas board until someone makes one. Every card made before this release is committed, its committedAt being its createdAt, and a board answers every operation as before but for its Options column among its columns, the fields named here and the entry an archive of unfinished work writes (card_abandoned, item 12); ' +
			'(2) every column carries role, "options" for the board\'s Options column and null for any other: POST /api/v1/boards/{boardId}/columns and PUT /api/v1/columns/{columnId} take role, "options" or null (left out on PUT, kept), ' +
			'anything else 400 role must be "options" or null, not <what was sent>; and each answers 409, writing nothing, for "options" on any other column (`This board already has its Options column.`; on a board that has none yet (made before this release, or restored from a backup), until the next start, `A delivery board\'s Options column is made with the board; it comes back at the next start.`; or on a column of an ideas board, every column of which is upstream), ' +
			'for any other column of a delivery board called Options, in any case (`Only the board\'s Options column is called Options. Choose another name.`), for the Options column renamed to anything but Options (`The Options column is always called Options.`) or given role null (`Every delivery board keeps its Options column.`), ' +
			'for a WIP limit above 0 on the Options column, and for a position at or left of the Options column, which stays the leftmost; a value sent back as the column holds it changes nothing and is not refused; PUT counts role among its six fields; ' +
			'and DELETE /api/v1/columns/{columnId} answers 409 for the Options column, empty or not (`Every delivery board keeps its Options column. Fold it away with the arrow on its strip instead.`), and for a column of an ideas board that holds cards not archived: ' +
			'ideas are moved out, or archived to discard them, not deleted with their column; ' +
			'(3) every delivery board has one Options column, made with the board and by a start-up step for existing boards; it cannot be renamed to anything but Options, deleted or given away: POST /api/v1/boards makes a delivery board with Options, To Do, On Hold, In Progress and Complete, in that order, ' +
			'and when the server starts, each delivery board that has none is given one, empty, titled Options, at its far left, writing no entry and sending no webhook; ' +
			'(4) every board carries kind, "delivery", which every board was, or "ideas": POST /api/v1/boards takes kind, and makes an ideas board with the columns New Ideas, Shaping and Ready for Replenishment (409 `A sub-board is a delivery board.` with a parentCardId, ' +
			'and 409 for a sub-board under an option); PUT /api/v1/boards/{boardId} takes kind, kept when it is left out or sent as the board holds it: a change is the board\'s owner\'s or an administrator\'s (403), and of an empty board only, no card live or archived, whose columns are replaced with the other kind\'s, ' +
			'and it is 409 for a sub-board and for a board holding cards (giving it the ideas kind, the message names POST /api/v1/boards/{boardId}/convert; back to delivery, it says to move the cards to a delivery board or delete them first); PUT counts kind among its five fields; and a column of an ideas board whose title makes it To Do, On Hold or Complete is 409 on create and on rename; ' +
			'(5) POST /api/v1/boards/{boardId}/convert is new: the board\'s owner or an administrator makes a board an ideas board with the cards it holds, {"kind": "ideas", "cards": <the live and archived cards seen>}; every card becomes an option, ' +
			'its empty To Do, On Hold, Complete and Options columns go (an Options column holding cards stays, an ordinary column; a board with no card at all is given the ideas board\'s columns), and one api:board_converted_to_ideas entry is written, with no webhook; it answers the board with its columns; ' +
			'(6) GET /api/v1/boards takes kind=delivery or kind=ideas, which lists only the boards of that kind the key\'s user can open; anything else is 400 kind must be "delivery" or "ideas", not <what was sent>; ' +
			'(7) every card answer carries committedAt and committedBy, when and by whom the card crossed the commitment point (null while it is an option), and discardedAt and discardedBy, set when it is archived as an option and cleared by its restore; ' +
			'no operation takes them in a body: a move, a creation, an archive, a restore and a conversion set them; ' +
			'(8) GET /api/v1/boards/{boardId}/cards takes stage=option or stage=committed, by the column each card is in, archived cards included with archived=true; anything else is 400 stage must be "option" or "committed", not <what was sent>; ' +
			'(9) POST /api/v1/boards/{boardId}/cards commits a card created outside an upstream column as it is created, committedAt its createdAt and committedBy the key\'s user, with no entry beyond api:card_created; one created in an Options column or on an ideas board is an option; ' +
			'(10) PUT /api/v1/cards/{cardId}/move records the commitment point: a move out of an upstream column into a committed one sets committedAt and committedBy and writes api:card_committed in place of api:card_moved, ' +
			'`"<title>": <from> → <to> (column <to id>, from column <from id>)`, sending card.committed, within one board instead of card.moved (straight into Complete, api:card_committed then api:card_completed, and card.committed then card.completed); ' +
			'across boards each board is still sent its own card.moved, the board it left with card_sent and the board it joins with card_moved_in, and the board it joins card.committed after it; ' +
			'a move back into an upstream column clears both and writes api:card_returned_to_options, sending card.moved (from Complete, api:card_reopened then api:card_returned_to_options, with the one card.moved); ' +
			'it answers 409 for an archived card crossing the commitment point either way, for a committed card with a sub-board going into an upstream column, and for a card with a sub-board going into another board\'s upstream; ' +
			'and an option moved to another board writes api:card_sent on the board it leaves, in place of api:card_moved_away; ' +
			'(11) POST /api/v1/cards/{cardId}/send is new: an option is sent to another delivery board, {"boardId": <board>, "to": "options" | "todo"}, into its Options column, still an option, or its To Do, which commits it; ' +
			'edit access to both boards; it answers the moved card, 400 for committed work, an ideas board or the card\'s own board, and 409 for an archived card, a board with no Options column or no column to commit into, and the refusals of a move; ' +
			'(12) DELETE /api/v1/cards/{cardId} records what it archives: an option is **discarded**, discardedAt and discardedBy set with archivedAt, writing api:card_discarded and sending card.discarded; ' +
			'committed work not in a Complete column is **abandoned**, api:card_abandoned, with no webhook; and api:card_archived is written only for a card archived from a Complete column. A live option deleted with ?permanent=true writes api:card_discarded and then api:card_deleted, ' +
			'and sends card.discarded and then card.deleted; archivedAt null on PUT /api/v1/cards/{cardId} restores a discarded card as an option, clearing discardedAt and discardedBy; ' +
			'(13) **the activity vocabulary changes**, for readers of GET /api/v1/audit-log, GET /api/v1/reports/activity and recentActivity on GET /api/v1/me/stats: seven actions are new, card_committed, card_returned_to_options, card_discarded, card_abandoned, card_sent, ' +
			'column_converted_to_options, which nothing writes now (the column conversion it recorded went before this release), and board_converted_to_ideas, each stored with api: when made through the API; and three are written less: card_archived only for work archived from Complete, unfinished committed work being card_abandoned and an option card_discarded, ' +
			'so a filter or a count of card_archived alone misses both; card_moved not for a move across the commitment point, card_committed or card_returned_to_options being written in its place; and card_moved_away not for an option leaving its board, which is card_sent. Entries written before are unchanged; ' +
			'(14) two webhook events are new, card.committed (a card moved out of an upstream column into a committed one, by any route, a Send to To Do included; data.action card_committed) and card.discarded (an option archived, or a live option deleted for good; data.action card_discarded; before card.deleted, with the card\'s id, for a delete), ' +
			'making ten, each of which can be named in events; **a webhook whose events list is empty is sent every event, so one made before this release receives both**; a webhook that lists card.moved and not card.committed no longer hears a move out of an Options column within one board ' +
			'(a move to another board still sends each board its own card.moved, card_sent and card_moved_in, and the board it joins card.committed too), ' +
			'as one that lists card.moved and not card.completed hears no completion; and card.moved also carries data.action card_returned_to_options, a card moved back upstream, and card_sent, an option sent or moved to another board, on the board it left: ' +
			'a move from a committed column of another board into upstream sends the board it joins two card.moved, card_moved_in and card_returned_to_options; ' +
			'(15) every delivery measure leaves options out: GET /api/v1/burndown charts committed cards only, each from its committedAt, worked out from each card as it is now, so a card returned to options leaves the past scope too; ' +
			'GET /api/v1/reports/activity puts no option in a bucket or a total, takes the created bucket\'s first column to be the board\'s first column that is not an Options column, and answers upstream, the boards\' upstream figures (null for a report on one user); ' +
			'GET /api/v1/milestones counts options in optionsCount and not in cardCount or doneCount, and GET /api/v1/milestones/{milestoneId}/summary in progress.options alone, each node with isOption, an option never in nextActionable and still an open blocker in the graph; ' +
			'and GET /api/v1/me/stats leaves options out of activeCards and of the average; ' +
			'(16) GET /api/v1/boards/{boardId}/upstream is new, with view access to the board: over the last days days (?days=, a whole number from 1 to 365, 30 by default), the board\'s options now and how long they have waited, how many cards were committed from options, ' +
			'returned to options, discarded, sent on and abandoned, the discard rate, and committedAll, "Committed (all)": the cards that arrived as committed work, each counted once, which credits a card created committed to the board it is on now and counts a card created and then returned to options as no arrival; ' +
			'(17) GET /api/v1/me/stats answers avgLeadTimeDays, the average days from commitment to done over the completed cards assigned to the key\'s user on boards they can open, and avgCycleTimeDays at the same value: it is a lead time, ' +
			'named cycle time for history, and kept so that no caller breaks; for a card made before this release the commitment is its creation, so the figure is as it was.\n\n' +
			'**Changed on 2026-10-14 (version 1.2.0).** New answers and fields, and one new operation, (85): (1) a 413 for a body over the size limit carries `limitBytes`, ' +
			'the limit as a number, beside its `message`; (2) a 413 for a body that declares more than the limit in Content-Length is answered ' +
			'before the key is looked at, so a request with no key, or a wrong one, can be answered 413 where it was 401; (3) a request with no key ' +
			'DumpFire accepts, a missing Authorization header included, is counted against the address it came from (an IPv6 address by its /64 network: (51)), 60 a minute, and the ' +
			'61st is answered 429 with `retryAfterSecs` and Retry-After where it was 401; (4) a body sent with no Content-Length, in chunks, is ' +
			'held to the same limit as it is read, and answered 413 with `limitBytes` once it passes it; (5) a body that is a JSON array, `[]` ' +
			'included, is answered 400, {"message": "The request body must be a JSON object"}, before the operation reads a field of it, where ' +
			'it was passed to the operation, which refused it in its own words as a body without the fields it needs; (6) the operations that create a column, ' +
			'a label and a category on a board answer 404, {"message": "Board not found"}, for a board that does not exist, to every caller, where everyone but ' +
			'an administrator was answered 403 and an administrator 500; (7) every operation that reads a body reads it before it looks for the resource or ' +
			'checks the key\'s user, so a body that is missing, is not valid JSON or is not an object is answered 400 to a caller who would be refused, ' +
			'where some were answered 403 or 404; what a field holds is still looked at after the 404 and the 403; (8) the operations that create or change a ' +
			'column, a label, a category or a webhook, that change a board category, and that put a label on a card or take it off, answer 400 naming the field for a ' +
			'field of the wrong type or one it may not hold, where it was stored as sent or was a 500: a name or a title is text, trimmed, of 1 to 200 ' +
			'characters, a colour written #rrggbb (item 52), a position a number, showAddCard and active true or false, a webhook\'s url an http or https address of at ' +
			'most 2048 characters, its secret at most 256 characters and its events names among the six webhook events there were then (ten since 2026-10-21), each trimmed, and an id in the path or the body a ' +
			'whole number of 1 or more; a value the row already holds, sent back unchanged, is accepted as it is; (9) taking a label off a card that does ' +
			'not have it is answered 404 where it was 200, and a label, column, category, board category or webhook deleted while its update was arriving ' +
			'is answered 404 where it was 200 with no body, or for a webhook 500; (10) the four operations that add or remove one dependency, on a card ' +
			'and on a subtask, read their ids as ids: one in the path of 0, 1.5 or -1 is answered 400, "Invalid card ID" or "Invalid subtask ID", ' +
			'where it was 404, and 1e3, which was read as the id 1000, is answered 400 too; one in the body of 0, -1, 1.5, "" or false is answered 400, "<field> must be an id", where it was 404, as are true ' +
			'and a list, which were read as card 1 and as the id in the list; and the subtask\'s two record an api:dependency_added and an ' +
			'api:dependency_removed activity entry, as the card\'s do; (11) adding a comment to a card answers 400 for content that is not text, ' +
			'"content must be text", where it was a 500, and for content over 50000 characters once trimmed, "content must be at most 50000 characters", ' +
			'where any length was stored: an edit was already held to 50000; (12) the activity report does not count a dependency added or removed ' +
			'(dependency_added, dependency_removed, dependencies_bulk_added, in either spelling) as an action on a card, so a card whose only activity in ' +
			'the window was one is not in the report, and a report on one user does not take a card to be theirs for one; (13) a member of a board stored ' +
			'with a role other than owner, editor or viewer, which the web application\'s sharing stored as sent until this date, has a viewer\'s access: ' +
			'one stored as admin had an administrator\'s access to that board; ' +
			'(14) every operation reads an id in its path as an id: one that is not a whole number of 1 or more written in digits, 1.5, abc and 1e3 among them, is answered 400 "Invalid <thing> ID", where some were read as another id and answered 404 or 403; ' +
			'(15) a board that does not exist is answered 404 "Board not found", to every caller, by GET, PUT and DELETE on /api/v1/boards/{boardId} and by the lists of its cards, columns, labels and categories, where everyone but an administrator was answered 403, and an administrator an empty list; ' +
			'(16) the operations that create or change a board, a board category, a card, a subtask or a milestone, that move a card, assign and remove an assignee, edit a comment and put a card into a milestone or take it out, read their fields by type and range, and answer 400 naming the field where a value was stored as sent or was a 500: a name is text of 1 to 200 characters once trimmed and a title of 1 to 500, an emoji 1 to 32, a description and an on-hold note at most 50000, a businessValue at most 10000, a coverUrl a colour written #rrggbb, one of the preset gradients or null (item 41), a priority one of low, medium, high and critical in any case, stored in lower case, a dueDate or a targetDate a day of the calendar written YYYY-MM-DD, empty text or null clearing it, a colorTag a colour written #rrggbb or empty, a board category\'s color a colour written #rrggbb, a position a number or one written as text, pinned and completed true or false, a status open or closed, and an id in the body a whole number of 1 or more; a value the row already holds, sent back unchanged, is accepted as it is; and each of them looks for what its path names, and checks the caller, before it reads a field, so a caller who would be refused is answered 404 or 403 whatever the body holds, where editing a comment and the two operations on /api/v1/milestones/{milestoneId}/cards answered a field first; ' +
			'(17) archivedAt on PUT /api/v1/cards/{cardId} may only be null, which restores the card: another value, which was stored, is answered 400; archivedAt null sent with a milestoneId restores the card before it is put in the milestone, where the card was refused as archived, and a milestone refused leaves it archived; ' +
			'(18) a card\'s categoryId must name a category of the card\'s board or one that belongs to no board, and is answered 404 "Category not found on this board" otherwise, where another board\'s was stored and one that did not exist was a 500; ' +
			'(19) removing an assignee who is not on the card is answered 404 "User is not assigned to this card", where it was 200 with an activity entry; ' +
			'(20) DELETE /api/v1/milestones/{milestoneId}/cards answers 404 "Card is not in this milestone" for a card that is not in it, where a card in another milestone was taken out of that one; taking a card out of a milestone, there or with milestoneId null on PUT /api/v1/cards/{cardId}, needs the right to change the milestone it is in, 403 "No edit access to this milestone", or "No access to this milestone" for one with cards on a board the key\'s user cannot open; ' +
			'putting a card that is in another milestone into this one takes it out of that one, and needs the right to change that one too: POST /api/v1/milestones/{milestoneId}/cards and milestoneId on PUT /api/v1/cards/{cardId} answer 403, and POST /api/v1/milestones/{milestoneId}/cards/bulk lists the card in its 409, "No edit access to milestone #<id>, which holds card #<n>", where each moved the card; and putting an archived card into a milestone is answered 400 "Card does not exist or is archived", as the bulk operation refuses one, where it was put in; ' +
			'(21) in a batch, an entry of links or of entries that is not an object is answered 400 "links[<n>] must be an object", where it was a 500, an entry of cardIds that is not an id "cardIds[<n>] must be an id", where null was read as card 0, and a blockedType or blockerType other than card or subtask is answered 400, where it was a 409; ' +
			'(22) GET /api/v1/audit-log reads limit and offset as whole numbers, a limit held between 1 and 500, 0 being the default of 100 as it was, and an offset of 0 or more, where -1 gave every entry, 2.5 was a 500 and a negative offset was echoed, and its boardId, userId and cardId as ids; ' +
			'(23) GET /api/v1/reports/activity answers 400 "from is not a date" for a from or to that is neither a date nor a timestamp, where it was taken as the window, reads a timestamp with an offset or no zone in UTC, gives each card an empty comments list for commentLimit=0, where 0 was read as 3, answers 400 for a negative commentLimit, where comments were left out, and reads each of boardIds as an id, where one that was not was left out; ' +
			'(24) GET /api/v1/me/stats answers an average cycle time of 0 as 0, where it was null; ' +
			'(25) the compact milestone summary has the titles of cards in cardTitles and of subtasks in subtaskTitles, where both were in cardTitles under the bare id; ' +
			'(26) adding a comment to a card looks for the card, and checks the key\'s user, before it reads the content, so a card that is not there is answered 404 and a user who may not edit its board 403 whatever the content, where an empty one was answered 400 first; ' +
			'(27) POST /api/v1/dependencies/bulk reads each end of a link and each entry of chain as an id, and answers 400 "<entry> must be a card id, \\"subtask:<id>\\", or {kind, id}", naming the entry, for one that is not a whole number of 1 or more, a list, or an object whose kind is not card or subtask, where 1.5 and "1e3" were taken as ids and reported in the 409, a list was read as the id in it and another kind as a card; ' +
			'(28) GET /api/v1/reports/activity reads a bare-date to as the end of that day when it checks that from is not after it, where from=2026-10-14T09:00:00Z&to=2026-10-14 was answered 400; ' +
			'(29) a webhook\'s url is answered, as its secret is, only to the board\'s owner and an administrator and in the answer to the request that created it: the two reads and the answer to an update leave the key out for anyone else, where every caller who could view the board was given it; ' +
			'(30) recentActivity on GET /api/v1/me/stats lists only entries on boards the key\'s user can open, the 20 counted after that, where an entry on a board they had been taken off was listed with the card title in its detail; ' +
			'(31) GET /api/v1/board-categories lists the board categories that hold a board the key\'s user can open, and those that hold no board, where every one was listed; GET /api/v1/board-categories/{categoryId} answers 403 "No access to this board category" for any other, where it was given; ' +
			'GET /api/v1/burndown with the boardCategoryId of one answers 403 "No access to board category <id>", where it was charted empty with the category\'s name; and PUT /api/v1/boards/{boardId} answers 403 "No access to this board category" for a categoryId that names one, where the board was filed under it; ' +
			'(32) GET /api/v1/categories/{categoryId} answers 403 "No access to this category" for a category of a board the key\'s user cannot open, where any key was given any category; ' +
			'(33) work on a board the key\'s user cannot open, at the other end of a dependency or in a milestone\'s plan, is listed withheld, with withheld true: ' +
			'its id, kind and whether it is finished, "A card on a board you cannot open" or "A subtask on a board you cannot open" for its title, "A board you cannot open" ' +
			'for its board name, an empty column title, and null for its board id, column id, priority and milestone, with no parentCardId on a withheld subtask of a plan, ' +
			'where its title, board, column and priority were given: by GET /api/v1/cards/{cardId}, GET /api/v1/cards/{cardId}/dependencies, the three operations on ' +
			'/api/v1/subtasks/{subtaskId}/dependencies, and GET /api/v1/milestones/{milestoneId}/summary, whole and compact, and its PDF; every dependency end and plan node ' +
			'carries withheld; and the summary\'s progress counts the cards on such boards under one entry of boards with id null and an empty column title, where it named each board, ' +
			'while its criticalPath, worked out from the real work, gives the id of the card a withheld subtask on the chain belongs to, as for any subtask; ' +
			'(34) GET /api/v1/milestones/{milestoneId} lists a card on a board the key\'s user cannot open withheld, as the summary lists its node, with withheld on every card, ' +
			'where a card moved off the milestone\'s board, which kept the milestone until (60), was listed with its title and board; GET /api/v1/burndown with a milestoneId charts only ' +
			'the milestone\'s cards on boards the key\'s user can open and says in meta.notes how many it leaves out, where such a card was charted and its board named; and ' +
			'DELETE /api/v1/boards/{boardId} deletes the board\'s card categories, and those of every sub-board deleted with it, so that a card on another board that carried one has none, ' +
			'where they were kept as categories of no board, which every key is given; ' +
			'(35) PUT /api/v1/columns/{columnId} answers 409 for a title that would make the column a Complete column (one called Complete or Done), or stop it being one, ' +
			'while it holds any card, archived ones included, and writes nothing, where the title was saved and every card in the column became finished, or open, by its new title alone; ' +
			'(36) POST /api/v1/boards/{boardId}/cards completes a card created in a Complete column as a move into one does: completedAt and firstCompletedAt are set, the key\'s user is given the XP for its priority, ' +
			'and api:card_created and then api:card_completed are written, which deliver card.created and card.completed, where the card was created with no completion date, no XP and no api:card_completed; ' +
			'(37) PUT /api/v1/cards/{cardId}/move mails the card\'s assignees who can open its board "Card moved" for a move that completes it, where no move through the API mailed them, and no move mails the user who made it; ' +
			'(38) archivedAt null on PUT /api/v1/cards/{cardId} is recorded as api:card_restored, and api:card_updated is written only for the other fields sent, so a restore alone no longer delivers card.updated; ' +
			'(39) completing a subtask with PUT /api/v1/subtasks/{subtaskId} writes api:subtask_completed and mails whoever asked for the card, and DELETE /api/v1/subtasks/{subtaskId} writes api:subtask_deleted, where neither wrote an entry; ' +
			'(40) in the action of GET /api/v1/audit-log only a trailing * is a wildcard, so card_* no longer finds cards_purged and cards_cleared; ' +
			'(41) coverUrl on PUT /api/v1/cards/{cardId} is a colour written #rrggbb, one of the eight preset gradients the updateCard body lists, empty text or null, and anything else is answered 400 ' +
			'"coverUrl must be a colour written #rrggbb, one of the preset gradients, or null", where any value was stored, an address or a style included; a cover is drawn on every viewer\'s page, as a strip across the top of the card on the board; ' +
			'a cover the card already holds, sent back unchanged, is accepted as it is; and recurrenceRule and nextRecurrence, which every card answer still carries, are described as not used: nothing sets or acts on them; ' +
			'(42) PUT /api/v1/cards/{cardId}/move answers 409 `Card "<title>" cannot go onto "<board>", which hangs beneath it` for a move onto one of the card\'s own sub-boards, ' +
			'or onto a board beneath one at any depth, and moves nothing, where it was answered 200 and the sub-board then hung beneath itself, on no dashboard; it is asked only of a move to another board, and a move of the card such a loop already hangs from onto a board outside the loop is not refused for it; ' +
			'(43) assigning a user to a card, removing one, editing a comment, creating a board, updating one and creating a milestone on a board in the web application write the entry the operation here writes, stored without api: and with source ui, ' +
			'and accepting a task request with an assignee writes assignee_added, so GET /api/v1/audit-log, GET /api/v1/reports/activity and recentActivity on GET /api/v1/me/stats hold them, where the web application wrote none; ' +
			'and POST /api/v1/boards with a parentCardId sends the board that card is on a live update, so that the sub-board shows on its card on the pages open there, where it sent none; its answer is unchanged; ' +
			'(44) PUT /api/v1/cards/{cardId} records only what it changes: a field sent with the value the card already holds is not a change, null and empty text being the same value when comparing (description, onHoldNote and businessValue still take text only, and empty text clears them), so a request that changes nothing writes nothing, records no activity entry, sends no card.updated and answers 200 with the card as it is, and api:card_updated names only the fields that changed, where every field sent was written and named; ' +
			'(45) a move out of an On Hold column (one titled On Hold, Hold, Blocked, Parked or Waiting) to one that is not clears the card\'s onHoldNote, by PUT /api/v1/cards/{cardId}/move and by every move in the web application, with no entry beside the move\'s own, where only a drag on the board page cleared it; ' +
			'(46) an archived card on a sub-board holds nothing back: PUT /api/v1/cards/{cardId}/move to a Complete column is still refused 409 for open subtasks, and the sub-board part of the check counts only cards on the card\'s sub-boards that are not archived and not in a Complete column, and the refusal counts those alone, in the same words, where an archived card held the card back and was counted, so a card held back only by archived cards could not be completed; ' +
			'(47) costUsd on the token answers prices claude-opus-5-5 at its own rate, $4 / $20 per million with cache reads at $0.20, where it was priced as claude-opus-5 at about twice that, ' +
			'and prices claude-sonnet-5-5 and claude-haiku-5-5 (at its rate for prompts of 100K tokens or fewer), where Haiku 5.5 was unpriced; a model id that is a listed one followed by a version ' +
			'DumpFire does not list (claude-opus-5-6) is unpriced and counted in unpricedTokens, where it was priced as the shorter id; cost is worked out when it is read, so these re-price past entries; ' +
			'the totals POST /api/v1/tokens/bulk answers for each card price each entry as GET /api/v1/cards/{cardId}/tokens does, where a model with a measured entry and an entry with no breakdown was priced as a whole at the 90/10 blend, several times its cost; ' +
			'(48) GET /api/v1/burndown answers forecast.spansBoards, true when the cards that pass the filters sit on more than one board, and each breakdown row\'s forecast carries its own; ' +
			'the forecast\'s dates are then pooled across boards and are not when the work finishes, which delivery dates board by board; every other field and value is as before. ' +
			'(49) GET /api/v1/milestones/{id}/summary answers progress.totalSubtasks, every subtask of the cards progress.openSubtasks counts, ticked or not, so the open figure has a total to be read against; every other field is as before. ' +
			'(50) sub-boards nest at most 20 levels below a board that is not a sub-board: POST /api/v1/boards with a parentCardId on a board already 20 levels deep, or in or below a loop, answers 409 "Sub-boards can be nested at most 20 levels deep, and a board under this card would be deeper." and creates nothing, ' +
			'and PUT /api/v1/cards/{cardId}/move to another board answers 409 `Card "<title>" cannot go onto "<board>": its sub-boards would then be nested more than 20 levels deep.` and moves nothing when the card\'s sub-boards would end up deeper than that and deeper than they are now, where both were accepted at any depth; a tree already deeper keeps working, and a move that leaves it no deeper is allowed. ' +
			'(51) a request with no key DumpFire accepts is counted against its address by the address\'s network: an IPv6 address by its /64, an IPv4 address written as IPv6 (::ffff:198.51.100.7) as the IPv4 address, and without a port, ' +
			'so the 61st request in a minute from any address of one IPv6 network is answered 429, where each address had sixty of its own; a key\'s own count is unchanged. ' +
			'(52) every operation that takes a color or a colorTag reads it as a colour written #rrggbb, # and six hex digits in either case, trimmed, and answers 400 for anything else, red and #fff included: ' +
			'"color must be a colour written #rrggbb" on POST /api/v1/boards/{boardId}/columns, /labels and /categories, POST /api/v1/board-categories and PUT /api/v1/columns/{columnId}, /labels/{labelId}, /categories/{categoryId} and /board-categories/{categoryId}, ' +
			'and "colorTag must be a colour written #rrggbb, or empty" on POST /api/v1/boards/{boardId}/cards, PUT /api/v1/cards/{cardId}, POST /api/v1/cards/{cardId}/subtasks and PUT /api/v1/subtasks/{subtaskId}, where empty text clears the tag; ' +
			'until then any text was stored, up to 32 characters where a length was checked, a style such as red;background:url(//x.io) included, and a colour is drawn into the page of everyone who opens the board; ' +
			'a colour the row already holds, sent back unchanged, is accepted as it is, and one stored before this rule is returned as stored. ' +
			'(53) every timestamp DumpFire stores is answered in ISO 8601 with Z, as 2026-10-14T08:00:00.000Z, in every answer under /api/v1/ (the data of a webhook body holds no stored time today, and would hold one in the same form): ' +
			'a field that was YYYY-MM-DD HH:MM:SS, which names no zone, comes back in ISO 8601, which is createdAt everywhere, updatedAt on a row never edited, an audit-log entry\'s createdAt, ' +
			'and the from and to of the activity report\'s period and of GET /api/v1/cards/{cardId}/board-history; a field that was ISO 8601 keeps its shape, but its fraction of a second is now always .000, ' +
			'because a moment is kept to the whole second; a date (dueDate, targetDate, asOf) is unchanged; and every such field is now declared format: date-time in this document. ' +
			'(54) a timestamp sent as the from or to of GET /api/v1/audit-log and GET /api/v1/reports/activity is read as ISO 8601, with or without a fraction and with Z or an offset, ' +
			'as YYYY-MM-DD HH:MM:SS in UTC, or as a date, and anything else is answered 400 "from is not a date" or "to is not a date": the audit log compared what it was sent as text, unchecked, ' +
			'so a bound written another way gained or lost the day at its end, and the activity report refused YYYY-MM-DD HH:MM:SS; a bound with an offset is read in UTC, and a date alone as `to` ' +
			'is the whole of that day, to 23:59:59 UTC, in the audit log as in the report, where the audit log left that day out. A from after its to is answered 400 "`from` is after `to`" by both (item 74). ' +
			'(55) PUT /api/v1/cards/{cardId} reads an archivedAt that is text as the moment it names, so the archivedAt a GET answered, sent back, is the stamp the card holds and changes nothing, ' +
			'in ISO 8601 with any fraction or offset or as YYYY-MM-DD HH:MM:SS; null still restores the card, and any other value, true and a number included, is still answered 400. ' +
			'(56) a webhook\'s url, on POST /api/v1/boards/{boardId}/webhooks and PUT /api/v1/webhooks/{webhookId}, may not point inside the network as written, and is answered 400 ' +
			'"Webhook url points inside the network: <why>" for one that does, where it was stored: a loopback, private, shared (carrier NAT), link-local (the cloud metadata service at 169.254.169.254 among them), ' +
			'reserved, documentation or multicast address, in IPv4 or IPv6, an IPv4 address written another way (2130706433, 127.1) or inside an IPv6 form (::ffff:127.0.0.1), and the name localhost, any name ending .localhost, a name with no dot, ' +
			'and any name ending .local, .internal or .home.arpa; one that carries a user name or password is answered 400 "Webhook url must not carry a user name or password". No name is looked up then: ' +
			'a name is judged at each delivery by every address it resolves to, and a delivery to one that resolves inside is not made. Redirects are not followed. The server\'s operator may let named receivers inside the network be sent to; ' +
			'a stored url sent back unchanged is accepted, and is refused at each delivery until it is changed or let in; ' +
			'(57) PUT /api/v1/webhooks/{webhookId} answers 403 "Only the board\'s owner or an administrator can change a webhook\'s address or secret. Ask the board\'s owner." to an editor who sends url or secret at all, whatever the value, ' +
			'and 403 "Only the board\'s owner or an administrator can switch a webhook on. Ask the board\'s owner." to one who sends active true for a webhook that is off, and writes nothing, where an editor could change both and switch one on; ' +
			'an editor still changes events, switches a webhook off, and may send active true for one already on; ' +
			'whoever creates a webhook, changes its url or secret, or switches it on is the one whose password reset switches it off; ' +
			'a create or a change of a webhook whose key is ended while its body is still arriving (a password reset of the key\'s user, committed meanwhile) ' +
			'is answered 401 "Invalid or expired API key" and writes nothing; ' +
			'(58) a board has at most 10 webhooks, switched-off ones counted: POST /api/v1/boards/{boardId}/webhooks answers 409 "This board has 10 webhooks, and a board may have at most 10: delete 1 before adding another." ' +
			'after every other check, and creates nothing, where any number could be made; a board that already has more keeps them all, and every active one is still sent. ' +
			'(59) a webhook answered to the board\'s owner or an administrator carries lastDelivery, what its last delivery since the server started came to: ' +
			'the moment the event was dispatched, the event, an outcome (delivered for a 2xx, answered for any other status, no-answer, or not-sent when it was refused before any request), ' +
			'the receiver\'s status or null, and a reason in fixed words that never names an address; null before the first delivery since the server started and after the url changes, ' +
			'and in the answer to the create; not given to anyone else, as url is not; the latest attempt only, kept in memory, and a not-reached result recorded no sooner than the timeout after the delivery got its connection, so its timing tells nothing. ' +
			'(60) PUT /api/v1/cards/{cardId}/move to another board takes the card out of its milestone when the milestone belongs to a board other than the one the card arrives on, in the same write as the move, and answers milestoneId null and leftMilestone, the id and name of the milestone it left (null for any other move, and for a third board\'s), ' +
			'where the card kept the milestone and its title was listed to every reader of the board it left; a milestone across boards (boardId null) keeps the card, and so does one of the board it arrives on; ' +
			'the api:card_moved_away entry on the board it left ends ` and out of milestone "<name>"`, or ` and out of a milestone of another board` for a third board\'s, and no other entry or webhook delivery is added (until item 103: an api:milestone_card_removed entry and its milestone.card_removed). ' +
			'(61) PUT /api/v1/cards/{cardId}/move into a Complete column answers 409 "A sub-board you cannot open still has incomplete cards that must be completed first. Ask this board\'s owner.", with no name and no count, when the only unfinished sub-boards of the card are ones the key\'s user cannot open, ' +
			'where the sub-board was named with its count of open cards; an unfinished sub-board they can open is named as before. ' +
			'(62) the "Unblocked" comment written on a card that was waiting on work of another board, read by GET /api/v1/cards/{cardId}/comments, names that work by its number only: ' +
			'"Unblocked: #12, a card on another board, completed — nothing is blocking this card now." or "Unblocked: a subtask on another board completed — …", where it gave the other board\'s title; work on the same board is named by its title as before, and comments written before are unchanged. ' +
			'(63) PATCH /api/v1/milestones/{milestoneId} gives a milestone to a board, with boardId, only when every card in it, archived ones included, is on that board, and otherwise answers 400 ' +
			'"Some cards in this milestone are not on that board (archived cards count too). Take those cards out of it first, or make the milestone cross-board instead; only its creator or an administrator can change a cross-board milestone afterwards.", ' +
			'where the milestone went to the board with its cards and the board\'s readers were given the titles of cards of other boards; boardId null, a milestone across boards, is accepted as before, ' +
			'and GET /api/v1/boards/{boardId}/cards?archived=true lists archived cards with their milestoneId; a boardId that names no board is answered 404 "Board not found", where an administrator ' +
			'was answered 500 and anyone else 403 "No edit access to that board". ' +
			'(64) boardIds on GET /api/v1/milestones lists only the boards the key\'s user can open, where a card of the milestone on another board gave that board\'s id; cardCount and doneCount ' +
			'still count such a card, as GET /api/v1/milestones/{milestoneId} lists it withheld. ' +
			'(65) a comment added by POST /api/v1/cards/{cardId}/comments that names an account as @username mails that account only when it can open the card\'s board ' +
			'(its owner, a member, a member of a team it is shared with, anyone for a public board, or an administrator), where anyone named was mailed the card\'s title, the board\'s name ' +
			'and the start of the comment; the comment is saved and answered as before, and the author is not told who was not mailed. ' +
			'(66) a name in a comment is the longest username, in any case, that the text after an @ begins with, where it was the letters, digits and _ after the @, lower-cased: ' +
			'a username with capitals, dots, hyphens, spaces or letters outside English can now be named, @jane.doe no longer reaches an account called jane, and an @ inside a word, ' +
			'as in an email address, names nobody; where two usernames differ only in case, the one typed exactly is named, and neither when the name is typed in neither spelling; ' +
			'only the first 200 @ of a comment that could start a name are read, so a mention after them mails nobody. ' +
			'(67) GET /api/v1/cards/{cardId}/board-history begins with the board a card started on when the card has no recorded creation, where the first board was left out ' +
			'because the move off it was recorded in the same second as the arrival. ' +
			'(68) the two activity entries of a move to another board, read by GET /api/v1/audit-log, name neither board: `"<title>" moved to another board (<from column> → <to column>)` ' +
			'on the board it left and `"<title>" moved from another board (<from column> → <to column>)` on the board it arrived on, where each named the other board; ' +
			'entries written before are unchanged. ' +
			'(69) this document lists every property of every answer it describes: GET /api/v1/burndown gives the fields of `filters` (categoryIds, labelIds, ' +
			'assigneeIds, priorities), of `options` (categories, labels, assignees, priorities, each a list of BurndownOption: id, name, color, count), ' +
			'of `scope.boardCategory` (id, name, color) and of `scope.milestone` (id, name, targetDate, status, boardId, createdAt), ' +
			'where each was an object with no fields, and GET /api/v1/openapi.json gives those of `servers` and `tags` and says `security`, `components` and ' +
			'`paths` are maps; nothing any operation answers has changed. ' +
			'(70) a token correction takes back no more than was recorded, on POST /api/v1/cards/{cardId}/tokens, POST /api/v1/subtasks/{subtaskId}/tokens and POST /api/v1/tokens/bulk: ' +
			'on the same card\'s own entries or the same subtask\'s, of the same `model`, a correction with no breakdown takes back at most the tokens recorded without one, and one with a ' +
			'breakdown no part beyond what is recorded of it; otherwise it is answered 400 (a reason in the 409 of a batch) and nothing is written, where it was taken and, sent as a bare total ' +
			'against measured work, priced the card below zero; DELETE /api/v1/tokens/{entryId} answers 400 only when removing an entry would take what is recorded of its model on its card or subtask below zero, as removing it before the negative entries that correct it would. ' +
			'(71) the "Unblocked" comments of a card moved to another board by PUT /api/v1/cards/{cardId}/move, read by GET /api/v1/cards/{cardId}/comments, name no work of the board it left: ' +
			'the move rewrites `Unblocked: #12 "<title>" completed — …` to `Unblocked: #12, a card on another board, completed — …`, unless card 12 is on the board the card arrives on, ' +
			'and `Unblocked: subtask "<title>" completed — …` to `Unblocked: a subtask on another board completed — …` unless every subtask it names is titled as one of the card\'s own, which go with it, the rest of each kept and its updatedAt unchanged, ' +
			'where they went on naming the work to readers of the board it arrived on; comments of cards moved before are unchanged. ' +
			'(72) GET /api/v1/reports/activity gives a card\'s milestoneName only when the key\'s user can open that milestone (as GET /api/v1/milestones/{milestoneId} would answer 200), ' +
			'and otherwise null, milestoneId as before, and its milestones list leaves out a milestone they cannot open, where a goal across boards was named to anyone who could open one of its boards. ' +
			'(73) POST /api/v1/cards/{cardId}/subtasks with no position puts the new subtask after the card\'s last one (one more than the largest position, or 0 for its first), as the web application places it, ' +
			'where every subtask sent with no position was put at 0; subtasks already at 0 keep it. GET /api/v1/cards/{cardId}/subtasks and the subtasks of GET /api/v1/cards/{cardId} are ordered by position, then id, where they had no order. ' +
			'(74) GET /api/v1/audit-log answers a from after its to with 400 "`from` is after `to`", as GET /api/v1/reports/activity does, where it answered 200 with an empty page; equal bounds name one second and are allowed. ' +
			'Its entries are newest first, and by id, newest first, within one second, so paging with offset neither repeats nor skips an entry of the second a page ends in. ' +
			'(75) a text field past its length limit is answered 400 in one wording, the request-body readers\' own, "<field> must be at most <max> characters", where some operations had their own: ' +
			'on POST /api/v1/boards/{boardId}/cards, PUT /api/v1/cards/{cardId}, POST /api/v1/cards/{cardId}/subtasks and PUT /api/v1/subtasks/{subtaskId}, `Title too long (max 500 chars)` is `title must be at most 500 characters`; ' +
			'on POST /api/v1/boards/{boardId}/cards and PUT /api/v1/cards/{cardId}, `Description too long (max 50000 chars)` is `description must be at most 50000 characters`; ' +
			'`name must be at most 200 characters` replaces `Board name too long (max 200 chars)` on POST /api/v1/boards and PUT /api/v1/boards/{boardId}, ' +
			'`Name too long (max 200 chars)` on POST /api/v1/board-categories, PUT /api/v1/board-categories/{categoryId}, POST /api/v1/boards/{boardId}/categories and PUT /api/v1/categories/{categoryId}, ' +
			'`Label name too long (max 200 chars)` on POST /api/v1/boards/{boardId}/labels and PUT /api/v1/labels/{labelId}, ' +
			'and `name too long (max 200 chars)` on POST /api/v1/milestones and PATCH /api/v1/milestones/{milestoneId}; ' +
			'on POST /api/v1/boards/{boardId}/columns and PUT /api/v1/columns/{columnId}, `Column title too long (max 200 chars)` is `title must be at most 200 characters`; ' +
			'and on PUT /api/v1/comments/{commentId}, `Comment too long (max 50000 chars)` is `content must be at most 50000 characters`, as POST /api/v1/cards/{cardId}/comments already answered. ' +
			'Every limit is as it was, and the web application\'s routes answer in the same words; a caller that matched the old text no longer matches it. ' +
			'(76) a card moved to another board by PUT /api/v1/cards/{cardId}/move is no longer named in other cards\' "Unblocked" comments, read by GET /api/v1/cards/{cardId}/comments, on any card not on the board it arrives on: ' +
			'the move rewrites `Unblocked: #12 "<title>" completed — …` naming it to `Unblocked: #12, a card on another board, completed — …`, and `Unblocked: subtask "<title>" completed — …` naming one of its subtasks, on a card ' +
			'that waited on that subtask as its dependencies still record, to `Unblocked: a subtask on another board completed — …`, the rest of each kept and its updatedAt unchanged ' +
			'(a subtask notice on a card that also waits on a subtask of the same title that is not the moved card\'s keeps its name, since that one may have written it), ' +
			'where they went on naming the card to readers who may not open the board it moved to; comments naming cards moved before are unchanged. ' +
			'(77) every write, each POST, PUT, PATCH and DELETE, asks again inside the transaction that writes whether its key is still open and who the key\'s user is now, as item 57 said of the webhook writes alone: ' +
			'a write whose key is ended (revoked, expired, or ended by a password reset of its user) while its body is still arriving is answered 401 "Invalid or expired API key" and writes nothing; ' +
			'one whose user\'s role or access was lowered meanwhile is refused as that user now is, 403 or 404 in the operation\'s own words (POST /api/v1/dependencies/bulk, POST /api/v1/tokens/bulk, and POST and DELETE /api/v1/milestones/{milestoneId}/cards/bulk with their 409, listing every item), and writes nothing, fires no webhook and sends no mail; ' +
			'nothing changes for a key that still holds and a user whose role is as it was. ' +
			'(78) a reopening and a move to another board send card.moved, by PUT /api/v1/cards/{cardId}/move as by the web application: a card moved out of a Complete column sends its board\'s webhooks card.moved with data.action card_reopened, ' +
			'and a card moved to another board sends the board it left card.moved with card_moved_away and the board it joined card.moved with card_moved_in, each with that board\'s own activity entry as detail, which names neither board; ' +
			'both sent nothing, so a receiver of card.moved missed them. A move into a Complete column still sends card.completed instead of card.moved, and one into another board\'s Complete column sends the joined board both. ' +
			'(79) GET /api/v1/me/stats counts activeCards and averages avgCycleTimeDays over the cards the key\'s user is assigned to on boards they can open now, the same boards the web application\'s dashboard and My Tasks count (an open card is still one with no completedAt here, where those two go by its column): ' +
			'both counted every board, so a user taken off a board saw the two figures move as cards there were completed, archived or unassigned; ' +
			'a user who can open no board is answered activeCards 0 and avgCycleTimeDays null. The shape is unchanged, and cardsCompleted and streak, which count the user\'s own completions, are as they were. ' +
			'(80) GET /api/v1/reports/activity reads only the boards the key\'s user can open, and meta.boardsExcludedForAccess is always 0, still in every answer and marked deprecated: ' +
			'it counted the boards with activity in the window that the key\'s user could not open, so polling a narrow window told them when a board they could not open was worked on, and naming one in boardIds whether it had activity. ' +
			'A board named in boardIds is checked in the order given, as GET /api/v1/burndown checks one, administrators included: one that does not exist is 404 "Board 7 not found", and one the key\'s user cannot open is 403 "No access to board 7", ' +
			'where both were answered 200; a saved list that holds a deleted board now fails. ' +
			'A milestone in milestones counts totalCards, completedAtStart and completedAtEnd over its cards on boards the key\'s user can open, as its burndown does (an administrator\'s over every board): ' +
			'a card moved onto a board they could not open was counted, so moving from across its completion told them the second it was completed. ' +
			'Every other figure is as it was for the boards the key\'s user can open. ' +
			'(81) a webhook is sent only while the account that set it up can open its board, asked at each event with that account\'s role as it is then, as a mail is sent only to assignees who can open the board: ' +
			'one set up by an editor went on sending every event of the board to its address after they were taken off the board, or out of the team it is shared with, or the board was made private, and one an administrator set up went on after they were made an ordinary user. ' +
			'A webhook whose setter cannot open the board, and one with no recorded setter (made before setters were recorded on 2026-10-18/19), is held: nothing is sent and active is left as it is; lastDelivery says "Not sent: the account that set it up can no longer open this board" or "Not sent: nobody is recorded as having set it up". ' +
			'A webhook answered to the board\'s owner or an administrator, and the answer to the create, carry pausedBecause: null unless the webhook is on and held, then one of two sentences saying why and what to do. ' +
			'A held webhook is sent again when its setter can open the board again; the board owner or an administrator takes one over by switching it off and then on, which makes them its setter, and sets a new secret, updating the receiver. ' +
			'(82) GET /api/v1/cards/{cardId}/comments lists comments made in the same second the later first, by id, in a list that is still newest first: they came back in no set order, in practice the earlier first, so a request\'s discussion copied onto its card on accept, and several comments posted in a row, read upside down. ' +
			'(83) the same list answers userEmoji "👤" for an author with no emoji, as POST there and GET and PUT /api/v1/comments/{commentId} do, where it was null against the Comment schema, whose userEmoji is a required string. ' +
			'(84) PUT /api/v1/comments/{commentId} with text that is the comment\'s own once both are trimmed writes nothing, keeps updatedAt, logs no api:comment_edited and sends no live update, and answers 200 with the comment as it is stored (with its author, as before): ' +
			'it wrote the comment again with a new updatedAt, which the web application shows as "(edited)", and recorded an edit nobody made. A caller who may not edit the comment is still refused 403 first. ' +
			'(85) DELETE /api/v1/comments/{commentId} is new, where the route answered 405: the comment\'s author while they can edit its board, or an administrator, as in the web application; no body; 200 {"success": true}; ' +
			'400 Invalid comment ID, 404 Comment not found, 403 No edit access to this board and 403 You can only delete your own comments. It logs api:comment_deleted (a delete made in the web application now logs comment_deleted; neither was recorded) and sends a live board update. ' +
			'No webhook is sent for it: re-reading the comment list is the only way to learn that a comment has gone. ' +
			'(86) DELETE /api/v1/cards/{cardId} on a card already archived answers 200 {"success": true} as before, but writes nothing and sends no live update: ' +
			'archivedAt keeps its first value and updatedAt is not moved, where both were stamped again with the time of the second request, and no second api:card_archived is logged. ' +
			'(87) PUT /api/v1/subtasks/{subtaskId} logs api:subtask_updated for an untick ("Reopened <subtask> (on <card>)") and for a change of title, description, priority, colorTag or dueDate ("Updated <subtask> (on <card>): title, dueDate"), ' +
			'not for a change of position alone; a request that changes nothing writes nothing, logs nothing and sends no live update, and answers 200 with the subtask. Neither was recorded, and an unchanged request was written and told. ' +
			'(88) POST /api/v1/dependencies/bulk logs one api:dependency_added per link it creates, on the board of the card that waits, with that card\'s id and the words a single add uses, ' +
			'where it logged one api:dependencies_bulk_added with no card on one board. dependencies_bulk_added is no longer written; an audit-log filter on it finds older entries only, and one on dependency_added now finds the links of a batch too. ' +
			'(89) the web application\'s card update (PUT /api/cards/{id}) no longer sends the card.updated webhook for a change of a card\'s position within its column, which a drag and PUT /api/v1/cards/{cardId}/move never sent: ' +
			'it logged card_updated "Updated fields: position" and moved updatedAt. With other fields it still sends card.updated, its detail no longer naming position. Nothing PUT /api/v1/cards/{cardId} accepts or answers changes. ' +
			'(90) goal changes are logged, where only a milestone made on a board was: PATCH /api/v1/milestones/{milestoneId} logs api:milestone_updated (naming the fields changed among name, description, targetDate and boardId), api:milestone_closed or api:milestone_reopened, ' +
			'and DELETE /api/v1/milestones/{milestoneId} logs api:milestone_deleted with the count of each board\'s cards released, each with no card, on the milestone\'s board, or for one across boards on each board holding its cards (on a change of board, the boards before and after); ' +
			'the milestone is named on a board as that board\'s readers knew it before the change (after it, on a board it joins), and as milestone #<id> where it is across boards. ' +
			'Every operation that puts a card into a milestone or takes it out logs api:milestone_card_added or api:milestone_card_removed on the card\'s board with its id: POST and DELETE /api/v1/milestones/{milestoneId}/cards, ' +
			'the bulk ones (one entry for each card attached or detached, none for a card skipped) and milestoneId on PUT /api/v1/cards/{cardId}, which logs these in place of naming milestoneId in api:card_updated, ' +
			'so **card.updated is no longer sent when milestoneId is the only change**, or comes with only a restore (archivedAt null). A card moved from one milestone to another logs one api:milestone_card_added naming the milestone it left, and no api:milestone_card_removed for that one. ' +
			'A change that changes nothing (every field as stored, or a card put into the milestone it is in) writes nothing, logs nothing and sends no live update, and answers 200 as before; a request that would be refused is still refused first. ' +
			'No webhook is sent for a change to the goal itself, and goal membership sends no card.updated on any route; a card put in or taken out sends milestone.card_added or milestone.card_removed (item 102). ' +
			'The plan-created mail is still sent by POST /api/v1/milestones/{milestoneId}/cards/bulk alone. ' +
			'(91) PUT /api/v1/cards/{cardId} answers 400 for a columnId other than the card\'s own (`columnId 12 is not this card\'s column (14): the card has moved since it was read, ' +
			'or a move was meant. Move a card with PUT /cards/{cardId}/move`), and `columnId must be an id` for one that is not an id or is null, where it saved the other fields sent and ignored it. ' +
			'The card\'s own column, sent back, is accepted as before, so a card read with GET can still be sent back whole. position is ignored here, whatever is sent, as it always was: ' +
			'reorder with PUT /cards/{cardId}/move. POST /api/v1/boards takes categoryId, the board category to file the new board under, where it ignored it: a category that does not exist is ' +
			'404 Board category not found, one of boards the key\'s user cannot open 403 No access to this board category, and one that is not an id 400 categoryId must be an id, ' +
			'where each made the board unfiled with 201. PUT /api/v1/boards/{boardId} answers 400 for a parentCardId other than the board\'s own, null on a sub-board included ' +
			'(`parentCardId 12 is not this board\'s parent card (none): …`), and `parentCardId must be an id` for one that is not an id, where it saved the other fields and ignored it. ' +
			'(92) DELETE /api/v1/milestones/{milestoneId}/cards/bulk takes an archived card out of the milestone, logging api:milestone_card_removed, as DELETE /api/v1/milestones/{milestoneId}/cards ' +
			'and milestoneId null on PUT /api/v1/cards/{cardId} do, where it refused the whole batch with a 409. An archived card that is not in the milestone is skipped and counted, and a card that does not exist ' +
			'is listed in the 409 as `Card not found` (it was `Card does not exist or is archived`), so an archived card on a board the key\'s user cannot edit is listed as one they cannot edit, with its id and no title, ' +
			'as the single detach answers 403. POST …/cards/bulk still refuses an archived card. A milestone whose only members were archived can now be emptied, and the plan-created mail, ' +
			'which counts archived members when it decides a milestone was empty, is then sent by the next bulk attach to it. ' +
			'(93) GET /api/v1/boards/{boardId}/cards lists the board\'s cards by column, in order of column position, ties by column id, and within a column in order of card position, ties by card id. ' +
			'It listed the columns in the order they were made in, so a column moved or added between two others came in the wrong place. The cards are read in one query, and an answer\'s fields are unchanged. ' +
			'(94) DELETE /api/v1/board-categories/{categoryId} takes every board filed under the category out of it, in the same request, where each kept the deleted category\'s id as its categoryId: ' +
			'a board read now answers categoryId null for it. Boards already holding the id of a category that no longer exists were cleared once, at the deploy. ' +
			'(95) PUT /api/v1/boards/{boardId} writes, logs and tells only the fields whose value changes: a body whose every field is as the board holds it answers the board as it is, ' +
			'with no api:board_updated and updatedAt unchanged, and an entry names only the fields that changed, where every field sent was written and named; {} is still 400. ' +
			'(96) GET /api/v1/milestones/{milestoneId} lists the milestone\'s archived cards in `archivedCards`, by card id, withheld as `cards` are, each with `archivedAt` (null when withheld); ' +
			'`cards` still leaves them out. They are the cards that stop PATCH …/{milestoneId} giving the milestone to another board when no live card does, and the refusal names none of them, ' +
			'where finding them meant asking each board for GET /api/v1/boards/{boardId}/cards?archived=true. ' +
			'(97) GET /api/v1/audit-log and the activity reads can return `attachment_added` and `attachment_deleted`, written by the web application when a file ' +
			'is attached to or deleted from a card; neither was recorded. No webhook is sent for either. ' +
			'(98) PUT /api/v1/columns/{columnId}, PUT /api/v1/labels/{labelId}, PUT /api/v1/categories/{categoryId} and PUT /api/v1/board-categories/{categoryId} write only the fields whose value changes: ' +
			'a body whose every field is as the row holds it (a name or title that trims to the stored one included) answers 200 with the row as it is, writes nothing and tells no open page, ' +
			'where every field sent was written and the board of a column, a label or a category told to re-read. {} is still 400, and a request that would be refused is still refused first. ' +
			'(99) A comment copied onto a card from a request\'s discussion, as the web application accepts the request, has the time its message was sent as its createdAt and its updatedAt, ' +
			'as GET /api/v1/cards/{cardId}/comments and the reports read it, where every copy had the time of the accept. ' +
			'(100) POST /api/v1/cards/{cardId}/assignees mails nobody who assigns themselves (the key\'s user given as userId), who was mailed "Assigned: <card>" about what they had just done. ' +
			'They are assigned, and the api:assignee_added entry and the live update written, as before, and anyone else assigned is mailed as before. The web application\'s routes that assign do the same. ' +
			'(101) GET /api/v1/boards/{boardId}, GET /api/v1/boards/{boardId}/columns and POST /api/v1/boards list a board\'s columns in order of position, ties by column id (the older first), ' +
			'as GET /api/v1/boards/{boardId}/cards already went through them; two columns at one position came in no set order, and POST /api/v1/boards answered its columns in no stated order. ' +
			'(102) two webhook events are new, milestone.card_added and milestone.card_removed: a card put in a milestone or taken out, by every operation and page that does it ' +
			'(POST and DELETE /api/v1/milestones/{milestoneId}/cards, the bulk pair, one delivery for each card, and milestoneId on PUT /api/v1/cards/{cardId}), sent to the webhooks of the card\'s board ' +
			'once the change is committed, with the body every event has: data.cardId, data.action (milestone_card_added or milestone_card_removed), data.source, data.user, and data.detail, ' +
			'the entry\'s words (`Added "Plan" to milestone "Launch"`, a milestone across boards named milestone #<id>). A card moved from one milestone to another sends one milestone.card_added naming the one it left, ' +
			'and no milestone.card_removed. A card that leaves a milestone because of another change sends milestone.card_removed too (item 103). ' +
			'A change to the milestone itself still sends nothing. ' +
			'**A webhook whose events list is empty is sent every event, so one made before this release starts receiving both**: list the events wanted to receive neither. ' +
			'Both can be named in events when a webhook is created or changed. ' +
			'(103) a card that leaves a milestone because of another change logs api:milestone_card_removed (milestone_card_removed from the web application) on its board, and that board\'s webhooks are sent milestone.card_removed once the change is committed, ' +
			'one delivery for each card, with data.detail the words of a card taken out and why in brackets: PUT /api/v1/cards/{cardId}/move to another board out of its milestone (`Removed "Plan" from milestone "Launch" (moved to another board)`, on the board it left, with its id; an older milestone of neither board named milestone #<id>); ' +
			'DELETE /api/v1/milestones/{milestoneId}, for each card it releases (`… (milestone deleted)`); a card in a milestone deleted for good by DELETE /api/v1/cards/{cardId}?permanent=true, beside its card.deleted, or with its column by DELETE /api/v1/columns/{columnId}, ' +
			'or by the web application\'s clear of a board\'s cards or purge of archived cards (`… (card deleted)`, data.cardId the deleted card\'s id, the entry stored with a null cardId); ' +
			'and a card on another board released from a milestone of a board deleted by DELETE /api/v1/boards/{boardId}, or of a sub-board deleted with its parent card (`… (milestone deleted with its board)`, the milestone named milestone #<id>). ' +
			'Each sent nothing for the milestone, and the column delete, the clear and the purge no card.deleted either. A card deleted with its own board (the board deleted, or a sub-board under a deleted card) still sends nothing: ' +
			'the board\'s log and webhooks are deleted with it. **A webhook whose events list is empty receives these from this release.** ' +
			'For a card deleted for good, card.deleted and milestone.card_removed are separate deliveries and may arrive in either order: treat a milestone.card_removed for a card unknown to the receiver, or already deleted, as harmless. ' +
			'(104) GET /api/v1/audit-log takes an optional before, the createdAt and id of the last entry the caller holds joined by a comma (2026-10-21T09:00:00.000Z,1234), ' +
			'and answers the entries older than it, newest first: an entry written between two pages is not given twice, where paging by offset gave the next page one already given for each entry written since. ' +
			'With before, total counts the entries the filters find older than it and hasMore says whether any follow the page; offset still applies, from the cursor. ' +
			'A before that is not a timestamp and an id is 400 "before must be an entry\'s createdAt and id, as 2026-10-21T09:00:00Z,1234". Without it every answer is as it was. ' +
			'The rate limit of a key is counted once ' +
			'the key is checked, against the key itself, so a wrong key that begins as a real one spends none of its allowance, and a key over ' +
			'its limit is not marked as used. /api/v1 with nothing after it is answered 401 in JSON where it was a 303. Every answer carries ' +
			'X-Content-Type-Options, X-Frame-Options, Referrer-Policy, Permissions-Policy and X-XSS-Protection: 0.\n\n' +
			'**Changed on 2026-10-13 (version 1.1.0).** The key is `message` on every failure. Until then the 401, the 429 and the 409 of a rejected ' +
			'batch carried their text as `error`, and the 409 of a dependency cycle on a card carried a fixed text as `error` beside the ' +
			'`message` it still has. A caller that read `error` on those reads `message` now; their other ' +
			'fields are unchanged. On the same day a body that is not valid JSON became a 400 where it was a 500, a body over the size limit ' +
			'became a 413 where a deployed server answered 500, and an unknown path and a wrong method became JSON where they were a page ' +
			'and plain text. Two answers about a subtask\'s dependencies changed their status on that day too: a link between a subtask and ' +
			'itself, or with an end that is archived, is answered 400 where it was 409, and removing a link that is not there is answered ' +
			'404 where it was 200.\n\n' +
			'**Timestamps.** Every timestamp in an answer is UTC, in ISO 8601 with a `Z`, as `2026-10-14T08:00:00.000Z`. That holds for every stored ' +
			'time, `createdAt`, `updatedAt`, `completedAt`, `archivedAt` and the rest, for the `from` and `to` of the activity report\'s period and of a ' +
			'card\'s board history, and for the moments of answering, `generatedAt` and a webhook\'s own `timestamp`. Each such field is declared ' +
			'`format: date-time`. A stored time is kept to the whole second, so its fraction is always `.000`; a moment of answering, `generatedAt` or a ' +
			'webhook\'s `timestamp`, carries the milliseconds of the moment it was made. A date, such as `dueDate`, `targetDate` or `asOf`, is `YYYY-MM-DD`. ' +
			'A timestamp sent as a parameter or in a body is read as ISO 8601, with or without a fraction and with a `Z` or an offset, as ' +
			'`YYYY-MM-DD HH:MM:SS` in UTC, or as a date, and an offset is moved to UTC; a date alone is the start of that day, or, as the end of a range, ' +
			'its last second, 23:59:59 UTC. Anything else is answered 400 naming the parameter. Until 2026-10-14 some stored times were answered as ' +
			'`YYYY-MM-DD HH:MM:SS`, which names no zone, and the same field could be in either form (item 53).\n\n' +
			'**The request body.** A body that is missing, is not valid JSON, or is JSON and not an object is answered 400 when the ' +
			'operation reads it. The size limit is 512 KB on every operation here. A body that declares more than that in Content-Length is ' +
			'answered 413 before the operation is reached, and before the key is looked at: its `message` says how large it is and what the ' +
			'limit is, and `limitBytes` is the limit as a number. A body sent in chunks, with no Content-Length, is held to the same limit as it ' +
			'is read: once it passes it, it is answered 413 with a `message` that says the limit, and `limitBytes`, and no more of it is read. A body ' +
			'that runs past the length it declared is answered 413, {"message": "Payload Too Large"}. Every operation that reads a body reads it before it looks ' +
			'for the resource, so a body that is not a JSON object sent to a card that does not exist is answered 400 where an object is answered 404 or 403. ' +
			'The fields of an object are read after that: what the path names is looked for (404, to everyone), the caller is checked (403), and then ' +
			'each field is read (400, naming the field), so a caller who would be refused is answered 404 or 403 whatever the fields hold. An ' +
			'operation with nothing in its path to look for, the token operations and the dependency and token batches read their fields first. ' +
			'The two milestone batches look for the milestone, and check the caller, before they read cardIds.\n\n' +
			'**Writes are all or nothing.** A request that changes several things saves all of them or none. ' +
			'A 500 is DumpFire failing, not the request being wrong: its body is {"message": "Internal Error"}, and a 500 that DumpFire itself ' +
			'answers to a write means nothing was written, so the same request can be sent again without anything being written twice. ' +
			'Every field is read by its type and range before anything is written, so a field the operation cannot use is a 400, never a 500. ' +
			'A 502, 503 or 504 is not an answer from DumpFire: it comes from a proxy in front of it, and the write may or may not ' +
			'have happened, so read the resource before sending a POST again. ' +
			'A 429 means the request was turned away and nothing was written: send it again, unchanged, after the Retry-After seconds. ' +
			'Any other 4xx answer means the request was refused and nothing was written. ' +
			'A 2xx answer means the change is committed: webhooks, live board updates and emails are sent after the commit, ' +
			'and one that fails does not undo the change or alter the answer.\n\n' +
			'**Deletes.** Archiving a card touches nothing but the card. A permanent delete of a card, a column or a board ' +
			'removes everything under it, sub-boards at every depth included, and every dependency link that has a deleted ' +
			'card or subtask at either end. Attachment files of deleted cards are kept on the server for 30 days. Ids are never reused.\n\n' +
			'**Attachments** are not part of this API. In the web application an attachment opened by its address is shown in ' +
			'the browser only if it is a PNG, JPEG, GIF, WebP or .txt file whose stored type and extension agree; every other ' +
			'attachment, a PDF, an HTML or an SVG file among them, is a download. Every answer carries ' +
			'Content-Security-Policy: sandbox and X-Content-Type-Options: nosniff. GET /api/v1/audit-log and the activity reads can return ' +
			'`attachment_added` and `attachment_deleted`, written by the web application when a file is attached to or deleted from a card; ' +
			'neither was recorded before. No webhook is sent for either.\n\n' +
			'**Three answers that are not JSON.** Each is made by SvelteKit before DumpFire\'s gate is given the request, so the gate ' +
			'cannot answer them as it answers everything else. (1) A POST, PUT, PATCH or DELETE whose Content-Type is that of a form or text/plain, sent with no Origin header ' +
			'matching the server, is answered 403 in plain text, with one exception: when the request\'s Accept header is exactly ' +
			'application/json, the same 403 is JSON, {"message": "Cross-site POST form submissions are forbidden"}, with the method that ' +
			'was sent in place of POST. Only a deployed server makes this check. It is what `curl -d` sends when no ' +
			'Content-Type is given: send Content-Type: application/json. (2) A path with a trailing slash is answered 308, to the same path ' +
			'without it: leave the slash off. (3) A URL that is not validly encoded is answered 400 in plain text. /api/v1 with nothing ' +
			'after it is not under /api/v1/: every operation is, and DumpFire\'s gate takes /api/v1 itself for a path of the web ' +
			'application\'s own, which a key does not open. It is answered 401, {"message": "Not authenticated"}.',
		contact: { name: 'DumpFire' }
	},
	servers: [{ url: '/', description: 'Current instance' }],
	security: [{ bearerAuth: [] }],
	components: {
		securitySchemes: {
			bearerAuth: {
				type: 'http',
				scheme: 'bearer',
				description:
					'API key prefixed with `df_`. Generate one from My Account → API Keys.'
			}
		},
		schemas: {
			Error: {
				type: 'object',
				description:
					'How every failure is answered. Some failures carry more beside the message: see RateLimitError, DependencyConflict, and for a batch that was refused ' +
					'DependencyBatchRejected, MilestoneCardsRejected, MilestoneCardsDetachRejected and TokenBatchRejected.',
				properties: {
					message: { type: 'string', description: 'Why the request failed, in words' }
				},
				required: ['message']
			},
			RateLimitError: {
				type: 'object',
				description: 'The body of a 429.',
				properties: {
					message: { type: 'string', description: 'Always "Rate limit exceeded"' },
					retryAfterSecs: {
						type: 'integer',
						description: 'Seconds until the request can be sent again. The Retry-After header carries the same number.'
					}
				},
				required: ['message', 'retryAfterSecs']
			},
			User: {
				type: 'object',
				properties: {
					id: { type: 'integer' },
					username: { type: 'string' },
					email: { type: 'string', format: 'email' },
					emoji: { type: 'string' },
					role: { type: 'string', enum: ['user', 'admin', 'superadmin'] }
				},
				required: ['id', 'username', 'email', 'emoji', 'role']
			},
			Board: {
				type: 'object',
				properties: {
					id: { type: 'integer' },
					name: { type: 'string' },
					emoji: { type: ['string', 'null'] },
					parentCardId: { type: ['integer', 'null'], description: 'The card this board is a sub-board of, or null' },
					categoryId: { type: ['integer', 'null'], description: 'The board category it is filed under on the dashboard, or null' },
					isPublic: { type: 'boolean' },
					kind: {
						type: 'string',
						enum: ['delivery', 'ideas'],
						description:
							'delivery for a board of committed work, which every board was before 2026-10-26; ideas for a board whose every column is upstream of the commitment point, holding options nobody has committed to yet.'
					},
					createdBy: { type: ['integer', 'null'], description: 'The user who created it. null once that user has been deleted.' },
					createdAt: { type: 'string', format: 'date-time' },
					updatedAt: { type: 'string', format: 'date-time' }
				},
				required: ['id', 'name', 'emoji', 'parentCardId', 'categoryId', 'isPublic', 'kind', 'createdBy', 'createdAt', 'updatedAt']
			},
			Column: {
				type: 'object',
				properties: {
					id: { type: 'integer' },
					boardId: { type: 'integer' },
					title: { type: 'string' },
					position: { type: 'number', description: 'Order on the board, lowest first. Not always a whole number.' },
					color: { type: 'string', description: 'A colour written #rrggbb; one stored before this rule is returned as stored' },
					wipLimit: { type: 'integer', minimum: 0, description: 'Work-in-progress limit. 0 means no limit. Never null.' },
					showAddCard: { type: 'boolean' },
					role: {
						type: ['string', 'null'],
						enum: ['options', null],
						description:
							'options for the board\'s Options column, upstream of the commitment point: cards in it are options, not committed work. Every delivery board has one, titled Options, at its far left (since 2026-10-26). null for every other column, whose title decides whether it is To Do, On Hold or Complete.'
					}
				},
				required: ['id', 'boardId', 'title', 'position', 'color', 'wipLimit', 'showAddCard', 'role']
			},
			BoardDetail: {
				type: 'object',
				description: 'A board with its columns. Every property of Board, described there, and `columns`.',
				properties: {
					id: { type: 'integer' },
					name: { type: 'string' },
					emoji: { type: ['string', 'null'] },
					parentCardId: { type: ['integer', 'null'] },
					categoryId: { type: ['integer', 'null'] },
					isPublic: { type: 'boolean' },
					kind: { type: 'string', enum: ['delivery', 'ideas'] },
					createdBy: { type: ['integer', 'null'] },
					createdAt: { type: 'string', format: 'date-time' },
					updatedAt: { type: 'string', format: 'date-time' },
					columns: { type: 'array', items: { $ref: '#/components/schemas/Column' } }
				},
				required: ['id', 'name', 'emoji', 'parentCardId', 'categoryId', 'isPublic', 'kind', 'createdBy', 'createdAt', 'updatedAt', 'columns']
			},
			Card: {
				type: 'object',
				description:
					'A card as it is stored, which is what creating and updating one answer. The list, the move and the single read each answer ' +
					'this and something beside it: see CardListItem, MovedCard and CardDetail.',
				properties: {
					id: { type: 'integer' },
					columnId: { type: 'integer' },
					categoryId: { type: ['integer', 'null'], description: 'Card category, or null' },
					title: { type: 'string' },
					description: { type: ['string', 'null'] },
					position: { type: 'number', description: 'Order within the column, lowest first. Not always a whole number.' },
					priority: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
					colorTag: { type: ['string', 'null'], description: 'A colour written #rrggbb, or an empty string for none; one stored before this rule is returned as stored' },
					dueDate: { type: ['string', 'null'] },
					onHoldNote: { type: ['string', 'null'], description: 'Why the card is on hold' },
					businessValue: { type: ['string', 'null'] },
					pinned: { type: 'boolean' },
					completedAt: {
						type: ['string', 'null'],
						format: 'date-time',
						description: 'When the card was moved into, or created in, a Complete column. null while it is not in one: reopening a card clears it.'
					},
					firstCompletedAt: {
						type: ['string', 'null'],
						format: 'date-time',
						description: 'When the card was first completed. Kept when it is reopened.'
					},
					archivedAt: { type: ['string', 'null'], format: 'date-time', description: 'When the card was archived, or null' },
					committedAt: {
						type: ['string', 'null'],
						format: 'date-time',
						description:
							'When the card crossed the commitment point. Set when the card is created outside an upstream column (an Options column, or any column of an ideas board), ' +
							'and when it is moved out of the Options column or off an ideas board; filled from createdAt by the repair the server makes at start-up for a card that has none, ' +
							'such as one restored from a backup made before 2026-10-26. null while the card is an option: cleared whenever a card becomes one, by a move back upstream or by converting its board to an ideas board.'
					},
					committedBy: {
						type: ['integer', 'null'],
						description: 'The user who committed it. null while the card is an option, when it was not recorded, or once that user has been deleted.'
					},
					discardedAt: {
						type: ['string', 'null'],
						format: 'date-time',
						description: 'When the card was discarded: archived while it was an option. null for a card that is not archived, or was archived as committed work.'
					},
					discardedBy: {
						type: ['integer', 'null'],
						description: 'The user who discarded it. null when it was not discarded, or once that user has been deleted.'
					},
					coverUrl: {
						type: ['string', 'null'],
						description:
							'The card\'s cover, drawn as a strip of colour across the top of the card on the board: a colour written #rrggbb or one of the eight preset gradients that updateCard lists. ' +
							'It holds a colour, not an address, whatever its name says. null for none. A page draws only a colour or a preset, so another value stored before covers were checked is kept and not drawn.'
					},
					recurrenceRule: {
						type: ['string', 'null'],
						description: 'Not used: nothing sets or acts on it. null unless it was set before recurrence was retired.'
					},
					nextRecurrence: {
						type: ['string', 'null'],
						description: 'Not used: nothing sets or acts on it. null unless it was set before recurrence was retired.'
					},
					milestoneId: { type: ['integer', 'null'], description: 'The milestone the card belongs to, or null' },
					createdBy: {
						type: ['integer', 'null'],
						description: 'The user who created it. null for a card made before this was recorded, or whose creator has been deleted.'
					},
					summary: {
						type: ['string', 'null'],
						description: 'Reporting field: the card in plain English, 200 characters at most. null when not recorded.'
					},
					theme: {
						type: ['string', 'null'],
						description: 'Reporting field: new capability, customer issue, security & compliance or maintenance. null when not recorded.'
					},
					customerImpact: {
						type: ['string', 'null'],
						description:
							'Reporting field: none, internal or live customers, which may be followed by a colon and detail ("live customers: Quickline"). null when not recorded.'
					},
					closeReason: {
						type: ['string', 'null'],
						description: 'Reporting field: delivered, not needed, superseded or parked. null when not recorded.'
					},
					releaseState: {
						type: ['string', 'null'],
						description: 'Reporting field: built, on UAT or live. null when not recorded.'
					},
					createdAt: { type: 'string', format: 'date-time' },
					updatedAt: { type: 'string', format: 'date-time' }
				},
				required: [
					'id', 'columnId', 'categoryId', 'title', 'description', 'position', 'priority', 'colorTag', 'dueDate', 'onHoldNote',
					'businessValue', 'pinned', 'completedAt', 'firstCompletedAt', 'archivedAt', 'committedAt', 'committedBy', 'discardedAt', 'discardedBy', 'coverUrl', 'recurrenceRule', 'nextRecurrence',
					'milestoneId', 'createdBy', 'summary', 'theme', 'customerImpact', 'closeReason', 'releaseState', 'createdAt', 'updatedAt'
				]
			},
			CardListItem: {
				type: 'object',
				description:
					'A card as the list of a board\'s cards gives it. Every property of Card, described there, and three more: `columnTitle`, `subtaskCount` and `subtaskCompleted`.',
				properties: {
					id: { type: 'integer' },
					columnId: { type: 'integer' },
					categoryId: { type: ['integer', 'null'] },
					title: { type: 'string' },
					description: { type: ['string', 'null'] },
					position: { type: 'number' },
					priority: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
					colorTag: { type: ['string', 'null'] },
					dueDate: { type: ['string', 'null'] },
					onHoldNote: { type: ['string', 'null'] },
					businessValue: { type: ['string', 'null'] },
					pinned: { type: 'boolean' },
					completedAt: { type: ['string', 'null'], format: 'date-time' },
					firstCompletedAt: { type: ['string', 'null'], format: 'date-time' },
					archivedAt: { type: ['string', 'null'], format: 'date-time' },
					committedAt: { type: ['string', 'null'], format: 'date-time' },
					committedBy: { type: ['integer', 'null'] },
					discardedAt: { type: ['string', 'null'], format: 'date-time' },
					discardedBy: { type: ['integer', 'null'] },
					coverUrl: {
						type: ['string', 'null'],
						description:
							'The card\'s cover, drawn as a strip of colour across the top of the card on the board: a colour written #rrggbb or one of the eight preset gradients that updateCard lists. ' +
							'It holds a colour, not an address, whatever its name says. null for none. A page draws only a colour or a preset, so another value stored before covers were checked is kept and not drawn.'
					},
					recurrenceRule: {
						type: ['string', 'null'],
						description: 'Not used: nothing sets or acts on it. null unless it was set before recurrence was retired.'
					},
					nextRecurrence: {
						type: ['string', 'null'],
						description: 'Not used: nothing sets or acts on it. null unless it was set before recurrence was retired.'
					},
					milestoneId: { type: ['integer', 'null'] },
					createdBy: { type: ['integer', 'null'] },
					summary: { type: ['string', 'null'] },
					theme: { type: ['string', 'null'] },
					customerImpact: { type: ['string', 'null'] },
					closeReason: { type: ['string', 'null'] },
					releaseState: { type: ['string', 'null'] },
					createdAt: { type: 'string', format: 'date-time' },
					updatedAt: { type: 'string', format: 'date-time' },
					columnTitle: { type: 'string', description: 'Title of the column the card is in' },
					subtaskCount: { type: 'integer', description: 'How many subtasks the card has' },
					subtaskCompleted: { type: 'integer', description: 'How many of them are completed' }
				},
				required: [
					'id', 'columnId', 'categoryId', 'title', 'description', 'position', 'priority', 'colorTag', 'dueDate', 'onHoldNote',
					'businessValue', 'pinned', 'completedAt', 'firstCompletedAt', 'archivedAt', 'committedAt', 'committedBy', 'discardedAt', 'discardedBy', 'coverUrl', 'recurrenceRule', 'nextRecurrence',
					'milestoneId', 'createdBy', 'summary', 'theme', 'customerImpact', 'closeReason', 'releaseState', 'createdAt', 'updatedAt',
					'columnTitle', 'subtaskCount', 'subtaskCompleted'
				]
			},
			MovedCard: {
				type: 'object',
				description:
					'A card as a move answers it. Every property of Card, described there, as they are after the move, and three more: `columnTitle`, `boardId` and `leftMilestone`.',
				properties: {
					id: { type: 'integer' },
					columnId: { type: 'integer' },
					categoryId: { type: ['integer', 'null'] },
					title: { type: 'string' },
					description: { type: ['string', 'null'] },
					position: { type: 'number' },
					priority: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
					colorTag: { type: ['string', 'null'] },
					dueDate: { type: ['string', 'null'] },
					onHoldNote: { type: ['string', 'null'] },
					businessValue: { type: ['string', 'null'] },
					pinned: { type: 'boolean' },
					completedAt: { type: ['string', 'null'], format: 'date-time' },
					firstCompletedAt: { type: ['string', 'null'], format: 'date-time' },
					archivedAt: { type: ['string', 'null'], format: 'date-time' },
					committedAt: { type: ['string', 'null'], format: 'date-time' },
					committedBy: { type: ['integer', 'null'] },
					discardedAt: { type: ['string', 'null'], format: 'date-time' },
					discardedBy: { type: ['integer', 'null'] },
					coverUrl: {
						type: ['string', 'null'],
						description:
							'The card\'s cover, drawn as a strip of colour across the top of the card on the board: a colour written #rrggbb or one of the eight preset gradients that updateCard lists. ' +
							'It holds a colour, not an address, whatever its name says. null for none. A page draws only a colour or a preset, so another value stored before covers were checked is kept and not drawn.'
					},
					recurrenceRule: {
						type: ['string', 'null'],
						description: 'Not used: nothing sets or acts on it. null unless it was set before recurrence was retired.'
					},
					nextRecurrence: {
						type: ['string', 'null'],
						description: 'Not used: nothing sets or acts on it. null unless it was set before recurrence was retired.'
					},
					milestoneId: { type: ['integer', 'null'] },
					createdBy: { type: ['integer', 'null'] },
					summary: { type: ['string', 'null'] },
					theme: { type: ['string', 'null'] },
					customerImpact: { type: ['string', 'null'] },
					closeReason: { type: ['string', 'null'] },
					releaseState: { type: ['string', 'null'] },
					createdAt: { type: 'string', format: 'date-time' },
					updatedAt: { type: 'string', format: 'date-time' },
					columnTitle: { type: 'string', description: 'Title of the column the card is now in' },
					boardId: { type: 'integer', description: 'The board the card is now on: another board after a move across boards' },
					leftMilestone: {
						type: ['object', 'null'],
						description:
							'The milestone of the board the card left that this move to another board took it out of; moving the card back does not put it back in. ' +
							'null for every other move, and for a milestone of a third board, which is not named. Since 2026-10-14.',
						properties: {
							id: { type: 'integer' },
							name: { type: 'string' }
						},
						required: ['id', 'name']
					}
				},
				required: [
					'id', 'columnId', 'categoryId', 'title', 'description', 'position', 'priority', 'colorTag', 'dueDate', 'onHoldNote',
					'businessValue', 'pinned', 'completedAt', 'firstCompletedAt', 'archivedAt', 'committedAt', 'committedBy', 'discardedAt', 'discardedBy', 'coverUrl', 'recurrenceRule', 'nextRecurrence',
					'milestoneId', 'createdBy', 'summary', 'theme', 'customerImpact', 'closeReason', 'releaseState', 'createdAt', 'updatedAt',
					'columnTitle', 'boardId', 'leftMilestone'
				]
			},
			Assignee: {
				type: 'object',
				properties: {
					id: { type: 'integer' },
					username: { type: 'string' },
					emoji: { type: 'string' }
				},
				required: ['id', 'username', 'emoji']
			},
			Subtask: {
				type: 'object',
				properties: {
					id: { type: 'integer' },
					cardId: { type: 'integer' },
					title: { type: 'string' },
					description: { type: ['string', 'null'] },
					priority: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
					colorTag: { type: ['string', 'null'], description: 'A colour written #rrggbb, or an empty string for none; one stored before this rule is returned as stored' },
					dueDate: { type: ['string', 'null'] },
					completed: { type: 'boolean' },
					position: { type: 'number', description: 'Order within the card, lowest first, and by id where two share it. Not always a whole number.' }
				},
				required: ['id', 'cardId', 'title', 'description', 'priority', 'colorTag', 'dueDate', 'completed', 'position']
			},
			Category: {
				type: 'object',
				properties: {
					id: { type: 'integer' },
					boardId: { type: ['integer', 'null'], description: 'Board this category belongs to' },
					name: { type: 'string' },
					color: { type: 'string', description: 'A colour written #rrggbb; one stored before this rule is returned as stored' }
				},
				required: ['id', 'boardId', 'name', 'color']
			},
			BoardCategory: {
				type: 'object',
				description: 'Dashboard-level category for grouping boards',
				properties: {
					id: { type: 'integer' },
					name: { type: 'string' },
					color: { type: 'string', description: 'A colour written #rrggbb; one stored before this rule is returned as stored' }
				},
				required: ['id', 'name', 'color']
			},
			Label: {
				type: 'object',
				properties: {
					id: { type: 'integer' },
					boardId: { type: 'integer' },
					name: { type: 'string' },
					color: { type: 'string', description: 'A colour written #rrggbb; one stored before this rule is returned as stored' }
				},
				required: ['id', 'boardId', 'name', 'color']
			},
			Webhook: {
				type: 'object',
				description:
					'A webhook of a board: every event of the board that it asks for is sent to its url as a POST. Where it may send: not inside the network, as written or as resolved. ' +
					'An address that is loopback, private, shared, link-local (the cloud metadata service among them), reserved, documentation or multicast, in IPv4 or IPv6, ' +
					'and the names localhost, *.localhost, a name with no dot, *.local, *.internal and *.home.arpa, are refused when the webhook is created or its url changed; ' +
					'a name is judged again at each delivery by every address it resolves to, and a delivery to one that resolves inside is not made. Redirects are not followed, ' +
					'and an address with a user name or password is refused. The server\'s operator may let named receivers inside the network be sent to. A board has at most 10 webhooks. ' +
					'There are ten events: card.created, card.updated, card.moved, card.completed, card.deleted, comment.added, milestone.card_added, milestone.card_removed, card.committed and card.discarded. ' +
					'card.moved is every column change but a completion and a commitment, told apart by data.action: card_moved, card_reopened (out of a Complete column), card_moved_away and card_moved_in (to another board, each sent to its own board with its own entry, which names neither board), ' +
					'card_returned_to_options (since 2026-10-26: a committed card moved back into an upstream column, a board\'s Options column or any column of an ideas board; the one card.moved of a move from Complete into Options, whose card_reopened entry sends none) ' +
					'and card_sent (since 2026-10-26: an option sent, or moved, to another board, on the board it left, in place of card_moved_away). ' +
					'A move into a Complete column sends card.completed instead (a move into another board\'s Complete column also sends each board its card.moved), and a move out of an upstream column into a committed one within one board sends card.committed instead, ' +
					'so a webhook that lists card.moved and not card.committed does not hear it; across boards each board is sent its own card.moved (card_sent to the board it left, card_moved_in to the board it joins), and the board it joins card.committed after it; a move from a committed column of another board into upstream sends the board it joins two card.moved, card_moved_in and card_returned_to_options. ' +
					'card.committed (since 2026-10-26) is a card committed out of upstream, by any route, a Send to To Do included, with data.action card_committed; card.discarded (since 2026-10-26) is an option archived or deleted, ' +
					'with data.action card_discarded, sent before card.deleted, with the card\'s id, for a delete. Archiving any other card sends nothing. ' +
					'milestone.card_added and milestone.card_removed (since 2026-10-21, item 102) are a card put in a milestone or taken out, sent to the card\'s board. A webhook with an empty events list receives every event, the four newest among them. ' +
					'Who it is sent for (since 2026-10-20): a webhook is sent only while the account that set it up, the one that created it or last set its url or secret or switched it on, can open the board, asked at each event with that account\'s role as it is then. ' +
					'One whose setter cannot, or that has no recorded setter (one made before setters were recorded on 2026-10-18/19), is held: nothing is sent to it, active is left as it is, and pausedBecause says why. ' +
					'One whose setter is given the board back is sent again with nothing else changed. To keep one without that, the board owner or an administrator takes it over: switches it off, then on, which makes them its setter, sets a new secret and updates the receiver.',
				properties: {
					id: { type: 'integer' },
					boardId: { type: 'integer' },
					url: {
						type: 'string',
						format: 'uri',
						description:
							'The delivery address. Present only when the caller is the board owner or an administrator, and in the response to the request that created the webhook, as the secret is. Omitted for every other caller, including board editors and viewers, and in the answer to an editor\'s own update: an address can name a server inside a network or carry credentials. Until 2026-10-14 it was given to every caller who could view the board.'
					},
					hasSecret: {
						type: 'boolean',
						description: 'Whether a signing secret is set. Always present.'
					},
					secret: {
						type: 'string',
						description:
							'The signing secret. Present only when the caller is the board owner or an administrator, and in the response to the request that created the webhook. Omitted for every other caller, including board editors and viewers.'
					},
					events: { type: 'array', items: { type: 'string' } },
					active: { type: 'boolean' },
					createdAt: { type: 'string', format: 'date-time' },
					lastDelivery: {
						type: ['object', 'null'],
						description:
							'What the last delivery came to. Present only when the caller is the board owner or an administrator, as the address is, and null in the response to the request that created the webhook. ' +
							'null until the webhook\'s first delivery since the server last started, and after its url changes until the next delivery or until the address is changed back: a result is kept in the server\'s memory, never stored, so a restart, a deploy included, forgets it. ' +
							'The latest attempt only, not a history: an earlier failure followed by a success is not shown; the system log keeps each failure. Read through the API only: nothing else tells anyone that a delivery failed, so poll this webhook or the board\'s list. ' +
							'An event the webhook does not ask for, and a webhook switched off, record nothing. Of two deliveries in flight the later dispatch\'s result is kept, whichever answers last.',
						properties: {
							at: { type: 'string', format: 'date-time', description: 'When the event was dispatched: the timestamp in the body sent' },
							event: { type: 'string', description: 'The event that was sent, e.g. card.moved' },
							outcome: {
								type: 'string',
								enum: ['delivered', 'answered', 'no-answer', 'not-sent'],
								description:
									'delivered: the receiver answered 2xx. answered: it answered any other status, a redirect included, which is not followed. ' +
									'no-answer: no status came: the name was not found, the certificate could not be checked, or the receiver could not be reached or did not answer in time. ' +
									'not-sent: no request was made: the address is inside the network, carries a user name or password, or is not http or https, or the webhook\'s events are not a list, ' +
									'or (since 2026-10-20) the webhook is held because the account that set it up can no longer open the board or nobody is recorded as having set it up.'
							},
							status: { type: ['integer', 'null'], description: 'The status the receiver answered; null when it answered none' },
							reason: {
								type: 'string',
								description:
									'One of a fixed set of sentences, e.g. "The receiver answered 500", "Not sent: the address is inside the network", "Not sent: the account that set it up can no longer open this board" or "Not sent: nobody is recorded as having set it up". It never holds the address, its path or query, the secret, or an address a name resolved to. ' +
									'A closed port, a filtered one and a receiver that does not answer read alike: "The receiver could not be reached, or did not answer within 10 seconds", recorded no sooner than the 10 seconds after the delivery was given its connection, whenever it failed. ' +
									'The 10 seconds count from that connection, not from a wait behind the 20 connections already open to one receiver. The system log, which administrators read, keeps the error itself.'
							}
						},
						required: ['at', 'event', 'outcome', 'status', 'reason']
					},
					pausedBecause: {
						type: ['string', 'null'],
						description:
							'Why the webhook is held, so that nothing is sent to it (since 2026-10-20). Present only when the caller is the board owner or an administrator, as the address is, and in the response to the request that created the webhook, where it is null: its creator is its setter and can open the board. ' +
							'null unless the webhook is on (active) and held, so a webhook switched off is null whoever set it. Worked out when the answer is made, never stored, so it is there after a restart when lastDelivery is null. While held it is one of two sentences, word for word. ' +
							'When the account that set it up can no longer open the board: "The account that set this up can no longer open this board, so nothing is sent. The address was chosen by that account: delete the webhook unless you recognise it; to keep it, switch it off and on, which makes you its setter, and set a new secret and update the receiver." ' +
							'When nobody is recorded as having set it up: "Nobody is recorded as having set this up. Delete it unless you recognise the address; to keep it, switch it off and on, which makes you its setter, and set a new secret." ' +
							'Sending active true for a webhook that is already on is no change and does not take it over.'
					}
				},
				required: ['id', 'boardId', 'hasSecret', 'events', 'active', 'createdAt']
			},
			Dependency: {
				type: 'object',
				description:
					'The work at the other end of one dependency link, with the link itself: in `blockedBy` it is what the card waits on, in `blocks` it is what waits on the card. It is a card or a subtask, and `kind` says which. ' +
					'Work on a board the key\'s user cannot open is listed, because it still blocks, but withheld: see `withheld`.',
				properties: {
					id: { type: 'integer', description: 'Id of the dependency link' },
					kind: {
						type: 'string',
						enum: ['card', 'subtask'],
						description: 'What `cardId` is the id of. Card 32 and subtask 32 are different things.'
					},
					cardId: { type: 'integer', description: 'Id of the card, or of the subtask when `kind` is subtask' },
					parentCardId: {
						type: ['integer', 'null'],
						description: 'For a subtask, the card it belongs to. null for a card, and for withheld work.'
					},
					title: {
						type: 'string',
						description: 'For withheld work, "A card on a board you cannot open" or "A subtask on a board you cannot open"'
					},
					boardId: { type: ['integer', 'null'], description: 'The board it is on, which may be another board. null for withheld work.' },
					boardName: { type: 'string', description: 'For withheld work, "A board you cannot open"' },
					columnName: {
						type: 'string',
						description: 'Title of the column it is in. For a subtask, its card\'s column. Empty for withheld work.'
					},
					priority: {
						type: ['string', 'null'],
						enum: ['low', 'medium', 'high', 'critical', null],
						description: 'null for withheld work'
					},
					resolved: { type: 'boolean', description: 'true once that work is finished, so that it no longer blocks' },
					withheld: {
						type: 'boolean',
						description:
							'true when the work is on a board the key\'s user cannot open. Then only what it is, its id and whether it is finished are told: ' +
							'its title and board name are replaced by the texts above, its column is empty, and its board, parent card and priority are null. ' +
							'Until 2026-10-14 they were given.'
					},
					createdByUserId: { type: ['integer', 'null'], description: 'Who recorded the link, where that is known' },
					createdAt: { type: 'string', format: 'date-time', description: 'When the link was recorded' }
				},
				required: [
					'id', 'kind', 'cardId', 'parentCardId', 'title', 'boardId', 'boardName', 'columnName', 'priority', 'resolved',
					'withheld', 'createdByUserId', 'createdAt'
				]
			},
			DependencyEnd: {
				type: 'object',
				description: 'One end of a dependency link: a card or a subtask, by its id.',
				properties: {
					kind: { type: 'string', enum: ['card', 'subtask'] },
					id: { type: 'integer' }
				},
				required: ['kind', 'id']
			},
			CardDependencies: {
				type: 'object',
				description: 'What a card waits on and what waits on it.',
				properties: {
					cardId: { type: 'integer' },
					isBlocked: { type: 'boolean', description: 'true when at least one thing the card waits on is not finished' },
					blockedBy: {
						type: 'array',
						items: { $ref: '#/components/schemas/Dependency' },
						description: 'What this card waits on. Left out when `direction=blocks`.'
					},
					blocks: {
						type: 'array',
						items: { $ref: '#/components/schemas/Dependency' },
						description: 'What waits on this card. Left out when `direction=blocked-by`.'
					}
				},
				required: ['cardId', 'isBlocked']
			},
			DependencyConflict: {
				type: 'object',
				description:
					'The body of a 409 for a dependency that cannot be added. There are two, and `cycle` tells them apart: a link that is already ' +
					'recorded is answered with the message alone, and a link that would close a loop with the loop as well.',
				properties: {
					message: {
						type: 'string',
						description: '"That dependency already exists", or the loop in words: "#10 waiting on #42 would create a cycle: #10 → #42 → #10"'
					},
					cycle: {
						type: 'array',
						items: { $ref: '#/components/schemas/DependencyEnd' },
						description: 'Only for a link that would close a loop: the chain it would close, in order'
					}
				},
				required: ['message']
			},
			LinkedWork: {
				type: 'object',
				description:
					'A card or subtask at the other end of a dependency link, as the single read of a card lists it. The dependencies operation gives the same work with the link beside it: see Dependency, ' +
					'which also says what is given of work on a board the key\'s user cannot open.',
				properties: {
					kind: { type: 'string', enum: ['card', 'subtask'], description: 'What `cardId` is the id of' },
					cardId: { type: 'integer', description: 'Id of the card, or of the subtask when `kind` is subtask' },
					parentCardId: {
						type: ['integer', 'null'],
						description: 'For a subtask, the card it belongs to. null for a card, and for withheld work.'
					},
					title: { type: 'string', description: 'For withheld work, "A card on a board you cannot open" or "A subtask on a board you cannot open"' },
					boardId: { type: ['integer', 'null'], description: 'null for withheld work' },
					boardName: { type: 'string', description: 'For withheld work, "A board you cannot open"' },
					columnName: { type: 'string', description: 'Empty for withheld work' },
					resolved: { type: 'boolean', description: 'true once that work is finished' },
					withheld: { type: 'boolean', description: 'true when the work is on a board the key\'s user cannot open, as on Dependency' }
				},
				required: ['kind', 'cardId', 'parentCardId', 'title', 'boardId', 'boardName', 'columnName', 'resolved', 'withheld']
			},
			BurndownPoint: {
				type: 'object',
				description: 'The state at the end of one UTC day, and what changed during it.',
				properties: {
					date: { type: 'string', format: 'date' },
					scope: { type: 'integer', description: 'Cards in scope: arrived and not dropped' },
					done: { type: 'integer', description: 'Of which completed' },
					remaining: { type: 'integer', description: 'scope - done' },
					added: { type: 'integer', description: 'Cards that arrived this day' },
					completed: { type: 'integer', description: 'Cards completed this day' },
					removed: { type: 'integer', description: 'Open cards dropped (archived) this day' }
				},
				required: ['date', 'scope', 'done', 'remaining', 'added', 'completed', 'removed']
			},
			BurndownSummary: {
				type: 'object',
				description: 'Start values are before the first day of the window, so remainingNow = remainingStart + added - completed - removed.',
				properties: {
					scopeStart: { type: 'integer' },
					scopeNow: { type: 'integer' },
					doneStart: { type: 'integer' },
					doneNow: { type: 'integer' },
					remainingStart: { type: 'integer' },
					remainingNow: { type: 'integer' },
					added: { type: 'integer' },
					completed: { type: 'integer' },
					removed: { type: 'integer' }
				},
				required: ['scopeStart', 'scopeNow', 'doneStart', 'doneNow', 'remainingStart', 'remainingNow', 'added', 'completed', 'removed']
			},
			BurndownForecast: {
				type: 'object',
				description: 'Where remaining is heading at the pace of the trailing 28 days, or since the day after the scope began if it is younger.',
				properties: {
					status: { type: 'string', enum: ['done', 'converging', 'not-converging', 'insufficient-data'] },
					basisDays: { type: 'integer' },
					asOf: { type: 'string', format: 'date' },
					completionRate: { type: 'number', description: 'Cards completed per day' },
					scopeRate: { type: 'number', description: 'Net scope change per day (added - dropped)' },
					netBurnRate: { type: 'number', description: 'completionRate - scopeRate' },
					projectedDate: {
						type: ['string', 'null'],
						format: 'date',
						description:
							'Remaining reaches zero at the net rate. When spansBoards is true this is pooled across boards, as if a card finished on one board cleared another\'s, and is not when the work finishes: use delivery.'
					},
					projectedDateNoNewScope: {
						type: ['string', 'null'],
						format: 'date',
						description: 'Remaining reaches zero if nothing more is added. Pooled across boards when spansBoards is true, as projectedDate is: use delivery.'
					},
					spansBoards: {
						type: 'boolean',
						description:
							'The cards that pass the filters sit on more than one board (for a breakdown row, that row\'s cards): the test delivery splits by board on. The rates still describe the pile as a whole; the dates are pooled, and the web application shows none.'
					}
				},
				required: ['status', 'basisDays', 'asOf', 'completionRate', 'scopeRate', 'netBurnRate', 'projectedDate', 'projectedDateNoNewScope', 'spansBoards']
			},
			DeliveryEstimate: {
				type: 'object',
				description:
					'How long the work open now would take to finish if nothing new were added. A Monte Carlo simulation: each of the trials replays randomly chosen days of the basis (their real completion counts) until the open work is used up. Seeded from the inputs, so the same data always gives the same answer. For a scope spanning several boards each board is simulated at its own pace and the dates are when the slowest board is done (method slowest-board); boards with no recent pace are left out of the dates and listed in parts.',
				properties: {
					status: { type: 'string', enum: ['estimated', 'done', 'no-pace', 'beyond-horizon', 'insufficient-data'] },
					method: { type: 'string', enum: ['pooled', 'slowest-board'], description: 'pooled: one pile at one pace (a single board). slowest-board: each board at its own pace, done when the slowest is.' },
					remaining: { type: 'integer', description: 'The open work being estimated, as of asOf' },
					basisFinished: { type: 'integer', description: 'Cards finished in the basis that the dates rest on (for slowest-board, those of the slowest board). Under 5 is thin evidence.' },
					asOf: { type: 'string', format: 'date' },
					basisDays: { type: 'integer' },
					throughputPerWeek: { type: 'number', description: 'Average finished per week over the basis' },
					arrivalPerWeek: { type: 'number', description: 'Net new work per week over the basis; not included in the estimate' },
					trials: { type: 'integer', description: '2,000 for the result, 500 per group; 0 when nothing was simulated' },
					p50: { $ref: '#/components/schemas/DeliveryPoint' },
					p85: { $ref: '#/components/schemas/DeliveryPoint' },
					p95: { $ref: '#/components/schemas/DeliveryPoint' },
					chanceByTarget: { type: ['number', 'null'], description: 'Share of trials finished by the target date (0-1), when there is a target' },
					bottleneck: {
						type: ['object', 'null'],
						description: 'slowest-board only: the board most likely to finish last, with the properties of a DeliveryPart. null otherwise.',
						properties: {
							key: { type: 'string', example: 'board:10' },
							name: { type: 'string' },
							remaining: { type: 'integer' },
							status: { type: 'string', enum: ['estimated', 'done', 'no-pace', 'beyond-horizon', 'insufficient-data'] },
							basisFinished: { type: 'integer' },
							p50: { $ref: '#/components/schemas/DeliveryPoint' },
							p85: { $ref: '#/components/schemas/DeliveryPoint' }
						},
						required: ['key', 'name', 'remaining', 'status', 'basisFinished', 'p50', 'p85']
					},
					parts: { type: 'array', items: { $ref: '#/components/schemas/DeliveryPart' }, description: 'slowest-board only: every board with open work, slowest first; boards with no recent pace last' },
					pooled: {
						type: ['object', 'null'],
						description: 'slowest-board only: the one-pile figure, as if effort could move freely between boards',
						properties: {
							status: { type: 'string' },
							p50: { $ref: '#/components/schemas/DeliveryPoint' },
							p85: { $ref: '#/components/schemas/DeliveryPoint' }
						},
						required: ['status', 'p50', 'p85']
					}
				},
				required: [
					'status', 'method', 'remaining', 'basisFinished', 'asOf', 'basisDays', 'throughputPerWeek', 'arrivalPerWeek', 'trials',
					'p50', 'p85', 'p95', 'chanceByTarget', 'bottleneck', 'parts', 'pooled'
				]
			},
			DeliveryPart: {
				type: 'object',
				description: "One board's own estimate inside a multi-board one",
				properties: {
					key: { type: 'string', example: 'board:10' },
					name: { type: 'string' },
					remaining: { type: 'integer' },
					status: { type: 'string', enum: ['estimated', 'done', 'no-pace', 'beyond-horizon', 'insufficient-data'] },
					basisFinished: { type: 'integer' },
					p50: { $ref: '#/components/schemas/DeliveryPoint' },
					p85: { $ref: '#/components/schemas/DeliveryPoint' }
				},
				required: ['key', 'name', 'remaining', 'status', 'basisFinished', 'p50', 'p85']
			},
			DeliveryPoint: {
				type: ['object', 'null'],
				description: 'A percentile of the simulated finish days; null when beyond two years or not simulated',
				properties: {
					days: { type: 'integer', description: 'Days after asOf' },
					date: { type: 'string', format: 'date' }
				},
				required: ['days', 'date']
			},
			BurndownTarget: {
				type: ['object', 'null'],
				description: 'The day the scope is meant to reach zero, and how the forecast compares with it. null when there is no target.',
				properties: {
					date: { type: 'string', format: 'date' },
					source: { type: 'string', enum: ['milestone', 'query'] },
					idealStart: {
						type: 'object',
						description: 'The ideal line runs from here to zero on date: the start of the window, or the first day with work if the window opens before any existed',
						properties: { date: { type: 'string', format: 'date' }, remaining: { type: 'integer' } },
						required: ['date', 'remaining']
					},
					onTrack: {
						type: ['boolean', 'null'],
						description:
							'The forecast\'s projectedDate lands on or before date. When forecast.spansBoards is true that date is pooled across boards, so this compares a date that is not when the work finishes: delivery.chanceByTarget is the measure to read.'
					},
					daysLate: {
						type: ['integer', 'null'],
						description: 'Days projectedDate lands after date; negative means early. Pooled across boards when forecast.spansBoards is true, as onTrack is.'
					}
				},
				required: ['date', 'source', 'idealStart', 'onTrack', 'daysLate']
			},
			BurndownOption: {
				type: 'object',
				description: 'A value offered in a filter, with how many cards in scope carry it',
				properties: {
					id: { type: ['integer', 'string'], description: 'The value to filter on: an id, the priority itself (critical, high, medium, low), or "none" for the empty bucket' },
					name: { type: 'string' },
					color: { type: ['string', 'null'] },
					count: { type: 'integer' }
				},
				required: ['id', 'name', 'color', 'count']
			},
			BurndownResult: {
				type: 'object',
				properties: {
					scope: {
						type: 'object',
						properties: {
							kind: { type: 'string', enum: ['workspace', 'boards', 'boardCategory', 'milestone'] },
							label: { type: 'string' },
							boards: {
								type: 'array',
								items: {
									type: 'object',
									properties: { id: { type: 'integer' }, name: { type: 'string' }, emoji: { type: 'string' } },
									required: ['id', 'name', 'emoji']
								}
							},
							boardCategory: {
								type: ['object', 'null'],
								description: 'With boardCategoryId: the board category charted',
								properties: { id: { type: 'integer' }, name: { type: 'string' }, color: { type: 'string' } },
								required: ['id', 'name', 'color']
							},
							milestone: {
								type: ['object', 'null'],
								description: 'With milestoneId: the milestone charted',
								properties: {
									id: { type: 'integer' },
									name: { type: 'string' },
									targetDate: { type: ['string', 'null'], format: 'date', description: 'The day it is meant to be reached, or null' },
									status: { type: 'string', enum: ['open', 'closed'] },
									boardId: { type: ['integer', 'null'], description: 'Its board, or null for a goal across boards' },
									createdAt: { type: 'string', format: 'date-time' }
								},
								required: ['id', 'name', 'targetDate', 'status', 'boardId', 'createdAt']
							}
						},
						required: ['kind', 'label', 'boards', 'boardCategory', 'milestone']
					},
					filters: {
						type: 'object',
						description: 'The filters applied, normalised ("me" resolved to your user id)',
						properties: {
							categoryIds: { type: 'array', items: { type: ['integer', 'string'] }, description: 'Category ids, and "none" for cards with no category' },
							labelIds: { type: 'array', items: { type: 'integer' } },
							assigneeIds: { type: 'array', items: { type: ['integer', 'string'] }, description: 'User ids, and "none" for cards with no assignee' },
							priorities: { type: 'array', items: { type: 'string' } }
						},
						required: ['categoryIds', 'labelIds', 'assigneeIds', 'priorities']
					},
					range: {
						type: 'object',
						properties: { from: { type: 'string', format: 'date' }, to: { type: 'string', format: 'date' }, days: { type: 'integer' } },
						required: ['from', 'to', 'days']
					},
					series: { type: 'array', items: { $ref: '#/components/schemas/BurndownPoint' } },
					summary: { $ref: '#/components/schemas/BurndownSummary' },
					forecast: { $ref: '#/components/schemas/BurndownForecast' },
					delivery: { $ref: '#/components/schemas/DeliveryEstimate' },
					target: { $ref: '#/components/schemas/BurndownTarget' },
					groupBy: { type: 'string', enum: ['none', 'board', 'category', 'label', 'assignee', 'priority'] },
					groups: {
						type: 'array',
						description: 'One per board, category, label, assignee or priority. remaining and scope are arrays aligned to the series dates. A card with several labels or assignees counts in each of their groups.',
						items: {
							type: 'object',
							properties: {
								key: { type: 'string' },
								kind: { type: 'string' },
								id: { type: ['integer', 'string'], description: 'The value to filter on to drill in; "none" for the empty bucket' },
								name: { type: 'string' },
								color: { type: ['string', 'null'] },
								cardCount: { type: 'integer' },
								remaining: { type: 'array', items: { type: 'integer' } },
								scope: { type: 'array', items: { type: 'integer' } },
								summary: { $ref: '#/components/schemas/BurndownSummary' },
								forecast: { $ref: '#/components/schemas/BurndownForecast' },
								delivery: { $ref: '#/components/schemas/DeliveryEstimate' }
							},
							required: ['key', 'kind', 'id', 'name', 'color', 'cardCount', 'remaining', 'scope', 'summary', 'forecast', 'delivery']
						}
					},
					options: {
						type: 'object',
						description: 'Only with options=true: filter values present in scope, each counted with every other filter applied.',
						properties: {
							categories: { type: 'array', items: { $ref: '#/components/schemas/BurndownOption' } },
							labels: { type: 'array', items: { $ref: '#/components/schemas/BurndownOption' } },
							assignees: { type: 'array', items: { $ref: '#/components/schemas/BurndownOption' } },
							priorities: { type: 'array', items: { $ref: '#/components/schemas/BurndownOption' } }
						},
						required: ['categories', 'labels', 'assignees', 'priorities']
					},
					meta: {
						type: 'object',
						description: 'Read notes before quoting a figure.',
						properties: {
							basis: { type: 'string', enum: ['card-timestamps'] },
							timezone: { type: 'string', enum: ['UTC'] },
							cardCount: { type: 'integer' },
							inferredCompletionDates: { type: 'integer', description: 'In Complete with no completion stamp; last update used' },
							inferredInWindow: { type: 'integer', description: 'Of those, how many have that stand-in date inside the window (and so can inflate the completed figure)' },
							reopenedCards: { type: 'integer', description: 'Completed once, since moved out of Complete; charted as open' },
							archivedDoneCards: { type: 'integer', description: 'Completed and since archived; still counted as done' },
							notes: { type: 'array', items: { type: 'string' } },
							generatedAt: { type: 'string', format: 'date-time' }
						},
						required: [
							'basis', 'timezone', 'cardCount', 'inferredCompletionDates', 'inferredInWindow', 'reopenedCards', 'archivedDoneCards',
							'notes', 'generatedAt'
						]
					}
				},
				required: ['scope', 'filters', 'range', 'series', 'summary', 'forecast', 'delivery', 'target', 'groupBy', 'groups', 'meta']
			},
			AuditLogEntry: {
				type: 'object',
				properties: {
					id: { type: 'integer' },
					boardId: { type: 'integer', description: 'The board the entry was written against' },
					cardId: { type: ['integer', 'null'], description: 'The card it is about. null for an entry about no card, or whose card has since been deleted.' },
					userId: { type: ['integer', 'null'], description: 'Who did it. null once that user has been deleted.' },
					action: {
						type: 'string',
						description: 'The canonical action name, the same whether it was done in the web application or through the API: card_moved. Filter and group on this.'
					},
					rawAction: { type: 'string', description: 'The action as stored: an action done through the API has the prefix api:' },
					detail: { type: ['string', 'null'] },
					userName: { type: ['string', 'null'], description: 'The user\'s name as it was when the entry was written' },
					userEmoji: { type: ['string', 'null'] },
					source: { type: 'string', enum: ['ui', 'api'], description: 'Where the action came from. Never null.' },
					createdAt: { type: 'string', format: 'date-time' },
					boardName: { type: 'string', description: 'Name of the board, or "Unknown"' }
				},
				required: [
					'id', 'boardId', 'cardId', 'userId', 'action', 'rawAction', 'detail', 'userName', 'userEmoji', 'source', 'createdAt', 'boardName'
				]
			},
			UserStats: {
				type: 'object',
				properties: {
					cardsCompleted: {
						type: 'object',
						description:
							'How many cards the user has completed, counted from the completions the activity log records as theirs, on any board. ' +
							'A record of what the user did: a card archived afterwards still counts, as archiving it does not undo the work.',
						properties: {
							total: { type: 'integer' },
							last7Days: { type: 'integer' },
							last30Days: { type: 'integer' }
						},
						required: ['total', 'last7Days', 'last30Days']
					},
					avgCycleTimeDays: {
						type: ['number', 'null'],
						description:
							'Average lead time, commitment to done; named cycle time for history. The same value as avgLeadTimeDays, kept so that no caller that reads it breaks: ' +
							'mean days from each card\'s committedAt to its completion, to one decimal place, over the completed cards the user is assigned to on boards the key\'s user can open, options and archived cards left out. ' +
							'Archived cards were averaged until 2026-10-27. For a card made before 2026-10-26 the commitment is its creation, so the figure is as it was; until then it was described as from creation to completion. ' +
							'null when there is none. An average of 0 is 0: until 2026-10-14 it was null, and the cards of every board were averaged.'
					},
					avgLeadTimeDays: {
						type: ['number', 'null'],
						description:
							'Average lead time, commitment to done (since 2026-10-26): mean days from each card\'s committedAt to its completion, to one decimal place, over the completed cards the user is assigned to ' +
							'on boards the key\'s user can open. An option, a card in a board\'s Options column or on an ideas board, is never among them, and since 2026-10-27 neither is an archived card, as in the board metrics. ' +
							'null when there is none; an average of 0 is 0. ' +
							'Complete is the delivery point, so this lead time is the customer\'s and the system\'s alike. The same value as avgCycleTimeDays.'
					},
					streak: {
						type: 'integer',
						description: 'Consecutive UTC days with at least one completion, counted back from today, or from yesterday if there is none today'
					},
					activeCards: {
						type: 'integer',
						description:
							'Cards the user is assigned to that are neither completed nor archived, on boards the key\'s user can open, options left out: a card in a board\'s Options column or on an ideas board is not open work (since 2026-10-26). ' +
							'Until 2026-10-14 the cards of every board were counted.'
					},
					recentActivity: {
						type: 'array',
						description:
							'The user\'s last 20 activity entries on boards they can open, newest first. An entry on a board the key\'s user can no longer open is left out before the 20 are counted: until 2026-10-14 it was listed, with the card title in its detail.',
						items: {
							type: 'object',
							properties: {
								id: { type: 'integer' },
								action: { type: 'string', description: 'The action as stored: an action done through the API has the prefix api:' },
								detail: { type: ['string', 'null'] },
								boardId: { type: 'integer' },
								createdAt: { type: 'string', format: 'date-time' }
							},
							required: ['id', 'action', 'detail', 'boardId', 'createdAt']
						}
					}
				},
				required: ['cardsCompleted', 'avgCycleTimeDays', 'avgLeadTimeDays', 'streak', 'activeCards', 'recentActivity']
			},
			CardDetail: {
				type: 'object',
				description:
					'A card as the single read gives it. Every property of Card, described there, and with it the board and column it is on, its subtasks, labels and assignees, and what it waits on and what waits on it.',
				properties: {
					id: { type: 'integer' },
					columnId: { type: 'integer' },
					categoryId: { type: ['integer', 'null'] },
					title: { type: 'string' },
					description: { type: ['string', 'null'] },
					position: { type: 'number' },
					priority: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
					colorTag: { type: ['string', 'null'] },
					dueDate: { type: ['string', 'null'] },
					onHoldNote: { type: ['string', 'null'] },
					businessValue: { type: ['string', 'null'] },
					pinned: { type: 'boolean' },
					completedAt: { type: ['string', 'null'], format: 'date-time' },
					firstCompletedAt: { type: ['string', 'null'], format: 'date-time' },
					archivedAt: { type: ['string', 'null'], format: 'date-time' },
					committedAt: { type: ['string', 'null'], format: 'date-time' },
					committedBy: { type: ['integer', 'null'] },
					discardedAt: { type: ['string', 'null'], format: 'date-time' },
					discardedBy: { type: ['integer', 'null'] },
					coverUrl: {
						type: ['string', 'null'],
						description:
							'The card\'s cover, drawn as a strip of colour across the top of the card on the board: a colour written #rrggbb or one of the eight preset gradients that updateCard lists. ' +
							'It holds a colour, not an address, whatever its name says. null for none. A page draws only a colour or a preset, so another value stored before covers were checked is kept and not drawn.'
					},
					recurrenceRule: {
						type: ['string', 'null'],
						description: 'Not used: nothing sets or acts on it. null unless it was set before recurrence was retired.'
					},
					nextRecurrence: {
						type: ['string', 'null'],
						description: 'Not used: nothing sets or acts on it. null unless it was set before recurrence was retired.'
					},
					milestoneId: { type: ['integer', 'null'] },
					createdBy: { type: ['integer', 'null'] },
					summary: { type: ['string', 'null'] },
					theme: { type: ['string', 'null'] },
					customerImpact: { type: ['string', 'null'] },
					closeReason: { type: ['string', 'null'] },
					releaseState: { type: ['string', 'null'] },
					createdAt: { type: 'string', format: 'date-time' },
					updatedAt: { type: 'string', format: 'date-time' },
					boardId: { type: 'integer', description: 'The board the card is on' },
					columnTitle: { type: 'string', description: 'Title of the column the card is in' },
					subtasks: { type: 'array', items: { $ref: '#/components/schemas/Subtask' }, description: 'Ordered by position, then id (item 73)' },
					labelIds: { type: 'array', items: { type: 'integer' } },
					assignees: { type: 'array', items: { $ref: '#/components/schemas/Assignee' } },
					isBlocked: { type: 'boolean', description: 'true when at least one thing the card waits on is not finished' },
					blockedBy: { type: 'array', items: { $ref: '#/components/schemas/LinkedWork' }, description: 'What the card waits on' },
					blocks: { type: 'array', items: { $ref: '#/components/schemas/LinkedWork' }, description: 'What waits on the card' }
				},
				required: [
					'id', 'columnId', 'categoryId', 'title', 'description', 'position', 'priority', 'colorTag', 'dueDate', 'onHoldNote',
					'businessValue', 'pinned', 'completedAt', 'firstCompletedAt', 'archivedAt', 'committedAt', 'committedBy', 'discardedAt', 'discardedBy', 'coverUrl', 'recurrenceRule', 'nextRecurrence',
					'milestoneId', 'createdBy', 'summary', 'theme', 'customerImpact', 'closeReason', 'releaseState', 'createdAt', 'updatedAt',
					'boardId', 'columnTitle', 'subtasks', 'labelIds', 'assignees', 'isBlocked', 'blockedBy', 'blocks'
				]
			},
			Comment: {
				type: 'object',
				properties: {
					id: { type: 'integer' },
					cardId: { type: 'integer' },
					userId: { type: 'integer' },
					content: { type: 'string' },
					createdAt: { type: 'string', format: 'date-time' },
					updatedAt: { type: 'string', format: 'date-time' },
					username: { type: 'string' },
					userEmoji: { type: 'string' }
				},
				required: ['id', 'cardId', 'userId', 'content', 'createdAt', 'updatedAt', 'username', 'userEmoji']
			},
			SubtaskLinkedWork: {
				type: 'object',
				description:
					'A card or subtask at the other end of one of a subtask\'s dependency links. The properties of LinkedWork, described there, and `priority`. ' +
					'The link has no id here: it is removed by naming the other end. Work on a board the key\'s user cannot open is withheld, as on Dependency.',
				properties: {
					kind: { type: 'string', enum: ['card', 'subtask'], description: 'What `cardId` is the id of' },
					cardId: { type: 'integer', description: 'Id of the card, or of the subtask when `kind` is subtask' },
					parentCardId: {
						type: ['integer', 'null'],
						description: 'For a subtask, the card it belongs to. null for a card, and for withheld work.'
					},
					title: { type: 'string', description: 'For withheld work, "A card on a board you cannot open" or "A subtask on a board you cannot open"' },
					boardId: { type: ['integer', 'null'], description: 'The board it is on, which may be another board. null for withheld work.' },
					boardName: { type: 'string', description: 'For withheld work, "A board you cannot open"' },
					columnName: {
						type: 'string',
						description: 'Title of the column it is in. For a subtask, its card\'s column. Empty for withheld work.'
					},
					priority: {
						type: ['string', 'null'],
						enum: ['low', 'medium', 'high', 'critical', null],
						description: 'null for withheld work'
					},
					resolved: { type: 'boolean', description: 'true once that work is finished, so that it no longer blocks' },
					withheld: { type: 'boolean', description: 'true when the work is on a board the key\'s user cannot open, as on Dependency' }
				},
				required: ['kind', 'cardId', 'parentCardId', 'title', 'boardId', 'boardName', 'columnName', 'priority', 'resolved', 'withheld']
			},
			SubtaskDependencies: {
				type: 'object',
				description:
					'What a subtask waits on and what waits on it. Both lists are always present. Work that has been archived or deleted is not listed.',
				properties: {
					subtaskId: { type: 'integer' },
					cardId: { type: 'integer', description: 'The card the subtask belongs to' },
					isBlocked: { type: 'boolean', description: 'true when at least one thing the subtask waits on is not finished' },
					blockedBy: {
						type: 'array',
						items: { $ref: '#/components/schemas/SubtaskLinkedWork' },
						description: 'What this subtask waits on'
					},
					blocks: {
						type: 'array',
						items: { $ref: '#/components/schemas/SubtaskLinkedWork' },
						description: 'What waits on this subtask'
					}
				},
				required: ['subtaskId', 'cardId', 'isBlocked', 'blockedBy', 'blocks']
			},
			DependencyLink: {
				type: 'object',
				description: 'One link of a batch, as DumpFire read it: `blocked` waits on `blocker`.',
				properties: {
					blocked: { type: 'integer', description: 'Id of the end that waits' },
					blockedType: { type: 'string', enum: ['card', 'subtask'], description: 'What `blocked` is the id of' },
					blocker: { type: 'integer', description: 'Id of the end it waits on' },
					blockerType: { type: 'string', enum: ['card', 'subtask'], description: 'What `blocker` is the id of' }
				},
				required: ['blocked', 'blockedType', 'blocker', 'blockerType']
			},
			DependencyBatchCreated: {
				type: 'object',
				description: 'What a batch of dependencies recorded.',
				properties: {
					created: { type: 'integer', description: 'Links written by this request. 0 when every link was already recorded.' },
					skippedAsDuplicate: { type: 'integer', description: 'Links of the batch that were already recorded, and were left as they are' },
					boardsTouched: { type: 'array', items: { type: 'integer' }, description: 'Ids of the boards the new links have an end on' },
					links: {
						type: 'array',
						items: { $ref: '#/components/schemas/DependencyLink' },
						description: 'The new links. The ones skipped as already recorded are not in it.'
					}
				},
				required: ['created', 'skippedAsDuplicate', 'boardsTouched', 'links']
			},
			DependencyBatchRejected: {
				type: 'object',
				description:
					'The body of the 409 for a batch of dependencies of which at least one link cannot be recorded. Nothing was written, the links that ' +
					'were acceptable included, and every link at fault is listed: in `rejected` if the link itself is wrong, in `forbidden` if the key\'s user may not make it.',
				properties: {
					message: { type: 'string', description: 'Always "Batch rejected — nothing was written"' },
					written: { type: 'integer', description: 'Always 0' },
					rejected: {
						type: 'array',
						description: 'The links that are wrong in themselves, each with why',
						items: {
							type: 'object',
							properties: {
								link: { $ref: '#/components/schemas/DependencyLink' },
								reason: {
									type: 'string',
									enum: ['self', 'missing-blocked', 'missing-blocker', 'cycle', 'duplicate-in-batch'],
									description:
										'self: an end waits on itself. missing-blocked and missing-blocker: that end does not exist or is archived. ' +
										'cycle: the link would close a loop, with the stored links or with earlier links of this batch. ' +
										'duplicate-in-batch: the batch has the same link twice.'
								},
								cycle: {
									type: 'array',
									items: { $ref: '#/components/schemas/DependencyEnd' },
									description: 'Only when `reason` is cycle: the chain the link would close, in order'
								},
								message: { type: 'string', description: 'The reason in words' }
							},
							required: ['link', 'reason', 'message']
						}
					},
					forbidden: {
						type: 'array',
						description:
							'The links that are right in themselves and have an end on a board the key\'s user cannot edit. A link in `rejected` is not checked for this.',
						items: {
							type: 'object',
							properties: {
								link: { $ref: '#/components/schemas/DependencyLink' },
								message: { type: 'string' }
							},
							required: ['link', 'message']
						}
					},
					wouldSkipAsDuplicate: { type: 'integer', description: 'Links of the batch that are already recorded' },
					wouldCreate: { type: 'integer', description: 'Links that would have been written had the others not been at fault' }
				},
				required: ['message', 'written', 'rejected', 'forbidden', 'wouldSkipAsDuplicate', 'wouldCreate']
			},
			Milestone: {
				type: 'object',
				description:
					'A milestone as it is stored: a goal that cards belong to. A card belongs to one milestone at most, and says which in its `milestoneId`. ' +
					'The list and the single read each answer this and something beside it: see MilestoneListItem and MilestoneDetail.',
				properties: {
					id: { type: 'integer' },
					boardId: {
						type: ['integer', 'null'],
						description: 'The board the milestone belongs to, which is then the only board its cards may be on. null for a milestone that spans boards.'
					},
					name: { type: 'string' },
					description: { type: 'string', description: 'An empty string when none was given. Never null.' },
					targetDate: { type: ['string', 'null'], description: 'The day the milestone is meant to be reached, as it was sent, or null' },
					status: { type: 'string', enum: ['open', 'closed'] },
					createdBy: { type: ['integer', 'null'], description: 'The user who created it' },
					createdAt: { type: 'string', format: 'date-time' },
					updatedAt: { type: 'string', format: 'date-time' }
				},
				required: ['id', 'boardId', 'name', 'description', 'targetDate', 'status', 'createdBy', 'createdAt', 'updatedAt']
			},
			MilestoneListItem: {
				type: 'object',
				description:
					'A milestone as the list gives it. Every property of Milestone, described there, and five more: `boardName`, `cardCount`, `doneCount`, `optionsCount` and `boardIds`. Archived cards are not counted.',
				properties: {
					id: { type: 'integer' },
					boardId: { type: ['integer', 'null'] },
					name: { type: 'string' },
					description: { type: 'string' },
					targetDate: { type: ['string', 'null'] },
					status: { type: 'string', enum: ['open', 'closed'] },
					createdBy: { type: ['integer', 'null'] },
					createdAt: { type: 'string', format: 'date-time' },
					updatedAt: { type: 'string', format: 'date-time' },
					boardName: { type: ['string', 'null'], description: 'Name of the board the milestone belongs to. null for a milestone that spans boards.' },
					cardCount: {
						type: 'integer',
						description: 'How many cards are in the milestone, options left out: a card in a board\'s Options column or on an ideas board is counted in optionsCount'
					},
					doneCount: { type: 'integer', description: 'How many of them are in a Complete column' },
					optionsCount: { type: 'integer', description: 'How many of its cards are options, in a board\'s Options column or on an ideas board, upstream of the commitment point' },
					boardIds: {
						type: 'array',
						items: { type: 'integer' },
						description:
							'Ids of the boards its cards are on that you can open. A card on a board you cannot open is still counted in cardCount and doneCount, as GET /milestones/{milestoneId} lists it withheld.'
					}
				},
				required: [
					'id', 'boardId', 'name', 'description', 'targetDate', 'status', 'createdBy', 'createdAt', 'updatedAt',
					'boardName', 'cardCount', 'doneCount', 'optionsCount', 'boardIds'
				]
			},
			MilestoneDetail: {
				type: 'object',
				description: 'A milestone as the single read gives it. Every property of Milestone, described there, `cards` and `archivedCards`.',
				properties: {
					id: { type: 'integer' },
					boardId: { type: ['integer', 'null'] },
					name: { type: 'string' },
					description: { type: 'string' },
					targetDate: { type: ['string', 'null'] },
					status: { type: 'string', enum: ['open', 'closed'] },
					createdBy: { type: ['integer', 'null'] },
					createdAt: { type: 'string', format: 'date-time' },
					updatedAt: { type: 'string', format: 'date-time' },
					cards: {
						type: 'array',
						description:
							'The cards in the milestone. Archived cards are left out: they are listed in `archivedCards`. A card on a board the key\'s user cannot open, which a card moved off the milestone\'s board can be, ' +
							'is listed withheld, as a plan node is: its id, `withheld` true, "A card on a board you cannot open" for its title, an empty column title, and null for its priority, column and board.',
						items: {
							type: 'object',
							properties: {
								id: { type: 'integer' },
								title: { type: 'string', description: 'For a withheld card, "A card on a board you cannot open".' },
								priority: { type: ['string', 'null'], enum: ['low', 'medium', 'high', 'critical', null], description: 'null when withheld.' },
								columnId: { type: ['integer', 'null'], description: 'null when withheld.' },
								columnTitle: { type: 'string', description: 'Empty when withheld.' },
								boardId: { type: ['integer', 'null'], description: 'null when withheld.' },
								withheld: { type: 'boolean', description: 'True when the card is on a board the key\'s user cannot open.' }
							},
							required: ['id', 'title', 'priority', 'columnId', 'columnTitle', 'boardId', 'withheld']
						}
					},
					archivedCards: {
						type: 'array',
						description:
							'The archived cards in the milestone, by card id (since 2026-10-14). Archiving a card keeps its milestone, and giving the milestone to another board counts them: ' +
							'these are the cards to take out with DELETE /api/v1/milestones/{milestoneId}/cards when that is refused and no card in `cards` is on another board. ' +
							'Each is a `cards` item with `archivedAt`. A card on a board the key\'s user cannot open, which a card moved off the milestone\'s board can be, ' +
							'is listed withheld, as in `cards`, and its `archivedAt` is null.',
						items: {
							type: 'object',
							properties: {
								id: { type: 'integer' },
								title: { type: 'string', description: 'For a withheld card, "A card on a board you cannot open".' },
								priority: { type: ['string', 'null'], enum: ['low', 'medium', 'high', 'critical', null], description: 'null when withheld.' },
								columnId: { type: ['integer', 'null'], description: 'null when withheld.' },
								columnTitle: { type: 'string', description: 'Empty when withheld.' },
								boardId: { type: ['integer', 'null'], description: 'null when withheld.' },
								withheld: { type: 'boolean', description: 'True when the card is on a board the key\'s user cannot open.' },
								archivedAt: { type: ['string', 'null'], format: 'date-time', description: 'When the card was archived. null when withheld.' }
							},
							required: ['id', 'title', 'priority', 'columnId', 'columnTitle', 'boardId', 'withheld', 'archivedAt']
						}
					}
				},
				required: ['id', 'boardId', 'name', 'description', 'targetDate', 'status', 'createdBy', 'createdAt', 'updatedAt', 'cards', 'archivedCards']
			},
			CardMilestoneChange: {
				type: 'object',
				description: 'Which milestone a card is in after it was put into one or taken out.',
				properties: {
					cardId: { type: 'integer' },
					milestoneId: { type: ['integer', 'null'], description: 'The milestone the card is in now. null after it was taken out.' },
					boardId: { type: 'integer', description: 'The board the card is on' }
				},
				required: ['cardId', 'milestoneId', 'boardId']
			},
			MilestoneCardsAttached: {
				type: 'object',
				description: 'What a batch of cards put into a milestone did.',
				properties: {
					milestoneId: { type: 'integer' },
					attached: { type: 'integer', description: 'Cards put into the milestone by this request' },
					skippedAlreadyIn: { type: 'integer', description: 'Cards of the batch that were already in it' },
					movedFromOtherGoal: {
						type: 'array',
						description: 'The cards among those attached that were in another milestone, and are in this one now',
						items: {
							type: 'object',
							properties: {
								cardId: { type: 'integer' },
								title: { type: 'string' },
								fromMilestoneId: { type: 'integer', description: 'The milestone the card was in' }
							},
							required: ['cardId', 'title', 'fromMilestoneId']
						}
					},
					boardsTouched: { type: 'array', items: { type: 'integer' }, description: 'Ids of the boards the attached cards are on' }
				},
				required: ['milestoneId', 'attached', 'skippedAlreadyIn', 'movedFromOtherGoal', 'boardsTouched']
			},
			MilestoneCardsRejected: {
				type: 'object',
				description:
					'The body of the 409 for a batch of cards of which at least one cannot be put into the milestone. No card was attached, and every card at fault is listed.',
				properties: {
					message: { type: 'string', description: 'Always "Batch rejected — nothing was written"' },
					attached: { type: 'integer', description: 'Always 0' },
					problems: {
						type: 'array',
						description: 'One entry for each card that cannot be attached',
						items: {
							type: 'object',
							properties: {
								cardId: { type: 'integer' },
								reason: {
									type: 'string',
									description:
										'In words: the card does not exist or is archived, the key\'s user cannot edit its board, or the milestone belongs to one board and the card is on another'
								}
							},
							required: ['cardId', 'reason']
						}
					},
					wouldAttach: { type: 'integer', description: 'Cards that would have been attached had the others not been at fault' },
					wouldSkipAlreadyIn: { type: 'integer', description: 'Cards of the batch that are already in the milestone' }
				},
				required: ['message', 'attached', 'problems', 'wouldAttach', 'wouldSkipAlreadyIn']
			},
			MilestoneCardsDetached: {
				type: 'object',
				description: 'What a batch of cards taken out of a milestone did.',
				properties: {
					milestoneId: { type: 'integer' },
					detached: { type: 'integer', description: 'Cards taken out of the milestone by this request' },
					skippedNotInMilestone: { type: 'integer', description: 'Cards of the batch that were not in it, and were left as they are' },
					boardsTouched: { type: 'array', items: { type: 'integer' }, description: 'Ids of the boards the detached cards are on' }
				},
				required: ['milestoneId', 'detached', 'skippedNotInMilestone', 'boardsTouched']
			},
			MilestoneCardsDetachRejected: {
				type: 'object',
				description:
					'The body of the 409 for a batch of cards of which at least one cannot be taken out of the milestone. No card was detached, and every card at fault is listed.',
				properties: {
					message: { type: 'string', description: 'Always "Batch rejected — nothing was written"' },
					detached: { type: 'integer', description: 'Always 0' },
					problems: {
						type: 'array',
						description: 'One entry for each card at fault',
						items: {
							type: 'object',
							properties: {
								cardId: { type: 'integer' },
								reason: { type: 'string', description: 'In words: the card does not exist or is archived, or the key\'s user cannot edit its board' }
							},
							required: ['cardId', 'reason']
						}
					}
				},
				required: ['message', 'detached', 'problems']
			},
			PlanNode: {
				type: 'object',
				description:
					'A card or a subtask as a milestone\'s plan sees it: what it is, where it is and whether it is finished. ' +
					'Work on a board the key\'s user cannot open is in the plan, because it still blocks or is still part of the goal, but withheld: see `withheld`.',
				properties: {
					kind: { type: 'string', enum: ['card', 'subtask'], description: 'What `id` is the id of. Card 32 and subtask 32 are different things.' },
					id: { type: 'integer' },
					title: { type: 'string', description: 'For withheld work, "A card on a board you cannot open" or "A subtask on a board you cannot open"' },
					priority: {
						type: ['string', 'null'],
						enum: ['low', 'medium', 'high', 'critical', null],
						description: 'null for withheld work'
					},
					columnId: { type: ['integer', 'null'], description: 'The column it is in. For a subtask, its card\'s column. null for withheld work.' },
					columnTitle: { type: 'string', description: 'Empty for withheld work' },
					boardId: { type: ['integer', 'null'], description: 'null for withheld work' },
					boardName: { type: 'string', description: 'For withheld work, "A board you cannot open"' },
					isComplete: { type: 'boolean', description: 'A card is complete in a Complete column. A subtask is complete when it is ticked, wherever its card is.' },
					milestoneId: {
						type: ['integer', 'null'],
						description: 'The milestone it is in. For a subtask, its card\'s milestone. null for withheld work.'
					},
					parentCardId: { type: 'integer', description: 'Only on a subtask: the card it belongs to. Left out of a withheld subtask, as of a card.' },
					withheld: {
						type: 'boolean',
						description:
							'true when the work is on a board the key\'s user cannot open. Then only what it is, its id and whether it is finished are told, ' +
							'with its place in the plan: its title and board name are replaced by the texts above, its column title is empty, and its column, ' +
							'board, priority and milestone are null. Until 2026-10-14 they were given.'
					}
				},
				required: ['kind', 'id', 'title', 'priority', 'columnId', 'columnTitle', 'boardId', 'boardName', 'isComplete', 'milestoneId', 'withheld']
			},
			MilestoneNode: {
				type: 'object',
				description:
					'A card or a subtask in a milestone\'s plan, with its place in the order of work. Every property of PlanNode, described there, and eight more. ' +
					'Withheld work keeps its place in the plan: only what PlanNode says is replaced.',
				properties: {
					kind: { type: 'string', enum: ['card', 'subtask'] },
					id: { type: 'integer' },
					title: { type: 'string' },
					priority: { type: ['string', 'null'], enum: ['low', 'medium', 'high', 'critical', null] },
					columnId: { type: ['integer', 'null'] },
					columnTitle: { type: 'string' },
					boardId: { type: ['integer', 'null'] },
					boardName: { type: 'string' },
					isComplete: { type: 'boolean' },
					milestoneId: { type: ['integer', 'null'] },
					parentCardId: { type: 'integer', description: 'Only on a subtask: the card it belongs to. Left out of a withheld subtask, as of a card.' },
					withheld: { type: 'boolean', description: 'true when the work is on a board the key\'s user cannot open, as on PlanNode' },
					external: {
						type: 'boolean',
						description: 'true for work that is not in the milestone and is listed because something in the milestone waits on it'
					},
					layer: { type: 'integer', description: 'Its place in the order of work, from 0: everything it waits on is in a lower layer' },
					blockedBy: { type: 'array', items: { $ref: '#/components/schemas/DependencyEnd' }, description: 'What it waits on, among the nodes of this plan' },
					blocks: { type: 'array', items: { $ref: '#/components/schemas/DependencyEnd' }, description: 'What waits on it, among the nodes of this plan' },
					openBlockers: { type: 'array', items: { $ref: '#/components/schemas/DependencyEnd' }, description: 'Of what it waits on, what is not finished' },
					downstreamCount: { type: 'integer', description: 'How much unfinished work waits on it, directly or through other work' },
					onCriticalPath: { type: 'boolean' },
					isOption: {
						type: 'boolean',
						description:
							'true for an option, a card in a board\'s Options column or on an ideas board, or a subtask of one. It stays in the graph, where an unfinished option still blocks ' +
							'what waits on it, but is in no count of progress and never in nextActionable. Told of withheld work too, as isComplete is.'
					}
				},
				required: [
					'kind', 'id', 'title', 'priority', 'columnId', 'columnTitle', 'boardId', 'boardName', 'isComplete', 'milestoneId',
					'withheld', 'external', 'layer', 'blockedBy', 'blocks', 'openBlockers', 'downstreamCount', 'onCriticalPath', 'isOption'
				]
			},
			MilestoneSummary: {
				type: 'object',
				description:
					'The whole plan of a milestone: how far it has got, the order its work must be done in, the longest chain of unfinished work, what can be started now and what is waiting. ' +
					'Archived cards are not part of it. With `compact=true` the answer has `cardTitles` and `subtaskTitles` and no `graph`; without it, `graph` and neither of the two.',
				properties: {
					milestone: { $ref: '#/components/schemas/Milestone' },
					progress: {
						type: 'object',
						description:
							'Counts of the milestone\'s own cards. Subtasks are counted only in `openSubtasks` and `totalSubtasks`. ' +
							'Its options, cards in a board\'s Options column or on an ideas board, are counted only in `options`: not in total, done, byColumn, the subtask counts or boards.',
						properties: {
							total: { type: 'integer', description: 'Cards in the milestone, options left out' },
							done: { type: 'integer', description: 'Of which in a Complete column' },
							percent: { type: 'integer', description: 'done as a percentage of total. 100 only when every card is done, and 0 only when none is.' },
							options: { type: 'integer', description: 'The milestone\'s cards that are options, upstream of the commitment point' },
							byColumn: {
								type: 'array',
								description: 'The cards by the title of the column they are in. Cards on boards the key\'s user cannot open are counted under an empty title.',
								items: {
									type: 'object',
									properties: { columnTitle: { type: 'string' }, count: { type: 'integer' } },
									required: ['columnTitle', 'count']
								}
							},
							openSubtasks: { type: 'integer', description: 'Subtasks of those cards that are not ticked' },
							totalSubtasks: { type: 'integer', description: 'Every subtask of those cards, ticked or not: what openSubtasks is out of' },
							boards: {
								type: 'array',
								description:
									'The boards the cards are on, the one with most cards first. Cards on boards the key\'s user cannot open, which a card moved off ' +
									'the milestone\'s board can be, are counted in one entry, with id null and the name "A board you cannot open". Until 2026-10-14 each such board was named.',
								items: {
									type: 'object',
									properties: { id: { type: ['integer', 'null'] }, name: { type: 'string' }, cardCount: { type: 'integer' } },
									required: ['id', 'name', 'cardCount']
								}
							}
						},
						required: ['total', 'done', 'percent', 'options', 'byColumn', 'openSubtasks', 'totalSubtasks', 'boards']
					},
					graph: {
						type: 'object',
						description:
							'The plan as a graph, for drawing it. Left out with `compact=true`. Its nodes are the milestone\'s cards, those of their subtasks that have a dependency link, ' +
							'and any work outside the milestone that something in it waits on directly, which is marked `external`.',
						properties: {
							nodes: { type: 'array', items: { $ref: '#/components/schemas/MilestoneNode' } },
							edges: {
								type: 'array',
								description: 'One for each dependency link between two nodes: `to` waits on `from`',
								items: {
									type: 'object',
									properties: {
										from: { $ref: '#/components/schemas/DependencyEnd' },
										to: { $ref: '#/components/schemas/DependencyEnd' }
									},
									required: ['from', 'to']
								}
							},
							layers: {
								type: 'array',
								description: 'The nodes in the order of work: one array for each layer, the first holding what waits on nothing',
								items: { type: 'array', items: { $ref: '#/components/schemas/DependencyEnd' } }
							},
							unordered: {
								type: 'array',
								items: { type: 'integer' },
								description: 'Ids of the milestone\'s cards that have no dependency link either way among the nodes'
							}
						},
						required: ['nodes', 'edges', 'layers', 'unordered']
					},
					cardTitles: {
						type: 'object',
						description:
							'Only with `compact=true`: the title of each card of the plan, keyed by its id, so that the ids in the rest of the answer can be read. ' +
							'A card on a board the key\'s user cannot open has the text the nodes give in place of its title. ' +
							'A subtask\'s title is in `subtaskTitles`. Until 2026-10-14 both were here, keyed by the bare id, and a card and a subtask with the same id took one key between them.',
						additionalProperties: { type: 'string' }
					},
					subtaskTitles: {
						type: 'object',
						description: 'Only with `compact=true`: the title of each subtask of the plan, keyed by its id',
						additionalProperties: { type: 'string' }
					},
					criticalPath: {
						type: 'array',
						items: { type: 'integer' },
						description:
							'Card ids of the longest chain of unfinished work in which each waits on the one before, in the order to do them. ' +
							'Where the chain runs through a subtask its card stands in for it. That is so for a withheld subtask too: the id of its card, on a board the key\'s user cannot open, is given here, ' +
							'though the node has no parentCardId, so that the chain is the same whoever asks. Nothing else of that card is given. Empty when no unfinished work waits on other unfinished work.'
					},
					criticalPathNodes: {
						type: 'array',
						items: { $ref: '#/components/schemas/PlanNode' },
						description: 'The same chain exactly, subtasks included'
					},
					nextActionable: {
						type: 'array',
						items: { $ref: '#/components/schemas/MilestoneNode' },
						description: 'Work in the milestone that is not finished and waits on nothing unfinished: what can be started now. The work that most other work waits on is first.'
					},
					blocked: {
						type: 'array',
						description: 'Work in the milestone that is not finished and waits on something unfinished',
						items: {
							type: 'object',
							properties: {
								card: { $ref: '#/components/schemas/MilestoneNode' },
								blockers: { type: 'array', items: { $ref: '#/components/schemas/PlanNode' }, description: 'The unfinished work it waits on' }
							},
							required: ['card', 'blockers']
						}
					}
				},
				required: ['milestone', 'progress', 'criticalPath', 'criticalPathNodes', 'nextActionable', 'blocked']
			},
			TokenEntry: {
				type: 'object',
				description:
					'One entry of the record of what work cost in tokens. An entry is on a card or on a subtask, never on both. Entries are added, not replaced: a mistake is corrected by a negative entry.',
				properties: {
					id: { type: 'integer' },
					cardId: { type: ['integer', 'null'], description: 'The card the entry is on. null for an entry on a subtask.' },
					subtaskId: { type: ['integer', 'null'], description: 'The subtask the entry is on. null for an entry on a card.' },
					subtaskTitle: { type: ['string', 'null'], description: 'Title of that subtask. null for an entry on a card.' },
					tokens: { type: 'integer', format: 'int64', description: 'How many tokens. Negative for a correction.' },
					model: { type: ['string', 'null'], description: 'The model that spent them, as it was sent' },
					inputTokens: {
						type: ['integer', 'null'],
						format: 'int64',
						description: 'Of the tokens, fresh input. null when no breakdown was sent, as are the four that follow.'
					},
					outputTokens: { type: ['integer', 'null'], format: 'int64' },
					cacheReadTokens: { type: ['integer', 'null'], format: 'int64' },
					cacheWrite5mTokens: { type: ['integer', 'null'], format: 'int64' },
					cacheWrite1hTokens: { type: ['integer', 'null'], format: 'int64' },
					apiCalls: { type: ['integer', 'null'], description: 'How many calls of the model the entry covers, where that was sent' },
					note: { type: ['string', 'null'] },
					createdAt: { type: 'string', format: 'date-time' }
				},
				required: [
					'id', 'cardId', 'subtaskId', 'subtaskTitle', 'tokens', 'model', 'inputTokens', 'outputTokens', 'cacheReadTokens',
					'cacheWrite5mTokens', 'cacheWrite1hTokens', 'apiCalls', 'note', 'createdAt'
				]
			},
			CardTokens: {
				type: 'object',
				description:
					'What a card has cost in tokens, its subtasks included, with every entry behind the figure. ' +
					'A card nobody has reported on has `recorded` false and `entries` 0: that is "not recorded", which is not a cost of zero.',
				properties: {
					cardId: { type: 'integer' },
					recorded: { type: 'boolean', description: 'true when there is at least one entry. When false the figures mean nothing and should be shown as unknown.' },
					total: { type: 'integer', format: 'int64', description: 'Sum of every entry, on the card and on its subtasks' },
					direct: { type: 'integer', format: 'int64', description: 'Of which on the card itself' },
					fromSubtasks: { type: 'integer', format: 'int64', description: 'Of which on its subtasks' },
					entries: { type: 'integer', description: 'How many entries make up the total' },
					byModel: {
						type: 'array',
						description: 'The total by model, largest first. Entries that named no model are under "unspecified".',
						items: {
							type: 'object',
							properties: { model: { type: 'string' }, tokens: { type: 'integer', format: 'int64' } },
							required: ['model', 'tokens']
						}
					},
					costUsd: {
						type: ['number', 'null'],
						description:
							'Estimated cost in US dollars, at Anthropic\'s list rates. It is worked out when it is read, so a change of rate re-prices past entries. ' +
							'null when no entry named a model DumpFire has a price for.'
					},
					costExact: { type: 'boolean', description: 'true only when every priced entry carried a breakdown, so that nothing in the cost is an assumption' },
					unpricedTokens: {
						type: 'integer',
						format: 'int64',
						description:
							'Tokens left out of the cost: recorded with no model, or with a model DumpFire has no price for. An id is priced when it is one in DumpFire\'s table, or one of them ' +
							'followed by a date (eight digits) or a tag (claude-haiku-4-5-20251001, claude-opus-4-6[1m]); one followed by a version the table does not list (claude-opus-5-6, claude-opus-50) is not priced.'
					},
					apiCalls: { type: ['integer', 'null'], description: 'Calls of the model behind the total. null unless every entry said how many.' },
					entryList: { type: 'array', items: { $ref: '#/components/schemas/TokenEntry' }, description: 'Every entry, newest first' }
				},
				required: [
					'cardId', 'recorded', 'total', 'direct', 'fromSubtasks', 'entries', 'byModel', 'costUsd', 'costExact', 'unpricedTokens',
					'apiCalls', 'entryList'
				]
			},
			TokenRecorded: {
				type: 'object',
				description:
					'The answer to an entry added to a card: the id of the new entry, and the card\'s totals with it counted. The totals are those of CardTokens, described there.',
				properties: {
					entryId: { type: 'integer', description: 'Id of the new entry: what DELETE /api/v1/tokens/{entryId} takes' },
					cardId: { type: 'integer' },
					recorded: { type: 'boolean' },
					total: { type: 'integer', format: 'int64' },
					direct: { type: 'integer', format: 'int64' },
					fromSubtasks: { type: 'integer', format: 'int64' },
					entries: { type: 'integer' },
					byModel: {
						type: 'array',
						items: {
							type: 'object',
							properties: { model: { type: 'string' }, tokens: { type: 'integer', format: 'int64' } },
							required: ['model', 'tokens']
						}
					},
					costUsd: { type: ['number', 'null'] },
					costExact: { type: 'boolean' },
					unpricedTokens: { type: 'integer', format: 'int64' },
					apiCalls: { type: ['integer', 'null'] }
				},
				required: [
					'entryId', 'cardId', 'recorded', 'total', 'direct', 'fromSubtasks', 'entries', 'byModel', 'costUsd', 'costExact',
					'unpricedTokens', 'apiCalls'
				]
			},
			TokenEntryDeleted: {
				type: 'object',
				description:
					'The answer to an entry removed: its id, and the totals of the card it counted towards without it. The totals are those of CardTokens, described there.',
				properties: {
					deleted: { type: 'integer', description: 'Id of the entry that was removed' },
					cardId: { type: 'integer', description: 'The card it counted towards: its own, or its subtask\'s' },
					recorded: { type: 'boolean', description: 'false when that was the card\'s last entry' },
					total: { type: 'integer', format: 'int64' },
					direct: { type: 'integer', format: 'int64' },
					fromSubtasks: { type: 'integer', format: 'int64' },
					entries: { type: 'integer' },
					byModel: {
						type: 'array',
						items: {
							type: 'object',
							properties: { model: { type: 'string' }, tokens: { type: 'integer', format: 'int64' } },
							required: ['model', 'tokens']
						}
					},
					costUsd: { type: ['number', 'null'] },
					costExact: { type: 'boolean' },
					unpricedTokens: { type: 'integer', format: 'int64' },
					apiCalls: { type: ['integer', 'null'] }
				},
				required: [
					'deleted', 'cardId', 'recorded', 'total', 'direct', 'fromSubtasks', 'entries', 'byModel', 'costUsd', 'costExact',
					'unpricedTokens', 'apiCalls'
				]
			},
			TokenBatchRecorded: {
				type: 'object',
				description: 'What a batch of token entries recorded.',
				properties: {
					written: { type: 'integer', description: 'Entries written: all of the batch' },
					boardsTouched: { type: 'array', items: { type: 'integer' }, description: 'Ids of the boards the entries\' cards are on' },
					cardTotals: {
						type: 'array',
						description: 'One for each card the batch added to, an entry on a subtask counting towards its card',
						items: {
							type: 'object',
							properties: {
								cardId: { type: 'integer' },
								total: { type: 'integer', format: 'int64', description: 'The card\'s total now, its subtasks included' },
								entries: { type: 'integer', description: 'How many entries make up that total' }
							},
							required: ['cardId', 'total', 'entries']
						}
					}
				},
				required: ['written', 'boardsTouched', 'cardTotals']
			},
			TokenBatchRejected: {
				type: 'object',
				description:
					'The body of the 409 for a batch of token entries of which at least one cannot be recorded. No entry was written, and every entry at fault is listed.',
				properties: {
					message: { type: 'string', description: 'Always "Batch rejected — nothing was written"' },
					written: { type: 'integer', description: 'Always 0' },
					problems: {
						type: 'array',
						description: 'One for each entry at fault',
						items: {
							type: 'object',
							properties: {
								index: { type: 'integer', description: 'Where the entry is in `entries`, from 0' },
								reason: {
									type: 'string',
									description:
										'In words: what a single entry sent to the card or the subtask would have been refused for. A card or subtask that does not exist, ' +
										'and one on a board the key\'s user cannot edit, are reasons here and not a 404 or a 403.'
								}
							},
							required: ['index', 'reason']
						}
					}
				},
				required: ['message', 'written', 'problems']
			},
			CardBoardHistory: {
				type: 'object',
				description: 'Which board a card was on, and when.',
				properties: {
					cardId: { type: 'integer' },
					history: {
						type: 'array',
						description: 'One span for each stay on a board, oldest first. The last is the board the card is on now.',
						items: {
							type: 'object',
							properties: {
								boardId: { type: 'integer' },
								boardName: { type: 'string', description: 'Name of the board, or "Board not visible to you" for one the key\'s user cannot see' },
								from: { type: 'string', format: 'date-time', description: 'When the card arrived on the board' },
								to: { type: ['string', 'null'], format: 'date-time', description: 'When it left. null on the span it is in now.' },
								current: { type: 'boolean', description: 'true on the span it is in now' }
							},
							required: ['boardId', 'boardName', 'from', 'to', 'current']
						}
					}
				},
				required: ['cardId', 'history']
			},
			ActivityReportCard: {
				type: 'object',
				description: 'One card of an activity report. Nothing is made up to fill a gap: a reporting field nobody recorded is null.',
				properties: {
					id: { type: 'integer' },
					title: { type: 'string' },
					summary: { type: ['string', 'null'], description: 'Reporting field: the card in plain English. null when not recorded.' },
					businessValue: { type: ['string', 'null'] },
					theme: { type: ['string', 'null'] },
					customerImpact: { type: ['string', 'null'] },
					closeReason: { type: ['string', 'null'] },
					releaseState: { type: ['string', 'null'] },
					bucket: {
						type: 'string',
						enum: ['completed', 'closed', 'progressed', 'on hold', 'created'],
						description:
							'What happened to the card in the window. completed: its completion date is in the window. closed: likewise, and its close reason is not needed or superseded, so nothing was built. ' +
							'on hold: it is in a column titled On Hold, Hold, Blocked, Parked or Waiting, or has an on-hold note. created: it was raised in the window, has not been edited since (updatedAt is its createdAt), and the activity log records no move of it; one raised before 2026-10-01 is also still in the board\'s first column that is not an Options column (since 2026-10-27, version 1.3.1). ' +
							'progressed: anything else, a card that sits in a Complete column and was completed outside the window included.'
					},
					priority: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
					columnTitle: { type: 'string' },
					boardId: { type: 'integer' },
					createdAt: { type: 'string', format: 'date-time' },
					createdBy: { type: ['integer', 'null'] },
					createdByName: { type: ['string', 'null'] },
					completedAt: { type: ['string', 'null'], format: 'date-time' },
					milestoneId: { type: ['integer', 'null'] },
					milestoneName: {
						type: ['string', 'null'],
						description: 'Null when the card is in no milestone, or in one you cannot open (card 2257). milestoneId is given either way.'
					},
					subtasks: {
						type: 'object',
						properties: {
							total: { type: 'integer' },
							completed: { type: 'integer' },
							items: {
								type: 'array',
								description: 'Only with `include=subtasks`, and only on a card that has subtasks',
								items: {
									type: 'object',
									properties: { id: { type: 'integer' }, title: { type: 'string' }, completed: { type: 'boolean' } },
									required: ['id', 'title', 'completed']
								}
							}
						},
						required: ['total', 'completed']
					},
					comments: {
						type: 'array',
						description:
							'Only with `include=comments`: the card\'s most recent comments, newest first, `commentLimit` of them at most, and none with `commentLimit=0`',
						items: {
							type: 'object',
							properties: {
								id: { type: 'integer' },
								content: { type: 'string' },
								createdAt: { type: 'string', format: 'date-time' },
								username: { type: 'string' }
							},
							required: ['id', 'content', 'createdAt', 'username']
						}
					},
					closeReasonAssumed: {
						type: 'boolean',
						description: 'true when the card was completed in the window with no close reason recorded, so that it is counted as delivered on an assumption'
					}
				},
				required: [
					'id', 'title', 'summary', 'businessValue', 'theme', 'customerImpact', 'closeReason', 'releaseState', 'bucket', 'priority',
					'columnTitle', 'boardId', 'createdAt', 'createdBy', 'createdByName', 'completedAt', 'milestoneId', 'milestoneName',
					'subtasks', 'closeReasonAssumed'
				]
			},
			ActivityReportBoard: {
				type: 'object',
				description: 'One board of an activity report, with its cards.',
				properties: {
					boardId: { type: 'integer' },
					name: { type: 'string' },
					emoji: { type: ['string', 'null'] },
					parentCardId: { type: ['integer', 'null'], description: 'The card this board is a sub-board of, or null' },
					totals: {
						type: 'object',
						description: 'How many of the board\'s cards are in each bucket',
						properties: {
							completed: { type: 'integer' },
							closed: { type: 'integer' },
							progressed: { type: 'integer' },
							'on hold': { type: 'integer' },
							created: { type: 'integer' }
						},
						required: ['completed', 'closed', 'progressed', 'on hold', 'created']
					},
					cards: { type: 'array', items: { $ref: '#/components/schemas/ActivityReportCard' } }
				},
				required: ['boardId', 'name', 'emoji', 'parentCardId', 'totals', 'cards']
			},
			ActivityReport: {
				type: 'object',
				description:
					'What happened in a window of time, on the boards the key\'s user can see. A card is in the report if anything about it moved in the window: ' +
					'it was completed, raised or edited, an action was logged against it, or someone commented on it. Archived cards are left out. Read `meta` before quoting a figure.',
				properties: {
					period: {
						type: 'object',
						properties: {
							from: { type: 'string', format: 'date-time', description: 'Start of the window, UTC, in ISO 8601: a date sent as from is the start of that day' },
							to: { type: 'string', format: 'date-time', description: 'End of the window, in the same form: a date sent as to is the last second of that day' },
							days: { type: 'integer' }
						},
						required: ['from', 'to', 'days']
					},
					user: {
						type: ['object', 'null'],
						description: 'Whose activity the report is of. null for a report on everyone, and when there is no user with the id asked for.',
						properties: {
							id: { type: 'integer' },
							username: { type: 'string' },
							emoji: { type: ['string', 'null'] }
						},
						required: ['id', 'username', 'emoji']
					},
					totals: {
						type: 'object',
						description: 'How many cards are in each bucket, over every board of the report',
						properties: {
							completed: { type: 'integer' },
							closed: { type: 'integer' },
							progressed: { type: 'integer' },
							'on hold': { type: 'integer' },
							created: { type: 'integer' },
							boards: { type: 'integer', description: 'Boards in the report' },
							cards: { type: 'integer', description: 'Cards in the report' }
						},
						required: ['completed', 'closed', 'progressed', 'on hold', 'created', 'boards', 'cards']
					},
					boards: {
						type: 'array',
						items: { $ref: '#/components/schemas/ActivityReportBoard' },
						description: 'The boards with a card in the report, the one with most completed and closed cards first'
					},
					milestones: {
						type: 'array',
						description:
							'The milestones you can open, of the report\'s cards, in which more cards were complete at the end of the window than at its start ' +
							'(card 2257: one you cannot open is left out). ' +
							'Their counts are of every card in the milestone that is not archived and is on a board the key\'s user can open (every board, to an administrator), by its completion date. ' +
							'Until 2026-10-20 a card on a board they could not open was counted, so moving from across its completion told them when it was completed (item 80).',
						items: {
							type: 'object',
							properties: {
								id: { type: 'integer' },
								name: { type: 'string' },
								boardId: { type: ['integer', 'null'] },
								targetDate: { type: ['string', 'null'] },
								status: { type: 'string', enum: ['open', 'closed'] },
								totalCards: { type: 'integer' },
								completedAtStart: { type: 'integer', description: 'Cards completed before the window' },
								completedAtEnd: { type: 'integer', description: 'Cards completed by the end of it' },
								percentAtStart: { type: 'integer' },
								percentAtEnd: { type: 'integer' },
								hasTargetDate: { type: 'boolean', description: 'false when the milestone has no target date, so that nothing can be said about its being on time' }
							},
							required: [
								'id', 'name', 'boardId', 'targetDate', 'status', 'totalCards', 'completedAtStart', 'completedAtEnd',
								'percentAtStart', 'percentAtEnd', 'hasTargetDate'
							]
						}
					},
					meta: {
						type: 'object',
						description: 'What the figures rest on, and what they leave out.',
						properties: {
							generatedAt: { type: 'string', format: 'date-time' },
							completionBasis: { type: 'string', enum: ['completedAt'], description: 'A card is completed in the window by its completion date, not by the activity log' },
							attribution: { type: 'string', description: 'How a card was taken to be a user\'s, in words. "All users." for a report on everyone.' },
							closeReasonAssumedCount: { type: 'integer', description: 'Cards counted as delivered with no close reason recorded' },
							missingSummaryCount: { type: 'integer', description: 'Cards in the report with no summary recorded' },
							completedOutsideWindow: {
								type: 'integer',
								description: 'Cards in a Complete column that were not completed in the window. They are in the report as progressed.'
							},
							boardsExcludedForAccess: {
								type: 'integer',
								deprecated: true,
								description:
									'Always 0. Until 2026-10-20 it counted the boards with activity in the window that the key\'s user could not open, which told them when those boards were worked on. ' +
									'The report now reads only boards they can open, and refuses a named board they cannot open (403). Still in every answer (item 80).'
							}
						},
						required: [
							'generatedAt', 'completionBasis', 'attribution', 'closeReasonAssumedCount', 'missingSummaryCount',
							'completedOutsideWindow', 'boardsExcludedForAccess'
						]
					},
					upstream: {
						type: ['object', 'null'],
						description:
							'What happened upstream of the commitment point on the boards the report covers, over the window, both ends included, and the options they hold now. ' +
							'An option is a card in a board\'s Options column or on an ideas board: it is in no bucket and no total above. ' +
							'Each card counts once, under its last act in the window among committed, returned, discarded and sent on; abandoned work is counted on its own. ' +
							'null for a report on one user, since these describe the boards, whoever\'s work it was.',
						properties: {
							options: { type: 'integer', description: 'Options now: live cards in an upstream column of these boards' },
							committedFromOptions: { type: 'integer', description: 'Cards whose last act in the window was a commitment out of upstream' },
							returnedToOptions: { type: 'integer', description: 'Cards whose last act in the window was a return into upstream' },
							discarded: { type: 'integer', description: 'Cards whose last act in the window was a discard, archived or deleted from upstream' },
							sentOn: { type: 'integer', description: 'Cards whose last act in the window was a Send to a board outside these boards' },
							abandoned: { type: 'integer', description: 'Cards of committed work archived before Complete in the window' },
							discardRate: {
								type: ['number', 'null'],
								description: 'discarded / (discarded + committedFromOptions + sentOn), from 0 to 1; null when all three are 0'
							},
							oldestOptionDays: { type: ['integer', 'null'], description: 'Whole days the oldest option now has waited; null with no options' },
							agingOptions: { type: 'integer', description: 'Options now that have waited more than 30 days' }
						},
						required: [
							'options', 'committedFromOptions', 'returnedToOptions', 'discarded', 'sentOn', 'abandoned', 'discardRate',
							'oldestOptionDays', 'agingOptions'
						]
					}
				},
				required: ['period', 'user', 'totals', 'boards', 'milestones', 'meta', 'upstream']
			}
		},
		parameters: {
			boardId: {
				name: 'boardId',
				in: 'path',
				required: true,
				schema: { type: 'integer', minimum: 1 },
				description: 'Board ID: a whole number of 1 or more, written in digits. Anything else, 1.5, abc and 1e3 among them, is 400 Invalid board ID.'
			},
			cardId: {
				name: 'cardId',
				in: 'path',
				required: true,
				schema: { type: 'integer', minimum: 1 },
				description: 'Card ID: a whole number of 1 or more, written in digits. Anything else, 1.5, abc and 1e3 among them, is 400 Invalid card ID.'
			},
			subtaskId: {
				name: 'subtaskId',
				in: 'path',
				required: true,
				schema: { type: 'integer', minimum: 1 },
				description: 'Subtask ID: a whole number of 1 or more, written in digits. Anything else, 1.5, abc and 1e3 among them, is 400 Invalid subtask ID.'
			},
			categoryId: {
				name: 'categoryId',
				in: 'path',
				required: true,
				schema: { type: 'integer', minimum: 1 },
				description: 'Category ID: a whole number of 1 or more, written in digits. Anything else, 1.5, abc and 1e3 among them, is 400 Invalid category ID.'
			},
			columnId: {
				name: 'columnId',
				in: 'path',
				required: true,
				schema: { type: 'integer', minimum: 1 },
				description: 'Column ID: a whole number of 1 or more, written in digits. Anything else, 1.5, abc and 1e3 among them, is 400 Invalid column ID.'
			},
			labelId: {
				name: 'labelId',
				in: 'path',
				required: true,
				schema: { type: 'integer', minimum: 1 },
				description: 'Label ID: a whole number of 1 or more, written in digits. Anything else, 1.5, abc and 1e3 among them, is 400 Invalid label ID.'
			},
			webhookId: {
				name: 'webhookId',
				in: 'path',
				required: true,
				schema: { type: 'integer', minimum: 1 },
				description: 'Webhook ID: a whole number of 1 or more, written in digits. Anything else, 1.5, abc and 1e3 among them, is 400 Invalid webhook ID.'
			},
			milestoneId: {
				name: 'milestoneId',
				in: 'path',
				required: true,
				schema: { type: 'integer', minimum: 1 },
				description: 'Milestone ID: a whole number of 1 or more, written in digits. Anything else, 1.5, abc and 1e3 among them, is 400 Invalid milestone ID.'
			},
			entryId: {
				name: 'entryId',
				in: 'path',
				required: true,
				schema: { type: 'integer', minimum: 1 },
				description: 'ID of one token entry, as `id` in a card\'s `entryList` and as `entryId` in the answer that recorded it'
			}
		},
		responses: {
			BadRequest: {
				description:
					'The request is not one the operation accepts, and the message says why: an id in the path that is not a whole number of 1 or more; a body that is ' +
					'missing, is not valid JSON, or is JSON and not an object; or a field of the body that is missing, of the wrong type, empty, too long or not allowed. ' +
					'Nothing was written.',
				content: {
					'application/json': {
						schema: { $ref: '#/components/schemas/Error' },
						example: { message: 'The request body is missing or is not valid JSON' }
					}
				}
			},
			Unauthorized: {
				description: 'No Authorization header, one that is not "Bearer <key>", or a key that is unknown, revoked or expired',
				content: {
					'application/json': {
						schema: { $ref: '#/components/schemas/Error' },
						example: { message: 'Invalid or expired API key' }
					}
				}
			},
			Forbidden: {
				description:
					'The key\'s user may not do this: no access to the board the resource is on, or view access where edit access is needed. Nothing was written.',
				content: {
					'application/json': {
						schema: { $ref: '#/components/schemas/Error' },
						example: { message: 'No edit access to this board' }
					}
				}
			},
			NotFound: {
				description: 'The resource the path names does not exist. The message says what was not found.',
				content: {
					'application/json': {
						schema: { $ref: '#/components/schemas/Error' },
						example: { message: 'Card not found' }
					}
				}
			},
			PayloadTooLarge: {
				description:
					'The request body is over the size limit, which is 512 KB on every operation of this API. Nothing was written. ' +
					'A request that declares more than the limit in Content-Length is answered before its body is read: the message says how large it is and ' +
					'what the limit is, and `limitBytes` is the limit as a number of bytes. A body sent in chunks, with no Content-Length, is answered the ' +
					'same once it has been read past the limit, with the limit and `limitBytes`; its size is not said, because it was not read to its end. ' +
					'A body that runs past the Content-Length it declared is answered as in the example, with no `limitBytes`.',
				content: {
					'application/json': {
						schema: { $ref: '#/components/schemas/Error' },
						example: { message: 'Payload Too Large' }
					}
				}
			},
			RateLimited: {
				description:
					'More than 60 requests in a minute with this key, counted once the key is checked; or, with no key DumpFire accepts, more than 60 in a minute from this address, an IPv6 address counted by its /64 network. The request was turned away and nothing was written: send it again, unchanged, after the Retry-After seconds.',
				headers: {
					'Retry-After': {
						description: 'Seconds until the request can be sent again. The same number as `retryAfterSecs` in the body.',
						schema: { type: 'integer' }
					}
				},
				content: {
					'application/json': {
						schema: { $ref: '#/components/schemas/RateLimitError' },
						example: { message: 'Rate limit exceeded', retryAfterSecs: 42 }
					}
				}
			},
			InternalError: {
				description:
					'DumpFire failed, and not the request: a field the operation cannot use is a 400. For a write nothing was written, so the same ' +
					'request can be sent again.',
				content: {
					'application/json': {
						schema: { $ref: '#/components/schemas/Error' },
						example: { message: 'Internal Error' }
					}
				}
			}
		}
	},
	paths: {
		// ─── User ───────────────────────────────────────────────────────────
		'/api/v1/me': {
			get: {
				tags: ['User'],
				summary: 'Get current user',
				description: "Returns the user profile associated with the API key.",
				operationId: 'getMe',
				responses: {
					'200': {
						description: 'User profile',
						content: {
							'application/json': {
								schema: { $ref: '#/components/schemas/User' },
								example: {
									id: 2,
									username: 'Greg Boon',
									email: 'greg@example.com',
									emoji: '🧑‍💻',
									role: 'admin'
								}
							}
						}
					},
					'401': { $ref: '#/components/responses/Unauthorized' },
					'429': { $ref: '#/components/responses/RateLimited' },
					'500': { $ref: '#/components/responses/InternalError' }
				}
			}
		},

		'/api/v1/me/stats': {
			get: {
				tags: ['User'],
				summary: 'Get personal stats',
				description:
					'How the key\'s user is doing: cards completed in all, in the last 7 days and in the last 30, the average lead time of the cards assigned to them, the days from commitment to done ' +
					'(avgLeadTimeDays, and avgCycleTimeDays at the same value, its name for history), the current streak of days with a completion, how many cards are assigned and open, and the last 20 activity entries. ' +
					'The average, the open count and the entries are of boards the key\'s user can open; the completed count and the streak are of the user\'s own completions, on any board. ' +
					'The average and the open count are of committed work: an option, a card in a board\'s Options column or on an ideas board, is in neither (since 2026-10-26, milestone 22). ' +
					'Both are of live cards: an archived card is in neither (the average since 2026-10-27); the completed count and the streak include it, as archiving a card does not undo its completion.',
				operationId: 'getMeStats',
				responses: {
					'200': {
						description: 'Personal statistics',
						content: {
							'application/json': {
								schema: { $ref: '#/components/schemas/UserStats' },
								example: {
									cardsCompleted: { total: 41, last7Days: 3, last30Days: 12 },
									avgCycleTimeDays: 4.2,
									avgLeadTimeDays: 4.2,
									streak: 2,
									activeCards: 5,
									recentActivity: [
										{ id: 9120, action: 'api:card_updated', detail: 'Updated fields: priority on "Deploy v2.1"', boardId: 1, createdAt: '2026-10-13T09:41:07.000Z' }
									]
								}
							}
						}
					},
					'401': { $ref: '#/components/responses/Unauthorized' },
					'429': { $ref: '#/components/responses/RateLimited' },
					'500': { $ref: '#/components/responses/InternalError' }
				}
			}
		},

		// ─── Boards ─────────────────────────────────────────────────────────
		'/api/v1/boards': {
			get: {
				tags: ['Boards'],
				summary: 'List boards',
				description:
					"Returns all boards the API key's user has access to, newest first. `kind` lists only the delivery boards or only the ideas boards among them (since 2026-10-26, milestone 22): " +
					'a filter of the list, so it never lists a board the key\'s user cannot open.',
				operationId: 'listBoards',
				parameters: [
					{
						name: 'kind',
						in: 'query',
						schema: { type: 'string', enum: ['delivery', 'ideas'] },
						description:
							'Only the boards of this kind: "delivery", boards of committed work (every board that is not an ideas board), or "ideas", ideas boards, every column of which is upstream of the commitment point. Not sent, or empty, every board. ' +
							'Anything else is 400 kind must be "delivery" or "ideas", not <what was sent>.'
					}
				],
				responses: {
					'200': {
						description: 'List of boards',
						content: {
							'application/json': {
								schema: { type: 'array', items: { $ref: '#/components/schemas/Board' } }
							}
						}
					},
					'400': {
						description: 'kind is neither "delivery" nor "ideas"',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'kind must be "delivery" or "ideas", not "backlog"' } } }
					},
					'401': { $ref: '#/components/responses/Unauthorized' },
					'429': { $ref: '#/components/responses/RateLimited' },
					'500': { $ref: '#/components/responses/InternalError' }
				}
			},
			post: {
				tags: ['Boards'],
				summary: 'Create a board',
				description:
					'Creates a new board with its kind\'s default columns: Options, To Do, On Hold, In Progress and Complete for a delivery board, the default, and New Ideas, Shaping and Ready for Replenishment for an ideas board (kind, since 2026-10-26). ' +
					'A delivery board\'s Options column, first, is its own for good: it is not renamed to anything but Options, deleted or given away, and no other is made. ' +
					'The API key\'s user is automatically added as board owner. To create a sub-board linked to a card, pass parentCardId: a sub-board is always a delivery board, and no sub-board is made under an option. ' +
					'To file it under a board category on the dashboard, pass categoryId: until 2026-10-14 it was ignored and the board made unfiled (item 91). ' +
					'A new board is private; its owner sets isPublic with PUT /boards/{boardId}.',
				operationId: 'createBoard',
				requestBody: {
					required: true,
					content: {
						'application/json': {
							schema: {
								type: 'object',
								required: ['name'],
								properties: {
									name: { type: 'string', minLength: 1, maxLength: 200, description: 'Board name: text, trimmed, of 1 to 200 characters' },
									emoji: { type: 'string', minLength: 1, maxLength: 32, description: 'Board emoji icon, 1 to 32 characters (default: 📋)' },
									parentCardId: { type: ['integer', 'null'], minimum: 1, description: 'ID of a card to link this board to as a sub-board. null, or left out, for none.' },
									categoryId: {
										type: ['integer', 'null'],
										minimum: 1,
										description:
											'The board category to file the new board under on the dashboard. null, or left out, for none. One that does not exist is 404, and one that holds boards, none of which the key\'s user can open, is 403. ' +
											'Until 2026-10-14 it was ignored and the board made unfiled.'
									},
									kind: {
										type: 'string',
										enum: ['delivery', 'ideas'],
										description:
											'"delivery", the default, made with Options, To Do, On Hold, In Progress and Complete; or "ideas", an ideas board, every column of which is upstream of the commitment point, made with New Ideas, Shaping and Ready for Replenishment. ' +
											'Anything else is 400 kind must be "delivery" or "ideas", not <what was sent>. A sub-board is a delivery board: "ideas" with a parentCardId is 409.'
									}
								}
							},
							examples: {
								basic: {
									summary: 'Create a standalone board',
									value: { name: 'Sprint 43', emoji: '🚀' }
								},
								subBoard: {
									summary: 'Create a sub-board linked to a card',
									value: { name: 'Sub-project Tasks', emoji: '📂', parentCardId: 10 }
								}
							}
						}
					}
				},
				responses: {
					'201': {
						description: 'Board created with its kind\'s default columns',
						content: {
							'application/json': {
								schema: { $ref: '#/components/schemas/BoardDetail' }
							}
						}
					},
					'400': {
						description: 'No name, a name that is empty or over 200 characters, an emoji that is empty or over 32, a field of the wrong type (`name must be text`; `parentCardId must be an id`; `categoryId must be an id`), a kind that is neither kind (`kind must be "delivery" or "ideas", not "backlog"`), or a body that is missing, is not valid JSON or is not an object. The fields are read before the parent card and the board category are looked for. Nothing was created.',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'name is required' } } }
					},
					'401': { $ref: '#/components/responses/Unauthorized' },
					'403': {
						description:
							'For a sub-board, no edit access to the board the parent card is on, which is the example. ' +
							'Or categoryId names a board category that holds boards, none of which the key\'s user can open: `No access to this board category`. Nothing was created.',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'No edit access to the parent card\'s board' } } }
					},
					'404': {
						description:
							'For a sub-board, there is no card with the id given as parentCardId, which is the example. ' +
							'Or the board category sent as categoryId does not exist: `Board category not found`. Nothing was created.',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'Parent card not found' } } }
					},
					'409': {
						description:
							'Sub-board only: a board under that card would be more than 20 levels deep, which is the example; kind is "ideas" (`A sub-board is a delivery board.`); ' +
							'or the card is an option, which has no sub-boards: on an ideas board, `An idea has no sub-boards; send it to a delivery board first.`, and in an Options column, `An option has no sub-boards; commit it first, by moving it out of the Options column.` Nothing was created.',
						content: {
							'application/json': {
								schema: { $ref: '#/components/schemas/Error' },
								example: { message: 'Sub-boards can be nested at most 20 levels deep, and a board under this card would be deeper.' }
							}
						}
					},
					'413': { $ref: '#/components/responses/PayloadTooLarge' },
					'429': { $ref: '#/components/responses/RateLimited' },
					'500': { $ref: '#/components/responses/InternalError' }
				}
			}
		},

		'/api/v1/boards/{boardId}': {
			get: {
				tags: ['Boards'],
				summary: 'Get board details',
				description: 'Returns a single board with its columns, in order of position, ties by column id.',
				operationId: 'getBoard',
				parameters: [{ $ref: '#/components/parameters/boardId' }],
				responses: {
					'200': {
						description: 'Board with columns',
						content: {
							'application/json': {
								schema: { $ref: '#/components/schemas/BoardDetail' }
							}
						}
					},
					'400': {
						description: 'boardId is not a whole number of 1 or more',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'Invalid board ID' } } }
					},
					'401': { $ref: '#/components/responses/Unauthorized' },
					'403': {
						description: 'No access to this board',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'No access to this board' } } }
					},
					'404': {
						description: 'There is no such board, whoever asks: it is looked for before access is checked. Until 2026-10-14 everyone but an administrator was answered 403.',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'Board not found' } } }
					},
					'429': { $ref: '#/components/responses/RateLimited' },
					'500': { $ref: '#/components/responses/InternalError' }
				}
			},
			put: {
				tags: ['Boards'],
				summary: 'Update a board',
				description:
					'Updates the fields sent. Updatable fields: name, emoji, categoryId, isPublic, kind. At least one of them must be sent.\n\n' +
					'Only the fields whose value changes are written, logged and told: a body whose every field is as the board holds it (a name that trims to the stored one included) ' +
					'answers 200 with the board as it is, with no api:board_updated and updatedAt unchanged, and api:board_updated names only the fields that changed. ' +
					'A request that would be refused is still refused first. Until 2026-10-14 every field sent was written and named (item 95).\n\n' +
					'Edit access to the board is enough for name, emoji and categoryId. `isPublic` decides who can see the board, and is accepted only from the board\'s owner or an administrator: ' +
					'sent by anyone else, the whole request is answered 403 and none of its fields is saved. An editor leaves it out.\n\n' +
					'`parentCardId` is not changed here: a board is put under a card, or taken out from under one, on the board page. It is accepted only as the card the board hangs under ' +
					'(null for a board on the dashboard), so a board read with GET can be sent back whole (an editor leaves isPublic out); any other value is 400 and nothing is saved. Until 2026-10-14 it was ignored and the other fields saved (item 91).',
				operationId: 'updateBoard',
				parameters: [{ $ref: '#/components/parameters/boardId' }],
				requestBody: {
					required: true,
					content: {
						'application/json': {
							schema: {
								type: 'object',
								properties: {
									name: { type: 'string', minLength: 1, maxLength: 200, description: 'Trimmed' },
									emoji: { type: 'string', minLength: 1, maxLength: 32 },
									categoryId: { type: ['integer', 'null'], minimum: 1, description: 'The board category to file the board under on the dashboard. null files it under none. One that does not exist is 404, and one that holds boards, none of which the key\'s user can open, is 403: until 2026-10-14 the board was filed under it.' },
									isPublic: { type: 'boolean', description: 'Whether everyone who is signed in can view the board. Only its owner or an administrator may send it.' },
									parentCardId: {
										type: ['integer', 'null'],
										minimum: 1,
										description:
											'Accepted only as the card the board hangs under, or null for a board on the dashboard, so a board read with GET can be sent back whole (an editor leaves isPublic out). ' +
											'Any other value, null on a sub-board included, is 400 (`parentCardId 12 is not this board\'s parent card (none): …`), and nothing is saved. ' +
											'A board is put under a card, or taken out from under one, on the board page. It does not count as a field to update.'
									},
									kind: {
										type: 'string',
										enum: ['delivery', 'ideas'],
										description:
											'"delivery" or "ideas". Left out, or sent as the board holds it, the kind is kept. A change is the board\'s owner\'s or an administrator\'s (403 otherwise), and only of an empty board, no card live or archived: its columns are then replaced with the other kind\'s defaults. ' +
											'A board holding cards becomes an ideas board by POST /api/v1/boards/{boardId}/convert; an ideas board holding cards does not become a delivery board. Anything else is 400 kind must be "delivery" or "ideas", not <what was sent>.'
									}
								}
							},
							example: { name: 'Sprint 44', emoji: '🚀' }
						}
					}
				},
				responses: {
					'200': {
						description: 'Updated board',
						content: {
							'application/json': {
								schema: { $ref: '#/components/schemas/Board' }
							}
						}
					},
					'400': {
						description: 'None of the five fields was sent, the name is empty or over 200 characters, the emoji empty or over 32, a field of the wrong type (`name must be text`, `categoryId must be an id`), a kind that is neither kind (`kind must be "delivery" or "ideas", not "backlog"`), `isPublic` is not `true` or `false` (`isPublic must be true or false`, answered to the board\'s owner or an administrator: anyone else who sends it is answered 403 whatever its value), a parentCardId other than the board\'s own (`parentCardId 12 is not this board\'s parent card (none): the board has been moved since it was read, or a link was meant. A board is put under a card, or taken out from under one, on the board page`, null on a sub-board included) or one that is not an id (`parentCardId must be an id`), boardId is not a whole number of 1 or more, or the body is missing, is not valid JSON or is not an object. Nothing was written.',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'No valid fields to update' } } }
					},
					'401': { $ref: '#/components/responses/Unauthorized' },
					'403': {
						description:
							'No edit access to this board. ' +
							'Or `isPublic` was sent by a caller who can edit the board and is neither its owner nor an administrator, which is the example. ' +
							'Or `kind` was sent changed by such a caller: `Only the board\'s owner or an administrator can change whether it is an ideas board`. ' +
							'Or categoryId names a board category that holds boards, none of which the key\'s user can open: `No access to this board category`. Nothing was written.',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'Only board owners and admins can change visibility' } } }
					},
					'404': {
						description: 'There is no such board, whoever asks: it is looked for before access is checked, and until 2026-10-14 everyone but an administrator was answered 403. Or the board category sent as categoryId does not exist: `Board category not found`, where it was stored. Nothing was written.',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'Board not found' } } }
					},
					'409': {
						description:
							'A change of kind that cannot be made, and nothing was written: the board is a sub-board, which is a delivery board (`A sub-board is a delivery board.`); ' +
							'or the board holds cards, archived ones included, whose commitment the change would decide without anyone deciding it: to "ideas" the message names POST /api/v1/boards/{boardId}/convert, which is the example, and back to "delivery" it says to move or delete them first.',
						content: {
							'application/json': {
								schema: { $ref: '#/components/schemas/Error' },
								example: {
									message:
										'This board holds 3 cards. Making it an ideas board would make them options without anyone deciding it: convert it instead (POST /api/v1/boards/12/convert), which counts the cards first and records it.'
								}
							}
						}
					},
					'413': { $ref: '#/components/responses/PayloadTooLarge' },
					'429': { $ref: '#/components/responses/RateLimited' },
					'500': { $ref: '#/components/responses/InternalError' }
				}
			},
			delete: {
				tags: ['Boards'],
				summary: 'Delete a board',
				description:
					'Permanently deletes the board and all its contents. Requires owner or admin role.\n\n' +
					'Goes with it: its columns, cards, labels, milestones, webhooks and card categories; every sub-board under any of its cards, at every depth, with its categories; ' +
					'every dependency link that has a deleted card or subtask at either end; and the report schedules that name the board. ' +
					'Kept: cards on other boards that were in one of its milestones, which are then in no milestone, and any that carried one of its categories, which then has none. ' +
					'Until 2026-10-14 its categories were kept, as categories of no board, which every key is given. Attachment files are kept on the server for 30 days.\n\n' +
					'No activity entry is written on the board, because the board\'s log is deleted with it, and no webhook of the board is sent: its webhooks go with it. ' +
					'A card on another board released from one of its milestones logs `api:milestone_card_removed` on its own board, and that board\'s webhooks are sent `milestone.card_removed` (item 103). ' +
					'The delete is one transaction: all of it happens or none of it.',
				operationId: 'deleteBoard',
				parameters: [{ $ref: '#/components/parameters/boardId' }],
				responses: {
					'200': {
						description: 'Deleted, with everything listed above',
						content: {
							'application/json': {
								schema: { type: 'object', properties: { success: { type: 'boolean' } }, required: ['success'] },
								example: { success: true }
							}
						}
					},
					'400': {
						description: 'boardId is not a whole number of 1 or more. Nothing was deleted.',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'Invalid board ID' } } }
					},
					'401': { $ref: '#/components/responses/Unauthorized' },
					'403': {
						description: 'Only the board\'s owner or an administrator may delete it. Nothing was deleted.',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'Only board owners and admins can delete boards' } } }
					},
					'404': {
						description: 'There is no such board, whoever asks: it is looked for before access is checked. Until 2026-10-14 everyone but an administrator was answered 403.',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'Board not found' } } }
					},
					'429': { $ref: '#/components/responses/RateLimited' },
					'500': { $ref: '#/components/responses/InternalError' }
				}
			}
		},

		'/api/v1/boards/{boardId}/convert': {
			post: {
				tags: ['Boards'],
				summary: 'Make a board an ideas board, cards and all',
				description:
					'Makes the board an ideas board with the cards it holds: every card on it, archived ones included, becomes an option (its committedAt and committedBy are cleared), its To Do, On Hold and Complete columns, which must be empty, are deleted (a board with no card at all is given the ideas board\'s default columns instead), ' +
					'and its Options column is deleted with them when it holds no card, live or archived, or else becomes an ordinary column, every column of an ideas board being upstream. One `api:board_converted_to_ideas` entry is written ("N cards became ideas"); nothing is written or sent for each card, and no webhook. ' +
					'Only the board\'s owner or an administrator may. `cards` is how many cards, live and archived, the board was seen to hold: a board that holds another number now is 409, so a card added since is not made an option unseen. ' +
					'An empty board can also be switched with PUT /api/v1/boards/{boardId} and kind, which gives it the ideas board\'s default columns instead. An ideas board holding cards is not made a delivery board.',
				operationId: 'convertBoard',
				parameters: [{ $ref: '#/components/parameters/boardId' }],
				requestBody: {
					required: true,
					content: {
						'application/json': {
							schema: {
								type: 'object',
								required: ['kind', 'cards'],
								properties: {
									kind: { type: 'string', enum: ['ideas'], description: 'What the board becomes. Anything else is 400 kind must be "ideas", not <what was sent>.' },
									cards: { type: 'integer', minimum: 0, description: 'How many cards, live and archived, the board holds, as the caller last saw it.' }
								}
							},
							example: { kind: 'ideas', cards: 7 }
						}
					}
				},
				responses: {
					'200': {
						description: 'The board, now an ideas board, with its columns',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/BoardDetail' } } }
					},
					'400': { $ref: '#/components/responses/BadRequest' },
					'401': { $ref: '#/components/responses/Unauthorized' },
					'403': {
						description: 'The caller cannot open the board, or can and is neither its owner nor an administrator',
						content: {
							'application/json': {
								schema: { $ref: '#/components/schemas/Error' },
								example: { message: "Only the board's owner or an administrator can make it an ideas board" }
							}
						}
					},
					'404': {
						description: 'There is no such board',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'Board not found' } } }
					},
					'409': {
						description:
							'Nothing was changed. In this order: the board is an ideas board already (`This board is already an ideas board.`); a card on it has a sub-board, and a card with sub-boards is never an option; ' +
							'the board is a sub-board (`A sub-board is a delivery board.`); a column whose title makes it To Do, On Hold or Complete holds a card, live or archived, which an ideas board has none of ' +
							'(a To Do or On Hold column is renamed first, `"To Do" holds 2 cards, and an ideas board has no To Do column: rename it first.`; a Complete column\'s cards are moved or deleted); the board holds another number of cards than `cards`. ' +
							'On success the empty To Do, On Hold and Complete columns are removed, and a board holding no card at all is given the ideas board\'s default columns (New Ideas, Shaping, Ready for Replenishment) in place of its own; the entry names the columns removed or replaced.',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'The board now holds 5 cards; look again.' } } }
					},
					'413': { $ref: '#/components/responses/PayloadTooLarge' },
					'429': { $ref: '#/components/responses/RateLimited' },
					'500': { $ref: '#/components/responses/InternalError' }
				}
			}
		},

		'/api/v1/boards/{boardId}/upstream': {
			get: {
				tags: ['Boards'],
				summary: 'What happened upstream of the commitment point on a board',
				description:
					'The board\'s upstream figures over the last `days` days, ending now, both ends included (since 2026-10-26, milestone 22): the options it holds now and how long they have waited, ' +
					'and how many cards were committed from options, returned to options, discarded, sent on to another board and abandoned in the window, with the discard rate; ' +
					'beside them `committedAll`, "Committed (all)", the cards that arrived as committed work in the window. They are the figures the board\'s Stats panel shows, worked out by the same code. ' +
					'An option is a card in the board\'s Options column, or any card of an ideas board. Acts are read from the activity log, which is never pruned, and counted when they happened: ' +
					'each card counts once, under its last act in the window among committed, returned, discarded and sent on, so a card committed, returned and committed again is one commitment, ' +
					'and a discard later restored still happened. Abandoned work is counted on its own, and is not in the discard rate. A deleted card\'s entries have no card id, and each counts once. ' +
					'View access to the board is enough. Nothing is written.',
				operationId: 'getBoardUpstream',
				parameters: [
					{ $ref: '#/components/parameters/boardId' },
					{
						name: 'days',
						in: 'query',
						schema: { type: 'integer', minimum: 1, maximum: 365, default: 30 },
						description: 'How many days the window runs back from now: a whole number from 1 to 365. Not sent, or empty, 30. Anything else is 400 days must be a whole number from 1 to 365.'
					}
				],
				responses: {
					'200': {
						description: 'The board\'s upstream figures',
						content: {
							'application/json': {
								schema: {
									type: 'object',
									properties: {
										boardId: { type: 'integer' },
										kind: { type: 'string', enum: ['delivery', 'ideas'], description: 'The board\'s kind: on an ideas board every card is an option' },
										days: { type: 'integer', description: 'The window\'s length in days, as asked or 30' },
										period: {
											type: 'object',
											description: 'The window: from `days` days ago to now, both ends included',
											properties: {
												from: { type: 'string', format: 'date-time' },
												to: { type: 'string', format: 'date-time' }
											},
											required: ['from', 'to']
										},
										options: { type: 'integer', description: 'Options now: cards not archived in an upstream column of the board, whatever the window' },
										committedFromOptions: { type: 'integer', description: 'Cards whose last act in the window was a commitment out of upstream (card_committed)' },
										returnedToOptions: { type: 'integer', description: 'Cards whose last act in the window was a return into upstream (card_returned_to_options), a figure of its own, not taken off the commitments' },
										discarded: { type: 'integer', description: 'Cards whose last act in the window was a discard, archived or deleted from upstream (card_discarded)' },
										sentOn: { type: 'integer', description: 'Cards whose last act in the window was a Send, or any move of an option, to another board (card_sent)' },
										abandoned: { type: 'integer', description: 'Cards of committed work archived before Complete in the window (card_abandoned), each once, whatever else it did' },
										discardRate: {
											type: ['number', 'null'],
											description: 'discarded / (discarded + committedFromOptions + sentOn), from 0 to 1; null when all three are 0'
										},
										oldestOptionDays: {
											type: ['integer', 'null'],
											description:
												'Whole days the oldest option now has waited, from when it became an option: the latest of its creation, its latest return to options and the latest conversion of its column, or its board, that made it one. null with no options.'
										},
										agingOptions: { type: 'integer', description: 'Options now that have waited more than 30 days' },
										committedAll: {
											type: 'integer',
											description:
												'"Committed (all)": the cards that arrived as committed work on the board in the window, each counted once: a card committed out of upstream (a card_committed entry on this board), ' +
												'and a card created in the window straight into a committed column. A card created committed is credited to the board it is on now, wherever it was made; ' +
												'a card created and then returned to options is no arrival, until it is committed again. A deleted card\'s entry counts once.'
										}
									},
									required: [
										'boardId', 'kind', 'days', 'period', 'options', 'committedFromOptions', 'returnedToOptions', 'discarded', 'sentOn', 'abandoned',
										'discardRate', 'oldestOptionDays', 'agingOptions', 'committedAll'
									]
								},
								example: {
									boardId: 12,
									kind: 'delivery',
									days: 30,
									period: { from: '2026-09-26T09:00:00.000Z', to: '2026-10-26T09:00:00.000Z' },
									options: 6,
									committedFromOptions: 3,
									returnedToOptions: 1,
									discarded: 1,
									sentOn: 0,
									abandoned: 0,
									discardRate: 0.25,
									oldestOptionDays: 41,
									agingOptions: 2,
									committedAll: 9
								}
							}
						}
					},
					'400': {
						description: 'boardId is not a whole number of 1 or more, or days is not a whole number from 1 to 365',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'days must be a whole number from 1 to 365' } } }
					},
					'401': { $ref: '#/components/responses/Unauthorized' },
					'403': {
						description: 'No access to this board',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'No access to this board' } } }
					},
					'404': {
						description: 'There is no such board, whoever asks: it is looked for before access is checked',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'Board not found' } } }
					},
					'429': { $ref: '#/components/responses/RateLimited' },
					'500': { $ref: '#/components/responses/InternalError' }
				}
			}
		},

		// ─── Columns ────────────────────────────────────────────────────────
		'/api/v1/boards/{boardId}/columns': {
			get: {
				tags: ['Columns'],
				summary: 'List columns on a board',
				description: 'Returns the board\'s columns in order of position, ties by column id (the older first).',
				operationId: 'listColumns',
				parameters: [{ $ref: '#/components/parameters/boardId' }],
				responses: {
					'200': {
						description: 'List of columns',
						content: {
							'application/json': {
								schema: { type: 'array', items: { $ref: '#/components/schemas/Column' } }
							}
						}
					},
					'400': {
						description: 'boardId is not a whole number of 1 or more',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'Invalid board ID' } } }
					},
					'401': { $ref: '#/components/responses/Unauthorized' },
					'403': {
						description: 'No access to this board',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'No access to this board' } } }
					},
					'404': {
						description: 'There is no such board, whoever asks: it is looked for before access is checked. Until 2026-10-14 everyone but an administrator was answered 403, and an administrator an empty list.',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'Board not found' } } }
					},
					'429': { $ref: '#/components/responses/RateLimited' },
					'500': { $ref: '#/components/responses/InternalError' }
				}
			},
			post: {
				tags: ['Columns'],
				summary: 'Create a column',
				operationId: 'createColumn',
				parameters: [{ $ref: '#/components/parameters/boardId' }],
				requestBody: {
					required: true,
					content: {
						'application/json': {
							schema: {
								type: 'object',
								required: ['title'],
								properties: {
									title: { type: 'string', maxLength: 200 },
									color: { type: 'string', pattern: '^#[0-9a-fA-F]{6}$', description: 'A colour written #rrggbb, trimmed (default: #6366f1). Anything else is 400 color must be a colour written #rrggbb.' },
									position: { type: 'number', description: 'Order on the board, lowest first. Default: after the last column. On a board with an Options column, a position at or left of it is 409.' },
									role: {
										type: ['string', 'null'],
										enum: ['options', null],
										description:
											'null or left out, an ordinary column. "options" is 409 on every board (since 2026-10-26): a delivery board is made with its Options column, and has one only, ' +
											'and every column of an ideas board is upstream already. Anything else is 400 role must be "options" or null, not <what was sent>.'
									},
									wipLimit: {
										type: ['integer', 'null'],
										description:
											'Work-in-progress limit, read as PUT /columns/{columnId} reads it: a whole number, 0 meaning no limit, and 0 when it is left out. null, a negative number or a value that is not a number is stored as 0; a fraction loses its fractional part. ' +
											'Until 2026-10-27 (version 1.3.1) it was not stored, and a new column had no limit.'
									}
								}
							},
							example: { title: 'Review', color: '#f59e0b', position: 3 }
						}
					}
				},
				responses: {
					'201': {
						description: 'Column created',
						content: {
							'application/json': { schema: { $ref: '#/components/schemas/Column' } }
						}
					},
					'400': { $ref: '#/components/responses/BadRequest' },
					'401': { $ref: '#/components/responses/Unauthorized' },
					'403': {
						description: 'No edit access to this board',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'No edit access to this board' } } }
					},
					'404': {
						description: 'There is no such board. Every caller is told so; until 2026-10-14 everyone but an administrator was answered 403, and an administrator 500.',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'Board not found' } } }
					},
					'409': {
						description:
							'The column cannot be made as sent, and nothing was written: role "options" on a delivery board, which has its Options column from when it was made ' +
							'(`This board already has its Options column.`; on a board that has none yet (made before this release, or restored from a backup), until the next start, `A delivery board\'s Options column is made with the board; it comes back at the next start.`), ' +
							'or on an ideas board, every column of which is upstream; a column of a delivery board called Options, in any case (`Only the board\'s Options column is called Options. Choose another name.`); ' +
							'or a position at or left of the board\'s Options column, which stays the leftmost. ' +
							'And on an ideas board, a column whose title makes it To Do, On Hold or Complete: `An ideas board has no Complete column: "Done" would make one. Choose another name.`',
						content: {
							'application/json': {
								schema: { $ref: '#/components/schemas/Error' },
								examples: {
									secondOptions: { summary: 'role "options" on a delivery board', value: { message: 'This board already has its Options column.' } },
									titledOptions: { summary: 'Another column called Options', value: { message: "Only the board's Options column is called Options. Choose another name." } }
								}
							}
						}
					},
					'413': { $ref: '#/components/responses/PayloadTooLarge' },
					'429': { $ref: '#/components/responses/RateLimited' },
					'500': { $ref: '#/components/responses/InternalError' }
				}
			}
		},

		'/api/v1/columns/{columnId}': {
			get: {
				tags: ['Columns'],
				summary: 'Get a column',
				operationId: 'getColumn',
				parameters: [{ $ref: '#/components/parameters/columnId' }],
				responses: {
					'200': {
						description: 'Column details',
						content: {
							'application/json': { schema: { $ref: '#/components/schemas/Column' } }
						}
					},
					'400': {
						description: 'columnId is not a whole number of 1 or more',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'Invalid column ID' } } }
					},
					'401': { $ref: '#/components/responses/Unauthorized' },
					'403': {
						description: 'No access to the board the column is on',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'No access to this board' } } }
					},
					'404': {
						description: 'There is no such column',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'Column not found' } } }
					},
					'429': { $ref: '#/components/responses/RateLimited' },
					'500': { $ref: '#/components/responses/InternalError' }
				}
			},
			put: {
				tags: ['Columns'],
				summary: 'Update a column',
				description:
					'Changes the fields sent. Only the fields whose value changes are written, and the board\'s open pages told: a body whose every field is as the column holds it ' +
					'(a title that trims to the stored one included) answers 200 with the column as it is, writing nothing. A request that would be refused is still refused first (item 98).',
				operationId: 'updateColumn',
				parameters: [{ $ref: '#/components/parameters/columnId' }],
				requestBody: {
					required: true,
					content: {
						'application/json': {
							schema: {
								type: 'object',
								properties: {
									title: { type: 'string', maxLength: 200 },
									color: { type: 'string', pattern: '^#[0-9a-fA-F]{6}$', description: 'A colour written #rrggbb, trimmed. Anything else is 400 color must be a colour written #rrggbb; a colour the row already holds, sent back unchanged, is accepted as it is.' },
									position: { type: 'number' },
									wipLimit: {
										type: ['integer', 'null'],
										description:
											'Work-in-progress limit: a whole number, 0 meaning no limit. null is accepted and stored as 0, which is how a limit is cleared; so is a negative number, or a value that is not a number. A fraction loses its fractional part. The column returned always has an integer here.'
									},
									showAddCard: { type: 'boolean' },
									role: {
										type: ['string', 'null'],
										enum: ['options', null],
										description:
											'Left out, or sent as the column holds it, the role is kept. Since 2026-10-26 it is not changed: "options" on any other column is 409 (a delivery board has its Options column from when it was made, and only the one), ' +
											'and null on a delivery board\'s Options column is 409 `Every delivery board keeps its Options column.` Anything else is 400 role must be "options" or null, not <what was sent>.'
									}
								}
							},
							example: { title: 'In Review', wipLimit: 3 }
						}
					}
				},
				responses: {
					'200': {
						description: 'Updated column',
						content: {
							'application/json': { schema: { $ref: '#/components/schemas/Column' } }
						}
					},
					'400': {
						description: 'None of the six fields was sent, a field of the wrong type (a title that is not text, a position that is not a number, showAddCard that is not true or false), the title is empty or over 200 characters, a colour that is not written #rrggbb (`color must be a colour written #rrggbb`), a role that is neither "options" nor null (`role must be "options" or null, not "backlog"`), columnId is not a whole number of 1 or more, or the body is missing, is not valid JSON or is not an object. Nothing was written.',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'No valid fields to update' } } }
					},
					'401': { $ref: '#/components/responses/Unauthorized' },
					'403': { $ref: '#/components/responses/Forbidden' },
					'404': {
						description: 'There is no such column',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'Column not found' } } }
					},
					'409': {
						description:
							'The title would make the column a Complete column, one called Complete or Done, or stop it being one, while the column holds any card, archived ones included. ' +
							'A card is finished because of the column it is in, so the rename would mark its cards finished without anyone finishing them, or turn finished work back into open work. ' +
							'The message says how many cards the column holds and, when any are, how many of them are archived. Nothing was written. An empty column is renamed freely, and so is one whose new title keeps its role, such as Complete to Done. ' +
							'Also 409, with nothing written, for the Options column\'s rules (since 2026-10-26), asked before the rule above: a delivery board\'s Options column renamed to anything but Options (`The Options column is always called Options.`) or given role null (`Every delivery board keeps its Options column.`). ' +
							'And after it: another column given role "options" (`This board already has its Options column.`; on a board that has none yet (made before this release, or restored from a backup), until the next start, `A delivery board\'s Options column is made with the board; it comes back at the next start.`; or on an ideas board, every column of which is upstream), another column of a delivery board renamed Options, in any case ' +
							'(`Only the board\'s Options column is called Options. Choose another name.`; one already so called keeps its title), a WIP limit above 0 on the Options column, and a position that would put a column at or left of the Options column, which stays the leftmost. ' +
							'And a column of an ideas board renamed so that its title makes it To Do, On Hold or Complete: `An ideas board has no To Do column: "To Do" would make one. Choose another name.`',
						content: {
							'application/json': {
								schema: { $ref: '#/components/schemas/Error' },
								examples: {
									completeRenamed: {
										summary: 'A Complete column holding cards renamed',
										value: {
											message:
												'This column holds 3 cards, 1 of them archived. They count as finished because the column is called Complete or Done, and renaming it to "Shipped" would turn them back into open work. Keep it called Complete or Done.'
										}
									},
									optionsRenamed: { summary: 'The Options column renamed to anything but Options', value: { message: 'The Options column is always called Options.' } },
									optionsGivenAway: { summary: 'The Options column given role null', value: { message: 'Every delivery board keeps its Options column.' } },
									titledOptions: { summary: 'Another column renamed Options', value: { message: "Only the board's Options column is called Options. Choose another name." } }
								}
							}
						}
					},
					'413': { $ref: '#/components/responses/PayloadTooLarge' },
					'429': { $ref: '#/components/responses/RateLimited' },
					'500': { $ref: '#/components/responses/InternalError' }
				}
			},
			delete: {
				tags: ['Columns'],
				summary: 'Delete a column',
				description:
					'Permanently deletes the column and every card in it, archived or not. The cards are deleted for good, not archived: ' +
					'each goes with its subtasks, comments and attachments, with every sub-board under it, and with every dependency link ' +
					'that has a deleted card or subtask at either end. Move the cards to another column first if they are to be kept. ' +
					'Attachment files are kept on the server for 30 days.\n\n' +
					'One `column_deleted` entry is written to the board\'s activity log and appears in the audit log, naming the column and how many cards went with it. ' +
					'No `card.deleted` webhook is sent for the cards. A card of the column that was in a milestone logs `api:milestone_card_removed` on the column\'s board, ' +
					'and that board\'s webhooks are sent `milestone.card_removed`, `… (card deleted)` (item 103). ' +
					'A card in a milestone on a sub-board deleted with the column\'s cards sends nothing: its board is gone, and its webhooks with it. ' +
					'A card on another board released from a milestone of such a sub-board logs `api:milestone_card_removed` on its own board, and that board\'s webhooks are sent `milestone.card_removed`, ' +
					'`… (milestone deleted with its board)`. ' +
					'The delete is one transaction: all of it happens or none of it.',
				operationId: 'deleteColumn',
				parameters: [{ $ref: '#/components/parameters/columnId' }],
				responses: {
					'200': {
						description: 'The column and its cards are deleted',
						content: {
							'application/json': {
								schema: { type: 'object', properties: { success: { type: 'boolean' } }, required: ['success'] },
								example: { success: true }
							}
						}
					},
					'400': {
						description: 'columnId is not a whole number of 1 or more. Nothing was deleted.',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'Invalid column ID' } } }
					},
					'401': { $ref: '#/components/responses/Unauthorized' },
					'403': { $ref: '#/components/responses/Forbidden' },
					'404': {
						description: 'There is no such column',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'Column not found' } } }
					},
					'409': {
						description:
							'The column is a delivery board\'s Options column, which every delivery board keeps, empty or not (since 2026-10-26): it is folded away on the board, not deleted. ' +
							'Or a column of an ideas board holding ideas: `This column of an ideas board still holds 2 ideas: move them out, or archive them to discard them, first.` Nothing was deleted.',
						content: {
							'application/json': {
								schema: { $ref: '#/components/schemas/Error' },
								examples: {
									optionsColumn: {
										summary: 'The Options column',
										value: { message: 'Every delivery board keeps its Options column. Fold it away with the arrow on its strip instead.' }
									},
									ideas: {
										summary: 'A column of an ideas board holding ideas',
										value: { message: 'This column of an ideas board still holds 2 ideas: move them out, or archive them to discard them, first.' }
									}
								}
							}
						}
					},
					'429': { $ref: '#/components/responses/RateLimited' },
					'500': { $ref: '#/components/responses/InternalError' }
				}
			}
		},

		// ─── Cards ──────────────────────────────────────────────────────────
		'/api/v1/boards/{boardId}/cards': {
			get: {
				tags: ['Cards'],
				summary: 'List cards on a board',
				description:
					'Returns the board\'s cards, column by column in order of column position, ties by column id, and within a column in order of card position, ties by card id. ' +
					'Each card comes with the title of its column and a count of its subtasks. ' +
					'Archived cards are left out unless `archived=true`, and take their place by position among the rest. `columnId` narrows the list to that column of this board: ' +
					'a column of another board gives an empty list. Until 2026-10-14 the columns came in the order they were made in, so a column moved or added between two others was listed in the wrong place (item 93). ' +
					'`stage` lists the options alone or the committed cards alone (since 2026-10-26, milestone 22): an option is a card in the board\'s Options column, or any card of an ideas board. ' +
					'Each card also carries committedAt and committedBy, null for an option, and discardedAt and discardedBy, set on an option archived from upstream.',
				operationId: 'listCards',
				parameters: [
					{ $ref: '#/components/parameters/boardId' },
					{
						name: 'columnId',
						in: 'query',
						schema: { type: 'integer', minimum: 1 },
						description: 'Filter cards to a specific column. An id: anything else is 400 Invalid column ID.'
					},
					{
						name: 'archived',
						in: 'query',
						schema: { type: 'boolean', default: false },
						description: 'Include archived cards'
					},
					{
						name: 'stage',
						in: 'query',
						schema: { type: 'string', enum: ['option', 'committed'] },
						description:
							'"option": only the cards upstream of the commitment point, in the board\'s Options column or on an ideas board; "committed": only the others, so an ideas board gives an empty list. ' +
							'Decided by the column each card is in, archived cards included with archived=true, so a discarded card is an option. Not sent, or empty, every card. ' +
							'Anything else is 400 stage must be "option" or "committed", not <what was sent>.'
					}
				],
				responses: {
					'200': {
						description: 'List of cards',
						content: {
							'application/json': {
								schema: { type: 'array', items: { $ref: '#/components/schemas/CardListItem' } }
							}
						}
					},
					'400': {
						description: 'boardId is not a whole number of 1 or more, columnId is not one (`Invalid column ID`), or stage is neither "option" nor "committed" (`stage must be "option" or "committed", not "backlog"`)',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'Invalid board ID' } } }
					},
					'401': { $ref: '#/components/responses/Unauthorized' },
					'403': {
						description: 'No access to this board',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'No access to this board' } } }
					},
					'404': {
						description: 'There is no such board, whoever asks: it is looked for before access is checked. Until 2026-10-14 everyone but an administrator was answered 403, and an administrator an empty list.',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'Board not found' } } }
					},
					'429': { $ref: '#/components/responses/RateLimited' },
					'500': { $ref: '#/components/responses/InternalError' }
				}
			},
			post: {
				tags: ['Cards'],
				summary: 'Create a card',
				description:
					'Creates a card in a column of this board. A card created in a Complete column, one called Complete or Done, is completed as it is created, as a card moved into one is: ' +
					'its completedAt and firstCompletedAt are the moment it was created, the key\'s user is given the XP for its priority, an api:card_created and then an api:card_completed activity entry are written, ' +
					'and the board\'s webhooks are sent card.created and card.completed. The check for open subtasks and sub-boards is not made: a new card has neither. ' +
					'The answer is the card as it was written, with its completedAt. Until 2026-10-14 such a card was left in the column with no completion date, no XP and no api:card_completed entry. ' +
					'A card created outside an upstream column is committed as it is created (since 2026-10-26): its committedAt is its createdAt and its committedBy the key\'s user, with no entry beyond api:card_created. ' +
					'One created in the board\'s Options column, or on an ideas board, is an option, with committedAt and committedBy null.',
				operationId: 'createCard',
				parameters: [{ $ref: '#/components/parameters/boardId' }],
				requestBody: {
					required: true,
					content: {
						'application/json': {
							schema: {
								type: 'object',
								required: ['columnId', 'title'],
								properties: {
									columnId: { type: 'integer', minimum: 1, description: 'Target column ID: a column of this board' },
									title: { type: 'string', minLength: 1, maxLength: 500, description: 'Trimmed' },
									description: { type: 'string', maxLength: 50000 },
									priority: {
										type: 'string',
										enum: ['low', 'medium', 'high', 'critical'],
										default: 'medium',
										description: 'Read in any case, and stored in lower case'
									},
									colorTag: { type: 'string', pattern: '^(#[0-9a-fA-F]{6})?$', description: 'A colour for visual tagging, written #rrggbb and trimmed, or empty for none' },
									categoryId: {
										type: ['integer', 'null'],
										minimum: 1,
										description: 'A category of this board, or one that belongs to no board. Any other is 404 Category not found on this board.'
									},
									dueDate: { type: ['string', 'null'], format: 'date', description: 'A day of the calendar written YYYY-MM-DD. null, or empty text, for none.' },
									businessValue: { type: 'string', maxLength: 10000 },
									position: { type: 'number', default: 0, description: 'A number, or a number written as text' },
									summary: { type: ['string', 'null'], maxLength: 200, description: 'Reporting field: the card in plain English' },
									theme: {
										type: ['string', 'null'],
										description: 'Reporting field. One of: new capability, customer issue, security & compliance, maintenance. Case is ignored.'
									},
									customerImpact: {
										type: ['string', 'null'],
										description: 'Reporting field. One of: none, internal, live customers; detail may follow a colon ("live customers: Quickline").'
									},
									closeReason: {
										type: ['string', 'null'],
										description: 'Reporting field. One of: delivered, not needed, superseded, parked.'
									},
									releaseState: { type: ['string', 'null'], description: 'Reporting field. One of: built, on UAT, live.' }
								}
							},
							example: {
								columnId: 1,
								title: 'Deploy v2.1',
								description: 'Run migrations, update configs',
								priority: 'high',
								dueDate: '2026-04-20'
							}
						}
					}
				},
				responses: {
					'201': {
						description: 'Card created',
						content: {
							'application/json': { schema: { $ref: '#/components/schemas/Card' } }
						}
					},
					'400': {
						description:
							'No columnId or title, a field of the wrong type (`title must be text`, `position must be a number`, `columnId must be an id`), a title that is empty or over 500 characters, ' +
							'a description over 50000, a businessValue over 10000, a priority that is not one of the four, a colorTag not written #rrggbb, a dueDate that is not a day written YYYY-MM-DD, ' +
							'a reporting field outside its list, a column that is not on this board, boardId is not a whole number of 1 or more, or a body that is missing, is not valid JSON or is not an object. ' +
							'The fields are read once the board is found and the caller may edit it. Nothing was created.',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'Column does not belong to this board' } } }
					},
					'401': { $ref: '#/components/responses/Unauthorized' },
					'403': {
						description: 'No edit access to this board. Nothing was created.',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'No edit access to this board' } } }
					},
					'404': {
						description:
							'There is no such board, whoever asks: until 2026-10-14 everyone but an administrator was answered 403. Or categoryId names a category that is neither this board\'s ' +
							'nor one of no board: `Category not found on this board`, where another board\'s was stored and one that did not exist was a 500. Nothing was created.',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'Board not found' } } }
					},
					'413': { $ref: '#/components/responses/PayloadTooLarge' },
					'429': { $ref: '#/components/responses/RateLimited' },
					'500': { $ref: '#/components/responses/InternalError' }
				}
			}
		},

		'/api/v1/cards/{cardId}': {
			get: {
				tags: ['Cards'],
				summary: 'Get a single card',
				description:
					'Returns the card with the board and column it is on, its subtasks (ordered by position, then id), label IDs and assignees, and what it waits on and what waits on it, ' +
					'so that whether it can be started is known without a second request. An archived card is returned like any other.',
				operationId: 'getCard',
				parameters: [{ $ref: '#/components/parameters/cardId' }],
				responses: {
					'200': {
						description: 'Card details',
						content: {
							'application/json': {
								schema: { $ref: '#/components/schemas/CardDetail' }
							}
						}
					},
					'400': {
						description: 'cardId is not a whole number of 1 or more',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'Invalid card ID' } } }
					},
					'401': { $ref: '#/components/responses/Unauthorized' },
					'403': {
						description: 'No access to the board the card is on',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'No access to this card\'s board' } } }
					},
					'404': { $ref: '#/components/responses/NotFound' },
					'429': { $ref: '#/components/responses/RateLimited' },
					'500': { $ref: '#/components/responses/InternalError' }
				}
			},
			put: {
				tags: ['Cards'],
				summary: 'Update a card',
				description:
					'Updates the fields sent. The body is validated before anything is written, and the update is one transaction: ' +
					'a request that is refused leaves every field as it was, the milestone included. The card is looked for and access checked first, then every field is read. ' +
					'A value the card already holds, sent back unchanged, is accepted as it is, even one these rules would refuse. ' +
					'A field sent with the value the card already holds is not a change: a request that changes nothing writes nothing, records no activity entry, sends no `card.updated` and answers 200 with the card as it is.\n\n' +
					'This operation does not move a card. `columnId` is accepted only as the column the card is in, so a card read with GET can be sent back whole; any other is 400 and nothing is saved. ' +
					'`position` is ignored here, whatever is sent. Move or reorder a card with PUT /cards/{cardId}/move. Until 2026-10-14 another columnId was ignored and the other fields saved (item 91).',
				operationId: 'updateCard',
				parameters: [{ $ref: '#/components/parameters/cardId' }],
				requestBody: {
					required: true,
					content: {
						'application/json': {
							schema: {
								type: 'object',
								properties: {
									title: { type: 'string', minLength: 1, maxLength: 500, description: 'Trimmed' },
									description: { type: 'string', maxLength: 50000 },
									priority: { type: 'string', enum: ['low', 'medium', 'high', 'critical'], description: 'Read in any case, and stored in lower case' },
									colorTag: { type: 'string', pattern: '^(#[0-9a-fA-F]{6})?$', description: 'A colour written #rrggbb and trimmed, or empty for none' },
									categoryId: {
										type: ['integer', 'null'],
										minimum: 1,
										description: 'A category of the card\'s board, or one that belongs to no board; null for none. Any other is 404 Category not found on this board, unless it is the one the card already has.'
									},
									dueDate: { type: ['string', 'null'], format: 'date', description: 'A day of the calendar written YYYY-MM-DD. null, or empty text, clears it.' },
									onHoldNote: { type: 'string', maxLength: 50000 },
									businessValue: { type: 'string', maxLength: 10000 },
									pinned: { type: 'boolean' },
									coverUrl: {
										type: ['string', 'null'],
										description:
											'The card\'s cover, drawn as a strip across the top of the card on the board: a colour written #rrggbb, or one of these eight gradients exactly as written here: ' +
											'linear-gradient(135deg, #667eea 0%, #764ba2 100%); linear-gradient(135deg, #f093fb 0%, #f5576c 100%); linear-gradient(135deg, #4facfe 0%, #00f2fe 100%); ' +
											'linear-gradient(135deg, #43e97b 0%, #38f9d7 100%); linear-gradient(135deg, #fa709a 0%, #fee140 100%); linear-gradient(135deg, #a18cd1 0%, #fbc2eb 100%); ' +
											'linear-gradient(135deg, #fccb90 0%, #d57eeb 100%); linear-gradient(135deg, #e0c3fc 0%, #8ec5fc 100%). ' +
											'null, or empty text, clears it. Anything else is 400 (`coverUrl must be a colour written #rrggbb, one of the preset gradients, or null`), ' +
											'unless it is the cover the card already holds. Until 2026-10-14 any value was stored, an address or a style included.'
									},
									archivedAt: {
										type: ['string', 'null'],
										description:
											'null restores an archived card: { "archivedAt": null }. It is the only value taken: another is 400, unless it is the stamp the card already holds. ' +
											'Archive a card with DELETE /cards/{cardId}. Until 2026-10-14 any value was stored. ' +
											'A restore is recorded as an api:card_restored activity entry, with the card\'s title, as a restore in the web application is. The api:card_updated entry, and so the card.updated webhook, ' +
											'is written only for the other fields sent, so a restore alone delivers no card.updated: until 2026-10-14 it was recorded as api:card_updated naming archivedAt. ' +
											'An archivedAt that changes nothing, null on a card that is not archived or the stamp the card holds, is not a change and is not named.'
									},
									milestoneId: {
										type: ['integer', 'null'],
										description:
											'The milestone to put the card in, or null to take it out of its milestone. Putting it in needs edit access to that milestone, and a milestone that belongs to one board takes only that board\'s cards; ' +
											'an archived card is refused. Taking it out, or putting it in another milestone, which takes it out of this one, needs edit access to the milestone it is in. The milestone it is already in, sent back, changes nothing. ' +
											'With archivedAt null in the same body, the card is restored first. ' +
											'A change logs `api:milestone_card_added` or `api:milestone_card_removed`, as the milestone operations do, and is not named in `api:card_updated`: ' +
											'so `card.updated` is not sent when milestoneId is the only change (until 2026-10-14 it logged "Updated fields: milestoneId" and sent `card.updated`); ' +
											'the board\'s webhooks are sent `milestone.card_added` or `milestone.card_removed` instead (item 102).'
									},
									summary: { type: ['string', 'null'], maxLength: 200, description: 'Reporting field: the card in plain English. null clears it.' },
									theme: {
										type: ['string', 'null'],
										description: 'Reporting field. One of: new capability, customer issue, security & compliance, maintenance. null clears it.'
									},
									customerImpact: {
										type: ['string', 'null'],
										description: 'Reporting field. One of: none, internal, live customers; detail may follow a colon ("live customers: Quickline"). null clears it.'
									},
									closeReason: {
										type: ['string', 'null'],
										description: 'Reporting field. One of: delivered, not needed, superseded, parked. null clears it.'
									},
									releaseState: { type: ['string', 'null'], description: 'Reporting field. One of: built, on UAT, live. null clears it.' },
									columnId: {
										type: 'integer',
										minimum: 1,
										description:
											'Accepted only as the column the card is in, so a card read with GET can be sent back whole. Any other value is 400 ' +
											'(`columnId 12 is not this card\'s column (14): the card has moved since it was read, or a move was meant. Move a card with PUT /cards/{cardId}/move`), ' +
											'and null or a value that is not an id is `columnId must be an id`; nothing is saved. Move a card with PUT /cards/{cardId}/move. It does not count as a field to update.'
									},
									position: {
										type: 'number',
										description: 'Ignored here, whatever is sent: reorder with PUT /cards/{cardId}/move. It does not count as a field to update.'
									}
								}
							},
							example: { priority: 'critical', dueDate: '2026-04-12' }
						}
					}
				},
				responses: {
					'200': {
						description: 'Updated card',
						content: {
							'application/json': { schema: { $ref: '#/components/schemas/Card' } }
						}
					},
					'400': {
						description:
							'No valid fields, a field of the wrong type (`pinned must be true or false`, `milestoneId must be an id`), a title that is empty or over 500 characters, a description or an onHoldNote over 50000 characters, ' +
							'a businessValue over 10000, a coverUrl that is not a colour written #rrggbb, one of the preset gradients or null (`coverUrl must be a colour written #rrggbb, one of the preset gradients, or null`), a priority that is not one of the four, a colorTag not written #rrggbb, a dueDate that is not a day written YYYY-MM-DD, ' +
							'an archivedAt other than null (`archivedAt may only be null, which restores the card. Archive a card with DELETE /cards/{cardId}`), ' +
							'a columnId other than the card\'s own (`columnId 12 is not this card\'s column (14): the card has moved since it was read, or a move was meant. Move a card with PUT /cards/{cardId}/move`), ' +
							'or one that is null or not an id (`columnId must be an id`), ' +
							'an invalid reporting field, a milestone that belongs to another board, an archived card put into a milestone (`Card does not exist or is archived`), ' +
							'cardId is not a whole number of 1 or more, or a body that is missing, is not valid JSON or is not an object. Nothing was written.',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'No valid fields to update' } } }
					},
					'401': { $ref: '#/components/responses/Unauthorized' },
					'403': {
						description: 'No edit access to this card\'s board, to the milestone it is to join, or to the milestone it is in, which it leaves with milestoneId null or another milestone. Nothing was written.',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'No edit access to this card\'s board' } } }
					},
					'404': {
						description: 'There is no such card, no milestone with the id given as milestoneId, or categoryId names a category neither of the card\'s board nor of no board (`Category not found on this board`). Nothing was written.',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'Milestone not found' } } }
					},
					'413': { $ref: '#/components/responses/PayloadTooLarge' },
					'429': { $ref: '#/components/responses/RateLimited' },
					'500': { $ref: '#/components/responses/InternalError' }
				}
			},
			delete: {
				tags: ['Cards'],
				summary: 'Delete a card',
				description:
					'Archives the card by default (soft-delete). Add `?permanent=true` to permanently delete. Both answer 200.\n\n' +
					'**Archive** sets `archivedAt` and writes a `card_archived` activity entry. Nothing else is touched: the card keeps its subtasks, ' +
					'comments, attachments, dependency links and sub-boards, and has them all when it is restored. No webhook is sent, except `card.discarded` for an option. ' +
					'Two archives are recorded as what they are, with one entry each in place of `card_archived` (milestone 22): a card in an upstream column ' +
					'(a board\'s Options column, or any column of an ideas board) is **discarded**, `discardedAt` and `discardedBy` are set with `archivedAt`, ' +
					'and `card_discarded` is written, which sends `card.discarded`; a card in a committed column that is not Complete is **abandoned**, ' +
					'`card_abandoned`, with no webhook and no field on the card. A restore clears `discardedAt` and `discardedBy`. ' +
					'A card already archived is answered 200 as it is: nothing is written, `archivedAt` keeps its first value, and no entry is logged. ' +
					'Until 2026-10-14 it was stamped again and a second entry logged (item 86).\n\n' +
					'**Permanent delete** removes the card with its subtasks, comments, assignees and attachments, every sub-board under it at every depth ' +
					'with everything on it, and every dependency link that has a deleted card or subtask at either end. Attachment files are kept on the server for 30 days. ' +
					'One `card_deleted` activity entry is written, with a null card id because the card is gone, and one `card.deleted` webhook is sent ' +
					'whose `data.cardId` is the id of the deleted card. A card in a milestone also logs `api:milestone_card_removed` and sends `milestone.card_removed` (item 103). ' +
					'A live card deleted from an upstream column (an archived card never) first writes `card_discarded` (null card id) and sends `card.discarded`, then `card_deleted` and `card.deleted`.',
				operationId: 'deleteCard',
				parameters: [
					{ $ref: '#/components/parameters/cardId' },
					{
						name: 'permanent',
						in: 'query',
						schema: { type: 'boolean', default: false },
						description: 'Permanently delete instead of archiving'
					}
				],
				responses: {
					'200': {
						description: 'Archived, or with `?permanent=true` deleted for good',
						content: {
							'application/json': {
								schema: {
									type: 'object',
									properties: { success: { type: 'boolean' } },
									required: ['success']
								},
								example: { success: true }
							}
						}
					},
					'400': {
						description: 'cardId is not a whole number of 1 or more. Nothing was archived or deleted.',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'Invalid card ID' } } }
					},
					'401': { $ref: '#/components/responses/Unauthorized' },
					'403': {
						description: 'No edit access to this card\'s board. Nothing was archived or deleted.',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'No edit access to this card\'s board' } } }
					},
					'404': { $ref: '#/components/responses/NotFound' },
					'429': { $ref: '#/components/responses/RateLimited' },
					'500': { $ref: '#/components/responses/InternalError' }
				}
			}
		},

		'/api/v1/cards/{cardId}/move': {
			put: {
				tags: ['Cards'],
				summary: 'Move a card',
				description:
					'Moves a card between columns, including across different boards. The target column can belong to any board the user has edit access to. For cross-board moves, board-scoped data (categoryId, labels) is automatically cleaned up. Moving to "Complete" or "Done" awards XP and fires a celebration event. The move will be rejected with 409 if the card has incomplete subtasks or sub-boards, or if the target column is on a board beneath the card, one of its own sub-boards at any depth: a card\'s sub-boards go with it, so they would hang beneath themselves. ' +
					'A move that completes the card mails its assignees who can open the board it is now on "Card moved: <title> → <column>", each as their own card-moved setting says, as a move made in the web application does; a move through the API that does not complete the card mails nobody. ' +
					'Whoever made the move is never mailed about it. Until 2026-10-14 no move through the API mailed an assignee. ' +
					'Moving a card out of an On Hold column (any column titled On Hold, Hold, Blocked, Parked or Waiting) to one that is not clears its onHoldNote. ' +
					'An archived card on a sub-board is not counted: a sub-board holds the card back while it has a card that is not archived and not in a Complete column. Until 2026-10-14 an archived card held it back. ' +
					'The 409 for sub-boards names an unfinished one the key\'s user can open; when the only unfinished ones are sub-boards they cannot open it reads "A sub-board you cannot open still has incomplete cards that must be completed first. Ask this board\'s owner.", with no name and no count. ' +
					'A move to another board takes the card out of its milestone when the milestone belongs to a board other than the one the card arrives on, and the answer has milestoneId null and names the milestone it left as leftMilestone, which is null for any other move; a milestone across boards keeps the card. Until 2026-10-14 the card kept the milestone. ' +
					'Leaving it logs `api:milestone_card_removed` on the board it left, and that board\'s webhooks are sent `milestone.card_removed` (item 103). ' +
					'An option, a card in an upstream column, moved to another board is sent on: the board it leaves logs `api:card_sent` in place of `api:card_moved_away`, at the same moment as the arrival, as POST /cards/{cardId}/send does.\n\n' +
					'**The commitment point** (since 2026-10-26, milestone 22). A card in an upstream column, a board\'s Options column or any column of an ideas board, is an option. ' +
					'A move out of an upstream column into a committed one commits it: committedAt is the moment and committedBy the key\'s user, and `api:card_committed` is written in place of `api:card_moved`, ' +
					'`"<title>": <from> → <to> (column <to id>, from column <from id>)`, which sends `card.committed`, within one board instead of `card.moved`; across boards each board is still sent its own `card.moved` (`card_sent` to the board it left, `card_moved_in` to the board it joins), and the board it joins `card.committed` after it. Straight into a Complete column it writes `api:card_committed` and then `api:card_completed`, and sends `card.committed` and then `card.completed`. ' +
					'A move back into an upstream column clears committedAt and committedBy and writes `api:card_returned_to_options`, which sends `card.moved`; from a Complete column it writes `api:card_reopened` and then `api:card_returned_to_options`, with one `card.moved`. ' +
					'Across boards the board it joins logs `api:card_moved_in` first. A move within upstream, or between committed columns, leaves the commitment as it is.',
				operationId: 'moveCard',
				parameters: [{ $ref: '#/components/parameters/cardId' }],
				requestBody: {
					required: true,
					content: {
						'application/json': {
							schema: {
								type: 'object',
								required: ['columnId'],
								properties: {
									columnId: { type: 'integer', minimum: 1, description: 'Target column ID (can be on a different board for cross-board moves)' },
									position: { type: 'number', description: 'Position within the column: a number, or a number written as text. Default: the position the card has. Until 2026-10-14 a value that was not a number was ignored.' }
								}
							},
							examples: {
								sameBoard: {
									summary: 'Move within the same board',
									value: { columnId: 4, position: 0 }
								},
								crossBoard: {
									summary: 'Move to a column on another board',
									value: { columnId: 12, position: 0 }
								}
							}
						}
					}
				},
				responses: {
					'200': {
						description: 'Card moved. The boardId in the response reflects the card\'s new board (may differ from original for cross-board moves).',
						content: {
							'application/json': {
								schema: { $ref: '#/components/schemas/MovedCard' }
							}
						}
					},
					'400': {
						description: 'No columnId, a cardId or columnId that is not a whole number of 1 or more, a position that is not a number, or a body that is missing, is not valid JSON or is not an object. A body that is not a JSON object is answered 400 whatever the card; the card is looked for, and the caller checked, before a field is read. Nothing was moved.',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'columnId is required' } } }
					},
					'401': { $ref: '#/components/responses/Unauthorized' },
					'403': {
						description: 'No edit access to the board the card is on, or to the board the target column is on. Nothing was moved.',
						content: {
							'application/json': {
								schema: { $ref: '#/components/schemas/Error' },
								example: { message: 'No edit access to this board' }
							}
						}
					},
					'404': {
						description: 'There is no such card, or no column with the id given as columnId',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'Column not found' } } }
					},
					'409': {
						description: 'Card has incomplete subtasks or sub-boards and cannot be moved to Complete, as `Card has 3 incomplete subtasks that must be completed first` (an archived card on a sub-board is not counted), or the target column is on a board beneath the card, one of its own sub-boards at any depth: `Card "<title>" cannot go onto "<board>", which hangs beneath it`, or onto a board where its sub-boards would be more than 20 levels deep: `Card "<title>" cannot go onto "<board>": its sub-boards would then be nested more than 20 levels deep.` ' +
							'Or the move would take an archived card across the commitment point, out of an upstream column (a board\'s Options column, or any column of an ideas board) into a committed one or back: `Card "<title>" is archived: restore it before moving it out of or back into Options`; or a committed card with a sub-board would go into an upstream column: `Card "<title>" has a sub-board, so it cannot go into the Options column: a card with sub-boards is committed work. Keep it in a committed column, or archive it if it is no longer wanted.` (`onto an ideas board` in place of `into the Options column`). A card already upstream with a sub-board may still move within its own board\'s upstream, but not into another board\'s. Nothing was moved.',
						content: {
							'application/json': {
								schema: { $ref: '#/components/schemas/Error' },
								example: { message: 'Card "Design work" cannot go onto "Design", which hangs beneath it' }
							}
						}
					},
					'413': { $ref: '#/components/responses/PayloadTooLarge' },
					'429': { $ref: '#/components/responses/RateLimited' },
					'500': { $ref: '#/components/responses/InternalError' }
				}
			}
		},

		'/api/v1/cards/{cardId}/send': {
			post: {
				tags: ['Cards'],
				summary: 'Send an option to another delivery board',
				description:
					'Sends an option, a card in an upstream column (any column of an ideas board, or a delivery board\'s Options column), to another delivery board: to its Options column, where it is still an option and keeps its age, ' +
					'or to its To Do, which commits it on arrival (committedAt now, committedBy the key\'s user). "To Do" is the board\'s first column titled To Do, or else its first committed column that is neither Complete nor On Hold: never On Hold. ' +
					'Committed work is moved with PUT /cards/{cardId}/move, not sent. Edit access to both boards is needed. The move is made as every move is: the board\'s labels, a category of the board it left and a milestone of that board are shed, as for PUT /cards/{cardId}/move. ' +
					'The board it leaves logs `api:card_sent` ("<title>" sent to another board\'s Options, or To Do, with the columns) in place of `api:card_moved_away`, and its webhooks are sent `card.moved`; the board it joins logs `api:card_moved_in`, at the same moment, and `api:card_committed` for To Do, which sends `card.committed`. Neither entry names the other board.',
				operationId: 'sendCard',
				parameters: [{ $ref: '#/components/parameters/cardId' }],
				requestBody: {
					required: true,
					content: {
						'application/json': {
							schema: {
								type: 'object',
								required: ['boardId', 'to'],
								properties: {
									boardId: { type: 'integer', minimum: 1, description: 'The delivery board it is sent to: not an ideas board, and not the board it is on.' },
									to: { type: 'string', enum: ['options', 'todo'], description: '"options", the board\'s Options column, or "todo", its To Do, which commits it. Anything else is 400 to must be "options" or "todo", not <what was sent>.' },
									position: { type: 'number', description: 'Position within the column: a number, or a number written as text. Default: the position the card has.' }
								}
							},
							example: { boardId: 12, to: 'todo' }
						}
					}
				},
				responses: {
					'200': {
						description: 'Card sent. The boardId in the response is the board it was sent to.',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/MovedCard' } } }
					},
					'400': {
						description:
							'No boardId or no to, a field of the wrong type or value (`boardId must be an id`, `to must be "options" or "todo", not "backlog"`), a cardId that is not a whole number of 1 or more, or a body that is missing, is not valid JSON or is not an object. ' +
							'Or, once both boards are found and the key\'s user may edit them: the card is committed work (`A committed card is moved, not sent`), the board named is an ideas board (`"<board>" is an ideas board: a card is sent to a delivery board, and moved onto an ideas board`), ' +
							'or it is the board the card is on (`The card is already on "<board>": move it within the board instead`). Nothing was moved.',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'A committed card is moved, not sent' } } }
					},
					'401': { $ref: '#/components/responses/Unauthorized' },
					'403': {
						description: 'No edit access to the board the card is on, or to the board it is sent to. Nothing was moved.',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'No edit access to this board' } } }
					},
					'404': {
						description: 'There is no such card, or no board with the id given as boardId',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'Board not found' } } }
					},
					'409': {
						description:
							'Nothing was moved. The card is archived: `Card "<title>" is archived: restore it before moving it out of or back into Options`. ' +
							'Or `to` is "options" and the board has no Options column: `"<board>" has no Options column`; or it is "todo" and the board has no column to commit into, every column being Complete, On Hold or Options: `"<board>" has no column to commit into: add a To Do column`. ' +
							'Or a card with a sub-board, which never goes into another board\'s upstream: `Card "<title>" has a sub-board, so it cannot go into the Options column: …`. ' +
							'Or any other refusal of a move (PUT /cards/{cardId}/move): onto a board beneath the card, or too deep.',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: '"Delivery" has no Options column' } } }
					},
					'413': { $ref: '#/components/responses/PayloadTooLarge' },
					'429': { $ref: '#/components/responses/RateLimited' },
					'500': { $ref: '#/components/responses/InternalError' }
				}
			}
		},

		// ─── Assignees ──────────────────────────────────────────────────────
		'/api/v1/cards/{cardId}/assignees': {
			get: {
				tags: ['Assignees'],
				summary: 'List assignees',
				description: 'Lists who the card is assigned to. Needs view access to the board the card is on, as reading the card does.',
				operationId: 'listAssignees',
				parameters: [{ $ref: '#/components/parameters/cardId' }],
				responses: {
					'200': {
						description: 'Assignee list',
						content: {
							'application/json': {
								schema: {
									type: 'array',
									items: { $ref: '#/components/schemas/Assignee' }
								}
							}
						}
					},
					'400': {
						description: 'cardId is not a whole number of 1 or more',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'Invalid card ID' } } }
					},
					'401': { $ref: '#/components/responses/Unauthorized' },
					'403': {
						description: 'No access to the board the card is on',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'No access to this card\'s board' } } }
					},
					'404': { $ref: '#/components/responses/NotFound' },
					'429': { $ref: '#/components/responses/RateLimited' },
					'500': { $ref: '#/components/responses/InternalError' }
				}
			},
			post: {
				tags: ['Assignees'],
				summary: 'Assign a user',
				description:
					'Assigns a user to the card, who is then notified by email, unless they are the key\'s user: nobody is mailed about assigning themselves (until 2026-10-14 they were). ' +
					'The user must themselves have access to the card\'s board. ' +
					'Assigning a user who is already assigned assigns nobody and notifies nobody, and is answered 200 all the same; the message says which happened.',
				operationId: 'assignUser',
				parameters: [{ $ref: '#/components/parameters/cardId' }],
				requestBody: {
					required: true,
					content: {
						'application/json': {
							schema: {
								type: 'object',
								required: ['userId'],
								properties: { userId: { type: 'integer', minimum: 1 } }
							},
							example: { userId: 2 }
						}
					}
				},
				responses: {
					'200': {
						description: 'The user is assigned, or already was',
						content: {
							'application/json': {
								schema: {
									type: 'object',
									properties: {
										success: { type: 'boolean' },
										message: { type: 'string', enum: ['User assigned', 'User already assigned'] }
									},
									required: ['success', 'message']
								},
								example: { success: true, message: 'User assigned' }
							}
						}
					},
					'400': {
						description: 'No userId, one that is not an id (`userId must be an id`), a user who has no access to the card\'s board, cardId is not a whole number of 1 or more, or a body that is missing, is not valid JSON or is not an object. Nothing was written.',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'User does not have access to this board' } } }
					},
					'401': { $ref: '#/components/responses/Unauthorized' },
					'403': {
						description: 'No edit access to the board the card is on. Nobody was assigned.',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'No edit access to this card\'s board' } } }
					},
					'404': {
						description: 'There is no such card, or no user with the id given as userId',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'User not found' } } }
					},
					'413': { $ref: '#/components/responses/PayloadTooLarge' },
					'429': { $ref: '#/components/responses/RateLimited' },
					'500': { $ref: '#/components/responses/InternalError' }
				}
			},
			delete: {
				tags: ['Assignees'],
				summary: 'Remove an assignee',
				description: 'Takes a user off the card. Removing a user who is not assigned to it is 404, `User is not assigned to this card`, with no activity entry written and no live update sent: until 2026-10-14 it was answered 200, with an activity entry that said they had been removed.',
				operationId: 'removeAssignee',
				parameters: [{ $ref: '#/components/parameters/cardId' }],
				requestBody: {
					required: true,
					content: {
						'application/json': {
							schema: {
								type: 'object',
								required: ['userId'],
								properties: { userId: { type: 'integer', minimum: 1 } }
							},
							example: { userId: 2 }
						}
					}
				},
				responses: {
					'200': {
						description: 'Assignee removed',
						content: {
							'application/json': {
								schema: { type: 'object', properties: { success: { type: 'boolean' } }, required: ['success'] },
								example: { success: true }
							}
						}
					},
					'400': { $ref: '#/components/responses/BadRequest' },
					'401': { $ref: '#/components/responses/Unauthorized' },
					'403': {
						description: 'No edit access to the board the card is on. Nobody was removed.',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'No edit access' } } }
					},
					'404': {
						description: 'There is no such card (`Card not found`), or the user is not assigned to it. Nobody was removed.',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'User is not assigned to this card' } } }
					},
					'413': { $ref: '#/components/responses/PayloadTooLarge' },
					'429': { $ref: '#/components/responses/RateLimited' },
					'500': { $ref: '#/components/responses/InternalError' }
				}
			}
		},

		// ─── Subtasks ───────────────────────────────────────────────────────
		'/api/v1/cards/{cardId}/subtasks': {
			get: {
				tags: ['Subtasks'],
				summary: 'List subtasks',
				description: 'The card\'s subtasks, ordered by position, then id: subtasks at one position in the order they were made. Until 2026-10-14 they had no order (item 73).',
				operationId: 'listSubtasks',
				parameters: [{ $ref: '#/components/parameters/cardId' }],
				responses: {
					'200': {
						description: 'Subtask list, ordered by position, then id',
						content: {
							'application/json': {
								schema: {
									type: 'array',
									items: { $ref: '#/components/schemas/Subtask' }
								}
							}
						}
					},
					'400': {
						description: 'cardId is not a whole number of 1 or more',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'Invalid card ID' } } }
					},
					'401': { $ref: '#/components/responses/Unauthorized' },
					'403': {
						description: 'No access to the board the card is on',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'No access to this card\'s board' } } }
					},
					'404': { $ref: '#/components/responses/NotFound' },
					'429': { $ref: '#/components/responses/RateLimited' },
					'500': { $ref: '#/components/responses/InternalError' }
				}
			},
			post: {
				tags: ['Subtasks'],
				summary: 'Create a subtask',
				operationId: 'createSubtask',
				parameters: [{ $ref: '#/components/parameters/cardId' }],
				requestBody: {
					required: true,
					content: {
						'application/json': {
							schema: {
								type: 'object',
								required: ['title'],
								properties: {
									title: { type: 'string', minLength: 1, maxLength: 500, description: 'Trimmed' },
									description: { type: 'string', maxLength: 50000 },
									priority: {
										type: 'string',
										enum: ['low', 'medium', 'high', 'critical'],
										description: 'Read in any case, and stored in lower case'
									},
									colorTag: { type: 'string', pattern: '^(#[0-9a-fA-F]{6})?$', description: 'A colour written #rrggbb and trimmed, or empty for none' },
									dueDate: { type: ['string', 'null'], format: 'date', description: 'A day of the calendar written YYYY-MM-DD. null, or empty text, for none.' },
									position: {
										type: 'number',
										description:
											'Where it sits among the card\'s subtasks, lowest first. Not sent: after the last one (one more than the largest position, or 0 for the card\'s first), ' +
											'as the web application places it (until 2026-10-14 it was 0, item 73)'
									}
								}
							},
							example: { title: 'Write the migration', priority: 'high' }
						}
					}
				},
				responses: {
					'201': {
						description: 'Subtask created',
						content: {
							'application/json': {
								schema: { $ref: '#/components/schemas/Subtask' }
							}
						}
					},
					'400': { $ref: '#/components/responses/BadRequest' },
					'401': { $ref: '#/components/responses/Unauthorized' },
					'403': {
						description: 'No edit access to the board the card is on. Nothing was created.',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'No edit access to this card\'s board' } } }
					},
					'404': { $ref: '#/components/responses/NotFound' },
					'413': { $ref: '#/components/responses/PayloadTooLarge' },
					'429': { $ref: '#/components/responses/RateLimited' },
					'500': { $ref: '#/components/responses/InternalError' }
				}
			}
		},

		'/api/v1/subtasks/{subtaskId}': {
			put: {
				tags: ['Subtasks'],
				summary: 'Update a subtask',
				description:
					'Updates the fields sent; at least one must be. A value the subtask already holds, sent back unchanged, is accepted as it is. Completing a subtask that was the last thing another card or subtask was waiting on records and sends the "Unblocked" notices with it. ' +
					'Completing a subtask writes an api:subtask_completed activity entry, "<subtask> (on <card>)", and mails whoever asked for the card, when it was made from a task request, "Subtask completed on your request", as ticking it in the web application does. ' +
					'Until 2026-10-14 it wrote neither. A subtask already complete, sent completed true again, writes neither.\n\n' +
					'Unticking a subtask (completed false on one that is complete) writes an api:subtask_updated entry, "Reopened <subtask> (on <card>)", and mails nobody. ' +
					'A change of title, description, priority, colorTag or dueDate writes an api:subtask_updated entry naming the fields changed, "Updated <subtask> (on <card>): title, dueDate", ' +
					'after the tick or untick when one request does both. A change of position alone is written and not recorded. ' +
					'A request that changes nothing writes nothing, logs nothing and sends no live update, and is answered 200 with the subtask as it is. Until 2026-10-14 neither an untick nor an edit was recorded, and an unchanged request was written and sent a live update (item 87).',
				operationId: 'updateSubtask',
				parameters: [{ $ref: '#/components/parameters/subtaskId' }],
				requestBody: {
					required: true,
					content: {
						'application/json': {
							schema: {
								type: 'object',
								properties: {
									title: { type: 'string', minLength: 1, maxLength: 500, description: 'Trimmed' },
									description: { type: 'string', maxLength: 50000 },
									priority: {
										type: 'string',
										enum: ['low', 'medium', 'high', 'critical'],
										description: 'Read in any case, and stored in lower case'
									},
									colorTag: { type: 'string', pattern: '^(#[0-9a-fA-F]{6})?$', description: 'A colour written #rrggbb and trimmed, or empty for none' },
									dueDate: { type: ['string', 'null'], format: 'date', description: 'A day of the calendar written YYYY-MM-DD. null, or empty text, clears it.' },
									completed: { type: 'boolean' },
									position: { type: 'number' }
								}
							},
							example: { completed: true }
						}
					}
				},
				responses: {
					'200': {
						description: 'Updated subtask',
						content: {
							'application/json': {
								schema: { $ref: '#/components/schemas/Subtask' }
							}
						}
					},
					'400': {
						description: 'None of the seven fields was sent, a field of the wrong type (`completed must be true or false`, `position must be a number`), a title that is empty or over 500 characters, a description over 50000, a priority that is not one of the four, a colorTag not written #rrggbb, a dueDate that is not a day written YYYY-MM-DD, subtaskId is not a whole number of 1 or more, or a body that is missing, is not valid JSON or is not an object. Nothing was written.',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'No valid fields to update' } } }
					},
					'401': { $ref: '#/components/responses/Unauthorized' },
					'403': {
						description: 'No edit access to the board the subtask\'s card is on. Nothing was written.',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'No edit access to this subtask\'s board' } } }
					},
					'404': {
						description: 'There is no such subtask',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'Subtask not found' } } }
					},
					'413': { $ref: '#/components/responses/PayloadTooLarge' },
					'429': { $ref: '#/components/responses/RateLimited' },
					'500': { $ref: '#/components/responses/InternalError' }
				}
			},
			delete: {
				tags: ['Subtasks'],
				summary: 'Delete a subtask',
				description:
					'Permanently deletes the subtask, together with every dependency link that has it at either end. The subtask and its links go together or not at all, with an api:subtask_deleted activity entry naming the subtask, ' +
					'as deleting one in the web application writes subtask_deleted. Until 2026-10-14 no entry was written.',
				operationId: 'deleteSubtask',
				parameters: [{ $ref: '#/components/parameters/subtaskId' }],
				responses: {
					'200': {
						description: 'Deleted',
						content: {
							'application/json': {
								schema: { type: 'object', properties: { success: { type: 'boolean' } }, required: ['success'] },
								example: { success: true }
							}
						}
					},
					'400': {
						description: 'subtaskId is not a whole number of 1 or more. Nothing was deleted.',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'Invalid subtask ID' } } }
					},
					'401': { $ref: '#/components/responses/Unauthorized' },
					'403': {
						description: 'No edit access to the board the subtask\'s card is on. Nothing was deleted.',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'No edit access to this subtask\'s board' } } }
					},
					'404': {
						description: 'There is no such subtask',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'Subtask not found' } } }
					},
					'429': { $ref: '#/components/responses/RateLimited' },
					'500': { $ref: '#/components/responses/InternalError' }
				}
			}
		},

		// ─── Comments ───────────────────────────────────────────────────────
		'/api/v1/cards/{cardId}/comments': {
			get: {
				tags: ['Comments'],
				summary: 'List comments',
				description: 'Returns all comments on a card, newest first and, within one second, the later first (by id). An author with no emoji is listed with userEmoji "👤", as every other comment answer has it.',
				operationId: 'listComments',
				parameters: [{ $ref: '#/components/parameters/cardId' }],
				responses: {
					'200': {
						description: 'Comment list',
						content: {
							'application/json': {
								schema: {
									type: 'array',
									items: { $ref: '#/components/schemas/Comment' }
								}
							}
						}
					},
					'400': {
						description: 'cardId is not a whole number of 1 or more. Until 2026-10-14 it was answered 404.',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'Invalid card ID' } } }
					},
					'401': { $ref: '#/components/responses/Unauthorized' },
					'403': {
						description: 'No access to the board the card is on',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'No access to this board' } } }
					},
					'404': {
						description: 'There is no such card',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'Card not found' } } }
					},
					'429': { $ref: '#/components/responses/RateLimited' },
					'500': { $ref: '#/components/responses/InternalError' }
				}
			},
			post: {
				tags: ['Comments'],
				summary: 'Add a comment',
				description: 'Posts a comment on a card. Notifies board members via email. Anyone it names as `@username` who can open the card\'s board is also told by email, and nobody else. A name is the longest username that the text after `@` begins with, in any case; an `@` inside a word, as in an email address, is not a mention. Only the first 200 `@` of a comment that could start a name are read. Needs edit access to the card\'s board: a viewer can read comments and cannot add one. Logs api:comment_added to the activity feed and emits a live board update.',
				operationId: 'createComment',
				parameters: [{ $ref: '#/components/parameters/cardId' }],
				requestBody: {
					required: true,
					content: {
						'application/json': {
							schema: {
								type: 'object',
								required: ['content'],
								properties: {
									content: { type: 'string', maxLength: 50000, description: 'Comment text (markdown supported). Trimmed, and 1 to 50000 characters once trimmed, as an edit is.' }
								}
							},
							example: { content: 'Investigated the issue — root cause was a missing null check in the auth middleware.' }
						}
					}
				},
				responses: {
					'201': {
						description: 'Comment created',
						content: {
							'application/json': {
								schema: { $ref: '#/components/schemas/Comment' }
							}
						}
					},
					'400': {
						description: 'No content, content that is empty, is not text or is over 50000 characters, or a body that is missing, is not valid JSON or is not an object. A cardId that is not a whole number of 1 or more is answered 400 too (`Invalid card ID`), where it was 404. A body that is not a JSON object is answered 400 whatever the card; the card is looked for, and the caller checked, before the content is read. Nothing was written. Until 2026-10-14 a new comment had no limit, and content that was not text was answered 500.',
						content: {
							'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'Comment cannot be empty' } }
						}
					},
					'401': { $ref: '#/components/responses/Unauthorized' },
					'403': {
						description: 'No access to the card\'s board, or view access only. Nothing was written.',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'No edit access' } } }
					},
					'404': {
						description: 'There is no such card',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'Card not found' } } }
					},
					'413': { $ref: '#/components/responses/PayloadTooLarge' },
					'429': { $ref: '#/components/responses/RateLimited' },
					'500': { $ref: '#/components/responses/InternalError' }
				}
			}
		},
		'/api/v1/comments/{commentId}': {
			get: {
				tags: ['Comments'],
				summary: 'Get a comment',
				description: 'Returns a single comment with its author. Requires view access to the card\'s board.',
				operationId: 'getComment',
				parameters: [{ name: 'commentId', in: 'path', required: true, schema: { type: 'integer', minimum: 1 }, description: 'Comment ID: a whole number of 1 or more. Anything else is 400 Invalid comment ID.' }],
				responses: {
					'200': {
						description: 'Comment',
						content: {
							'application/json': {
								schema: { $ref: '#/components/schemas/Comment' }
							}
						}
					},
					'400': {
						description: 'commentId is not a whole number of 1 or more',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'Invalid comment ID' } } }
					},
					'401': { $ref: '#/components/responses/Unauthorized' },
					'403': {
						description: 'No access to the board the comment\'s card is on',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'No access to this board' } } }
					},
					'404': {
						description: 'There is no such comment',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'Comment not found' } } }
					},
					'429': { $ref: '#/components/responses/RateLimited' },
					'500': { $ref: '#/components/responses/InternalError' }
				}
			},
			put: {
				tags: ['Comments'],
				summary: 'Edit a comment',
				description: 'Replaces the comment text. Only the comment\'s author or an admin may edit, and the author only while they can still edit the board the comment is on, which is what posting a comment asks for: having written a comment is not access to its board, and an author who has been made a viewer can read it and not change it. Sets updatedAt, logs api:comment_edited to the activity feed and emits a live board update, unless the text is unchanged: text that is the comment\'s own once both are trimmed writes nothing, keeps updatedAt, logs nothing and sends no update, and is answered 200 with the comment as it is stored. The text is stored trimmed (no tag prefixing). The comment is looked for and access checked before the text is read, so a caller who may not edit it is refused whatever text they send.',
				operationId: 'updateComment',
				parameters: [{ name: 'commentId', in: 'path', required: true, schema: { type: 'integer', minimum: 1 }, description: 'Comment ID: a whole number of 1 or more. Anything else is 400 Invalid comment ID.' }],
				requestBody: {
					required: true,
					content: {
						'application/json': {
							schema: {
								type: 'object',
								required: ['content'],
								properties: {
									content: { type: 'string', minLength: 1, maxLength: 50000, description: 'Replacement comment text (markdown supported), counted and stored trimmed' }
								}
							},
							example: { content: 'Root cause was a missing null check — fixed in the auth middleware.' }
						}
					}
				},
				responses: {
					'200': {
						description: 'Updated comment',
						content: {
							'application/json': {
								schema: { $ref: '#/components/schemas/Comment' }
							}
						}
					},
					'400': {
						description: 'Content that is not text, is empty or is over 50000 characters, commentId is not a whole number of 1 or more, or a body that is missing, is not valid JSON or is not an object. The comment is looked for and the caller checked first: a comment that is not there is 404, and a caller who may not edit it 403, whatever was sent (until 2026-10-14 the content was looked at first). Nothing was written.',
						content: {
							'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'Comment cannot be empty' } }
						}
					},
					'401': { $ref: '#/components/responses/Unauthorized' },
					'403': {
						description:
							'No edit access to the board the comment is on, which its author is answered too once they have lost the board or can only view it (`No edit access to this board`). ' +
							'Or not the comment author and not an admin, which is the example. Nothing was written.',
						content: {
							'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'You can only edit your own comments' } }
						}
					},
					'404': {
						description: 'There is no such comment',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'Comment not found' } } }
					},
					'413': { $ref: '#/components/responses/PayloadTooLarge' },
					'429': { $ref: '#/components/responses/RateLimited' },
					'500': { $ref: '#/components/responses/InternalError' }
				}
			},
			delete: {
				tags: ['Comments'],
				summary: 'Delete a comment',
				description:
					'Deletes the comment (new on 2026-10-14, change item 85). Only the comment\'s author or an admin may delete it, and the author only while they can still edit the board the comment is on, as for an edit; the board\'s owner may not delete a comment somebody else wrote. ' +
					'No request body. Logs api:comment_deleted to the activity feed, its detail Deleted a comment on "<card>", or Deleted a comment by <author> on "<card>" when the caller is not the author; the comment\'s text is not recorded. Emits a live board update. ' +
					'No webhook is sent: there is no comment.deleted event, so a receiver mirroring comments learns that one has gone only by reading GET /api/v1/cards/{cardId}/comments again.',
				operationId: 'deleteComment',
				parameters: [{ name: 'commentId', in: 'path', required: true, schema: { type: 'integer', minimum: 1 }, description: 'Comment ID: a whole number of 1 or more. Anything else is 400 Invalid comment ID.' }],
				responses: {
					'200': {
						description: 'Deleted',
						content: {
							'application/json': {
								schema: { type: 'object', properties: { success: { type: 'boolean' } }, required: ['success'] },
								example: { success: true }
							}
						}
					},
					'400': {
						description: 'commentId is not a whole number of 1 or more. Nothing was deleted.',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'Invalid comment ID' } } }
					},
					'401': { $ref: '#/components/responses/Unauthorized' },
					'403': {
						description:
							'No edit access to the board the comment is on, which its author is answered too once they have lost the board or can only view it (`No edit access to this board`). ' +
							'Or not the comment author and not an admin, which is the example. Nothing was deleted.',
						content: {
							'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'You can only delete your own comments' } }
						}
					},
					'404': {
						description: 'There is no such comment',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'Comment not found' } } }
					},
					'429': { $ref: '#/components/responses/RateLimited' },
					'500': { $ref: '#/components/responses/InternalError' }
				}
			}
		},

		// ─── Labels ─────────────────────────────────────────────────────────
		'/api/v1/boards/{boardId}/labels': {
			get: {
				tags: ['Labels'],
				summary: 'List labels on a board',
				operationId: 'listLabels',
				parameters: [{ $ref: '#/components/parameters/boardId' }],
				responses: {
					'200': {
						description: 'List of labels',
						content: {
							'application/json': {
								schema: { type: 'array', items: { $ref: '#/components/schemas/Label' } }
							}
						}
					},
					'400': {
						description: 'boardId is not a whole number of 1 or more',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'Invalid board ID' } } }
					},
					'401': { $ref: '#/components/responses/Unauthorized' },
					'403': {
						description: 'No access to this board',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'No access to this board' } } }
					},
					'404': {
						description: 'There is no such board, whoever asks: it is looked for before access is checked. Until 2026-10-14 everyone but an administrator was answered 403, and an administrator an empty list.',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'Board not found' } } }
					},
					'429': { $ref: '#/components/responses/RateLimited' },
					'500': { $ref: '#/components/responses/InternalError' }
				}
			},
			post: {
				tags: ['Labels'],
				summary: 'Create a label',
				operationId: 'createLabel',
				parameters: [{ $ref: '#/components/parameters/boardId' }],
				requestBody: {
					required: true,
					content: {
						'application/json': {
							schema: {
								type: 'object',
								required: ['name'],
								properties: {
									name: { type: 'string', maxLength: 200 },
									color: { type: 'string', pattern: '^#[0-9a-fA-F]{6}$', description: 'A colour written #rrggbb, trimmed (default: #6366f1). Anything else is 400 color must be a colour written #rrggbb.' }
								}
							},
							example: { name: 'Frontend', color: '#3b82f6' }
						}
					}
				},
				responses: {
					'201': {
						description: 'Label created',
						content: {
							'application/json': { schema: { $ref: '#/components/schemas/Label' } }
						}
					},
					'400': { $ref: '#/components/responses/BadRequest' },
					'401': { $ref: '#/components/responses/Unauthorized' },
					'403': {
						description: 'No edit access to this board',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'No edit access to this board' } } }
					},
					'404': {
						description: 'There is no such board. Every caller is told so; until 2026-10-14 everyone but an administrator was answered 403, and an administrator 500.',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'Board not found' } } }
					},
					'413': { $ref: '#/components/responses/PayloadTooLarge' },
					'429': { $ref: '#/components/responses/RateLimited' },
					'500': { $ref: '#/components/responses/InternalError' }
				}
			}
		},

		'/api/v1/labels/{labelId}': {
			get: {
				tags: ['Labels'],
				summary: 'Get a label',
				operationId: 'getLabel',
				parameters: [{ $ref: '#/components/parameters/labelId' }],
				responses: {
					'200': {
						description: 'Label details',
						content: {
							'application/json': { schema: { $ref: '#/components/schemas/Label' } }
						}
					},
					'400': {
						description: 'labelId is not a whole number of 1 or more',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'Invalid label ID' } } }
					},
					'401': { $ref: '#/components/responses/Unauthorized' },
					'403': {
						description: 'No access to the board the label belongs to',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'No access to this board' } } }
					},
					'404': {
						description: 'There is no such label',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'Label not found' } } }
					},
					'429': { $ref: '#/components/responses/RateLimited' },
					'500': { $ref: '#/components/responses/InternalError' }
				}
			},
			put: {
				tags: ['Labels'],
				summary: 'Update a label',
				description:
					'Changes the name or the colour. Only the fields whose value changes are written, and the board\'s open pages told: a body whose every field is as the label holds it ' +
					'(a name that trims to the stored one included) answers 200 with the label as it is, writing nothing. A request that would be refused is still refused first (item 98).',
				operationId: 'updateLabel',
				parameters: [{ $ref: '#/components/parameters/labelId' }],
				requestBody: {
					required: true,
					content: {
						'application/json': {
							schema: {
								type: 'object',
								properties: {
									name: { type: 'string', maxLength: 200 },
									color: { type: 'string', pattern: '^#[0-9a-fA-F]{6}$', description: 'A colour written #rrggbb, trimmed. Anything else is 400 color must be a colour written #rrggbb; a colour the row already holds, sent back unchanged, is accepted as it is.' }
								}
							},
							example: { name: 'Backend', color: '#10b981' }
						}
					}
				},
				responses: {
					'200': {
						description: 'Updated label',
						content: {
							'application/json': { schema: { $ref: '#/components/schemas/Label' } }
						}
					},
					'400': {
						description: 'Neither name nor color was sent, the name is not text or is empty or over 200 characters, a colour that is not written #rrggbb (`color must be a colour written #rrggbb`), labelId is not a whole number of 1 or more, or the body is missing, is not valid JSON or is not an object. Nothing was written.',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'No valid fields to update' } } }
					},
					'401': { $ref: '#/components/responses/Unauthorized' },
					'403': { $ref: '#/components/responses/Forbidden' },
					'404': {
						description: 'There is no such label',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'Label not found' } } }
					},
					'413': { $ref: '#/components/responses/PayloadTooLarge' },
					'429': { $ref: '#/components/responses/RateLimited' },
					'500': { $ref: '#/components/responses/InternalError' }
				}
			},
			delete: {
				tags: ['Labels'],
				summary: 'Delete a label',
				description: 'Permanently deletes the label. Card-label associations are removed automatically.',
				operationId: 'deleteLabel',
				parameters: [{ $ref: '#/components/parameters/labelId' }],
				responses: {
					'200': {
						description: 'Deleted',
						content: {
							'application/json': {
								schema: { type: 'object', properties: { success: { type: 'boolean' } }, required: ['success'] },
								example: { success: true }
							}
						}
					},
					'400': {
						description: 'labelId is not a whole number of 1 or more. Nothing was deleted.',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'Invalid label ID' } } }
					},
					'401': { $ref: '#/components/responses/Unauthorized' },
					'403': { $ref: '#/components/responses/Forbidden' },
					'404': {
						description: 'There is no such label',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'Label not found' } } }
					},
					'429': { $ref: '#/components/responses/RateLimited' },
					'500': { $ref: '#/components/responses/InternalError' }
				}
			}
		},

		// ─── Card Labels ────────────────────────────────────────────────────
		'/api/v1/cards/{cardId}/labels': {
			get: {
				tags: ['Card Labels'],
				summary: 'List labels on a card',
				operationId: 'listCardLabels',
				parameters: [{ $ref: '#/components/parameters/cardId' }],
				responses: {
					'200': {
						description: 'Labels assigned to this card',
						content: {
							'application/json': {
								schema: { type: 'array', items: { $ref: '#/components/schemas/Label' } }
							}
						}
					},
					'400': {
						description: 'cardId is not a whole number of 1 or more',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'Invalid card ID' } } }
					},
					'401': { $ref: '#/components/responses/Unauthorized' },
					'403': {
						description: 'No access to the board the card is on',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'No access to this board' } } }
					},
					'404': { $ref: '#/components/responses/NotFound' },
					'429': { $ref: '#/components/responses/RateLimited' },
					'500': { $ref: '#/components/responses/InternalError' }
				}
			},
			post: {
				tags: ['Card Labels'],
				summary: 'Assign a label to a card',
				description:
					'Puts one of the board\'s labels on the card. The answer says which of two things happened: 201 with the pair when the label was put on, ' +
					'and 200 with a message when the card had it already and nothing changed.',
				operationId: 'assignLabel',
				parameters: [{ $ref: '#/components/parameters/cardId' }],
				requestBody: {
					required: true,
					content: {
						'application/json': {
							schema: {
								type: 'object',
								required: ['labelId'],
								properties: { labelId: { type: 'integer', description: 'A label of the board the card is on' } }
							},
							example: { labelId: 3 }
						}
					}
				},
				responses: {
					'200': {
						description: 'The card had the label already. Nothing changed.',
						content: {
							'application/json': {
								schema: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] },
								example: { message: 'Label already assigned' }
							}
						}
					},
					'201': {
						description: 'Label assigned',
						content: {
							'application/json': {
								schema: {
									type: 'object',
									properties: { cardId: { type: 'integer' }, labelId: { type: 'integer' } },
									required: ['cardId', 'labelId']
								},
								example: { cardId: 10, labelId: 3 }
							}
						}
					},
					'400': {
						description: 'No labelId, a labelId that is not a whole number of 1 or more, a label that belongs to another board, cardId not a whole number of 1 or more, or a body that is missing, is not valid JSON or is not an object. Nothing was written.',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'Label does not belong to this card\'s board' } } }
					},
					'401': { $ref: '#/components/responses/Unauthorized' },
					'403': { $ref: '#/components/responses/Forbidden' },
					'404': {
						description: 'There is no such card, or no label with the id given as labelId',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'Label not found' } } }
					},
					'413': { $ref: '#/components/responses/PayloadTooLarge' },
					'429': { $ref: '#/components/responses/RateLimited' },
					'500': { $ref: '#/components/responses/InternalError' }
				}
			},
			delete: {
				tags: ['Card Labels'],
				summary: 'Remove a label from a card',
				description: 'Takes a label off the card. A label the card does not have is answered 404, and nothing is written: until 2026-10-14 it was answered 200.',
				operationId: 'removeCardLabel',
				parameters: [{ $ref: '#/components/parameters/cardId' }],
				requestBody: {
					required: true,
					content: {
						'application/json': {
							schema: {
								type: 'object',
								required: ['labelId'],
								properties: { labelId: { type: 'integer' } }
							},
							example: { labelId: 3 }
						}
					}
				},
				responses: {
					'200': {
						description: 'Label removed',
						content: {
							'application/json': {
								schema: { type: 'object', properties: { success: { type: 'boolean' } }, required: ['success'] },
								example: { success: true }
							}
						}
					},
					'400': { $ref: '#/components/responses/BadRequest' },
					'401': { $ref: '#/components/responses/Unauthorized' },
					'403': { $ref: '#/components/responses/Forbidden' },
					'404': {
						description: 'There is no such card, or the card does not have the label',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'Label not found on this card' } } }
					},
					'413': { $ref: '#/components/responses/PayloadTooLarge' },
					'429': { $ref: '#/components/responses/RateLimited' },
					'500': { $ref: '#/components/responses/InternalError' }
				}
			}
		},

		// ─── Dependencies ───────────────────────────────────────────────────
		'/api/v1/cards/{cardId}/dependencies': {
			get: {
				tags: ['Dependencies'],
				summary: 'List card dependencies',
				description:
					'Returns what this card waits on (`blockedBy`) and what waits on it (`blocks`), with whether it is blocked now. Either can be a card or a subtask, on this board or another. ' +
					'Work that has been archived or deleted is not listed.',
				operationId: 'listDependencies',
				parameters: [
					{ $ref: '#/components/parameters/cardId' },
					{
						name: 'direction',
						in: 'query',
						schema: { type: 'string', enum: ['both', 'blocked-by', 'blocks'], default: 'both' },
						description: 'Which of the two lists to return. With `blocked-by` the answer has no `blocks`, and with `blocks` no `blockedBy`.'
					}
				],
				responses: {
					'200': {
						description: 'The card\'s dependencies',
						content: {
							'application/json': {
								schema: { $ref: '#/components/schemas/CardDependencies' },
								example: {
									cardId: 10,
									isBlocked: true,
									blockedBy: [
										{
											id: 7,
											kind: 'card',
											cardId: 42,
											parentCardId: null,
											title: 'Run the migration',
											boardId: 1,
											boardName: 'Sprint 43',
											columnName: 'In Progress',
											priority: 'high',
											resolved: false,
											createdByUserId: 2,
											createdAt: '2026-10-13T09:41:07.000Z'
										}
									],
									blocks: []
								}
							}
						}
					},
					'400': {
						description: 'cardId is not a whole number of 1 or more, or direction is not one of both, blocked-by and blocks',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'direction must be one of: blocked-by, blocks, both' } } }
					},
					'401': { $ref: '#/components/responses/Unauthorized' },
					'403': {
						description: 'No access to the board the card is on',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'No access to this card\'s board' } } }
					},
					'404': { $ref: '#/components/responses/NotFound' },
					'429': { $ref: '#/components/responses/RateLimited' },
					'500': { $ref: '#/components/responses/InternalError' }
				}
			},
			post: {
				tags: ['Dependencies'],
				summary: 'Add a dependency',
				description:
					'Records that this card waits on a card or a subtask, or that one of those waits on this card. Send exactly one of the four fields. ' +
					'A card that waits on unfinished work is blocked. The other end may be on another board, and edit access is needed to the boards at both ends.\n\n' +
					'Two refusals are answered 409: a link that is already recorded, and a link that would close a loop, which is the one with `cycle` in its body. ' +
					'An end that waits on itself, and an end that is archived, are answered 400. Nothing is written by a request that is refused.',
				operationId: 'addDependency',
				parameters: [{ $ref: '#/components/parameters/cardId' }],
				requestBody: {
					required: true,
					content: {
						'application/json': {
							schema: {
								type: 'object',
								description: 'Exactly one of the four.',
								properties: {
									dependsOnCardId: { type: 'integer', description: 'This card waits on that card' },
									dependsOnSubtaskId: { type: 'integer', description: 'This card waits on that subtask' },
									blocksCardId: { type: 'integer', description: 'That card waits on this card' },
									blocksSubtaskId: { type: 'integer', description: 'That subtask waits on this card' }
								}
							},
							example: { dependsOnCardId: 42 }
						}
					}
				},
				responses: {
					'201': {
						description: 'The link is recorded. `blocked` is the end that waits and `blocker` the end it waits on.',
						content: {
							'application/json': {
								schema: {
									type: 'object',
									properties: {
										blocked: { $ref: '#/components/schemas/DependencyEnd' },
										blocker: { $ref: '#/components/schemas/DependencyEnd' },
										isBlocked: { type: 'boolean', description: 'Whether the card in the path is blocked now' }
									},
									required: ['blocked', 'blocker', 'isBlocked']
								},
								example: { blocked: { kind: 'card', id: 10 }, blocker: { kind: 'card', id: 42 }, isBlocked: true }
							}
						}
					},
					'400': {
						description:
							'None of the four fields, more than one of them, an id in the path or the body that is not a whole number of 1 or more, an end that waits on itself, an end that is archived, ' +
							'or a body that is missing, is not valid JSON or is not an object. Nothing was written.',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'Provide only one of the dependsOn*/blocks* fields' } } }
					},
					'401': { $ref: '#/components/responses/Unauthorized' },
					'403': {
						description: 'No edit access to this card\'s board, or to the board the other end is on. Nothing was written.',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'No edit access to the board holding #42' } } }
					},
					'404': {
						description: 'There is no such card, or the card or subtask named in the body does not exist',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: '#42 not found' } } }
					},
					'409': {
						description:
							'The link is already recorded, or it would close a loop. The loop is the one with `cycle` in its body: the chain the link would close, in order. Nothing was written.',
						content: {
							'application/json': {
								schema: { $ref: '#/components/schemas/DependencyConflict' },
								example: {
									message: '#10 waiting on #42 would create a cycle: #10 → #42 → #10',
									cycle: [
										{ kind: 'card', id: 10 },
										{ kind: 'card', id: 42 }
									]
								}
							}
						}
					},
					'413': { $ref: '#/components/responses/PayloadTooLarge' },
					'429': { $ref: '#/components/responses/RateLimited' },
					'500': { $ref: '#/components/responses/InternalError' }
				}
			},
			delete: {
				tags: ['Dependencies'],
				summary: 'Remove a dependency',
				description:
					'Removes one link. The body names the other end exactly as the request that added the link did, with one of the same four fields.\n\n' +
					'A link is removed by whoever may edit the board of the end that waits, whichever end the request is addressed to; an administrator always. ' +
					'Edit access to the board of the end that is waited on is not asked for and is not enough: adding a link needs both boards, and removing one needs the waiting end\'s. ' +
					'The card in the path must be one the caller can view. ' +
					'A caller who may not remove the link is answered 403 before the link is looked for, so the answer does not say whether it exists.',
				operationId: 'removeDependency',
				parameters: [{ $ref: '#/components/parameters/cardId' }],
				requestBody: {
					required: true,
					content: {
						'application/json': {
							schema: {
								type: 'object',
								description: 'Exactly one of the four.',
								properties: {
									dependsOnCardId: { type: 'integer', description: 'This card waits on that card' },
									dependsOnSubtaskId: { type: 'integer', description: 'This card waits on that subtask' },
									blocksCardId: { type: 'integer', description: 'That card waits on this card' },
									blocksSubtaskId: { type: 'integer', description: 'That subtask waits on this card' }
								}
							},
							example: { dependsOnCardId: 42 }
						}
					}
				},
				responses: {
					'200': {
						description: 'Dependency removed',
						content: {
							'application/json': {
								schema: {
									type: 'object',
									properties: {
										success: { type: 'boolean' },
										removed: { type: 'integer', description: 'How many links were removed: 1' }
									},
									required: ['success', 'removed']
								},
								example: { success: true, removed: 1 }
							}
						}
					},
					'400': {
						description: 'None of the four fields, more than one of them, an id in the path or the body that is not a whole number of 1 or more, or a body that is missing, is not valid JSON or is not an object. Nothing was removed.',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'Provide only one of the dependsOn*/blocks* fields' } } }
					},
					'401': { $ref: '#/components/responses/Unauthorized' },
					'403': {
						description:
							'No edit access to the board of the end that waits, which is the example, or no access at all to the board the card in the path is on (`No access to this card\'s board`). ' +
							'Answered before the link is looked for. Nothing was removed.',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'No edit access to the board holding #10, the end that waits' } } }
					},
					'404': {
						description:
							'There is no such card, the card or subtask named in the body as the end that waits does not exist, or there is no link between this card and the end named in the body. ' +
							'The last is answered only to a caller who may edit the board of the end that waits.',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'Dependency not found' } } }
					},
					'413': { $ref: '#/components/responses/PayloadTooLarge' },
					'429': { $ref: '#/components/responses/RateLimited' },
					'500': { $ref: '#/components/responses/InternalError' }
				}
			}
		},

		'/api/v1/subtasks/{subtaskId}/dependencies': {
			get: {
				tags: ['Dependencies'],
				summary: 'List subtask dependencies',
				description:
					'Returns what this subtask waits on (`blockedBy`) and what waits on it (`blocks`), with whether it is blocked now. Either can be a card or a subtask, on this board or another. ' +
					'Both lists are always there: this operation has no `direction`. Work that has been archived or deleted is not listed. ' +
					'An entry does not carry the id of its link, which the card\'s list does: a link is removed by naming its other end.',
				operationId: 'listSubtaskDependencies',
				parameters: [{ $ref: '#/components/parameters/subtaskId' }],
				responses: {
					'200': {
						description: 'The subtask\'s dependencies',
						content: {
							'application/json': {
								schema: { $ref: '#/components/schemas/SubtaskDependencies' },
								example: {
									subtaskId: 3471,
									cardId: 10,
									isBlocked: true,
									blockedBy: [
										{
											kind: 'card',
											cardId: 42,
											parentCardId: null,
											title: 'Run the migration',
											boardId: 1,
											boardName: 'Sprint 43',
											columnName: 'In Progress',
											priority: 'high',
											resolved: false
										}
									],
									blocks: []
								}
							}
						}
					},
					'400': {
						description: 'subtaskId is not a whole number of 1 or more',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'Invalid subtask ID' } } }
					},
					'401': { $ref: '#/components/responses/Unauthorized' },
					'403': {
						description: 'No access to the board the subtask\'s card is on',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'No access' } } }
					},
					'404': {
						description: 'There is no such subtask',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'Subtask not found' } } }
					},
					'429': { $ref: '#/components/responses/RateLimited' },
					'500': { $ref: '#/components/responses/InternalError' }
				}
			},
			post: {
				tags: ['Dependencies'],
				summary: 'Add a dependency to a subtask',
				description:
					'Records that this subtask waits on a card or a subtask, or that one of those waits on this subtask. Send exactly one of the four fields, which mean what they mean on a card. ' +
					'A subtask that waits on unfinished work is blocked. The other end may be on another board, and edit access is needed to the boards at both ends. ' +
					'The answer is the subtask\'s dependencies as they then are.\n\n' +
					'The refusals are those of a card. Two are answered 409: a link that is already recorded, and a link that would close a loop, which is the one with `cycle` in its body. ' +
					'An end that waits on itself, and an end that is archived, are answered 400. Nothing is written by a request that is refused.\n\n' +
					'The link is recorded with an `api:dependency_added` activity entry on the board of the subtask\'s card, as a card\'s is: until 2026-10-14 this wrote none.',
				operationId: 'addSubtaskDependency',
				parameters: [{ $ref: '#/components/parameters/subtaskId' }],
				requestBody: {
					required: true,
					content: {
						'application/json': {
							schema: {
								type: 'object',
								description: 'Exactly one of the four.',
								properties: {
									dependsOnCardId: { type: 'integer', description: 'This subtask waits on that card' },
									dependsOnSubtaskId: { type: 'integer', description: 'This subtask waits on that subtask' },
									blocksCardId: { type: 'integer', description: 'That card waits on this subtask' },
									blocksSubtaskId: { type: 'integer', description: 'That subtask waits on this subtask' }
								}
							},
							example: { dependsOnCardId: 42 }
						}
					}
				},
				responses: {
					'201': {
						description: 'The link is recorded. The subtask\'s dependencies, with it among them.',
						content: {
							'application/json': {
								schema: { $ref: '#/components/schemas/SubtaskDependencies' },
								example: {
									subtaskId: 3471,
									cardId: 10,
									isBlocked: true,
									blockedBy: [
										{
											kind: 'card',
											cardId: 42,
											parentCardId: null,
											title: 'Run the migration',
											boardId: 1,
											boardName: 'Sprint 43',
											columnName: 'In Progress',
											priority: 'high',
											resolved: false
										}
									],
									blocks: []
								}
							}
						}
					},
					'400': {
						description:
							'None of the four fields, more than one of them, an id in the path or the body that is not a whole number of 1 or more, an end that waits on itself, an end that is archived, ' +
							'or a body that is missing, is not valid JSON or is not an object. Nothing was written.',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'Provide only one end' } } }
					},
					'401': { $ref: '#/components/responses/Unauthorized' },
					'403': {
						description: 'No edit access to the board this subtask\'s card is on, or to the board the other end is on. Nothing was written.',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'No edit access to the board holding #42' } } }
					},
					'404': {
						description: 'There is no such subtask, or the card or subtask named in the body does not exist',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: '#42 not found' } } }
					},
					'409': {
						description:
							'The link is already recorded, or it would close a loop. The loop is the one with `cycle` in its body: the chain the link would close, in order. Nothing was written.',
						content: {
							'application/json': {
								schema: { $ref: '#/components/schemas/DependencyConflict' },
								example: {
									message: 'subtask #3471 waiting on #42 would create a cycle: subtask #3471 → #42 → subtask #3471',
									cycle: [
										{ kind: 'subtask', id: 3471 },
										{ kind: 'card', id: 42 }
									]
								}
							}
						}
					},
					'413': { $ref: '#/components/responses/PayloadTooLarge' },
					'429': { $ref: '#/components/responses/RateLimited' },
					'500': { $ref: '#/components/responses/InternalError' }
				}
			},
			delete: {
				tags: ['Dependencies'],
				summary: 'Remove a dependency from a subtask',
				description:
					'Removes one link. The body names the other end exactly as the request that added the link did, with one of the same four fields. ' +
					'The answer is the subtask\'s dependencies as they then are.\n\n' +
					'The rule is a card\'s: a link is removed by whoever may edit the board of the end that waits, whichever end the request is addressed to; an administrator always. ' +
					'Edit access to the board of the end that is waited on is not asked for and is not enough. The subtask in the path must be one the caller can view. ' +
					'A caller who may not remove the link is answered 403 before the link is looked for, so the answer does not say whether it exists.\n\n' +
					'The removal is recorded with an `api:dependency_removed` activity entry on the board of the end that waits, as a card\'s is: until 2026-10-14 this wrote none.',
				operationId: 'removeSubtaskDependency',
				parameters: [{ $ref: '#/components/parameters/subtaskId' }],
				requestBody: {
					required: true,
					content: {
						'application/json': {
							schema: {
								type: 'object',
								description: 'Exactly one of the four.',
								properties: {
									dependsOnCardId: { type: 'integer', description: 'This subtask waits on that card' },
									dependsOnSubtaskId: { type: 'integer', description: 'This subtask waits on that subtask' },
									blocksCardId: { type: 'integer', description: 'That card waits on this subtask' },
									blocksSubtaskId: { type: 'integer', description: 'That subtask waits on this subtask' }
								}
							},
							example: { dependsOnCardId: 42 }
						}
					}
				},
				responses: {
					'200': {
						description: 'The link is removed. The subtask\'s dependencies, without it.',
						content: {
							'application/json': {
								schema: { $ref: '#/components/schemas/SubtaskDependencies' },
								example: { subtaskId: 3471, cardId: 10, isBlocked: false, blockedBy: [], blocks: [] }
							}
						}
					},
					'400': {
						description: 'None of the four fields, more than one of them, an id in the path or the body that is not a whole number of 1 or more, or a body that is missing, is not valid JSON or is not an object. Nothing was removed.',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'Provide only one end' } } }
					},
					'401': { $ref: '#/components/responses/Unauthorized' },
					'403': {
						description:
							'No edit access to the board of the end that waits, which is the example, or no access at all to the board this subtask\'s card is on (`No access`). ' +
							'Answered before the link is looked for. Nothing was removed.',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'No edit access to the board holding subtask #3471, the end that waits' } } }
					},
					'404': {
						description:
							'There is no such subtask, the card or subtask named in the body as the end that waits does not exist, or there is no link between this subtask and the end named in the body. ' +
							'The last is answered only to a caller who may edit the board of the end that waits.',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'Dependency not found' } } }
					},
					'413': { $ref: '#/components/responses/PayloadTooLarge' },
					'429': { $ref: '#/components/responses/RateLimited' },
					'500': { $ref: '#/components/responses/InternalError' }
				}
			}
		},

		'/api/v1/dependencies/bulk': {
			post: {
				tags: ['Dependencies'],
				summary: 'Add many dependencies',
				description:
					'Records many dependency links in one request. Send `links`, each of which says that `blocked` waits on `blocker`, or send `chain`, in which each entry waits on the one before it: ' +
					'{"chain": [1686, 1559, 1444]} says that 1559 waits on 1686 and 1444 waits on 1559. Not both.\n\n' +
					'An end may be a card or a subtask, and is written in one of four ways: a number, which is a card id; a number as text, "42", which is a card id too; ' +
					'the text "subtask:42" or "card:42"; or an object {"kind": "subtask", "id": 42}, which is a card unless its `kind` is "subtask". ' +
					'In `links` each end has two names: `blocked` or `cardId` for the end that waits, and `blocker` or `dependsOnCardId` for the end it waits on. ' +
					'The ends may be on any boards, and edit access is needed to the board of every end.\n\n' +
					'**All or nothing.** The whole batch is checked before anything is written, loops between the links of the batch included. ' +
					'If one link is refused nothing is written, the links that were acceptable included, and the answer is a 409 that lists every link at fault, so that a long list is put right in one go. ' +
					'A link to an end that does not exist, and a link the key\'s user may not make, are reasons in that 409: this operation answers no 404 and no 403.\n\n' +
					'A link that is already recorded is not a fault. It is skipped and counted, so the same batch can be sent twice.\n\n' +
					'Each link written logs one api:dependency_added activity entry, as POST /cards/{cardId}/dependencies does: on the board of the card that waits (a subtask\'s card), with that card\'s id, ' +
					'in the words "#12 now waits on subtask #45". A link skipped as already recorded logs none. Until 2026-10-14 a batch logged one api:dependencies_bulk_added entry with no card, on one board, which is no longer written (item 88).',
				operationId: 'addDependencies',
				requestBody: {
					required: true,
					content: {
						'application/json': {
							schema: {
								type: 'object',
								description: 'Exactly one of the two.',
								properties: {
									links: {
										type: 'array',
										minItems: 1,
										maxItems: 500,
										description: 'The links to record, 500 at most',
										items: {
											type: 'object',
											description:
												'`blocked` waits on `blocker`. Both ends are needed, each under either of its names. A link written with the field names of the single-card operation is read too: ' +
												'`cardId` as `blocked` and `dependsOnCardId` as `blocker`.',
											properties: {
												blocked: {
													type: ['integer', 'string', 'object'],
													description: 'The end that waits: a card id, a card id as text, "card:<id>", "subtask:<id>", or {kind, id}'
												},
												blocker: {
													type: ['integer', 'string', 'object'],
													description: 'The end it waits on, written in the same way'
												},
												cardId: {
													type: ['integer', 'string', 'object'],
													description: 'Another name for `blocked`, written in the same way. Read only when `blocked` is not sent or is null.'
												},
												dependsOnCardId: {
													type: ['integer', 'string', 'object'],
													description: 'Another name for `blocker`, written in the same way. Read only when `blocker` is not sent or is null.'
												},
												blockedType: {
													type: 'string',
													enum: ['card', 'subtask'],
													description: 'What `blocked` is the id of, for a caller who would rather say it here. Read before the kind in `blocked` itself. Any other word is 400, where it was a 409.'
												},
												blockerType: { type: 'string', enum: ['card', 'subtask'], description: 'The same, for `blocker`' }
											}
										}
									},
									chain: {
										type: 'array',
										minItems: 2,
										description: 'At least two ends, in the order the work is done: each waits on the one before it. 500 links at most, which is 501 ends.',
										items: { type: ['integer', 'string', 'object'], description: 'A card id, a card id as text, "card:<id>", "subtask:<id>", or {kind, id}' }
									}
								}
							},
							example: {
								links: [
									{ blocked: 1559, blocker: 1686 },
									{ blocked: 'subtask:3471', blocker: 1559 }
								]
							}
						}
					}
				},
				responses: {
					'201': {
						description:
							'Every link of the batch is recorded, or was already. Also the answer when all of them were already recorded: `created` is then 0.',
						content: {
							'application/json': {
								schema: { $ref: '#/components/schemas/DependencyBatchCreated' },
								example: {
									created: 2,
									skippedAsDuplicate: 0,
									boardsTouched: [1],
									links: [
										{ blocked: 1559, blockedType: 'card', blocker: 1686, blockerType: 'card' },
										{ blocked: 3471, blockedType: 'subtask', blocker: 1559, blockerType: 'card' }
									]
								}
							}
						}
					},
					'400': {
						description:
							'The batch cannot be read: both `links` and `chain`, neither, `links` empty, a `chain` of fewer than two, a link with no `blocked` or no `blocker`, ' +
							'an end written in none of the three ways, an entry of `links` that is not an object (`links[<n>] must be an object`, which was a 500), a `blockedType` or `blockerType` that is neither card nor subtask ' +
							'(`links[<n>].blockedType must be one of: card, subtask`), more than 500 links, or a body that is missing, is not valid JSON or is not an object. Nothing was written.',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'Provide either links or chain, not both' } } }
					},
					'401': { $ref: '#/components/responses/Unauthorized' },
					'409': {
						description: 'At least one link cannot be recorded. Nothing was written, and every link at fault is listed with the reason.',
						content: {
							'application/json': {
								schema: { $ref: '#/components/schemas/DependencyBatchRejected' },
								example: {
									message: 'Batch rejected — nothing was written',
									written: 0,
									rejected: [
										{
											link: { blocked: 1444, blockedType: 'card', blocker: 1559, blockerType: 'card' },
											reason: 'cycle',
											cycle: [
												{ kind: 'card', id: 1444 },
												{ kind: 'card', id: 1686 },
												{ kind: 'card', id: 1559 }
											],
											message: '#1444 waiting on #1559 would create a cycle: #1444 → #1686 → #1559 → #1444'
										}
									],
									forbidden: [],
									wouldSkipAsDuplicate: 0,
									wouldCreate: 1
								}
							}
						}
					},
					'413': { $ref: '#/components/responses/PayloadTooLarge' },
					'429': { $ref: '#/components/responses/RateLimited' },
					'500': { $ref: '#/components/responses/InternalError' }
				}
			}
		},

		// ─── Categories (Per-Board Card Categories) ─────────────────────────
		'/api/v1/boards/{boardId}/categories': {
			get: {
				tags: ['Categories'],
				summary: 'List categories on a board',
				description: 'Returns all card categories for the specified board.',
				operationId: 'listCategories',
				parameters: [{ $ref: '#/components/parameters/boardId' }],
				responses: {
					'200': {
						description: 'List of categories',
						content: {
							'application/json': {
								schema: { type: 'array', items: { $ref: '#/components/schemas/Category' } }
							}
						}
					},
					'400': {
						description: 'boardId is not a whole number of 1 or more',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'Invalid board ID' } } }
					},
					'401': { $ref: '#/components/responses/Unauthorized' },
					'403': {
						description: 'No access to this board',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'No access to this board' } } }
					},
					'404': {
						description: 'There is no such board, whoever asks: it is looked for before access is checked. Until 2026-10-14 everyone but an administrator was answered 403, and an administrator an empty list.',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'Board not found' } } }
					},
					'429': { $ref: '#/components/responses/RateLimited' },
					'500': { $ref: '#/components/responses/InternalError' }
				}
			},
			post: {
				tags: ['Categories'],
				summary: 'Create a category',
				description: 'Creates a new card category on the specified board.',
				operationId: 'createCategory',
				parameters: [{ $ref: '#/components/parameters/boardId' }],
				requestBody: {
					required: true,
					content: {
						'application/json': {
							schema: {
								type: 'object',
								required: ['name'],
								properties: {
									name: { type: 'string', maxLength: 200, description: 'Category name' },
									color: { type: 'string', pattern: '^#[0-9a-fA-F]{6}$', description: 'A colour written #rrggbb, trimmed (default: #6366f1). Anything else is 400 color must be a colour written #rrggbb.' }
								}
							},
							example: { name: 'Bug', color: '#ef4444' }
						}
					}
				},
				responses: {
					'201': {
						description: 'Category created',
						content: {
							'application/json': { schema: { $ref: '#/components/schemas/Category' } }
						}
					},
					'400': { $ref: '#/components/responses/BadRequest' },
					'401': { $ref: '#/components/responses/Unauthorized' },
					'403': {
						description: 'No edit access to this board',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'No edit access to this board' } } }
					},
					'404': {
						description: 'There is no such board. Every caller is told so; until 2026-10-14 everyone but an administrator was answered 403, and an administrator 500.',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'Board not found' } } }
					},
					'413': { $ref: '#/components/responses/PayloadTooLarge' },
					'429': { $ref: '#/components/responses/RateLimited' },
					'500': { $ref: '#/components/responses/InternalError' }
				}
			}
		},

		'/api/v1/categories/{categoryId}': {
			get: {
				tags: ['Categories'],
				summary: 'Get a category',
				description:
					'Returns one card category: one that belongs to no board, or one of a board the key\'s user can open. Until 2026-10-14 any key could read any category.',
				operationId: 'getCategory',
				parameters: [{ $ref: '#/components/parameters/categoryId' }],
				responses: {
					'200': {
						description: 'Category details',
						content: {
							'application/json': { schema: { $ref: '#/components/schemas/Category' } }
						}
					},
					'400': {
						description: 'categoryId is not a whole number of 1 or more',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'Invalid category ID' } } }
					},
					'401': { $ref: '#/components/responses/Unauthorized' },
					'403': {
						description: 'The category belongs to a board the key\'s user cannot open',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'No access to this category' } } }
					},
					'404': {
						description: 'There is no such category',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'Category not found' } } }
					},
					'429': { $ref: '#/components/responses/RateLimited' },
					'500': { $ref: '#/components/responses/InternalError' }
				}
			},
			put: {
				tags: ['Categories'],
				summary: 'Update a category',
				description:
					'Changes the name or the colour. Needs edit access to the board the category belongs to; a category that belongs to no board can be changed only by an administrator. ' +
					'Only the fields whose value changes are written, and the board\'s open pages told: a body whose every field is as the category holds it ' +
					'(a name that trims to the stored one included) answers 200 with the category as it is, writing nothing (item 98).',
				operationId: 'updateCategory',
				parameters: [{ $ref: '#/components/parameters/categoryId' }],
				requestBody: {
					required: true,
					content: {
						'application/json': {
							schema: {
								type: 'object',
								properties: {
									name: { type: 'string', maxLength: 200 },
									color: { type: 'string', pattern: '^#[0-9a-fA-F]{6}$', description: 'A colour written #rrggbb, trimmed. Anything else is 400 color must be a colour written #rrggbb; a colour the row already holds, sent back unchanged, is accepted as it is.' }
								}
							},
							example: { name: 'Feature', color: '#10b981' }
						}
					}
				},
				responses: {
					'200': {
						description: 'Updated category',
						content: {
							'application/json': { schema: { $ref: '#/components/schemas/Category' } }
						}
					},
					'400': {
						description: 'Neither name nor color was sent, the name is not text or is empty or over 200 characters, a colour that is not written #rrggbb (`color must be a colour written #rrggbb`), categoryId is not a whole number of 1 or more, or the body is missing, is not valid JSON or is not an object. Nothing was written.',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'No valid fields to update' } } }
					},
					'401': { $ref: '#/components/responses/Unauthorized' },
					'403': {
						description: 'No edit access to the board the category belongs to, or the category belongs to no board and the key\'s user is not an administrator. Nothing was written.',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'Only an administrator can change a category that belongs to no board' } } }
					},
					'404': {
						description: 'There is no such category',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'Category not found' } } }
					},
					'413': { $ref: '#/components/responses/PayloadTooLarge' },
					'429': { $ref: '#/components/responses/RateLimited' },
					'500': { $ref: '#/components/responses/InternalError' }
				}
			},
			delete: {
				tags: ['Categories'],
				summary: 'Delete a category',
				description:
					'Permanently deletes the card category. Cards using this category will have their categoryId set to null. ' +
					'Needs edit access to the board the category belongs to; a category that belongs to no board can be deleted only by an administrator.',
				operationId: 'deleteCategory',
				parameters: [{ $ref: '#/components/parameters/categoryId' }],
				responses: {
					'200': {
						description: 'Deleted',
						content: {
							'application/json': {
								schema: { type: 'object', properties: { success: { type: 'boolean' } }, required: ['success'] },
								example: { success: true }
							}
						}
					},
					'400': {
						description: 'categoryId is not a whole number of 1 or more. Nothing was deleted.',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'Invalid category ID' } } }
					},
					'401': { $ref: '#/components/responses/Unauthorized' },
					'403': {
						description: 'No edit access to the board the category belongs to, or the category belongs to no board and the key\'s user is not an administrator. Nothing was deleted.',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'Only an administrator can change a category that belongs to no board' } } }
					},
					'404': {
						description: 'There is no such category',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'Category not found' } } }
					},
					'429': { $ref: '#/components/responses/RateLimited' },
					'500': { $ref: '#/components/responses/InternalError' }
				}
			}
		},

		// ─── Board Categories (Dashboard Grouping) ──────────────────────────
		'/api/v1/board-categories': {
			get: {
				tags: ['Board Categories'],
				summary: 'List board categories',
				description:
					'Returns the board categories, used for grouping boards on the dashboard, that hold a board the key\'s user can open, and those that hold no board yet. A board category all of whose boards they cannot open is left out; an administrator is given every one. Until 2026-10-14 every one was listed to every key.',
				operationId: 'listBoardCategories',
				responses: {
					'200': {
						description: 'List of board categories',
						content: {
							'application/json': {
								schema: { type: 'array', items: { $ref: '#/components/schemas/BoardCategory' } }
							}
						}
					},
					'401': { $ref: '#/components/responses/Unauthorized' },
					'429': { $ref: '#/components/responses/RateLimited' },
					'500': { $ref: '#/components/responses/InternalError' }
				}
			},
			post: {
				tags: ['Board Categories'],
				summary: 'Create a board category',
				description: 'Creates a new board category for grouping boards on the dashboard.',
				operationId: 'createBoardCategory',
				requestBody: {
					required: true,
					content: {
						'application/json': {
							schema: {
								type: 'object',
								required: ['name'],
								properties: {
									name: { type: 'string', minLength: 1, maxLength: 200, description: 'Category name, trimmed' },
									color: { type: 'string', pattern: '^#[0-9a-fA-F]{6}$', description: 'A colour written #rrggbb, trimmed (default: #6366f1). Anything else is 400 color must be a colour written #rrggbb.' }
								}
							},
							example: { name: 'Development', color: '#6366f1' }
						}
					}
				},
				responses: {
					'201': {
						description: 'Board category created',
						content: {
							'application/json': { schema: { $ref: '#/components/schemas/BoardCategory' } }
						}
					},
					'400': { $ref: '#/components/responses/BadRequest' },
					'401': { $ref: '#/components/responses/Unauthorized' },
					'413': { $ref: '#/components/responses/PayloadTooLarge' },
					'429': { $ref: '#/components/responses/RateLimited' },
					'500': { $ref: '#/components/responses/InternalError' }
				}
			}
		},

		'/api/v1/board-categories/{categoryId}': {
			get: {
				tags: ['Board Categories'],
				summary: 'Get a board category',
				description:
					'Returns one board category, if it holds a board the key\'s user can open or holds no board, as the list gives them. Until 2026-10-14 any key was given any board category by its id.',
				operationId: 'getBoardCategory',
				parameters: [{ $ref: '#/components/parameters/categoryId' }],
				responses: {
					'200': {
						description: 'Board category details',
						content: {
							'application/json': { schema: { $ref: '#/components/schemas/BoardCategory' } }
						}
					},
					'400': {
						description: 'categoryId is not a whole number of 1 or more',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'Invalid category ID' } } }
					},
					'401': { $ref: '#/components/responses/Unauthorized' },
					'403': {
						description: 'The board category holds boards, and the key\'s user can open none of them',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'No access to this board category' } } }
					},
					'404': {
						description: 'There is no such board category',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'Board category not found' } } }
					},
					'429': { $ref: '#/components/responses/RateLimited' },
					'500': { $ref: '#/components/responses/InternalError' }
				}
			},
			put: {
				tags: ['Board Categories'],
				summary: 'Update a board category',
				description:
					'Changes the name or the colour. A board category changes how every board filed under it is shown, so the key\'s user must be able to edit each of those boards. One with no boards under it may be changed by anyone. ' +
					'Only the fields whose value changes are written: a body whose every field is as the board category holds it ' +
					'(a name that trims to the stored one included) answers 200 with it as it is, writing nothing (item 98).',
				operationId: 'updateBoardCategory',
				parameters: [{ $ref: '#/components/parameters/categoryId' }],
				requestBody: {
					required: true,
					content: {
						'application/json': {
							schema: {
								type: 'object',
								properties: {
									name: { type: 'string', maxLength: 200 },
									color: { type: 'string', pattern: '^#[0-9a-fA-F]{6}$', description: 'A colour written #rrggbb, trimmed. Anything else is 400 color must be a colour written #rrggbb; a colour the row already holds, sent back unchanged, is accepted as it is.' }
								}
							},
							example: { name: 'Infrastructure', color: '#f59e0b' }
						}
					}
				},
				responses: {
					'200': {
						description: 'Updated board category',
						content: {
							'application/json': { schema: { $ref: '#/components/schemas/BoardCategory' } }
						}
					},
					'400': {
						description: 'Neither name nor color was sent, the name is not text or is empty or over 200 characters, a colour that is not written #rrggbb (`color must be a colour written #rrggbb`), categoryId is not a whole number of 1 or more, or the body is missing, is not valid JSON or is not an object. Nothing was written.',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'No valid fields to update' } } }
					},
					'401': { $ref: '#/components/responses/Unauthorized' },
					'403': {
						description: 'A board filed under this category is one the key\'s user cannot edit. Nothing was written.',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'This category groups boards you cannot edit' } } }
					},
					'404': {
						description: 'There is no such board category',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'Board category not found' } } }
					},
					'413': { $ref: '#/components/responses/PayloadTooLarge' },
					'429': { $ref: '#/components/responses/RateLimited' },
					'500': { $ref: '#/components/responses/InternalError' }
				}
			},
			delete: {
				tags: ['Board Categories'],
				summary: 'Delete a board category',
				description:
					'Permanently deletes the board category, and takes every board filed under it out of it in the same request: each board\'s categoryId becomes null. ' +
					'Those boards\' updatedAt is left as it is, and nothing is logged. ' +
					'The key\'s user must be able to edit every board filed under it.',
				operationId: 'deleteBoardCategory',
				parameters: [{ $ref: '#/components/parameters/categoryId' }],
				responses: {
					'200': {
						description: 'Deleted',
						content: {
							'application/json': {
								schema: { type: 'object', properties: { success: { type: 'boolean' } }, required: ['success'] },
								example: { success: true }
							}
						}
					},
					'400': {
						description: 'categoryId is not a whole number of 1 or more. Nothing was deleted.',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'Invalid category ID' } } }
					},
					'401': { $ref: '#/components/responses/Unauthorized' },
					'403': {
						description: 'A board filed under this category is one the key\'s user cannot edit. Nothing was deleted.',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'This category groups boards you cannot edit' } } }
					},
					'404': {
						description: 'There is no such board category',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'Board category not found' } } }
					},
					'429': { $ref: '#/components/responses/RateLimited' },
					'500': { $ref: '#/components/responses/InternalError' }
				}
			}
		},

		// ─── Webhooks ───────────────────────────────────────────────────────
		'/api/v1/boards/{boardId}/webhooks': {
			get: {
				tags: ['Webhooks'],
				summary: 'List webhooks on a board',
				operationId: 'listWebhooks',
				parameters: [{ $ref: '#/components/parameters/boardId' }],
				responses: {
					'200': {
						description: 'List of webhooks',
						content: {
							'application/json': {
								schema: { type: 'array', items: { $ref: '#/components/schemas/Webhook' } }
							}
						}
					},
					'400': {
						description: 'boardId is not a whole number',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'Invalid board ID' } } }
					},
					'401': { $ref: '#/components/responses/Unauthorized' },
					'403': {
						description: 'No access to this board',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'No access to this board' } } }
					},
					'404': {
						description: 'There is no such board',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'Board not found' } } }
					},
					'429': { $ref: '#/components/responses/RateLimited' },
					'500': { $ref: '#/components/responses/InternalError' }
				}
			},
			post: {
				tags: ['Webhooks'],
				summary: 'Create a webhook',
				operationId: 'createWebhook',
				description:
					'Needs edit access to the board. The url may not point inside the network as written, nor carry a user name or password (see Webhook); no name is looked up here. ' +
					'A board has at most 10 webhooks, switched-off ones counted: an 11th is answered 409, after every other check. The key\'s user is recorded as the one who set the webhook\'s address, ' +
					'which no answer gives.',
				parameters: [{ $ref: '#/components/parameters/boardId' }],
				requestBody: {
					required: true,
					content: {
						'application/json': {
							schema: {
								type: 'object',
								required: ['url'],
								properties: {
									url: { type: 'string', format: 'uri', maxLength: 2048, description: 'Webhook delivery URL: an http or https address' },
									secret: { type: 'string', maxLength: 256, description: 'Shared secret for HMAC verification' },
									events: { type: 'array', items: { type: 'string', enum: ['card.created', 'card.updated', 'card.moved', 'card.completed', 'card.deleted', 'comment.added', 'milestone.card_added', 'milestone.card_removed', 'card.committed', 'card.discarded'] }, description: 'Event types to subscribe to, each trimmed of spaces at either end, among the ten. An empty list, or none, is every event, the two milestone events among them (item 102), and card.committed and card.discarded (since 2026-10-26). Goal membership sends no card.updated on any route: it sends milestone.card_added or milestone.card_removed.' }
								}
							},
							example: { url: 'https://example.com/webhook', secret: 'my-secret', events: ['card.created', 'card.moved'] }
						}
					}
				},
				responses: {
					'201': {
						description: 'Webhook created. The secret is in this answer, to the caller who has just sent it.',
						content: {
							'application/json': { schema: { $ref: '#/components/schemas/Webhook' } }
						}
					},
					'400': {
						description: 'No url, a url that is not an http or https address, one that points inside the network as written ("Webhook url points inside the network: 127.0.0.1 is a loopback address"), one that carries a user name or password, a secret over 256 characters, an event that is not one of the ten, boardId not a whole number of 1 or more, or a body that is missing, is not valid JSON or is not an object. Nothing was created.',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'URL is required' } } }
					},
					'401': { $ref: '#/components/responses/Unauthorized' },
					'403': { $ref: '#/components/responses/Forbidden' },
					'404': {
						description: 'There is no such board',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'Board not found' } } }
					},
					'409': {
						description: 'The board already has 10 webhooks, switched off ones included. Nothing was created. The message gives the count and how many to delete.',
						content: {
							'application/json': {
								schema: { $ref: '#/components/schemas/Error' },
								example: { message: 'This board has 10 webhooks, and a board may have at most 10: delete 1 before adding another.' }
							}
						}
					},
					'413': { $ref: '#/components/responses/PayloadTooLarge' },
					'429': { $ref: '#/components/responses/RateLimited' },
					'500': { $ref: '#/components/responses/InternalError' }
				}
			}
		},

		'/api/v1/webhooks/{webhookId}': {
			get: {
				tags: ['Webhooks'],
				summary: 'Get a webhook',
				operationId: 'getWebhook',
				parameters: [{ $ref: '#/components/parameters/webhookId' }],
				responses: {
					'200': {
						description: 'Webhook details',
						content: {
							'application/json': { schema: { $ref: '#/components/schemas/Webhook' } }
						}
					},
					'400': {
						description: 'webhookId is not a whole number',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'Invalid webhook ID' } } }
					},
					'401': { $ref: '#/components/responses/Unauthorized' },
					'403': {
						description: 'No access to the board the webhook belongs to',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'No access to this board' } } }
					},
					'404': {
						description: 'There is no such webhook',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'Webhook not found' } } }
					},
					'429': { $ref: '#/components/responses/RateLimited' },
					'500': { $ref: '#/components/responses/InternalError' }
				}
			},
			put: {
				tags: ['Webhooks'],
				summary: 'Update a webhook',
				operationId: 'updateWebhook',
				description:
					'Needs edit access to the board. Changing the url or the secret, and switching a webhook on, need the board\'s owner or an administrator: an editor who sends url or secret at all, ' +
					'whatever the value, or active true for a webhook that is off, is answered 403 and nothing is written. An editor changes events, switches a webhook off, and may send active true for one already on. ' +
					'Send only the fields that change. A new url is held to the rules of Webhook; the stored one sent back unchanged is accepted. ' +
					'The key\'s user is recorded as the one who set the webhook when the url or the secret changes, or the webhook is switched on, which no answer gives.',
				parameters: [{ $ref: '#/components/parameters/webhookId' }],
				requestBody: {
					required: true,
					content: {
						'application/json': {
							schema: {
								type: 'object',
								properties: {
									url: { type: 'string', format: 'uri', maxLength: 2048, description: 'An http or https address' },
									secret: { type: 'string', maxLength: 256 },
									events: { type: 'array', items: { type: 'string', enum: ['card.created', 'card.updated', 'card.moved', 'card.completed', 'card.deleted', 'comment.added', 'milestone.card_added', 'milestone.card_removed', 'card.committed', 'card.discarded'] }, description: 'Each trimmed of spaces at either end, among the ten. An empty list is every event, the two milestone events among them (item 102), and card.committed and card.discarded (since 2026-10-26). Goal membership sends no card.updated on any route: it sends milestone.card_added or milestone.card_removed.' },
									active: { type: 'boolean' }
								}
							},
							example: { active: false }
						}
					}
				},
				responses: {
					'200': {
						description: 'Updated webhook',
						content: {
							'application/json': { schema: { $ref: '#/components/schemas/Webhook' } }
						}
					},
					'400': {
						description: 'None of the four fields was sent, a field that is not what it may hold (a url that is not an http or https address, one that points inside the network as written, one that carries a user name or password, a secret over 256 characters, an event that is not one of the ten, active that is not true or false), webhookId is not a whole number of 1 or more, or the body is missing, is not valid JSON or is not an object. Nothing was written.',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'No fields to update' } } }
					},
					'401': { $ref: '#/components/responses/Unauthorized' },
					'403': {
						description:
							'No access to the board, or view access where edit access is needed; or a caller who is not the board\'s owner or an administrator sent url or secret, whatever the value, ' +
							'or active true for a webhook that is off. Nothing was written.',
						content: {
							'application/json': {
								schema: { $ref: '#/components/schemas/Error' },
								examples: {
									addressOrSecret: {
										summary: 'An editor sent url or secret',
										value: { message: 'Only the board\'s owner or an administrator can change a webhook\'s address or secret. Ask the board\'s owner.' }
									},
									switchOn: {
										summary: 'An editor switched a webhook on',
										value: { message: 'Only the board\'s owner or an administrator can switch a webhook on. Ask the board\'s owner.' }
									},
									viewer: {
										summary: 'View access only',
										value: { message: 'No edit access to this board' }
									}
								}
							}
						}
					},
					'404': {
						description: 'There is no such webhook',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'Webhook not found' } } }
					},
					'413': { $ref: '#/components/responses/PayloadTooLarge' },
					'429': { $ref: '#/components/responses/RateLimited' },
					'500': { $ref: '#/components/responses/InternalError' }
				}
			},
			delete: {
				tags: ['Webhooks'],
				summary: 'Delete a webhook',
				operationId: 'deleteWebhook',
				parameters: [{ $ref: '#/components/parameters/webhookId' }],
				responses: {
					'200': {
						description: 'Deleted',
						content: {
							'application/json': {
								schema: { type: 'object', properties: { success: { type: 'boolean' } }, required: ['success'] },
								example: { success: true }
							}
						}
					},
					'400': {
						description: 'webhookId is not a whole number. Nothing was deleted.',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'Invalid webhook ID' } } }
					},
					'401': { $ref: '#/components/responses/Unauthorized' },
					'403': { $ref: '#/components/responses/Forbidden' },
					'404': {
						description: 'There is no such webhook',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'Webhook not found' } } }
					},
					'429': { $ref: '#/components/responses/RateLimited' },
					'500': { $ref: '#/components/responses/InternalError' }
				}
			}
		},

		// ─── Burndown ───────────────────────────────────────────────────────
		'/api/v1/burndown': {
			get: {
				tags: ['Burndown'],
				summary: 'Burndown series and forecast',
				description:
					'How much work was open on each UTC day, and where it is heading, for a board, several boards, a board category, a milestone or everything you can see, narrowed by card category, label, assignee or priority. Rebuilt from each card\'s created, completed and archived dates rather than daily snapshots, so any filter works over any window. Read meta.notes before quoting a figure. ' +
					'Committed work only (since 2026-10-26, milestone 22): an option, a card in a board\'s Options column or on an ideas board, is not charted, and a card\'s scope starts when it was committed, its committedAt, ' +
					'which for a card made before then is its creation. Each card is charted as it is now, so a card returned to options leaves the past days\' scope too.',
				operationId: 'getBurndown',
				parameters: [
					{ name: 'boardIds', in: 'query', schema: { type: 'string' }, description: 'Comma-separated board ids. View access to each is required.' },
					{ name: 'boardCategoryId', in: 'query', schema: { type: 'integer' }, description: 'Every board in this board category that you can see. Not with boardIds. One that holds boards, none of which you can see, is refused 403: until 2026-10-14 it was charted empty, with its name.' },
					{ name: 'milestoneId', in: 'query', schema: { type: 'integer' }, description: 'The milestone\'s cards, on whichever boards you can see: one on a board you cannot see is left out, and meta.notes says how many. Combines with boardIds to narrow. Until 2026-10-14 a card moved to a board you cannot see was charted, and its board named.' },
					{ name: 'categoryIds', in: 'query', schema: { type: 'string' }, description: 'Card category ids; "none" = uncategorised.' },
					{ name: 'labelIds', in: 'query', schema: { type: 'string' }, description: 'Label ids; a card matches if it carries any of them.' },
					{ name: 'assigneeIds', in: 'query', schema: { type: 'string' }, description: 'User ids; "me" = you, "none" = unassigned.' },
					{ name: 'priorities', in: 'query', schema: { type: 'string' }, description: 'Any of critical, high, medium, low.' },
					{ name: 'from', in: 'query', schema: { type: 'string', format: 'date' }, description: 'First day (UTC). Not with days.' },
					{ name: 'to', in: 'query', schema: { type: 'string', format: 'date' }, description: 'Last day (UTC), default today. A future date is clamped to today.' },
					{ name: 'days', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 730 }, description: 'Window length ending at to, 1 to 730. Default 30, or since creation for a milestone.' },
					{ name: 'target', in: 'query', schema: { type: 'string' }, description: 'Draw an ideal line to zero on this day (YYYY-MM-DD). Defaults to the milestone\'s target date; "none" hides it.' },
					{ name: 'groupBy', in: 'query', schema: { type: 'string', enum: ['none', 'board', 'category', 'label', 'assignee', 'priority'] }, description: 'Per-group series for a breakdown.' },
					{ name: 'options', in: 'query', schema: { type: 'boolean' }, description: 'true adds the filter values present in scope, with counts.' },
				],
				responses: {
					'200': {
						description: 'Burndown for the requested scope',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/BurndownResult' } } }
					},
					'400': {
						description: 'A parameter is invalid; the message names it',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'Use boardIds or boardCategoryId, not both' } } }
					},
					'401': { $ref: '#/components/responses/Unauthorized' },
					'403': {
						description: 'No access to a requested board or milestone, or a board category that holds boards, none of which you can see (`No access to board category 3`)',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'No access to board 7' } } }
					},
					'404': {
						description: 'A requested board, board category or milestone does not exist',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'Board 7 not found' } } }
					},
					'429': { $ref: '#/components/responses/RateLimited' },
					'500': { $ref: '#/components/responses/InternalError' }
				}
			}
		},
		// ─── Audit Log ──────────────────────────────────────────────────────
		'/api/v1/audit-log': {
			get: {
				tags: ['Audit'],
				summary: 'Get audit log',
				description:
					'Returns activity log entries from every board, newest first, and by id within a second, a page at a time. Administrators only. ' +
					'The filters all apply together. A page holds 100 entries unless `limit` says otherwise, and 500 at most: ' +
					'read `pagination.hasMore`, and ask for the next page with `before` (or `offset`), before taking a page for the whole answer. ' +
					'`before` names the last entry you hold, so entries written while you page are not given twice (item 104). ' +
					'Since 2026-10-26 (milestone 22) the actions include card_committed, card_returned_to_options, card_discarded, card_abandoned, card_sent, column_converted_to_options and board_converted_to_ideas, ' +
					'and card_archived is written only for a card archived from a Complete column: unfinished committed work archived is card_abandoned, and an option card_discarded. ' +
					'A commitment is card_committed, not card_moved, and an option leaving its board card_sent, not card_moved_away. Entries written before keep their actions.',
				operationId: 'getAuditLog',
				parameters: [
					{
						name: 'boardId',
						in: 'query',
						schema: { type: 'integer', minimum: 1 },
						description: 'Filter by board ID. An id: anything else is 400 Invalid board ID.'
					},
					{
						name: 'userId',
						in: 'query',
						schema: { type: 'integer', minimum: 1 },
						description: 'Filter by user ID. An id: anything else is 400 Invalid user ID.'
					},
					{
						name: 'cardId',
						in: 'query',
						schema: { type: 'integer', minimum: 1 },
						description: 'Filter by card ID. An id: anything else is 400 Invalid card ID.'
					},
					{
						name: 'action',
						in: 'query',
						schema: { type: 'string' },
						description:
							'Filter by action, by its canonical name: `card_moved` finds moves made in the web application and through the API alike. A trailing * matches a prefix: `card_*`. ' +
							'Nothing else is a wildcard, so `card_*` finds card_moved and card_completed and not cards_purged or cards_cleared: until 2026-10-14 the _ of a prefix matched any one character, and it found those too.'
					},
					{
						name: 'source',
						in: 'query',
						schema: { type: 'string', enum: ['ui', 'api'] },
						description: 'Filter by where the action came from: the web application or the API'
					},
					{
						name: 'from',
						in: 'query',
						schema: { type: 'string' },
						description:
							'Entries created at or after this moment: ISO 8601, with or without a fraction and with Z or an offset, which is read in UTC; YYYY-MM-DD HH:MM:SS in UTC; or a date, which is from the start of that day. ' +
							'Anything else is 400 `from is not a date`: until 2026-10-14 it was compared as text with the stored time, unchecked (item 54).'
					},
					{
						name: 'to',
						in: 'query',
						schema: { type: 'string' },
						description:
							'Entries created at or before this moment, read as `from` is, but a date alone is the whole of that day, to 23:59:59 UTC. ' +
							'Anything else is 400 `to is not a date`: until 2026-10-14 a date alone left that day out.'
					},
					{
						name: 'limit',
						in: 'query',
						schema: { type: 'integer', default: 100, minimum: 1, maximum: 500 },
						description: 'Entries in a page, rounded down. More than 500 is read as 500, and less than 1 as 1, but 0, which is the default, as it always was; text that is not a number is the default too. Until 2026-10-14 -1 gave every entry and 2.5 was a 500.'
					},
					{
						name: 'offset',
						in: 'query',
						schema: { type: 'integer', default: 0, minimum: 0 },
						description: 'Entries to skip, for the pages after the first: rounded down, and less than 0 is read as 0. A negative offset was echoed until 2026-10-14. ' +
							'Each entry written after the first page moves every later page down by one, so a page asked by offset can begin with an entry already given: page with `before` instead. With `before`, counted from the cursor.'
					},
					{
						name: 'before',
						in: 'query',
						schema: { type: 'string', example: '2026-10-21T09:00:00.000Z,1234' },
						description:
							'The `createdAt` and `id` of the last entry you hold, joined by a comma: the page is the entries older than it, newest first, so entries written while you page are not given twice. ' +
							'The time is read as `from` is, but a date alone names no entry. With it, `total` counts the entries the filters find older than it and `hasMore` says whether any follow this page. ' +
							'Anything else is 400 `before must be an entry\'s createdAt and id, as 2026-10-21T09:00:00Z,1234`. Since 2026-10-14 (item 104).'
					}
				],
				responses: {
					'200': {
						description: 'A page of audit log entries, and where the page lies in the whole',
						content: {
							'application/json': {
								schema: {
									type: 'object',
									properties: {
										data: { type: 'array', items: { $ref: '#/components/schemas/AuditLogEntry' } },
										pagination: {
											type: 'object',
											properties: {
												limit: { type: 'integer', description: 'The page size that was applied' },
												offset: { type: 'integer' },
												count: { type: 'integer', description: 'Entries in this page' },
												total: { type: 'integer', description: 'Entries that match the filters, in all; with `before`, those older than it' },
												hasMore: { type: 'boolean', description: 'true when entries that match lie beyond this page (with `before`, beyond it and this page)' },
												defaultLimit: { type: 'integer', description: 'The page size when no limit is sent: 100' },
												maxLimit: { type: 'integer', description: 'The largest page size: 500' }
											},
											required: ['limit', 'offset', 'count', 'total', 'hasMore', 'defaultLimit', 'maxLimit']
										}
									},
									required: ['data', 'pagination']
								}
							}
						}
					},
					'400': {
						description: 'source is neither ui nor api, boardId, userId or cardId is not a whole number of 1 or more (`Invalid board ID`), from or to is not a date or a timestamp (`from is not a date`), from is after to ("`from` is after `to`", item 74), or before is not an entry\'s createdAt and id (item 104)',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'source must be "ui" or "api"' } } }
					},
					'401': { $ref: '#/components/responses/Unauthorized' },
					'403': {
						description: 'The key\'s user is not an administrator',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'Admin access required' } } }
					},
					'429': { $ref: '#/components/responses/RateLimited' },
					'500': { $ref: '#/components/responses/InternalError' }
				}
			}
		},

		// ─── Milestones ─────────────────────────────────────────────────────
		'/api/v1/milestones': {
			get: {
				tags: ['Milestones'],
				summary: 'List milestones',
				description:
					'Returns the milestones the key\'s user can see, each with how many cards it has and how many of them are done. ' +
					'A milestone that belongs to a board is seen by whoever can see that board. One that spans boards is seen by whoever can see every board its cards are on, ' +
					'and while it has no cards by its creator alone. An administrator sees them all.\n\n' +
					'Open milestones come first, then the earlier target date, with those that have none last, then the newer milestone.',
				operationId: 'listMilestones',
				parameters: [
					{
						name: 'boardId',
						in: 'query',
						schema: { type: 'integer', minimum: 1 },
						description:
							'Only the milestones that belong to this board, which is an id: anything else is 400 Invalid boardId. A milestone that spans boards is not among them, even when it has cards on the board.'
					},
					{
						name: 'status',
						in: 'query',
						schema: { type: 'string', enum: ['open', 'closed'] },
						description: 'Only the milestones with this status'
					}
				],
				responses: {
					'200': {
						description: 'The milestones. An empty list when there is none to see.',
						content: {
							'application/json': {
								schema: { type: 'array', items: { $ref: '#/components/schemas/MilestoneListItem' } },
								example: [
									{
										id: 17,
										boardId: null,
										name: 'Security hardening',
										description: 'Everything the audit of September raised',
										targetDate: '2026-12-01',
										status: 'open',
										createdBy: 2,
										createdAt: '2026-10-01T08:15:00.000Z',
										updatedAt: '2026-10-01T08:15:00.000Z',
										boardName: null,
										cardCount: 12,
										doneCount: 5,
										boardIds: [1, 4]
									}
								]
							}
						}
					},
					'400': {
						description: 'status is neither open nor closed, or boardId is not a whole number of 1 or more',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'status must be open or closed' } } }
					},
					'401': { $ref: '#/components/responses/Unauthorized' },
					'429': { $ref: '#/components/responses/RateLimited' },
					'500': { $ref: '#/components/responses/InternalError' }
				}
			},
			post: {
				tags: ['Milestones'],
				summary: 'Create a milestone',
				description:
					'Creates a milestone with no cards in it: cards are put into it afterwards. With `boardId` the milestone belongs to that board, ' +
					'needs edit access to it, and takes cards of that board only. Without one, or with null, it spans boards, and may be changed afterwards by its creator and by an administrator.',
				operationId: 'createMilestone',
				requestBody: {
					required: true,
					content: {
						'application/json': {
							schema: {
								type: 'object',
								required: ['name'],
								properties: {
									name: { type: 'string', minLength: 1, maxLength: 200, description: 'Milestone name: text, trimmed, of 1 to 200 characters' },
									boardId: { type: ['integer', 'null'], minimum: 1, description: 'The board the milestone belongs to. Leave out, or send null, for one that spans boards.' },
									description: { type: 'string', maxLength: 50000, description: 'Default: an empty string' },
									targetDate: {
										type: ['string', 'null'],
										format: 'date',
										description: 'The day the milestone is meant to be reached: a day of the calendar written YYYY-MM-DD. null, or empty text, for none. Until 2026-10-14 any text was stored.'
									}
								}
							},
							example: { name: 'Security hardening', description: 'Everything the audit of September raised', targetDate: '2026-12-01' }
						}
					}
				},
				responses: {
					'201': {
						description: 'The milestone, as it was created',
						content: {
							'application/json': {
								schema: { $ref: '#/components/schemas/Milestone' },
								example: {
									id: 17,
									boardId: null,
									name: 'Security hardening',
									description: 'Everything the audit of September raised',
									targetDate: '2026-12-01',
									status: 'open',
									createdBy: 2,
									createdAt: '2026-10-01T08:15:00.000Z',
									updatedAt: '2026-10-01T08:15:00.000Z'
								}
							}
						}
					},
					'400': {
						description: 'No name, a name that is empty or over 200 characters, a description over 50000, a targetDate that is not a day written YYYY-MM-DD, a field of the wrong type (`name must be text`, `boardId must be an id`), or a body that is missing, is not valid JSON or is not an object. With boardId, the board is looked for and access checked before the other fields are read. Nothing was created.',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'name is required' } } }
					},
					'401': { $ref: '#/components/responses/Unauthorized' },
					'403': {
						description: 'With boardId only: no edit access to that board. Nothing was created.',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'No edit access to that board' } } }
					},
					'404': {
						description: 'With boardId only: there is no such board',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'Board not found' } } }
					},
					'413': { $ref: '#/components/responses/PayloadTooLarge' },
					'429': { $ref: '#/components/responses/RateLimited' },
					'500': { $ref: '#/components/responses/InternalError' }
				}
			}
		},

		'/api/v1/milestones/{milestoneId}': {
			get: {
				tags: ['Milestones'],
				summary: 'Get a milestone',
				description:
					'Returns one milestone with the cards in it, archived cards left out of `cards` and listed in `archivedCards`, each with when it was archived. ' +
					'A card on a board the key\'s user cannot open is listed withheld, with `withheld` true. ' +
					'For the order the work must be done in, what can be started and what is waiting, ask for its summary.',
				operationId: 'getMilestone',
				parameters: [{ $ref: '#/components/parameters/milestoneId' }],
				responses: {
					'200': {
						description: 'The milestone and its cards',
						content: {
							'application/json': {
								schema: { $ref: '#/components/schemas/MilestoneDetail' },
								example: {
									id: 17,
									boardId: null,
									name: 'Security hardening',
									description: 'Everything the audit of September raised',
									targetDate: '2026-12-01',
									status: 'open',
									createdBy: 2,
									createdAt: '2026-10-01T08:15:00.000Z',
									updatedAt: '2026-10-01T08:15:00.000Z',
									cards: [{ id: 1686, title: 'Rotate the signing keys', priority: 'high', columnId: 3, columnTitle: 'In Progress', boardId: 1, withheld: false }],
									archivedCards: [
										{ id: 1559, title: 'Spike: key storage', priority: 'low', columnId: 9, columnTitle: 'Complete', boardId: 4, withheld: false, archivedAt: '2026-10-09T16:02:44.000Z' }
									]
								}
							}
						}
					},
					'400': {
						description: 'milestoneId is not a whole number of 1 or more',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'Invalid milestone ID' } } }
					},
					'401': { $ref: '#/components/responses/Unauthorized' },
					'403': {
						description: 'The key\'s user cannot see this milestone: the board it belongs to, or for one that spans boards a board one of its cards is on',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'No access to this milestone' } } }
					},
					'404': {
						description: 'There is no such milestone',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'Milestone not found' } } }
					},
					'429': { $ref: '#/components/responses/RateLimited' },
					'500': { $ref: '#/components/responses/InternalError' }
				}
			},
			patch: {
				tags: ['Milestones'],
				summary: 'Update a milestone',
				description:
					'Changes the fields that are sent and leaves the rest: at least one of the five. The milestone is looked for and access checked before a field is read, and a value it already holds, sent back unchanged, is accepted as it is. A milestone that belongs to a board is changed by whoever can edit that board; ' +
					'one that spans boards by its creator and by an administrator.\n\n' +
					'`status` closes a milestone and opens it again, and does nothing to its cards. `boardId` gives the milestone to a board, which needs edit access to that board, ' +
					'or with null makes it span boards. Null is always accepted, and the cards in the milestone stay in it. A board is accepted only when every card in the milestone, archived ones included, ' +
					'is on that board: a milestone of a board is opened by whoever can open that board, who would otherwise read the titles of cards of other boards. The milestone\'s own board sent back is no change.\n\n' +
					'**Logged.** A change logs `api:milestone_updated` naming the fields changed (name, description, targetDate, boardId), and a change of status `api:milestone_closed` or `api:milestone_reopened`, ' +
					'each with no card, on the milestone\'s board, or for one across boards on each board holding its cards; a change of board logs on the boards before and after. ' +
					'Each names the milestone as that board\'s readers knew it before the change (as it is after, on a board it joins), and one across boards as `milestone #<id>`. ' +
					'A request whose every field is as stored writes nothing, logs nothing and sends no live update, and is answered 200 with the milestone as it is. No webhook is sent. Until 2026-10-14 nothing was logged.',
				operationId: 'updateMilestone',
				parameters: [{ $ref: '#/components/parameters/milestoneId' }],
				requestBody: {
					required: true,
					content: {
						'application/json': {
							schema: {
								type: 'object',
								properties: {
									name: { type: 'string', minLength: 1, maxLength: 200, description: 'Text, trimmed, and not empty' },
									description: { type: 'string', maxLength: 50000 },
									targetDate: { type: ['string', 'null'], format: 'date', description: 'A day of the calendar written YYYY-MM-DD. null or an empty string clears it. Until 2026-10-14 any text was stored.' },
									status: { type: 'string', enum: ['open', 'closed'] },
									boardId: { type: ['integer', 'null'], minimum: 1, description: 'The board the milestone belongs to, or null for one that spans boards. An id: anything else is 400 boardId must be an id. A board is accepted only when every card in the milestone, archived ones included, is on it.' }
								}
							},
							example: { status: 'closed' }
						}
					}
				},
				responses: {
					'200': {
						description: 'The milestone, as it is after the change',
						content: {
							'application/json': {
								schema: { $ref: '#/components/schemas/Milestone' },
								example: {
									id: 17,
									boardId: null,
									name: 'Security hardening',
									description: 'Everything the audit of September raised',
									targetDate: '2026-12-01',
									status: 'closed',
									createdBy: 2,
									createdAt: '2026-10-01T08:15:00.000Z',
									updatedAt: '2026-10-13T09:41:07.000Z'
								}
							}
						}
					},
					'400': {
						description:
							'None of the five fields was sent, a field of the wrong type (`name must be text`, `boardId must be an id`), the name is empty or over 200 characters, a description over 50000, ' +
							'a targetDate that is not a day written YYYY-MM-DD, status is neither open nor closed, milestoneId is not a whole number of 1 or more, ' +
							'or the body is missing, is not valid JSON or is not an object. Or boardId names a board and a card in the milestone is on another board: ' +
							'"Some cards in this milestone are not on that board (archived cards count too). Take those cards out of it first, or make the milestone cross-board instead; only its creator or an administrator can change a cross-board milestone afterwards." ' +
							'Archived cards count, and GET /api/v1/milestones/{milestoneId} lists them in `archivedCards`. Nothing was written.',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'No valid fields to update' } } }
					},
					'401': { $ref: '#/components/responses/Unauthorized' },
					'403': {
						description: 'The key\'s user cannot see or cannot change this milestone, or cannot edit the board sent as boardId. Nothing was written.',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'No edit access to this milestone' } } }
					},
					'404': {
						description: 'There is no such milestone, or no board has the id sent as boardId ("Board not found")',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'Milestone not found' } } }
					},
					'413': { $ref: '#/components/responses/PayloadTooLarge' },
					'429': { $ref: '#/components/responses/RateLimited' },
					'500': { $ref: '#/components/responses/InternalError' }
				}
			},
			delete: {
				tags: ['Milestones'],
				summary: 'Delete a milestone',
				description:
					'Permanently deletes the milestone and keeps the work. Every card in it, archived cards included, is left with no milestone, and none is deleted or changed in any other way. ' +
					'The answer says how many cards were released. The milestone goes and its cards are released together, or neither happens.\n\n' +
					'It logs `api:milestone_deleted`, with no card, on the milestone\'s board, or for one across boards on each board holding its cards, saying how many of that board\'s cards were released, ' +
					'and every board of a card released is sent a live update. Then each card released logs `api:milestone_card_removed` on its own board, with its id, ' +
					'and that board\'s webhooks are sent `milestone.card_removed` (item 103); no other webhook is sent. Until 2026-10-14 nothing was logged.',
				operationId: 'deleteMilestone',
				parameters: [{ $ref: '#/components/parameters/milestoneId' }],
				responses: {
					'200': {
						description: 'Deleted, and its cards released',
						content: {
							'application/json': {
								schema: {
									type: 'object',
									properties: {
										success: { type: 'boolean' },
										cardsReleased: { type: 'integer', description: 'How many cards were in the milestone and now have none' }
									},
									required: ['success', 'cardsReleased']
								},
								example: { success: true, cardsReleased: 12 }
							}
						}
					},
					'400': {
						description: 'milestoneId is not a whole number of 1 or more. Nothing was deleted.',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'Invalid milestone ID' } } }
					},
					'401': { $ref: '#/components/responses/Unauthorized' },
					'403': {
						description: 'The key\'s user cannot see or cannot change this milestone. Nothing was deleted.',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'No edit access to this milestone' } } }
					},
					'404': {
						description: 'There is no such milestone',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'Milestone not found' } } }
					},
					'429': { $ref: '#/components/responses/RateLimited' },
					'500': { $ref: '#/components/responses/InternalError' }
				}
			}
		},

		'/api/v1/milestones/{milestoneId}/cards': {
			post: {
				tags: ['Milestones'],
				summary: 'Put a card into a milestone',
				description:
					'Puts one card into the milestone. A card is in one milestone at most, so a card that is in another is moved into this one and is not refused. ' +
					'Needs edit access to the card\'s board, and the right to change the milestone, and the right to change the milestone the card leaves, if it is in another: until 2026-10-14 it was moved whoever asked. ' +
					'A milestone that belongs to a board takes cards of that board only. ' +
					'An archived card is refused, `Card does not exist or is archived`, as the bulk operation refuses one: until 2026-10-14 it was put in.\n\n' +
					'The same can be done by sending `milestoneId` when updating the card. For several cards at once use the bulk operation.\n\n' +
					'It logs `api:milestone_card_added` on the card\'s board, with its id, naming the milestone it left if it was in another (no `api:milestone_card_removed` is logged for that one). ' +
					'A card already in this milestone is answered 200 as it is, with nothing written, logged or sent; an archived one is still refused. ' +
					'The card\'s board\'s webhooks are sent `milestone.card_added` (item 102); goal membership sends no `card.updated` on any route.',
				operationId: 'addCardToMilestone',
				parameters: [{ $ref: '#/components/parameters/milestoneId' }],
				requestBody: {
					required: true,
					content: {
						'application/json': {
							schema: {
								type: 'object',
								required: ['cardId'],
								properties: {
									cardId: { type: 'integer', minimum: 1, description: 'The card to put into the milestone' }
								}
							},
							example: { cardId: 1686 }
						}
					}
				},
				responses: {
					'200': {
						description: 'The card is in the milestone',
						content: {
							'application/json': {
								schema: { $ref: '#/components/schemas/CardMilestoneChange' },
								example: { cardId: 1686, milestoneId: 17, boardId: 1 }
							}
						}
					},
					'400': {
						description:
							'No cardId, one that is not an id (`cardId must be an id`), a milestone that belongs to one board and a card that is on another, an archived card (`Card does not exist or is archived`), milestoneId is not a whole number of 1 or more, ' +
							'or a body that is missing, is not valid JSON or is not an object. Nothing was written.',
						content: {
							'application/json': {
								schema: { $ref: '#/components/schemas/Error' },
								example: { message: 'That milestone belongs to a single board. Make it cross-board first, or move the card.' }
							}
						}
					},
					'401': { $ref: '#/components/responses/Unauthorized' },
					'403': {
						description: 'No edit access to the card\'s board, or the key\'s user cannot see or cannot change this milestone, or the one the card is in. Nothing was written.',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'No edit access to this card\'s board' } } }
					},
					'404': {
						description: 'There is no such card, or no such milestone',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'Card not found' } } }
					},
					'413': { $ref: '#/components/responses/PayloadTooLarge' },
					'429': { $ref: '#/components/responses/RateLimited' },
					'500': { $ref: '#/components/responses/InternalError' }
				}
			},
			delete: {
				tags: ['Milestones'],
				summary: 'Take a card out of a milestone',
				description:
					'Leaves one card with no milestone. The card is not changed in any other way. Needs the right to change this milestone, and edit access to the card\'s board.\n\n' +
					'The card must be in this milestone: a card in another, or in none, is 404 `Card is not in this milestone`. Until 2026-10-14 a card in another milestone was taken out of that one, ' +
					'and a card in none was answered as a success. The same rule holds for `milestoneId: null` on PUT /cards/{cardId}: taking a card out needs the right to change the milestone it is in.\n\n' +
					'It logs `api:milestone_card_removed` on the card\'s board, with its id, and the board\'s webhooks are sent `milestone.card_removed` (item 102).',
				operationId: 'removeCardFromMilestone',
				parameters: [{ $ref: '#/components/parameters/milestoneId' }],
				requestBody: {
					required: true,
					content: {
						'application/json': {
							schema: {
								type: 'object',
								required: ['cardId'],
								properties: {
									cardId: { type: 'integer', minimum: 1, description: 'The card to take out' }
								}
							},
							example: { cardId: 1686 }
						}
					}
				},
				responses: {
					'200': {
						description: 'The card has no milestone',
						content: {
							'application/json': {
								schema: { $ref: '#/components/schemas/CardMilestoneChange' },
								example: { cardId: 1686, milestoneId: null, boardId: 1 }
							}
						}
					},
					'400': {
						description: 'No cardId, one that is not an id (`cardId must be an id`), milestoneId is not a whole number of 1 or more, or a body that is missing, is not valid JSON or is not an object. Nothing was written.',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'cardId is required' } } }
					},
					'401': { $ref: '#/components/responses/Unauthorized' },
					'403': {
						description: 'The key\'s user cannot see this milestone (`No access to this milestone`, as for one with cards on a board they cannot open) or cannot change it (`No edit access to this milestone`), or has no edit access to the card\'s board. Nothing was written.',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'No edit access to this milestone' } } }
					},
					'404': {
						description: 'There is no such milestone, or no such card, or the card is not in this milestone (`Card is not in this milestone`). Nothing was written.',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'Card not found' } } }
					},
					'413': { $ref: '#/components/responses/PayloadTooLarge' },
					'429': { $ref: '#/components/responses/RateLimited' },
					'500': { $ref: '#/components/responses/InternalError' }
				}
			}
		},

		'/api/v1/milestones/{milestoneId}/cards/bulk': {
			post: {
				tags: ['Milestones'],
				summary: 'Put many cards into a milestone',
				description:
					'Puts up to 500 cards into the milestone in one request. Needs the right to change the milestone, and edit access to the board of every card. ' +
					'A milestone that belongs to a board takes cards of that board only.\n\n' +
					'**All or nothing.** Every card is checked before any is attached. If one is refused none is attached, the cards that were acceptable included, ' +
					'and the answer is a 409 that lists every card at fault. A card that does not exist, and a card on a board the key\'s user cannot edit, are reasons in that 409 and not a 404 or a 403. ' +
					'An archived card is refused, here as by the single-card operation.\n\n' +
					'A card that is already in the milestone is not a fault: it is skipped and counted, so the same batch can be sent twice. ' +
					'A card that is in another milestone is moved, and the answer names each one that was. Moving it takes it out of that milestone, so it needs the right to change that one too: ' +
					'a card in one the key\'s user cannot change is a reason in the 409, `No edit access to milestone #<id>, which holds card #<n>`. An id sent twice is counted once.\n\n' +
					'When the batch puts the first cards into a milestone that had none, and email is set up, the people assigned to those cards and the administrators are told by email that a plan was created. ' +
					'A failure to send it changes neither the cards nor the answer. This operation alone sends that mail: a card put in one at a time, here or in the web application, sends none.\n\n' +
					'Each card put in logs `api:milestone_card_added` on its board, with its id, one moved naming the milestone it left, and its board\'s webhooks are sent one `milestone.card_added` for it (item 102); a card skipped logs and sends nothing.',
				operationId: 'addCardsToMilestone',
				parameters: [{ $ref: '#/components/parameters/milestoneId' }],
				requestBody: {
					required: true,
					content: {
						'application/json': {
							schema: {
								type: 'object',
								required: ['cardIds'],
								properties: {
									cardIds: { type: 'array', items: { type: 'integer' }, minItems: 1, maxItems: 500, description: 'The cards to put into the milestone' }
								}
							},
							example: { cardIds: [1686, 1559, 1444] }
						}
					}
				},
				responses: {
					'200': {
						description: 'Every card of the batch is in the milestone',
						content: {
							'application/json': {
								schema: { $ref: '#/components/schemas/MilestoneCardsAttached' },
								example: {
									milestoneId: 17,
									attached: 3,
									skippedAlreadyIn: 0,
									movedFromOtherGoal: [{ cardId: 1444, title: 'Rotate the signing keys', fromMilestoneId: 12 }],
									boardsTouched: [1, 4]
								}
							}
						}
					},
					'400': {
						description:
							'cardIds is not an array, is empty, has more than 500 entries or has an entry that is not an id (`cardIds[<n>] must be an id`, where null was read as card 0); milestoneId is not a whole number of 1 or more; ' +
							'or the body is missing, is not valid JSON or is not an object. Nothing was written.',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'cardIds must be an array of card ids' } } }
					},
					'401': { $ref: '#/components/responses/Unauthorized' },
					'403': {
						description: 'The key\'s user cannot see or cannot change this milestone. Nothing was written.',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'No edit access to this milestone' } } }
					},
					'404': {
						description: 'There is no such milestone',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'Milestone not found' } } }
					},
					'409': {
						description: 'At least one card cannot be put into the milestone. No card was attached, and every card at fault is listed with the reason.',
						content: {
							'application/json': {
								schema: { $ref: '#/components/schemas/MilestoneCardsRejected' },
								example: {
									message: 'Batch rejected — nothing was written',
									attached: 0,
									problems: [{ cardId: 1444, reason: 'Card does not exist or is archived' }],
									wouldAttach: 2,
									wouldSkipAlreadyIn: 0
								}
							}
						}
					},
					'413': { $ref: '#/components/responses/PayloadTooLarge' },
					'429': { $ref: '#/components/responses/RateLimited' },
					'500': { $ref: '#/components/responses/InternalError' }
				}
			},
			delete: {
				tags: ['Milestones'],
				summary: 'Take many cards out of a milestone',
				description:
					'Leaves up to 500 cards with no milestone in one request. The cards are not changed in any other way. ' +
					'Needs the right to change the milestone, and edit access to the board of every card.\n\n' +
					'**All or nothing.** Every card is checked before any is taken out. If one is refused none is taken out, and the answer is a 409 that lists every card at fault: ' +
					'one that does not exist (`Card not found`), and one on a board the key\'s user cannot edit (`No edit access to the board holding card #<id>`), an archived one included.\n\n' +
					'**An archived card is taken out**, as DELETE /api/v1/milestones/{milestoneId}/cards and milestoneId null on PUT /api/v1/cards/{cardId} take it out: an archived card keeps its milestone, ' +
					'and still holds the milestone to its board. Until 2026-10-14 it was a fault, `Card does not exist or is archived`, and the whole batch was refused (item 92). ' +
					'A milestone whose only cards were archived can now be emptied, and the next POST …/cards/bulk to it then sends the plan-created mail.\n\n' +
					'A card that is not in this milestone, archived or not, is not a fault: it is skipped and counted, and stays in whatever milestone it is in.\n\n' +
					'Each card taken out logs `api:milestone_card_removed` on its board, with its id, its board\'s webhooks are sent one `milestone.card_removed` for it (item 102), and its board is sent a live update; a card skipped logs and sends nothing.',
				operationId: 'removeCardsFromMilestone',
				parameters: [{ $ref: '#/components/parameters/milestoneId' }],
				requestBody: {
					required: true,
					content: {
						'application/json': {
							schema: {
								type: 'object',
								required: ['cardIds'],
								properties: {
									cardIds: { type: 'array', items: { type: 'integer' }, minItems: 1, maxItems: 500, description: 'The cards to take out of the milestone' }
								}
							},
							example: { cardIds: [1686, 1559, 1444] }
						}
					}
				},
				responses: {
					'200': {
						description: 'Every card listed that was in the milestone is in none now',
						content: {
							'application/json': {
								schema: { $ref: '#/components/schemas/MilestoneCardsDetached' },
								example: { milestoneId: 17, detached: 2, skippedNotInMilestone: 1, boardsTouched: [1] }
							}
						}
					},
					'400': {
						description:
							'cardIds is not an array, is empty, has more than 500 entries or has an entry that is not an id (`cardIds[<n>] must be an id`, where null was read as card 0); milestoneId is not a whole number of 1 or more; ' +
							'or the body is missing, is not valid JSON or is not an object. Nothing was written.',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'cardIds must be an array of card ids' } } }
					},
					'401': { $ref: '#/components/responses/Unauthorized' },
					'403': {
						description: 'The key\'s user cannot see or cannot change this milestone. Nothing was written.',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'No edit access to this milestone' } } }
					},
					'404': {
						description: 'There is no such milestone',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'Milestone not found' } } }
					},
					'409': {
						description:
							'At least one card cannot be taken out: it does not exist (`Card not found`; until 2026-10-14 `Card does not exist or is archived`, which an archived card was given too), ' +
							'or it is on a board the key\'s user cannot edit, archived or not. No card was detached, and every card at fault is listed with the reason, by its id and with no title.',
						content: {
							'application/json': {
								schema: { $ref: '#/components/schemas/MilestoneCardsDetachRejected' },
								example: {
									message: 'Batch rejected — nothing was written',
									detached: 0,
									problems: [{ cardId: 1444, reason: 'No edit access to the board holding card #1444' }]
								}
							}
						}
					},
					'413': { $ref: '#/components/responses/PayloadTooLarge' },
					'429': { $ref: '#/components/responses/RateLimited' },
					'500': { $ref: '#/components/responses/InternalError' }
				}
			}
		},

		'/api/v1/milestones/{milestoneId}/summary': {
			get: {
				tags: ['Milestones'],
				summary: 'Get a milestone\'s plan',
				description:
					'The whole plan of a milestone in one answer, which is what to ask for when the question is what to work on next: how far the milestone has got, ' +
					'the order its work must be done in, the critical path, what can be started now and what is waiting, and on what. ' +
					'It is worked out from the dependency links between the milestone\'s cards and their subtasks. Work outside the milestone that something in it waits on is shown too, marked `external`.\n\n' +
					'`compact=true` leaves out `graph`, which is the bulk of the answer and is needed only to draw the plan, and gives `cardTitles` and `subtaskTitles` in its place.',
				operationId: 'getMilestoneSummary',
				parameters: [
					{ $ref: '#/components/parameters/milestoneId' },
					{
						name: 'compact',
						in: 'query',
						schema: { type: 'boolean', default: false },
						description: 'true leaves out `graph` and adds `cardTitles` and `subtaskTitles`. Anything but the text true is read as false.'
					}
				],
				responses: {
					'200': {
						description: 'The milestone\'s plan',
						content: {
							'application/json': { schema: { $ref: '#/components/schemas/MilestoneSummary' } }
						}
					},
					'400': {
						description: 'milestoneId is not a whole number of 1 or more',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'Invalid milestone ID' } } }
					},
					'401': { $ref: '#/components/responses/Unauthorized' },
					'403': {
						description: 'The key\'s user cannot see this milestone',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'No access to this milestone' } } }
					},
					'404': {
						description: 'There is no such milestone',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'Milestone not found' } } }
					},
					'429': { $ref: '#/components/responses/RateLimited' },
					'500': { $ref: '#/components/responses/InternalError' }
				}
			}
		},

		'/api/v1/milestones/{milestoneId}/pdf': {
			get: {
				tags: ['Milestones'],
				summary: 'Get a milestone\'s plan as a PDF',
				description:
					'The milestone\'s plan as a PDF file: the document the planning view\'s download button produces, made from the same summary. ' +
					'The answer is the file itself and not JSON, sent as a download named plan-<name>-<date>.pdf. A failure is answered as JSON, as everywhere else.',
				operationId: 'getMilestonePdf',
				parameters: [{ $ref: '#/components/parameters/milestoneId' }],
				responses: {
					'200': {
						description: 'The PDF file',
						headers: {
							'Content-Disposition': {
								description: 'attachment, with the file name: plan-<the milestone\'s name>-<today, YYYY-MM-DD>.pdf',
								schema: { type: 'string' }
							}
						},
						content: {
							'application/pdf': { schema: { type: 'string', format: 'binary' } }
						}
					},
					'400': {
						description: 'milestoneId is not a whole number of 1 or more',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'Invalid milestone ID' } } }
					},
					'401': { $ref: '#/components/responses/Unauthorized' },
					'403': {
						description: 'The key\'s user cannot see this milestone',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'No access to this milestone' } } }
					},
					'404': {
						description: 'There is no such milestone',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'Milestone not found' } } }
					},
					'429': { $ref: '#/components/responses/RateLimited' },
					'500': { $ref: '#/components/responses/InternalError' }
				}
			}
		},

		// ─── Tokens ─────────────────────────────────────────────────────────
		'/api/v1/cards/{cardId}/tokens': {
			get: {
				tags: ['Tokens'],
				summary: 'Get what a card has cost',
				description:
					'Returns what the card has cost in tokens so far, the entries on its subtasks counted in, with every entry behind the figure. ' +
					'A card nobody has reported on is answered with `recorded` false and `entries` 0. That means not recorded, which is not a cost of zero: show it as unknown.',
				operationId: 'getCardTokens',
				parameters: [{ $ref: '#/components/parameters/cardId' }],
				responses: {
					'200': {
						description: 'The card\'s totals and entries',
						content: {
							'application/json': {
								schema: { $ref: '#/components/schemas/CardTokens' },
								example: {
									cardId: 1713,
									recorded: true,
									total: 62000,
									direct: 52900,
									fromSubtasks: 9100,
									entries: 2,
									byModel: [
										{ model: 'claude-opus-5', tokens: 52900 },
										{ model: 'claude-sonnet-5', tokens: 9100 }
									],
									costUsd: 0.09548,
									costExact: false,
									unpricedTokens: 0,
									apiCalls: null,
									entryList: [
										{
											id: 312,
											cardId: null,
											subtaskId: 3471,
											subtaskTitle: 'Verify on UAT',
											tokens: 9100,
											model: 'claude-sonnet-5',
											inputTokens: null,
											outputTokens: null,
											cacheReadTokens: null,
											cacheWrite5mTokens: null,
											cacheWrite1hTokens: null,
											apiCalls: null,
											note: 'verification',
											createdAt: '2026-10-13T10:02:31.000Z'
										},
										{
											id: 311,
											cardId: 1713,
											subtaskId: null,
											subtaskTitle: null,
											tokens: 52900,
											model: 'claude-opus-5',
											inputTokens: 1200,
											outputTokens: 900,
											cacheReadTokens: 48000,
											cacheWrite5mTokens: 2800,
											cacheWrite1hTokens: 0,
											apiCalls: 14,
											note: 'applied the fix',
											createdAt: '2026-10-13T09:41:07.000Z'
										}
									]
								}
							}
						}
					},
					'400': {
						description: 'cardId is not a whole number of 1 or more',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'Invalid card ID' } } }
					},
					'401': { $ref: '#/components/responses/Unauthorized' },
					'403': {
						description: 'No access to the board the card is on',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'No access to this board' } } }
					},
					'404': { $ref: '#/components/responses/NotFound' },
					'429': { $ref: '#/components/responses/RateLimited' },
					'500': { $ref: '#/components/responses/InternalError' }
				}
			},
			post: {
				tags: ['Tokens'],
				summary: 'Add to what a card has cost',
				description:
					'Adds one entry to the card\'s record of what it cost. It adds and never replaces: report as the work goes and the total climbs, ' +
					'and two callers on the same card can each report their own without knowing what the other spent. ' +
					'To correct an over-report send a negative `tokens`, which leaves the first entry to be seen; when the entries it corrects were measured, send the breakdown of what is taken back. ' +
					'Sending the same request twice adds the tokens twice.\n\n' +
					'**A correction takes back no more than was recorded**, on the card\'s own entries (not its subtasks\') of the same `model`. One with no breakdown takes back at most the tokens recorded ' +
					'without one, and one with a breakdown no part beyond what is recorded of it; otherwise it is answered 400, naming what may be taken back, and nothing is written. ' +
					'A correction sent as a bare total is priced at full input rates, and measured work is mostly cache reads at a tenth of that or less, so taking it from measured work priced the card below zero.\n\n' +
					'**The breakdown.** `inputTokens`, `outputTokens` and the three cache fields say what the tokens were. They are priced very differently, so the cost is exact only with them. ' +
					'If any of the five is sent, `inputTokens` and `outputTokens` must both be, and those sent must add up to `tokens`: a cache field left out counts as 0. ' +
					'For a negative entry they are sent as positive numbers that add up to its size.\n\n' +
					'**Limits.** `tokens` is a whole number and not 0, sent as a number and not as text, and 10,000,000,000 at most either way. ' +
					'With `apiCalls`, no more than 1,200,000 tokens to a call: more means a running total was sent, and it is refused.\n\n' +
					'Needs edit access to the card\'s board. An archived card can still be reported on. The body is checked before the card is looked for, ' +
					'so a body at fault sent to a card that does not exist is answered 400.',
				operationId: 'addCardTokens',
				parameters: [{ $ref: '#/components/parameters/cardId' }],
				requestBody: {
					required: true,
					content: {
						'application/json': {
							schema: {
								type: 'object',
								required: ['tokens'],
								properties: {
									tokens: { type: 'integer', format: 'int64', description: 'How many tokens this entry adds. Negative to correct an earlier entry. Not 0.' },
									model: { type: 'string', maxLength: 80, description: 'The model that spent them, by its id. Without it the entry cannot be priced.' },
									note: { type: 'string', maxLength: 500, description: 'What the entry covers' },
									apiCalls: { type: 'integer', minimum: 0, description: 'How many calls of the model the entry covers' },
									inputTokens: { type: 'integer', format: 'int64', minimum: 0, description: 'Of the tokens, fresh input' },
									outputTokens: { type: 'integer', format: 'int64', minimum: 0, description: 'Of the tokens, output' },
									cacheReadTokens: { type: 'integer', format: 'int64', minimum: 0, description: 'Of the tokens, read from the cache' },
									cacheWrite5mTokens: { type: 'integer', format: 'int64', minimum: 0, description: 'Of the tokens, written to the 5-minute cache' },
									cacheWrite1hTokens: { type: 'integer', format: 'int64', minimum: 0, description: 'Of the tokens, written to the 1-hour cache' }
								}
							},
							example: {
								tokens: 52900,
								model: 'claude-opus-5',
								note: 'applied the fix',
								apiCalls: 14,
								inputTokens: 1200,
								outputTokens: 900,
								cacheReadTokens: 48000,
								cacheWrite5mTokens: 2800,
								cacheWrite1hTokens: 0
							}
						}
					}
				},
				responses: {
					'201': {
						description: 'The entry is recorded. Its id, and the card\'s totals with it counted.',
						content: {
							'application/json': {
								schema: { $ref: '#/components/schemas/TokenRecorded' },
								example: {
									entryId: 311,
									cardId: 1713,
									recorded: true,
									total: 52900,
									direct: 52900,
									fromSubtasks: 0,
									entries: 1,
									byModel: [{ model: 'claude-opus-5', tokens: 52900 }],
									costUsd: 0.07,
									costExact: true,
									unpricedTokens: 0,
									apiCalls: 14
								}
							}
						}
					},
					'400': {
						description:
							'`tokens` is missing, is not a number, is not whole, is 0 or is beyond a limit; `model` or `note` is not text or is too long; `apiCalls` or a field of the breakdown is not a whole number or is negative; ' +
							'the breakdown lacks `inputTokens` or `outputTokens`, or does not add up to `tokens`; a correction takes back more than is recorded on the card for its model, without a breakdown more than ' +
							'was recorded without one or with one more of a part than is recorded of it; cardId is not a whole number of 1 or more; or the body is missing, is not valid JSON or is not an object. Nothing was written.',
						content: {
							'application/json': {
								schema: { $ref: '#/components/schemas/Error' },
								example: { message: 'The breakdown sums to 50100 but tokens is 52900. Every component must be included and they must add up.' }
							}
						}
					},
					'401': { $ref: '#/components/responses/Unauthorized' },
					'403': {
						description: 'No edit access to the card\'s board. Nothing was written.',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'No edit access to the board holding card #1713' } } }
					},
					'404': {
						description: 'There is no such card',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'Card #1713 does not exist' } } }
					},
					'413': { $ref: '#/components/responses/PayloadTooLarge' },
					'429': { $ref: '#/components/responses/RateLimited' },
					'500': { $ref: '#/components/responses/InternalError' }
				}
			}
		},

		'/api/v1/subtasks/{subtaskId}/tokens': {
			post: {
				tags: ['Tokens'],
				summary: 'Add to what a subtask has cost',
				description:
					'Adds one entry to what a subtask cost. A subtask is one step of a card, so this is where to report a step as it is ticked off. ' +
					'An entry on a subtask counts towards its card, so a card whose work is all in subtasks needs no entry of its own. ' +
					'The answer gives the card\'s total, not the subtask\'s.\n\n' +
					'The body, its breakdown, its limits and its refusals are those of an entry added to a card. Needs edit access to the board the subtask\'s card is on.',
				operationId: 'addSubtaskTokens',
				parameters: [{ $ref: '#/components/parameters/subtaskId' }],
				requestBody: {
					required: true,
					content: {
						'application/json': {
							schema: {
								type: 'object',
								required: ['tokens'],
								properties: {
									tokens: { type: 'integer', format: 'int64', description: 'How many tokens this entry adds. Negative to correct an earlier entry. Not 0.' },
									model: { type: 'string', maxLength: 80, description: 'The model that spent them, by its id. Without it the entry cannot be priced.' },
									note: { type: 'string', maxLength: 500, description: 'What the entry covers' },
									apiCalls: { type: 'integer', minimum: 0, description: 'How many calls of the model the entry covers' },
									inputTokens: { type: 'integer', format: 'int64', minimum: 0, description: 'Of the tokens, fresh input' },
									outputTokens: { type: 'integer', format: 'int64', minimum: 0, description: 'Of the tokens, output' },
									cacheReadTokens: { type: 'integer', format: 'int64', minimum: 0, description: 'Of the tokens, read from the cache' },
									cacheWrite5mTokens: { type: 'integer', format: 'int64', minimum: 0, description: 'Of the tokens, written to the 5-minute cache' },
									cacheWrite1hTokens: { type: 'integer', format: 'int64', minimum: 0, description: 'Of the tokens, written to the 1-hour cache' }
								}
							},
							example: { tokens: 9100, model: 'claude-sonnet-5', note: 'verification' }
						}
					}
				},
				responses: {
					'201': {
						description: 'The entry is recorded',
						content: {
							'application/json': {
								schema: {
									type: 'object',
									properties: {
										entryId: { type: 'integer', description: 'Id of the new entry: what DELETE /api/v1/tokens/{entryId} takes' },
										subtaskId: { type: 'integer' },
										cardId: { type: 'integer', description: 'The card the subtask belongs to' },
										cardTotal: {
											type: 'integer',
											format: 'int64',
											description: 'That card\'s total now, this entry and those of its other subtasks included'
										},
										recorded: { type: 'boolean' },
										entries: { type: 'integer', description: 'How many entries make up the card\'s total' }
									},
									required: ['entryId', 'subtaskId', 'cardId', 'cardTotal', 'recorded', 'entries']
								},
								example: { entryId: 312, subtaskId: 3471, cardId: 1713, cardTotal: 62000, recorded: true, entries: 2 }
							}
						}
					},
					'400': {
						description:
							'As for an entry added to a card: `tokens`, `model`, `note`, `apiCalls` or the breakdown is at fault, a correction takes back more than is recorded on the subtask for its model, ' +
							'subtaskId is not a whole number of 1 or more, ' +
							'or the body is missing, is not valid JSON or is not an object. Nothing was written.',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'tokens must not be zero — omit the call instead' } } }
					},
					'401': { $ref: '#/components/responses/Unauthorized' },
					'403': {
						description: 'No edit access to the board the subtask\'s card is on. Nothing was written.',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'No edit access to the board holding subtask #3471' } } }
					},
					'404': {
						description: 'There is no such subtask',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'Subtask #3471 does not exist' } } }
					},
					'413': { $ref: '#/components/responses/PayloadTooLarge' },
					'429': { $ref: '#/components/responses/RateLimited' },
					'500': { $ref: '#/components/responses/InternalError' }
				}
			}
		},

		'/api/v1/tokens/{entryId}': {
			delete: {
				tags: ['Tokens'],
				summary: 'Delete a token entry',
				description:
					'Removes one entry outright, as if it had never been made. It is for an entry that should not exist, one reported against the wrong card for instance. ' +
					'For an over-report a negative entry is the better correction, because it leaves the first to be seen. ' +
					'An entry is refused only when removing it would take what is recorded of its model on its card or subtask below zero, as removing it before the negative entries that correct it would. ' +
					'Needs edit access to the board of the card the entry counts towards. The answer gives that card\'s totals without the entry.',
				operationId: 'deleteTokenEntry',
				parameters: [{ $ref: '#/components/parameters/entryId' }],
				responses: {
					'200': {
						description: 'The entry is removed',
						content: {
							'application/json': {
								schema: { $ref: '#/components/schemas/TokenEntryDeleted' },
								example: {
									deleted: 312,
									cardId: 1713,
									recorded: true,
									total: 52900,
									direct: 52900,
									fromSubtasks: 0,
									entries: 1,
									byModel: [{ model: 'claude-opus-5', tokens: 52900 }],
									costUsd: 0.07,
									costExact: true,
									unpricedTokens: 0,
									apiCalls: 14
								}
							}
						}
					},
					'400': {
						description:
							'entryId is not a whole number of 1 or more, or removing the entry would take what is recorded of its model on its card or subtask below zero, as it would before the negative entries that correct it are removed. Nothing was removed.',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'Invalid entry ID' } } }
					},
					'401': { $ref: '#/components/responses/Unauthorized' },
					'403': {
						description: 'No edit access to the board of the card the entry counts towards. Nothing was removed.',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'No edit access to the board holding card #1713' } } }
					},
					'404': {
						description: 'There is no such entry',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'Token entry #312 does not exist' } } }
					},
					'429': { $ref: '#/components/responses/RateLimited' },
					'500': { $ref: '#/components/responses/InternalError' }
				}
			}
		},

		'/api/v1/tokens/bulk': {
			post: {
				tags: ['Tokens'],
				summary: 'Add many token entries',
				description:
					'Records up to 200 entries in one request, each on a card or on a subtask: an entry names exactly one of `cardId` and `subtaskId`, and is otherwise the body of a single entry. ' +
					'A card\'s whole cost, step by step, is then one request and not one for each subtask.\n\n' +
					'**All or nothing.** Every entry is checked before any is written. If one is refused none is written, the entries that were acceptable included, ' +
					'and the answer is a 409 that lists every entry at fault by its place in the list. A card or subtask that does not exist, and one on a board the key\'s user cannot edit, ' +
					'are reasons in that 409: this operation answers no 404 and no 403. A correction is held to what is recorded and to the entries before it in the batch, ' +
					'so +10000 then -10000 on a new card is written, and an over-correction is a reason in the 409.\n\n' +
					'**Not safe to send twice.** Entries add up, so the same batch sent again adds the tokens again. Report each step once.',
				operationId: 'addTokenEntries',
				requestBody: {
					required: true,
					content: {
						'application/json': {
							schema: {
								type: 'object',
								required: ['entries'],
								properties: {
									entries: {
										type: 'array',
										minItems: 1,
										maxItems: 200,
										items: {
											type: 'object',
											description: 'Exactly one of `cardId` and `subtaskId`, and `tokens`. The rest are as for a single entry.',
											required: ['tokens'],
											properties: {
												cardId: { type: 'integer', description: 'The card the entry is on' },
												subtaskId: { type: 'integer', description: 'The subtask the entry is on' },
												tokens: { type: 'integer', format: 'int64', description: 'How many tokens this entry adds. Negative to correct an earlier entry. Not 0.' },
												model: { type: 'string', maxLength: 80 },
												note: { type: 'string', maxLength: 500 },
												apiCalls: { type: 'integer', minimum: 0 },
												inputTokens: { type: 'integer', format: 'int64', minimum: 0 },
												outputTokens: { type: 'integer', format: 'int64', minimum: 0 },
												cacheReadTokens: { type: 'integer', format: 'int64', minimum: 0 },
												cacheWrite5mTokens: { type: 'integer', format: 'int64', minimum: 0 },
												cacheWrite1hTokens: { type: 'integer', format: 'int64', minimum: 0 }
											}
										}
									}
								}
							},
							example: {
								entries: [
									{ cardId: 1713, tokens: 18400, model: 'claude-opus-5', note: 'planning' },
									{ subtaskId: 3471, tokens: 9100, model: 'claude-sonnet-5' }
								]
							}
						}
					}
				},
				responses: {
					'201': {
						description: 'Every entry of the batch is recorded',
						content: {
							'application/json': {
								schema: { $ref: '#/components/schemas/TokenBatchRecorded' },
								example: { written: 2, boardsTouched: [1], cardTotals: [{ cardId: 1713, total: 27500, entries: 2 }] }
							}
						}
					},
					'400': {
						description: '`entries` is not an array, is empty, has more than 200 entries or has an entry that is not an object (`entries[<n>] must be an object`, which was a 500), or the body is missing, is not valid JSON or is not an object. Nothing was written.',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'entries must be an array' } } }
					},
					'401': { $ref: '#/components/responses/Unauthorized' },
					'409': {
						description: 'At least one entry cannot be recorded. No entry was written, and every entry at fault is listed with the reason.',
						content: {
							'application/json': {
								schema: { $ref: '#/components/schemas/TokenBatchRejected' },
								example: {
									message: 'Batch rejected — nothing was written',
									written: 0,
									problems: [{ index: 1, reason: 'Subtask #3471 does not exist' }]
								}
							}
						}
					},
					'413': { $ref: '#/components/responses/PayloadTooLarge' },
					'429': { $ref: '#/components/responses/RateLimited' },
					'500': { $ref: '#/components/responses/InternalError' }
				}
			}
		},

		// ─── Reports ────────────────────────────────────────────────────────
		'/api/v1/reports/activity': {
			get: {
				tags: ['Reports'],
				summary: 'Get an activity report',
				description:
					'Everything a management report of a period needs, in one answer: the cards that were completed, closed with nothing built, moved on, put on hold or raised in the window, ' +
					'board by board, each with its reporting fields, and the milestones that moved. With no parameters it is the last 30 days, for everyone, on every board the key\'s user can see.\n\n' +
					'A card is completed in the window by its own completion date, not by the activity log. Only the boards the key\'s user can open are read, and a board named in boardIds that they cannot open is refused: ' +
					'until 2026-10-20 the others were read and left out, and `meta.boardsExcludedForAccess` said how many had activity, which told any reader when a board they could not open was worked on. It is always 0 now (item 80). ' +
					'A report on one user holds the cards that user logged an action on or commented on in the window, raised, or is assigned to now. ' +
					'A dependency added or removed is not counted as an action on a card, for the window or for a user: until 2026-10-14 the entries the API wrote for one were. ' +
					'Anyone may ask for their own or for everyone\'s; a report on another user needs an administrator.',
				operationId: 'getActivityReport',
				parameters: [
					{
						name: 'userId',
						in: 'query',
						schema: { type: 'integer', minimum: 1 },
						description: 'Report on this user\'s activity. Left out, the report is on everyone\'s.'
					},
					{
						name: 'from',
						in: 'query',
						schema: { type: 'string' },
						description:
							'Start of the window, UTC: a date as YYYY-MM-DD, which is from the start of that day, a full ISO time, or YYYY-MM-DD HH:MM:SS in UTC; a time with an offset, or with no zone, is read in UTC. ' +
							'Default: 30 days before now. Anything else is 400 `from is not a date`: until 2026-10-14 it was not checked, and YYYY-MM-DD HH:MM:SS was refused (item 54).'
					},
					{
						name: 'to',
						in: 'query',
						schema: { type: 'string' },
						description:
							'End of the window, UTC: a date as YYYY-MM-DD, which is to the end of that day, 23:59:59, or a time, read as `from` is. Default: now. Anything else is 400 `to is not a date`.'
					},
					{
						name: 'boardIds',
						in: 'query',
						schema: { type: 'string' },
						description:
							'Comma-separated board ids, to report on those boards only. Left out, every board the key\'s user can see. Each is an id: one that is not is 400, where it was left out. ' +
							'Each is then checked in the order given, administrators included: one that does not exist is 404 `Board 7 not found`, and one the key\'s user cannot open is 403 `No access to board 7`, as GET /api/v1/burndown answers. ' +
							'Until 2026-10-20 both were answered 200 with nothing of the board, so a saved list that holds a deleted board now fails (item 80).'
					},
					{
						name: 'include',
						in: 'query',
						schema: { type: 'string' },
						description: 'More about each card: subtasks, comments, or both as subtasks,comments. Left out, a card has its subtask counts and neither list.'
					},
					{
						name: 'commentLimit',
						in: 'query',
						schema: { type: 'integer', default: 3, minimum: 0, maximum: 20 },
						description:
							'With include=comments, how many of each card\'s most recent comments: a whole number. More than 20 is read as 20, and 0 gives each card an empty `comments` list. ' +
							'A negative number, or one that is not whole, is 400. Until 2026-10-14 0 was read as 3, and a negative number left the key out.'
					}
				],
				responses: {
					'200': {
						description: 'The report',
						content: {
							'application/json': { schema: { $ref: '#/components/schemas/ActivityReport' } }
						}
					},
					'400': {
						description: 'userId is not a whole number of 1 or more, from or to is not a date or a timestamp, from is after to, boardIds holds no id or an entry that is not one, or commentLimit is negative or not whole',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: '`from` is after `to`' } } }
					},
					'401': { $ref: '#/components/responses/Unauthorized' },
					'403': {
						description:
							'userId is another user, and the key\'s user is not an administrator; or a board named in boardIds the key\'s user cannot open (`No access to board 7`). ' +
							'Until 2026-10-20 such a board was answered 200 (item 80).',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'Only an admin can report on another user' } } }
					},
					'404': {
						description: 'A board named in boardIds does not exist (`Board 7 not found`), whoever asks. Until 2026-10-20 it was answered 200 (item 80).',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'Board 7 not found' } } }
					},
					'429': { $ref: '#/components/responses/RateLimited' },
					'500': { $ref: '#/components/responses/InternalError' }
				}
			}
		},

		'/api/v1/cards/{cardId}/board-history': {
			get: {
				tags: ['Reports'],
				summary: 'Get the boards a card has been on',
				description:
					'Returns which board the card was on and when, oldest first, read back from the moves the activity log records. ' +
					'A card that changes board appears in the audit log under both boards, and this is what says which it was on at the time of an entry.\n\n' +
					'Needs view access to the board the card is on now. An earlier board the key\'s user cannot see is still listed, with its id and dates, and with "Board not visible to you" for its name.',
				operationId: 'getCardBoardHistory',
				parameters: [{ $ref: '#/components/parameters/cardId' }],
				responses: {
					'200': {
						description: 'The card\'s stays on boards',
						content: {
							'application/json': {
								schema: { $ref: '#/components/schemas/CardBoardHistory' },
								example: {
									cardId: 1713,
									history: [
										{ boardId: 4, boardName: 'Backlog', from: '2026-09-02T11:20:45.000Z', to: '2026-09-18T14:03:10.000Z', current: false },
										{ boardId: 1, boardName: 'Sprint 43', from: '2026-09-18T14:03:10.000Z', to: null, current: true }
									]
								}
							}
						}
					},
					'400': {
						description: 'cardId is not a whole number',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'Invalid card ID' } } }
					},
					'401': { $ref: '#/components/responses/Unauthorized' },
					'403': {
						description: 'No access to the board the card is on now',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message: 'No access to this card\'s board' } } }
					},
					'404': { $ref: '#/components/responses/NotFound' },
					'429': { $ref: '#/components/responses/RateLimited' },
					'500': { $ref: '#/components/responses/InternalError' }
				}
			}
		},

		// ─── This document ──────────────────────────────────────────────────
		'/api/v1/openapi.json': {
			get: {
				tags: ['OpenAPI'],
				summary: 'Get this document',
				description:
					'Returns the OpenAPI 3.1 description of this API, which is this document and what the /docs page is drawn from. ' +
					'It is the one operation that needs no key: it is answered without an Authorization header, is counted against no rate limit, and so is never answered 401 or 429. ' +
					'It may be read from a page of any origin, and may be kept for ten seconds by whatever fetches it.',
				operationId: 'getOpenApiDocument',
				security: [],
				responses: {
					'200': {
						description: 'The document',
						headers: {
							'Cache-Control': { description: 'public, max-age=10', schema: { type: 'string' } },
							'Access-Control-Allow-Origin': { description: '*', schema: { type: 'string' } }
						},
						content: {
							'application/json': {
								schema: {
									type: 'object',
									description: 'An OpenAPI 3.1 document',
									properties: {
										openapi: { type: 'string', description: 'The version of OpenAPI the document is written in: 3.1.0' },
										info: {
											type: 'object',
											properties: {
												title: { type: 'string' },
												version: { type: 'string', description: 'The version of this document, which changes when what it describes does' },
												description: { type: 'string' },
												contact: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] }
											},
											required: ['title', 'version', 'description', 'contact']
										},
										servers: {
											type: 'array',
											items: { type: 'object', properties: { url: { type: 'string' }, description: { type: 'string' } }, required: ['url', 'description'] }
										},
										security: {
											type: 'array',
											items: { type: 'object', additionalProperties: true },
											description: 'What every operation needs unless it says otherwise: a key'
										},
										components: {
											type: 'object',
											additionalProperties: true,
											description: 'The schemas, parameters and responses the operations refer to, and how a key is sent'
										},
										paths: { type: 'object', additionalProperties: true, description: 'Every operation, by path and method' },
										tags: {
											type: 'array',
											items: { type: 'object', properties: { name: { type: 'string' }, description: { type: 'string' } }, required: ['name', 'description'] },
											description: 'The groups the operations are listed under'
										}
									},
									required: ['openapi', 'info', 'servers', 'security', 'components', 'paths', 'tags']
								}
							}
						}
					},
					'500': { $ref: '#/components/responses/InternalError' }
				}
			}
		}
	},
	tags: [
		{ name: 'User', description: 'Current authenticated user' },
		{ name: 'Boards', description: 'Kanban boards' },
		{ name: 'Columns', description: 'Board columns' },
		{ name: 'Cards', description: 'Task cards on boards' },
		{ name: 'Assignees', description: 'Card user assignments' },
		{ name: 'Subtasks', description: 'Card subtasks / checklist items' },
		{ name: 'Comments', description: 'Card discussion comments' },
		{ name: 'Labels', description: 'Board labels for tagging cards' },
		{ name: 'Card Labels', description: 'Label assignments on cards' },
		{
			name: 'Dependencies',
			description:
				'What a card or a subtask waits on and what waits on it. Either end of a link can be a card or a subtask, on any board. One link at a time from the card or the subtask, or many in one request.'
		},
		{
			name: 'Milestones',
			description:
				'Goals that cards belong to, on one board or across several, and the plan of each: the order of its work, its critical path, what can be started and what is waiting'
		},
		{ name: 'Tokens', description: 'What work cost in tokens, recorded entry by entry on a card or a subtask and added up on the card' },
		{ name: 'Categories', description: 'Card categories (per-board tags for cards)' },
		{ name: 'Board Categories', description: 'Dashboard categories for grouping boards' },
		{ name: 'Webhooks', description: 'Webhook subscriptions for board events' },
		{ name: 'Burndown', description: 'Remaining work over time, with a forecast, for any board, group, milestone or filter' },
		{ name: 'Audit', description: 'Activity audit log' },
		{ name: 'Reports', description: 'The activity report for a period, and which board a card was on when' },
		{ name: 'OpenAPI', description: 'This document, which the /docs page is drawn from. Needs no key.' }
	]
};

/** GET /api/v1/openapi.json — Public OpenAPI 3.1 specification. */
export const GET: RequestHandler = async () => {
	return json(spec, {
		headers: {
			'Cache-Control': 'public, max-age=10',
			'Access-Control-Allow-Origin': '*'
		}
	});
};
