/**
 * The guarded append — the only way a line enters the ledger, shared by `epic record` and
 * `epic verdict`.
 *
 * Append, then **re-read the tail and compare**. The read-back is the whole point: a write whose
 * outcome was never proven is `8` and a write that landed as something else is `9`, and neither is
 * allowed to read as a recorded event. The same discipline `review append-criterion` applies to a
 * GitHub artifact, applied here to a local file.
 */
import {Effect, FileSystem} from "effect";
import {type LedgerLine, ledgerPathIn, renderLine} from "./ledger.ts";

export type Append =
	| {readonly _tag: "Appended"}
	/** The write was attempted and its outcome could not be proven — `8`. */
	| {readonly _tag: "Unknown"; readonly reason: string}
	/** The write landed and the tail does not read back — `9`. */
	| {readonly _tag: "Mismatch"};

/**
 * Append one line to the run's ledger.
 *
 * Read-modify-write rather than `O_APPEND`: the tail has to be re-read to be proven either way, and
 * the lane guard makes the run single-writer, so the whole file is read once per append regardless.
 */
export const appendLine = (
	dir: string,
	line: LedgerLine,
): Effect.Effect<Append, never, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const path = ledgerPathIn(dir);
		const bytes = renderLine(line);
		const current = yield* fs.readFileString(path).pipe(
			Effect.map((text) => ({_tag: "Text" as const, text})),
			Effect.catchTag("PlatformError", (cause) =>
				Effect.succeed({_tag: "Unreadable" as const, reason: cause.message}),
			),
		);
		if (current._tag === "Unreadable") {
			return {_tag: "Unknown" as const, reason: current.reason};
		}
		const base =
			current.text === "" || current.text.endsWith("\n") ? current.text : `${current.text}\n`;
		const wrote = yield* fs.writeFileString(path, `${base}${bytes}`).pipe(
			Effect.as(null),
			Effect.catchTag("PlatformError", (cause) => Effect.succeed(cause.message)),
		);
		if (wrote !== null) return {_tag: "Unknown" as const, reason: wrote};

		const readBack = yield* fs.readFileString(path).pipe(
			Effect.map((text) => ({_tag: "Text" as const, text})),
			Effect.catchTag("PlatformError", (cause) =>
				Effect.succeed({_tag: "Unreadable" as const, reason: cause.message}),
			),
		);
		if (readBack._tag === "Unreadable") {
			return {_tag: "Unknown" as const, reason: readBack.reason};
		}
		const tail =
			readBack.text
				.split("\n")
				.filter((row) => row.trim() !== "")
				.at(-1) ?? "";
		return tail === bytes.trimEnd() ? {_tag: "Appended" as const} : {_tag: "Mismatch" as const};
	});
