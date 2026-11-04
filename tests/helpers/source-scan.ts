/**
 * Reading a route file's source for its handlers, shared by the tests that
 * pin something to the source: tests/check-at-the-write.test.ts (what a
 * handler does before it reads its body) and tests/gate.test.ts case 8 of
 * card 2700 (which internal handlers read a body other than as JSON).
 */
import ts from 'typescript';

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
