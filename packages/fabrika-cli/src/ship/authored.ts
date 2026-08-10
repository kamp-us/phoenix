/**
 * The stdin-and-leak fence the two writing verbs share.
 *
 * **The text arrives on stdin only** — no `--body`, no `--body-file`. A path flag is how a
 * machine-local path reaches a public surface while the poster reads success, and the bare-`@`
 * refusal is that byte pattern caught after the fact (#3086).
 *
 * The leak predicate is `../report/leaks.ts`, imported. Two known issues on that seam are inherited
 * rather than resolved here, and the refusals name both: a body that proves path-cleanliness *by
 * example* trips the generic detector (#4994 — generic by design, #2393), and no verb can rewrite a
 * foreign comment (#4995). Both route to a human.
 */
import type {Effect} from "effect";
import type {StdinRead} from "../io/stdin.ts";
import {isBareAtReference, renderLeaks, scanBody} from "../report/leaks.ts";
import {FAILED, refuse, type VerbOutcome} from "../verb.ts";
import {BARE_AT_PATH, EMPTY_STDIN, LEAKED_PATH} from "./codes.ts";

export type Authored =
	| {readonly _tag: "Refused"; readonly outcome: VerbOutcome}
	| {readonly _tag: "Text"; readonly text: string; readonly bytes: number};

export interface AuthoredMessages {
	readonly empty: string;
	readonly bareAt: string;
	readonly leaked: (count: number, first: {line: number; class: string}) => string;
}

export const readAuthored = (
	verb: string,
	read: StdinRead,
	messages: AuthoredMessages,
): Authored => {
	if (read._tag === "Failed") {
		return {
			_tag: "Refused",
			outcome: refuse(
				FAILED,
				`${verb}: could not read stdin: ${read.reason} — the text is UNKNOWN, never empty.`,
			),
		};
	}
	const text = read._tag === "NoStdin" ? "" : read.text;
	const bytes = new TextEncoder().encode(text).length;
	if (text.trim() === "") {
		return {_tag: "Refused", outcome: refuse(EMPTY_STDIN, messages.empty)};
	}
	if (isBareAtReference(text)) {
		return {_tag: "Refused", outcome: refuse(BARE_AT_PATH, messages.bareAt)};
	}
	const scan = scanBody(text);
	const first = scan.leaks[0];
	if (first !== undefined) {
		return {
			_tag: "Refused",
			outcome: refuse(
				LEAKED_PATH,
				messages.leaked(scan.leaks.length, {line: first.line, class: first.class}),
				renderLeaks(scan.leaks),
			),
		};
	}
	return {_tag: "Text", text, bytes};
};

/** The stdin effect both verbs take, kept as one type so the adapter wires them identically. */
export type StdinSource = Effect.Effect<StdinRead>;
