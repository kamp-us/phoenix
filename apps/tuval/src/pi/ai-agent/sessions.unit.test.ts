/**
 * Both of Pi's stores, driven off fixture directories written here — real `.jsonl` session files
 * in a real temp tree, read back through the pin's own `SessionManager`, so no `pi` CLI and no
 * socket are involved.
 *
 * The file shape is the pin's: a `session` header line naming the id, the cwd and the timestamp,
 * then `message` entries, which is what `buildSessionInfo` counts and reads the first prompt off
 * (`dist/core/session-manager.js` at 0.84.3).
 *
 * The unreadable store is a plain file standing where a directory should be, so `readdir` fails
 * with ENOTDIR for every user on every platform — a chmod fixture passes as root and would make
 * this test lie in a container that runs as one.
 */

import {mkdirSync, mkdtempSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {assert, describe, it} from "@effect/vitest";
import {Effect} from "effect";
import {readPiSessions} from "./sessions.ts";

const at = (seconds: number): string => new Date(1_760_000_000_000 + seconds * 1_000).toISOString();

const said = (text: string, seconds: number) => ({
	type: "message",
	id: `m-${seconds}`,
	parentId: null,
	timestamp: at(seconds),
	message: {role: "user", content: [{type: "text", text}], timestamp: 0},
});

interface Fixture {
	readonly id: string;
	readonly cwd: string;
	readonly seconds: number;
	readonly prompt?: string;
	/** What `appendSessionInfo` writes when the operator names a session: a `session_info` entry. */
	readonly name?: string;
}

const named = (name: string, seconds: number) => ({
	type: "session_info",
	id: `n-${seconds}`,
	parentId: null,
	timestamp: at(seconds),
	name,
});

/** One session file, named the way `SessionManager.create` names one: `<stamp>_<id>.jsonl`. */
const writeSession = (dir: string, session: Fixture): void => {
	const header = {
		type: "session",
		version: 3,
		id: session.id,
		timestamp: at(session.seconds),
		cwd: session.cwd,
	};
	const lines = [
		JSON.stringify(header),
		...(session.name === undefined ? [] : [JSON.stringify(named(session.name, session.seconds))]),
		...(session.prompt === undefined
			? []
			: [JSON.stringify(said(session.prompt, session.seconds))]),
	];
	writeFileSync(
		join(dir, `${at(session.seconds).replace(/[:.]/g, "-")}_${session.id}.jsonl`),
		`${lines.join("\n")}\n`,
	);
};

/** The `pi` CLI's store: a per-cwd slug directory under `<agentDir>/sessions`, as the pin lays it out. */
const cliStore = (agentDir: string, slug: string): string => {
	const dir = join(agentDir, "sessions", slug);
	mkdirSync(dir, {recursive: true});
	return dir;
};

const tuvalStore = (root: string): string => {
	const dir = join(root, ".tuval", "pi-sessions");
	mkdirSync(dir, {recursive: true});
	return dir;
};

const temp = (): string => mkdtempSync(join(tmpdir(), "tuval-pi-sessions-"));

describe("the Pi backend's two session stores", () => {
	it.effect("unions a `pi` CLI session and a Tuval one, newest first", () =>
		Effect.gen(function* () {
			const agentDir = temp();
			const root = temp();
			writeSession(cliStore(agentDir, "--work-phoenix--"), {
				id: "from-the-terminal",
				cwd: "/work/phoenix",
				seconds: 10,
				prompt: "port the loader",
			});
			writeSession(tuvalStore(root), {
				id: "from-tuval",
				cwd: root,
				seconds: 20,
				prompt: "open the composer",
			});

			const read = yield* readPiSessions({agentDir, tuvalDir: tuvalStore(root)});

			assert.deepStrictEqual(
				read.sessions.map((row) => row.sessionId),
				["from-tuval", "from-the-terminal"],
			);
			assert.deepStrictEqual(read.failures, []);
		}),
	);

	it.effect("reads every per-cwd directory of the CLI store, not just one", () =>
		Effect.gen(function* () {
			const agentDir = temp();
			writeSession(cliStore(agentDir, "--work-phoenix--"), {
				id: "one-project",
				cwd: "/work/phoenix",
				seconds: 10,
			});
			writeSession(cliStore(agentDir, "--work-demlik--"), {
				id: "another-project",
				cwd: "/work/demlik",
				seconds: 11,
			});

			const read = yield* readPiSessions({agentDir});

			assert.deepStrictEqual([...read.sessions.map((row) => row.sessionId)].sort(), [
				"another-project",
				"one-project",
			]);
		}),
	);

	it.effect("carries what Pi supplies and leaves the branch it does not absent", () =>
		Effect.gen(function* () {
			const root = temp();
			writeSession(tuvalStore(root), {
				id: "described",
				cwd: root,
				seconds: 30,
				prompt: "read my old chats",
			});

			const read = yield* readPiSessions({agentDir: temp(), tuvalDir: tuvalStore(root)});
			const [row] = read.sessions;

			assert.isDefined(row);
			assert.strictEqual(row?.backend, "pi");
			assert.strictEqual(row?.firstPrompt, "read my old chats");
			assert.strictEqual(row?.folder, root);
			assert.strictEqual(row?.messageCount, 1);
			assert.strictEqual(row?.lastModified, new Date(at(30)).getTime());
			assert.isFalse(row !== undefined && "branch" in row);
			// Pi's title is a `session_info` entry, and this session has none (#8135).
			assert.isFalse(row !== undefined && "title" in row);
		}),
	);

	/**
	 * #8135: the port asks one title question, so Pi answers it from the field the pin already has —
	 * `SessionInfo.name`, the "user-defined display name from session_info entries" — rather than
	 * leaving Pi with a second answer or none.
	 */
	it.effect("titles a session the operator named, keeping the first prompt beside it", () =>
		Effect.gen(function* () {
			const root = temp();
			writeSession(tuvalStore(root), {
				id: "renamed",
				cwd: root,
				seconds: 35,
				name: "The picker rewrite",
				prompt: "why is the picker empty",
			});

			const read = yield* readPiSessions({agentDir: temp(), tuvalDir: tuvalStore(root)});
			const [row] = read.sessions;

			assert.strictEqual(row?.title, "The picker rewrite");
			assert.strictEqual(row?.firstPrompt, "why is the picker empty");
		}),
	);

	// The pin writes "(no messages)" as `firstMessage` for a session holding none, which is a label
	// rather than something the operator typed.
	it.effect("leaves the first prompt absent for a session that holds no message", () =>
		Effect.gen(function* () {
			const root = temp();
			writeSession(tuvalStore(root), {id: "silent", cwd: root, seconds: 40});

			const read = yield* readPiSessions({agentDir: temp(), tuvalDir: tuvalStore(root)});
			const [row] = read.sessions;

			assert.isFalse(row !== undefined && "firstPrompt" in row);
			assert.strictEqual(row?.messageCount, 0);
		}),
	);

	it.effect("deduplicates by session id when one store is configured over the other", () =>
		Effect.gen(function* () {
			const agentDir = temp();
			const shared = cliStore(agentDir, "--work-phoenix--");
			writeSession(shared, {id: "counted-once", cwd: "/work/phoenix", seconds: 50});

			const read = yield* readPiSessions({agentDir, tuvalDir: shared});

			assert.deepStrictEqual(
				read.sessions.map((row) => row.sessionId),
				["counted-once"],
			);
		}),
	);

	it.effect("answers a store that was never written as no sessions rather than a failure", () =>
		Effect.gen(function* () {
			const read = yield* readPiSessions({
				agentDir: temp(),
				tuvalDir: join(temp(), "never-written"),
			});

			assert.deepStrictEqual(read.sessions, []);
			assert.deepStrictEqual(read.failures, []);
			assert.deepStrictEqual([...read.answered], ["pi-cli", "tuval"]);
		}),
	);

	it.effect("keeps the readable store's rows when the other cannot be read", () =>
		Effect.gen(function* () {
			const agentDir = temp();
			writeSession(cliStore(agentDir, "--work-phoenix--"), {
				id: "still-listed",
				cwd: "/work/phoenix",
				seconds: 60,
			});
			const broken = join(temp(), "pi-sessions");
			writeFileSync(broken, "not a directory\n");

			const read = yield* readPiSessions({agentDir, tuvalDir: broken});

			assert.deepStrictEqual(
				read.sessions.map((row) => row.sessionId),
				["still-listed"],
			);
			assert.deepStrictEqual([...read.answered], ["pi-cli"]);
			assert.strictEqual(read.failures.length, 1);
			assert.strictEqual(read.failures[0]?.store, "tuval");
		}),
	);

	it.effect("answers nothing when neither store could be read", () =>
		Effect.gen(function* () {
			const brokenAgentDir = temp();
			writeFileSync(join(brokenAgentDir, "sessions"), "not a directory\n");
			const brokenTuvalDir = join(temp(), "pi-sessions");
			writeFileSync(brokenTuvalDir, "not a directory\n");

			const read = yield* readPiSessions({
				agentDir: brokenAgentDir,
				tuvalDir: brokenTuvalDir,
			});

			assert.deepStrictEqual(read.answered, []);
			assert.strictEqual(read.failures.length, 2);
		}),
	);
});
