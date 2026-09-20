/**
 * `CommandRef` — one slash command, named the way a picker names one.
 *
 * Like `ModelRef` beside it, this rides no port: the picker lives in the window, which already
 * reads the whole `AiAgentSessionState`, so a sixth port would buy nothing (#8060).
 *
 * `name` carries no leading slash — the composer writes the sigil itself, and a ref that carried
 * one would render `//compact`. `argumentHint` is a hint, never an argument editor: the picker
 * inserts the command and the operator types the rest.
 */

import {Predicate} from "effect";

export interface CommandRef {
	readonly name: string;
	readonly description?: string;
	/** What the command expects after it, e.g. `<file>`. Absent when the backend names none. */
	readonly argumentHint?: string;
}

export const isCommandRef = (value: unknown): value is CommandRef =>
	Predicate.isObject(value) &&
	typeof value.name === "string" &&
	value.name.length > 0 &&
	(value.description === undefined || typeof value.description === "string") &&
	(value.argumentHint === undefined || typeof value.argumentHint === "string");
