/**
 * The one walk of the line that `parse` and `complete` both read.
 *
 * Two rules make it incremental — a line is read the same way after every keystroke, and a line
 * that is merely unfinished is never refused (#7617 R1.5):
 *
 * 1. **The caret's token is still being typed.** It is the last token, or a fresh empty one when
 *    the line ends on a separator. A committed token that names nothing is a refusal; the caret's
 *    token only has to be a *prefix* of something.
 * 2. **The deepest registered spell on the walk wins**, and every token after its path is an
 *    argument. Positional arguments fill the parameters in declaration order; a token shaped
 *    `name=value` whose `name` is an unbound parameter binds by name instead. Rule 1 outranks this
 *    one where the two meet: while the caret's token still prefixes a deeper segment it is a path
 *    being typed, not an argument.
 *
 * Arguments bind as text. Decoding them against the spell's real `params` is the executor's, so the
 * only value this module refuses is one outside an enum parameter's literals — the check the kernel
 * would make anyway, made here so the palette cannot accept what the kernel rejects.
 */

import {didYouMean} from "./did-you-mean.ts";
import {
	describeExpected,
	type IndexedSpell,
	type IndexNode,
	type ParamSpec,
	type SpellIndex,
} from "./spell-index.ts";
import {type Token, tokenize} from "./tokenize.ts";

/** What the caret is typing — the only thing `complete` needs from the walk. */
export type Slot =
	| {readonly kind: "segment"; readonly node: IndexNode; readonly token: Token}
	| {readonly kind: "value"; readonly param: ParamSpec; readonly token: Token}
	| {readonly kind: "none"};

/** The parse verdict without its candidate list, which only `complete` can rank. */
export type ReadingCore =
	| {
			readonly kind: "Complete";
			readonly spell: IndexedSpell;
			readonly args: Readonly<Record<string, string>>;
	  }
	| {readonly kind: "Partial"; readonly spell?: IndexedSpell; readonly cursorArg?: ParamSpec}
	| {
			readonly kind: "Refused";
			readonly position: number;
			readonly expected: string;
			readonly didYouMean?: string;
	  };

export interface Reading {
	readonly core: ReadingCore;
	readonly slot: Slot;
}

/** A node's children as an expectation. Past a handful the list stops helping and a name is kinder. */
const describeSegments = (segments: ReadonlyArray<string>): string =>
	segments.length === 0 || segments.length > 6 ? "<segment>" : segments.join("|");

const refused = (
	position: number,
	expected: string,
	suggestion?: string,
): Extract<ReadingCore, {kind: "Refused"}> =>
	suggestion === undefined
		? {kind: "Refused", position, expected}
		: {kind: "Refused", position, expected, didYouMean: suggestion};

const NAMED = /^([A-Za-z][A-Za-z0-9_-]*)=([\s\S]*)$/;

export const read = (input: string, registry: SpellIndex): Reading => {
	const {tokens, trailingSeparator} = tokenize(input);
	const caretIndex = trailingSeparator ? tokens.length : Math.max(0, tokens.length - 1);
	const caret: Token = tokens[caretIndex] ?? {text: "", start: input.length, end: input.length};

	const trail: Array<IndexNode> = [registry.root];
	let deepest: IndexNode = registry.root;
	let matched = 0;
	for (const token of tokens) {
		const child = deepest.children.get(token.text);
		if (child === undefined) break;
		deepest = child;
		trail.push(child);
		matched += 1;
	}
	// `trail` holds a node for every depth from 0 to `matched`, so the fallback never fires; it is
	// here so a reader of the depth arithmetic below is not asked to trust a non-null assertion.
	const nodeAt = (depth: number): IndexNode => trail[depth] ?? registry.root;

	let spell: IndexedSpell | undefined;
	let consumed = 0;
	for (let depth = matched; depth >= 1; depth -= 1) {
		const found = nodeAt(depth).spell;
		if (found !== undefined) {
			spell = found;
			consumed = depth;
			break;
		}
	}

	if (spell === undefined || consumed > caretIndex) {
		const node = nodeAt(Math.min(caretIndex, matched));
		const segments = [...node.children.keys()];
		const segmentSlot: Slot = {kind: "segment", node, token: caret};

		if (spell !== undefined) return {core: finish(spell, {}, new Set()), slot: segmentSlot};

		const offender = tokens[matched];
		if (matched < caretIndex && offender !== undefined) {
			return {
				core: refused(
					offender.start,
					describeSegments(segments),
					didYouMean(offender.text, segments),
				),
				slot: {kind: "none"},
			};
		}

		const reachable = segments.some((segment) => segment.startsWith(caret.text));
		return {
			core: reachable
				? {kind: "Partial"}
				: refused(caret.start, describeSegments(segments), didYouMean(caret.text, segments)),
			slot: segmentSlot,
		};
	}

	// Rule 1 outranks rule 2 where they meet. A spell registered at a prefix of a longer path would
	// otherwise swallow the segment the caret is halfway through: with `focus layout` registered and
	// `focus layout close` under it, `focus layout c` is a path being typed, not a bad argument to
	// `focus layout`.
	if (caretIndex <= matched) {
		const node = nodeAt(caretIndex);
		if ([...node.children.keys()].some((segment) => segment.startsWith(caret.text))) {
			return {core: {kind: "Partial", spell}, slot: {kind: "segment", node, token: caret}};
		}
	}

	return bind(spell, tokens, consumed, caretIndex, caret);
};

