import { defineRule } from "@oxlint/plugins";

import {
	classifyWideningTarget,
	createTypeEnvironment,
	hasOpenDictionaryKey,
	isKnownEvidenceExpression,
	type TypeEnvironment,
	type WideningTarget,
} from "../shared/dictionary-types.ts";

import type { ESTree, Scope, SourceCode, Variable } from "@oxlint/plugins";

type FunctionExpression = ESTree.ArrowFunctionExpression | ESTree.Function;

function unwrapExpression(expression: ESTree.Expression): ESTree.Expression {
	let current = expression;
	while (
		current.type === "ParenthesizedExpression" ||
		current.type === "TSAsExpression" ||
		current.type === "TSSatisfiesExpression" ||
		current.type === "TSTypeAssertion" ||
		current.type === "TSNonNullExpression"
	) {
		current = current.expression;
	}
	return current;
}

function resolveVariable(
	sourceCode: SourceCode,
	identifier: ESTree.IdentifierReference,
): Variable | null {
	let scope: Scope | null = sourceCode.getScope(identifier);
	while (scope !== null) {
		const variable = scope.set.get(identifier.name);
		if (variable !== undefined) return variable;
		scope = scope.upper;
	}
	return null;
}

function variableDeclarator(variable: Variable): ESTree.VariableDeclarator | null {
	if (variable.defs.length !== 1) return null;
	const [definition] = variable.defs;
	return definition?.type === "Variable" && definition.node.type === "VariableDeclarator"
		? definition.node
		: null;
}

function isStableConstVariable(variable: Variable, declarator: ESTree.VariableDeclarator): boolean {
	return (
		declarator.parent.type === "VariableDeclaration" &&
		declarator.parent.kind === "const" &&
		variable.references.every((reference) => reference.init || !reference.isWrite())
	);
}

function hasKnownEvidence(
	sourceCode: SourceCode,
	expression: ESTree.Expression,
	visitedVariables = new Set<Variable>(),
): boolean {
	if (isKnownEvidenceExpression(expression)) return true;
	const unwrapped = unwrapExpression(expression);
	if (unwrapped.type !== "Identifier") return false;
	const variable = resolveVariable(sourceCode, unwrapped);
	if (variable === null || visitedVariables.has(variable)) return false;
	const declarator = variableDeclarator(variable);
	if (
		declarator === null ||
		declarator.init === null ||
		!isStableConstVariable(variable, declarator)
	) {
		return false;
	}
	visitedVariables.add(variable);
	return hasKnownEvidence(sourceCode, declarator.init, visitedVariables);
}

function enclosingFunction(node: ESTree.Node): FunctionExpression | null {
	let current: ESTree.Node | null = node.parent;
	while (current !== null && current.type !== "Program") {
		if (
			current.type === "ArrowFunctionExpression" ||
			current.type === "FunctionDeclaration" ||
			current.type === "FunctionExpression"
		) {
			return current;
		}
		current = current.parent;
	}
	return null;
}

function sourceKeyName(sourceCode: SourceCode, key: ESTree.PropertyKey): string {
	if (key.type === "Identifier" || key.type === "PrivateIdentifier") return key.name;
	if (key.type === "Literal") return String(key.value);
	return sourceCode.getText(key);
}

function functionName(sourceCode: SourceCode, owner: FunctionExpression | null): string {
	if (owner === null) return "anonymous function";
	if (owner.id !== null) return owner.id.name;
	const parent = owner.parent;
	if (parent.type === "VariableDeclarator" && parent.id.type === "Identifier")
		return parent.id.name;
	if (parent.type === "MethodDefinition") return sourceKeyName(sourceCode, parent.key);
	return "anonymous function";
}

function isEmptyObjectExpression(
	sourceCode: SourceCode,
	expression: ESTree.Expression,
	visitedVariables = new Set<Variable>(),
): boolean {
	const unwrapped = unwrapExpression(expression);
	if (unwrapped.type === "ObjectExpression") return unwrapped.properties.length === 0;
	// An accumulator reaches its `return` as a name, not as the `{}` it was
	// declared with, so follow the same const chain the evidence walk follows.
	// Without this the rule exempts `const table: Record<…> = {}` and then
	// reports `return table` on the next line.
	if (unwrapped.type !== "Identifier") return false;
	const variable = resolveVariable(sourceCode, unwrapped);
	if (variable === null || visitedVariables.has(variable)) return false;
	const declarator = variableDeclarator(variable);
	if (
		declarator === null ||
		declarator.init === null ||
		!isStableConstVariable(variable, declarator)
	) {
		return false;
	}
	visitedVariables.add(variable);
	return isEmptyObjectExpression(sourceCode, declarator.init, visitedVariables);
}

function collectOwnReturns(node: ESTree.Node, into: ESTree.ReturnStatement[]): void {
	for (const [key, value] of Object.entries(node)) {
		if (key === "parent") continue;
		for (const child of Array.isArray(value) ? value : [value]) {
			if (child === null || typeof child !== "object" || !("type" in child)) continue;
			const candidate: ESTree.Node = child;
			if (
				candidate.type === "ArrowFunctionExpression" ||
				candidate.type === "FunctionDeclaration" ||
				candidate.type === "FunctionExpression"
			) {
				continue;
			}
			if (candidate.type === "ReturnStatement") into.push(candidate);
			collectOwnReturns(candidate, into);
		}
	}
}

