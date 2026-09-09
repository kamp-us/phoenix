/**
 * Pi's two session stores, read as one list of neutral rows.
 *
 * Pi keeps the sessions ruling 3 (#8070) names in two places, and a listing that reads one of them
 * is wrong about the other:
 *
 * 1. **The `pi` CLI's global store**, `<agentDir>/sessions/<per-cwd slug>/*.jsonl` — where a
 *    session the operator started with `pi` in a terminal lands.
 * 2. **Tuval's own per-project store**, `<projectRoot>/.tuval/pi-sessions/*.jsonl` — deliberately
 *    outside the global one (`server/AgentSessionHost.ts`), so the global scan reaches none of it.
 *
 * Rows are read through `SessionManager.listAll(dir)`, which builds a `SessionInfo` per `.jsonl`
 * file in one directory. The global store's per-cwd slug directories are enumerated here rather
 * than by the pin's no-argument `listAll()`, because that overload resolves its root from
 * `getAgentDir()` — process env at call time — and would ignore the `agentDir` this layer was
 * built on, which is the same directory its credentials and its model catalog are rebased on.
 *
 * **Known limitation.** Tuval's own Pi sessions under *other* project roots stay unreachable:
 * Tuval knows one project root, and `sessionDir` is a programmatic option with no config knob, so
 * there is no set of roots to walk. Multi-root discovery is not built here.
 */

import {existsSync, readdirSync} from "node:fs";
import {join} from "node:path";
import {type SessionInfo, SessionManager} from "@earendil-works/pi-coding-agent";
import {Effect} from "effect";
import {newestFirst, type SessionSummary, sessionSummary} from "../../ai-agent/service/index.ts";

/** Which of Pi's two stores a row came from, or a failure is about. */
export type PiSessionStore = "pi-cli" | "tuval";

/** One store that could not be read. The other store's rows still come back beside it. */
export interface StoreFailure {
	readonly store: PiSessionStore;
	readonly detail: string;
	readonly cause?: unknown;
}

export interface StoreRead {
	/** The union of every store that answered, deduplicated and newest first. */
	readonly sessions: ReadonlyArray<SessionSummary>;
	/** The stores that answered. Empty means nothing was read and `sessions` claims nothing. */
	readonly answered: ReadonlyArray<PiSessionStore>;
	readonly failures: ReadonlyArray<StoreFailure>;
}

export interface PiSessionStores {
	/** Pi's config directory for this process: the `pi` CLI's store is `<agentDir>/sessions`. */
	readonly agentDir: string;
	/** Tuval's own store, or absent when this layer has no project root to locate one under. */
	readonly tuvalDir?: string | undefined;
}

/** What the pin writes as `firstMessage` for a session holding none. An absence, not a prompt. */
const NO_MESSAGES = "(no messages)";

/**
 * One `SessionInfo` as the neutral row. `branch` is left absent because Pi records no git branch —
 * `SessionInfo` has no field for one — and `firstPrompt` drops the pin's own placeholder, which is
 * a label for an empty session rather than something the operator typed.
 *
 * `title` is Pi's `name`, which the pin documents as the "user-defined display name from
 * session_info entries" — the same thing Claude's `/rename` title is, so the port's one title
 * question keeps one answer instead of one per backend (#8135). A session nobody named has none.
 */
const rowOf = (info: SessionInfo): SessionSummary =>
	sessionSummary({
		sessionId: info.id,
		lastModified: info.modified,
		backend: "pi",
		title: info.name,
		firstPrompt: info.firstMessage === NO_MESSAGES ? undefined : info.firstMessage,
		folder: info.cwd,
		messageCount: info.messageCount,
	});

/**
 * The directories of one store that hold `.jsonl` session files: the per-cwd slug directories for
 * the CLI's store, and the store itself for Tuval's.
 *
 * A store that was never written is no sessions and no failure. One that exists and cannot be read
 * is the failure, and it is read here even for the single-directory store: `listSessionsFromDir`
 * swallows its own read error and answers `[]` (`dist/core/session-manager.js` at 0.84.3), so an
 * unreadable store left to the pin would be reported as an empty one.
 */