const finish = (
	spell: IndexedSpell,
	args: Readonly<Record<string, string>>,
	bound: ReadonlySet<string>,
): ReadingCore => {
	const missing = spell.params.find((param) => param.required && !bound.has(param.name));
	return missing === undefined
		? {kind: "Complete", spell, args}
		: {kind: "Partial", spell, cursorArg: missing};
};

const bind = (
	spell: IndexedSpell,
	tokens: ReadonlyArray<Token>,
	consumed: number,
	caretIndex: number,
	caret: Token,
): Reading => {
	const caretIsArgument = caretIndex >= consumed && caretIndex < tokens.length;
	const committed = tokens.slice(consumed, caretIsArgument ? caretIndex : tokens.length);
	const pending = caretIsArgument && caret.text !== "" ? caret : undefined;

	const args: Record<string, string> = {};
	const bound = new Set<string>();
	const byName = new Map(spell.params.map((param) => [param.name, param]));
	let position = 0;

	const nextPositional = (): ParamSpec | undefined => {
		while (position < spell.params.length) {
			const param = spell.params[position];
			if (param === undefined || !bound.has(param.name)) return param;
			position += 1;
		}
		return undefined;
	};

	const target = (token: Token): {param: ParamSpec; value: string} | undefined => {
		const named = NAMED.exec(token.text);
		const name = named?.[1];
		const value = named?.[2];
		if (name !== undefined && value !== undefined) {
			const param = byName.get(name);
			if (param !== undefined && !bound.has(param.name)) return {param, value};
		}
		const positional = nextPositional();
		return positional === undefined ? undefined : {param: positional, value: token.text};
	};

	for (const token of committed) {
		const slot = target(token);
		if (slot === undefined) {
			return {core: refused(token.start, "no further arguments"), slot: {kind: "none"}};
		}
		if (slot.param.literals !== undefined && !slot.param.literals.includes(slot.value)) {
			return {
				core: refused(
					token.start,
					describeExpected(slot.param),
					didYouMean(slot.value, slot.param.literals),
				),
				slot: {kind: "value", param: slot.param, token},
			};
		}
		args[slot.param.name] = slot.value;
		bound.add(slot.param.name);
	}

	if (pending !== undefined) {
		const slot = target(pending);
		if (slot === undefined) {
			return {core: refused(pending.start, "no further arguments"), slot: {kind: "none"}};
		}
		const valueSlot: Slot = {kind: "value", param: slot.param, token: pending};
		const {literals} = slot.param;
		if (literals !== undefined && !literals.includes(slot.value)) {
			// A prefix of a literal is a literal the user has not finished typing.
			return literals.some((literal) => literal.startsWith(slot.value))
				? {core: {kind: "Partial", spell, cursorArg: slot.param}, slot: valueSlot}
				: {
						core: refused(
							pending.start,
							describeExpected(slot.param),
							didYouMean(slot.value, literals),
						),
						slot: valueSlot,
					};
		}
		args[slot.param.name] = slot.value;
		bound.add(slot.param.name);
		return {core: finish(spell, args, bound), slot: valueSlot};
	}

	const open = nextPositional();
	return {
		core: finish(spell, args, bound),
		slot: open === undefined ? {kind: "none"} : {kind: "value", param: open, token: caret},
	};
};
