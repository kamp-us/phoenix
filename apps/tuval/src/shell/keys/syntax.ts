/**
 * The key grammar: one keyboard event in, one vim-style string out, and back again. Re-derived by
 * hand from the founder's Studio (`monorepo/packages/runekeeper/syntax-vim.ts`) — nothing is
 * imported from it. The algorithm is unchanged; the hand-rolled `{ok, value}` result is Effect's
 * `Result` (`effect/Result`, rc.112) and each error is a `_tag`ged plain object.
 *
 * A `Key` is a superset of the Web API's `KeyboardEvent`, so a host can hand this module an event
 * verbatim — but nothing here reads the DOM or subscribes to anything. Listening is the shell
 * host's; this module only names what was pressed.
 */

import {Result} from "effect";

const has = <T extends object, K extends keyof T>(
	obj: T,
	key: string | number | symbol,
): key is K => Object.hasOwn(obj, key);

const aliases = {
	left: "ArrowLeft",
	right: "ArrowRight",
	up: "ArrowUp",
	down: "ArrowDown",
	bs: "Backspace",
	menu: "ContextMenu",
	apps: "ContextMenu",
	del: "Delete",
	return: "Enter",
	cr: "Enter",
	esc: "Escape",
	pgup: "PageUp",
	pgdn: "PageDown",
	lt: "<",
	less: "<",
	lesser: "<",
	gt: ">",
	greater: ">",
};

const alias = (key: string) => {
	const keyLower = key.toLowerCase();
	return has(aliases, keyLower) ? aliases[keyLower] : key;
};

const enUsTranslations = {
	Backquote: ["`", "~"],
	Digit1: ["1", "!"],
	Digit2: ["2", "@"],
	Digit3: ["3", "#"],
	Digit4: ["4", "$"],
	Digit5: ["5", "%"],
	Digit6: ["6", "^"],
	Digit7: ["7", "&"],
	Digit8: ["8", "*"],
	Digit9: ["9", "("],
	Digit0: ["0", ")"],
	Minus: ["-", "_"],
	Equal: ["=", "+"],
	Backslash: ["\\", "|"],
	BracketLeft: ["[", "{"],
	BracketRight: ["]", "}"],
	Semicolon: [";", ":"],
	Quote: ["'", '"'],
	Comma: [",", "<"],
	Period: [".", ">"],
	Slash: ["/", "?"],
};

const codeToEnUsQwerty = (code: string, shift?: boolean) => {
	if (code.startsWith("Key")) {
		const key = code.slice(3);
		return shift ? key : key.toLowerCase();
	}
	return (has(enUsTranslations, code) ? enUsTranslations[code][shift ? 1 : 0] : code) ?? code;
};

/** A key string that is not a key at all — the empty string, two characters, an unclosed chord. */
export interface InvalidKeyError {
	readonly _tag: "InvalidKeyError";
	readonly key: string;
	readonly message: `Invalid key: ${string}`;
}

/** A chord naming a modifier outside `a`/`c`/`m`/`s`. */
export interface UnknownModifierError {
	readonly _tag: "UnknownModifierError";
	readonly modifier: string;
	readonly context: string;
	readonly message: `${string}: Unknown modifier: ${string}`;
}

/** A chord naming one modifier twice, in either case. */
export interface DuplicateModifierError {
	readonly _tag: "DuplicateModifierError";
	readonly modifier: string;
	readonly context: string;
	readonly message: `${string}: Duplicate modifier: ${string}`;
}

/** Shift over a single-character key: the character already carries the shift. */
export interface DisallowedModifierError {
	readonly _tag: "DisallowedModifierError";
	readonly modifier: string;
	readonly context: string;
	readonly message: `${string}: Unusable modifier with single-character keys: ${string}`;
}

export type KeyParseError =
	| InvalidKeyError
	| UnknownModifierError
	| DuplicateModifierError
	| DisallowedModifierError;

/**
 * A key with optional modifiers — a superset of the Web API's
 * [`KeyboardEvent`](https://developer.mozilla.org/docs/Web/API/KeyboardEvent).
 */