const leavesOf = (
	store: PiSessionStore,
	root: string,
): Effect.Effect<ReadonlyArray<string>, StoreFailure> =>
	Effect.try({
		try: () => {
			if (!existsSync(root)) return [];
			const entries = readdirSync(root, {withFileTypes: true});
			if (store === "tuval") return [root];
			return entries
				.filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
				.map((entry) => join(root, entry.name));
		},
		catch: (cause) => ({store, detail: "Pi could not read the session store", cause}),
	});

/** Every directory the stores keep `.jsonl` files in, beside the stores that would not answer. */
export interface StoreDirs {
	readonly dirs: ReadonlyArray<string>;
	readonly failures: ReadonlyArray<StoreFailure>;
}

const targetsOf = (stores: PiSessionStores): ReadonlyArray<readonly [PiSessionStore, string]> => [
	["pi-cli", join(stores.agentDir, "sessions")],
	...(stores.tuvalDir === undefined ? [] : [["tuval", stores.tuvalDir] as const]),
];

/**
 * Where a stored session's file could be, across both stores.
 *
 * The transcript read (`./PiAiAgent.ts`) walks these to find one session's JSONL, so it reaches
 * every row `readPiSessions` unions: a session the operator started with `pi` in a terminal lives
 * in the CLI store and is unreachable off Tuval's own directory alone (#8233).
 *
 * A store that would not enumerate is named in `failures` rather than failing the call, for the
 * reason `readPiSessions` gives — the other store's directories are still worth looking in, and it
 * is the caller that knows whether a miss across what did answer is a miss at all.
 */
export const piSessionDirs = (stores: PiSessionStores): Effect.Effect<StoreDirs> =>
	Effect.map(
		Effect.forEach(
			targetsOf(stores),
			([store, root]) =>
				leavesOf(store, root).pipe(
					Effect.map((dirs) => ({dirs, failure: null as StoreFailure | null})),
					Effect.catch((failure) => Effect.succeed({dirs: [] as ReadonlyArray<string>, failure})),
				),
			{concurrency: "unbounded"},
		),
		(answers) => ({
			dirs: answers.flatMap((answer) => answer.dirs),
			failures: answers.flatMap((answer) => (answer.failure === null ? [] : [answer.failure])),
		}),
	);

interface StoreAnswer {
	readonly store: PiSessionStore;
	readonly sessions: ReadonlyArray<SessionSummary>;
	readonly failure: StoreFailure | null;
}

const readStore = (store: PiSessionStore, root: string): Effect.Effect<StoreAnswer> =>
	leavesOf(store, root).pipe(
		Effect.flatMap((leaves) =>
			Effect.forEach(
				leaves,
				(leaf) =>
					Effect.tryPromise({
						try: () => SessionManager.listAll(leaf),
						catch: (cause): StoreFailure => ({
							store,
							detail: "Pi could not read the session store",
							cause,
						}),
					}),
				// Independent directory reads, and the result order is the input's either way.
				{concurrency: "unbounded"},
			),
		),
		Effect.map(
			(batches): StoreAnswer => ({store, sessions: batches.flat().map(rowOf), failure: null}),
		),
		Effect.catch((failure) => Effect.succeed({store, sessions: [], failure})),
	);

/**
 * Both stores, unioned. Never fails: a store that could not be read is named in `failures` and the
 * other store's rows still come back, because a read error is not the claim "this machine holds no
 * Pi sessions".
 *
 * The dedup keeps the first row for an id — the stores hold different files today, so it only
 * fires if one is ever configured to overlap the other, where both copies are the same session.
 */
export const readPiSessions = (stores: PiSessionStores): Effect.Effect<StoreRead> =>
	Effect.gen(function* () {
		const answers = yield* Effect.forEach(
			targetsOf(stores),
			([store, root]) => readStore(store, root),
			{concurrency: "unbounded"},
		);

		const seen = new Set<string>();
		const sessions: Array<SessionSummary> = [];
		for (const answer of answers) {
			for (const row of answer.sessions) {
				if (seen.has(row.sessionId)) continue;
				seen.add(row.sessionId);
				sessions.push(row);
			}
		}

		return {
			sessions: newestFirst(sessions),
			answered: answers.filter((answer) => answer.failure === null).map((answer) => answer.store),
			failures: answers.flatMap((answer) => (answer.failure === null ? [] : [answer.failure])),
		};
	});