/** Whether every path out of a function carries a known value. A return type
 *  covers all of them at once, so one arm returning `null` while the rest return
 *  a parse result is not the annotation discarding evidence — it is the
 *  annotation doing its job, and judging it from that one arm is unsound. */
function everyReturnHasEvidence(sourceCode: SourceCode, owner: FunctionExpression): boolean {
	const body = owner.body;
	// A bodiless overload signature has no return to judge the annotation by.
	if (body === null || body.type !== "BlockStatement") return true;
	const returns: ESTree.ReturnStatement[] = [];
	collectOwnReturns(body, returns);
	return returns.every(
		(statement) =>
			statement.argument !== null && hasKnownEvidence(sourceCode, statement.argument),
	);
}

function isDictionaryAccumulatorTarget(destination: WideningTarget): boolean {
	return destination.kind === "open dictionary" || destination.kind === "generic container";
}

function hasParentAssertion(node: ESTree.Node): boolean {
	return node.parent?.type === "TSAsExpression" || node.parent?.type === "TSTypeAssertion";
}

/** Detect sound syntactic cases where a known value is explicitly widened and loses evidence. */
export const noKnownValueWideningRule = defineRule({
	meta: {
		type: "problem",
		docs: {
			description:
				"Disallow syntactically established values from flowing into explicitly broad or anonymous target types that discard useful evidence.",
		},
		messages: {
			widening:
				"The explicit {{target}} type on {{subject}} discards known type evidence. Keep inference, validate with `satisfies`, or use a named owner contract.",
		},
	},
	createOnce(context) {
		let environment: TypeEnvironment | null = null;

		const reportFlow = (
			expression: ESTree.Expression,
			destination: WideningTarget | null,
			subject: string,
		) => {
			if (destination === null) return;
			if (
				isDictionaryAccumulatorTarget(destination) &&
				isEmptyObjectExpression(context.sourceCode, expression)
			) {
				return;
			}
			if (!hasKnownEvidence(context.sourceCode, expression)) return;
			context.report({
				node: expression,
				messageId: "widening",
				data: { subject, target: destination.kind },
			});
		};

		// A dictionary keyed by a bare `string`/`number`/`symbol` is out of scope.
		// The annotation is what permits the dynamic index in the first place, so
		// there is no version of the table that both keeps the literal value types
		// and still answers `table[runtimeKey]` — and with
		// `noUncheckedIndexedAccess` on, that lookup is already `V | undefined`,
		// which is the safety the evidence would have bought. A key that closes
		// over a union of literals is a different matter and stays reported.
		const classify = (type: ESTree.TSType): WideningTarget | null => {
			if (environment === null) return null;
			const target = classifyWideningTarget(type, environment);
			return target?.kind === "open dictionary" && hasOpenDictionaryKey(type, environment)
				? null
				: target;
		};

		const targetFromAnnotation = (annotation: ESTree.TSTypeAnnotation | null | undefined) =>
			annotation === null || annotation === undefined
				? null
				: classify(annotation.typeAnnotation);

		return {
			Program(node) {
				environment = createTypeEnvironment(node);
			},
			VariableDeclarator(node) {
				if (node.init === null || node.id.type !== "Identifier") return;
				// A `let` is annotated for the sake of every write it will take, so
				// its initializer alone cannot show the annotation is unearned.
				if (node.parent.type === "VariableDeclaration" && node.parent.kind !== "const") return;
				reportFlow(
					node.init,
					targetFromAnnotation(node.id.typeAnnotation),
					`binding \`${node.id.name}\``,
				);
			},
			PropertyDefinition(node) {
				if (node.value === null) return;
				reportFlow(
					node.value,
					targetFromAnnotation(node.typeAnnotation),
					`property \`${sourceKeyName(context.sourceCode, node.key)}\``,
				);
			},
			AccessorProperty(node) {
				if (node.value === null) return;
				reportFlow(
					node.value,
					targetFromAnnotation(node.typeAnnotation),
					`property \`${sourceKeyName(context.sourceCode, node.key)}\``,
				);
			},

			ReturnStatement(node) {
				if (node.argument === null) return;
				const owner = enclosingFunction(node);
				if (owner !== null && !everyReturnHasEvidence(context.sourceCode, owner)) return;
				reportFlow(
					node.argument,
					targetFromAnnotation(owner?.returnType),
					`return value of \`${functionName(context.sourceCode, owner)}\``,
				);
			},
			ArrowFunctionExpression(node) {
				if (node.body.type === "BlockStatement") return;
				reportFlow(
					node.body,
					targetFromAnnotation(node.returnType),
					`return value of \`${functionName(context.sourceCode, node)}\``,
				);
			},
			TSAsExpression(node) {
				if (hasParentAssertion(node)) return;
				reportFlow(node.expression, classify(node.typeAnnotation), "assertion");
			},
			TSTypeAssertion(node) {
				if (hasParentAssertion(node)) return;
				reportFlow(node.expression, classify(node.typeAnnotation), "assertion");
			},
		};
	},
});