export interface Key {
	/** The same as [`KeyboardEvent.key`](https://developer.mozilla.org/docs/Web/API/KeyboardEvent/key). */
	readonly key: string;
	/** The same as [`KeyboardEvent.code`](https://developer.mozilla.org/docs/Web/API/KeyboardEvent/code). */
	readonly code?: string;
	readonly shiftKey?: boolean;
	readonly ctrlKey?: boolean;
	readonly altKey?: boolean;
	readonly metaKey?: boolean;
}

const specialCases = {
	"<": "lt",
	">": "gt",
};

const ignored = /^($|Unidentified$|Process$|Dead$|Alt|Control|Hyper|Meta|Shift|Super|OS)/;

/**
 * The string form of one key event, or the empty string for a key no binding can name — a bare
 * modifier, an unidentified key. Modifiers are emitted in `a`, `c`, `m`, `s` order so one event
 * has exactly one spelling.
 */
export const stringify = (event: Key): string => {
	let shift = event.shiftKey;
	let key = event.key || "Unidentified";
	if (key === "Unidentified") {
		key = codeToEnUsQwerty(event.code || "", shift);
	} else {
		key = alias(key);
		if (key === " ") key = "Space";
	}

	if (ignored.test(key)) return "";

	if (key.length === 1) {
		// A single character already carries its shift, so `s-` would double-count it.
		shift = false;
	} else {
		key = key.toLowerCase();
	}

	let modifiers = "";
	if (event.altKey) modifiers += "a-";
	if (event.ctrlKey) modifiers += "c-";
	if (event.metaKey) modifiers += "m-";
	if (shift) modifiers += "s-";

	if (has(specialCases, key)) key = specialCases[key];

	return modifiers || key.length > 1 ? `<${modifiers}${key}>` : key;
};

const modifierMap = {
	a: "altKey",
	c: "ctrlKey",
	m: "metaKey",
	s: "shiftKey",
} as const;

/** One key string back into the event it names, or the reason it names none. */
export const parse = (keyString: string): Result.Result<Key, KeyParseError> => {
	if (keyString.length === 1) {
		if (/\s/.test(keyString)) {
			return Result.fail({
				_tag: "InvalidKeyError",
				key: keyString,
				message: `Invalid key: ${keyString}`,
			});
		}
		return Result.succeed({key: keyString});
	}

	const match = keyString.match(/^<((?:[a-z]-)*)([a-z\d]+|[^<>\s])>$/i);
	if (!match) {
		return Result.fail({
			_tag: "InvalidKeyError",
			key: keyString,
			message: `Invalid key: ${keyString}`,
		});
	}
	const [, modifiers, key] = match;

	const obj: {
		key: string;
		altKey?: boolean;
		ctrlKey?: boolean;
		metaKey?: boolean;
		shiftKey?: boolean;
	} = {key: alias(key ?? "")};

	for (const modifier of (modifiers ?? "").split("-").slice(0, -1)) {
		const modifierLower = modifier.toLowerCase();
		if (!has(modifierMap, modifierLower)) {
			return Result.fail({
				_tag: "UnknownModifierError",
				modifier,
				context: keyString,
				message: `${keyString}: Unknown modifier: ${modifier}`,
			});
		}
		const modifierName = modifierMap[modifierLower];

		if (obj[modifierName] !== undefined) {
			return Result.fail({
				_tag: "DuplicateModifierError",
				modifier,
				context: keyString,
				message: `${keyString}: Duplicate modifier: ${modifier}`,
			});
		}

		obj[modifierName] = true;

		if (obj.key.length === 1 && obj.shiftKey) {
			return Result.fail({
				_tag: "DisallowedModifierError",
				modifier,
				context: keyString,
				message: `${keyString}: Unusable modifier with single-character keys: ${modifier}`,
			});
		}
	}

	return Result.succeed(obj);
};

/** The one spelling of a key string: parse it, then stringify what came back. */
export const normalize = (keyString: string): Result.Result<string, KeyParseError> =>
	Result.map(parse(keyString), stringify);

/**
 * A sequence string split into the key strings it holds — `"<c-b>x"` into `["<c-b>", "x"]`. A
 * chord is one element; anything else is one character each.
 */
export const parseSequence = (keySequence: string): ReadonlyArray<string> | null =>
	keySequence.match(/<[^<>\s]+>|[\s\S]|^$/g);
