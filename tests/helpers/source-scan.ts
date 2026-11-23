/**
 * Reading a route file's source for its handlers, shared by the tests that
 * pin something to the source: tests/check-at-the-write.test.ts (what a
 * handler does before it reads its body) and tests/gate.test.ts case 8 of
 * card 2700 (which internal handlers read a body other than as JSON).
 *
 * And the lists of service modules and their helper modules, which
 * tests/check-at-the-write.test.ts holds to the service rule and
 * tests/decisions-api.test.ts case 3 reads for the decision services (card
 * 2713, R5): one list, so that the two cannot drift.
 */
import ts from 'typescript';

/**
 * The modules both API trees' handlers call for their work, each written to
 * the rule of tests/check-at-the-write.test.ts. Slice A1: the cards; A2: what is on a card; A3: dependencies,
 * a card's cost and the token writes, milestones; A4: boards, dashboard
 * groupings, columns, card categories and labels.
 */
export const SERVICES: readonly string[] = [
	'src/lib/server/cards.ts',
	'src/lib/server/card-assignees.ts',
	'src/lib/server/card-comments.ts',
	'src/lib/server/card-labels.ts',
	'src/lib/server/subtasks.ts',
	'src/lib/server/work-dependencies.ts',
	'src/lib/server/token-service.ts',
	'src/lib/server/milestone-service.ts',
	'src/lib/server/boards.ts',
	'src/lib/server/board-groupings.ts',
	'src/lib/server/columns.ts',
	'src/lib/server/card-categories.ts',
	'src/lib/server/labels.ts',
	// Card 2337: the card window's files, the web application's alone.
	'src/lib/server/card-attachments.ts',
	// Card 2674: the people directory and its groups, an administrator's.
	'src/lib/server/people.ts',
	// Card 2675: decisions and their permanent record. Card 2713: the former decision service, split by area into
	// `decision-<area>-writes.ts`.
	'src/lib/server/decision-authoring-writes.ts',
	'src/lib/server/decision-lifecycle-writes.ts',
	'src/lib/server/decision-participant-writes.ts',
	'src/lib/server/decision-card-link-writes.ts',
	'src/lib/server/decision-response-writes.ts',
	'src/lib/server/decision-ruling-writes.ts',
	'src/lib/server/decision-question-writes.ts',
	// Card 2684: a participant's objection or request to talk to the decider.
	'src/lib/server/decision-flag-writes.ts'
];

/**
 * The modules the decision services share pieces through (card 2713, D2):
 * no service, and on neither SERVICES nor NOT_SERVICES. Each is held by the
 * helper pin of tests/check-at-the-write.test.ts: imported by name by the
 * decision services alone, importing none, writing nothing; and rule 3
 * follows a read into it.
 */
export const SERVICE_HELPERS: readonly string[] = ['src/lib/server/decision-write-shared.ts'];

/** A decision service: a module on SERVICES named `src/lib/server/decision*.ts` (card 2713). */
export const DECISION_SERVICE = /^src\/lib\/server\/decision[^/]*\.ts$/;

/** A function a handler can be written as. */
export type HandlerFunction = ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression;

/** Every name SvelteKit takes a `+server.ts` handler under. */
export const ROUTE_METHODS: readonly string[] = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'fallback'];

/** `node` without the parentheses, `await` and `!` round it. */
function bare(node: ts.Expression): ts.Expression {
	let inner = node;
	while (ts.isParenthesizedExpression(inner) || ts.isAwaitExpression(inner) || ts.isNonNullExpression(inner)) inner = inner.expression;
	return inner;
}

/**
 * The function each exported handler named in `methods` is:
 * `export const PUT = async (...) => {}`, `export async function PUT(...)`, or
 * a function of the file exported by name (`export { handler as PUT }`). One
 * exported by name from another file, or as anything but a function written
 * here, has no function (`fn` undefined): a caller reports it as one it cannot
 * read.
 */
export function handlersOf(
	tree: ts.SourceFile,
	methods: readonly string[] = ROUTE_METHODS
): { method: string; fn: HandlerFunction | undefined; at: ts.Node }[] {
	const found: { method: string; fn: HandlerFunction | undefined; at: ts.Node }[] = [];
	/** The function written in this file under a name, if it is one. */
	const local = (name: string): HandlerFunction | undefined => {
		for (const statement of tree.statements) {
			if (ts.isFunctionDeclaration(statement) && statement.name?.text === name) return statement;
			if (!ts.isVariableStatement(statement)) continue;
			for (const declared of statement.declarationList.declarations) {
				if (!ts.isIdentifier(declared.name) || declared.name.text !== name) continue;
				const value = declared.initializer && bare(declared.initializer);
				return value && (ts.isArrowFunction(value) || ts.isFunctionExpression(value)) ? value : undefined;
			}
		}
		return undefined;
	};
	for (const statement of tree.statements) {
		if (ts.isExportDeclaration(statement) && !statement.isTypeOnly && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
			for (const element of statement.exportClause.elements) {
				if (!methods.includes(element.name.text)) continue;
				const fn = statement.moduleSpecifier ? undefined : local((element.propertyName ?? element.name).text);
				found.push({ method: element.name.text, fn, at: element });
			}
			continue;
		}
		const exported = ts.canHaveModifiers(statement) && ts.getModifiers(statement)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
		if (!exported) continue;
		if (ts.isFunctionDeclaration(statement) && statement.name && methods.includes(statement.name.text)) {
			found.push({ method: statement.name.text, fn: statement, at: statement });
		}
		if (ts.isVariableStatement(statement)) {
			for (const declared of statement.declarationList.declarations) {
				if (!ts.isIdentifier(declared.name) || !methods.includes(declared.name.text)) continue;
				const value = declared.initializer && bare(declared.initializer);
				const fn = value && (ts.isArrowFunction(value) || ts.isFunctionExpression(value)) ? value : undefined;
				found.push({ method: declared.name.text, fn, at: declared });
			}
		}
	}
	return found;
}
