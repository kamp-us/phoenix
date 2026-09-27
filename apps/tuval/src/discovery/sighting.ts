/**
 * Whether a desk is running under this home, read off the discovery record (`./record.ts`) and
 * never off the record alone: a desk that crashed left its record behind, so a record counts only
 * once the desk it names has answered (#9696).
 *
 * The desk answers through its page, the way the page's own bundle does: a `GET` of the page
 * server's launch endpoint returns the transport's launch URL. That one read proves the desk is up
 * and hands the caller the address a request travels on.
 */

import {Context, Effect, Layer, Option, Schema} from "effect";
import {LAUNCH_ENDPOINT} from "../page/dev-server.ts";
import {type DeskRecord, type DeskRecordRead, readDeskRecord} from "./record.ts";

/** What a caller found under the home: no desk, a record nothing answers for, or a live desk. */
export type DeskSighting =
	| {readonly _tag: "NoDesk"}
	| {readonly _tag: "Stale"; readonly reason: string; readonly pid: number | null}
	| {readonly _tag: "Live"; readonly record: DeskRecord; readonly launchUrl: string};

/**
 * The sighting a record read and the desk's answer make. `answer` is `None` when the desk the record
 * names did not answer; it is never consulted for a record that is absent or unreadable.
 */
export const classify = (read: DeskRecordRead, answer: Option.Option<string>): DeskSighting => {
	switch (read._tag) {
		case "Absent":
			return {_tag: "NoDesk"};
		case "Unreadable":
			return {_tag: "Stale", reason: `its record is unreadable: ${read.reason}`, pid: null};
		case "Found":
			return Option.match(answer, {
				onNone: () => ({
					_tag: "Stale",
					reason: `the desk it names (pid ${read.record.pid}) does not answer`,
					pid: read.record.pid,
				}),
				onSome: (launchUrl) => ({_tag: "Live", record: read.record, launchUrl}),
			});
	}
};

/** Asks the desk a record names whether it is up. `Some` carries the transport's launch URL. */
export class DeskProbe extends Context.Service<
	DeskProbe,
	{readonly answer: (record: DeskRecord) => Effect.Effect<Option.Option<string>>}
>()("tuval/DeskProbe") {
	/** The real probe: the process has to exist, and then its page has to answer. */
	static readonly layer = Layer.succeed(DeskProbe, {
		answer: (record) =>
			Effect.flatMap(processExists(record.pid), (exists) =>
				exists ? fetchLaunchUrl(record.page) : Effect.succeedNone,
			),
	});
}

/** A probe step that did not get an answer. The record it was probing reads as stale. */
class NoAnswer extends Schema.TaggedError<NoAnswer>()("tuval/NoAnswer", {
	cause: Schema.Defect(),
}) {}

/** How long a desk has to answer before its record is called stale. */
const ANSWER_TIMEOUT_MS = 2_000;

/** `EPERM` is a process that exists under another user; only `ESRCH` says it is gone. */
const processExists = (pid: number): Effect.Effect<boolean> =>
	Effect.try({try: () => process.kill(pid, 0), catch: (cause) => new NoAnswer({cause})}).pipe(
		Effect.as(true),
		Effect.catch((error) =>
			Effect.succeed((error.cause as NodeJS.ErrnoException).code === "EPERM"),
		),
	);

const LaunchAnswer = Schema.Struct({url: Schema.String});
const decodeLaunchAnswer = Schema.decodeUnknownOption(LaunchAnswer);

const fetchLaunchUrl = (page: string): Effect.Effect<Option.Option<string>> =>
	Effect.tryPromise({
		try: async () => {
			const response = await fetch(new URL(LAUNCH_ENDPOINT, page), {
				signal: AbortSignal.timeout(ANSWER_TIMEOUT_MS),
			});
			return response.ok ? ((await response.json()) as unknown) : null;
		},
		catch: (cause) => new NoAnswer({cause}),
	}).pipe(
		Effect.map((body) =>
			decodeLaunchAnswer(body).pipe(
				Option.map((answer) => answer.url),
				Option.filter((url) => url.startsWith("ws://")),
			),
		),
		Effect.orElseSucceed(Option.none<string>),
	);

/** Read the record under `home` and ask the desk it names. */
export const sightDesk = Effect.fn("Tuval.sightDesk")(function* (home: string) {
	const read = yield* readDeskRecord(home);
	const answer =
		read._tag === "Found"
			? yield* DeskProbe.use((probe) => probe.answer(read.record))
			: Option.none<string>();
	return classify(read, answer);
});
