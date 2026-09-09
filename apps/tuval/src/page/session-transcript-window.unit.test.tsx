/**
 * @vitest-environment jsdom
 *
 * The whole read-only transcript path, from the table a page really mounts to the calls that leave
 * over its socket: `pageRenderers` builds the session-list renderer at a scripted `call`, a row is
 * picked, and every assertion below is on what that socket was asked for and what the window
 * rendered from the answer (#8238).
 *
 * It is mounted through `pageRenderers` rather than through `sessionListWindow` with a stub source,
 * because the fault this file exists to keep out was exactly a window whose seam was never bound:
 * the surface said "reading" forever and every unit around it passed (#8492's hand-verification).
 * The pure half — one reply becoming a landing, a sequence of landings folding into one history —
 * is `./session-transcript.unit.test.ts`.
 */

import {act, cleanup, fireEvent, render, screen, within} from "@testing-library/react";
import {Effect, Stream} from "effect";
import {Socket} from "effect/unstable/socket";
import type {ReactElement} from "react";
import {beforeEach, describe, expect, it} from "vitest";
import type {SessionListState} from "../ai-agent/renderer-ref.ts";
import {SESSION_LIST_STATE} from "../ai-agent/renderer-ref.ts";
import {claudeSession} from "../ai-agent/window/fixtures.ts";
import {SESSION_LIST_WINDOW_REF} from "../ai-agent/window/index.ts";
import {ProcessId} from "../process/process.ts";
import type {SpellPath} from "../protocol/ids.ts";
import {CallId} from "../protocol/ids.ts";
import type {SpellFailure, SpellReply} from "../protocol/messages.ts";
import {PROTOCOL_VERSION, SpellCall, SpellReplyError, SpellReplyOk} from "../protocol/messages.ts";
import {SESSION_LIST_CALL_PATH} from "../protocol/session-list.ts";
import type {SessionTranscript, TranscriptItemWire} from "../protocol/session-transcript.ts";
import {
	SESSION_TRANSCRIPT_CALL_PATH,
	SESSION_TRANSCRIPT_PATH,
} from "../protocol/session-transcript.ts";
import {installDomShims} from "../shell/ui/dom.testing.ts";
import type {ProcessView, WindowHost} from "../shell/window/index.ts";
import {delivered, WindowId} from "../shell/window/index.ts";
import type {SpellCaller} from "./renderers.tsx";
import {pageRenderers} from "./renderers.tsx";
import {sessionTranscriptCall} from "./session-transcript.ts";

installDomShims();

/**
 * The scripted socket, and it is a **registry** rather than a router with a default arm: it answers
 * only the two addresses the kernel really registers, and refuses anything else the way the kernel
 * does. That is what makes a mis-addressed call fail here — the first cut of this file parked every
 * non-list path, so the page sending the bare `session.transcript` instead of the program-prefixed
 * one passed every assertion below and failed on a real desk (#8238).
 *
 * `session.list` answers at once — this file is not about the list — and a transcript call is
 * parked, so a test decides when a page lands and whether it lands at all. Parking is what makes the
 * two cases that matter reachable: an older read that is still out, and a reply that arrives after
 * the read it belongs to was left behind.
 */
interface Parked {
	readonly spell: SpellCall;
	readonly answer: (reply: SpellReply) => void;
	readonly fail: () => void;
	interrupted: boolean;
}

let parked: Array<Parked> = [];

const ok = (id: string, result: unknown): SpellReply =>
	new SpellReplyOk({
		type: "spell.reply",
		version: PROTOCOL_VERSION,
		id: CallId.make(id),
		ok: true,
		result,
	});

const refusal = (id: string, error: SpellFailure): SpellReply =>
	new SpellReplyError({
		type: "spell.reply",
		version: PROTOCOL_VERSION,
		id: CallId.make(id),
		ok: false,
		error,
	});

const NOT_FOUND: SpellFailure = {
	tag: "tuval/TranscriptError",
	message: 'no session "c-1" is stored for this working directory',
	path: [...SESSION_TRANSCRIPT_CALL_PATH],
};

/** The kernel's own refusal for a path nothing is registered at (`../commands/errors.ts`). */
const unknownSpell = (path: SpellPath): SpellFailure => ({
	tag: "tuval/commands/UnknownSpell",
	message: `no spell is registered at path "${path.join(" ")}"`,
	path,
});

const call: SpellCaller = (spell) =>
	Effect.callback<SpellReply, Socket.SocketError>((resume) => {
		const address = spell.path.join(".");
		if (address === SESSION_LIST_CALL_PATH.join(".")) {
			resume(Effect.succeed(ok(spell.id, {sessions: [claudeSession], unreadable: []})));
			return;
		}
		if (address !== SESSION_TRANSCRIPT_CALL_PATH.join(".")) {
			resume(Effect.succeed(refusal(spell.id, unknownSpell(spell.path))));
			return;
		}
		const pending: Parked = {
			spell,
			answer: (reply) => resume(Effect.succeed(reply)),
			fail: () =>
				resume(
					Effect.fail(
						new Socket.SocketError({
							reason: new Socket.SocketCloseError({code: 1006}),
						}),
					),
				),
			interrupted: false,
		};
		parked.push(pending);
		return Effect.sync(() => {
			pending.interrupted = true;
		});
	});

/**
 * A whole host over the session-list row's own state, because that state is what the page's table
 * admits a renderer over (`./readable-state.tsx`): a stub missing `readProcess` never gets past the
 * admission test, so the surface under assertion would never mount.
 */
const hostFor = (window: string): WindowHost<SessionListState> => ({
	windowId: WindowId.make(window),
	processId: ProcessId.make("p-1"),
	readProcess: Stream.succeed<ProcessView<SessionListState>>({
		_tag: "Live",
		processId: ProcessId.make("p-1"),
		lifecycle: "running",
		revision: 1,
		state: SESSION_LIST_STATE,
	}),
	dispatch: () => Effect.succeed(delivered),
	view: () => null,
	setView: () => Effect.void,
});

const mount = (window = "w-1"): ReactElement => {
	const entry = pageRenderers(call)[SESSION_LIST_WINDOW_REF.ref];
	if (entry === undefined) throw new Error("the page's table has no session-list renderer");
	return <>{entry.render(hostFor(window))}</>;
};

const settle = async (): Promise<void> => {
	await act(async () => {
		await Promise.resolve();
	});
};

/** Mount the page's own window and pick the one row on offer. */
const openSession = async (window = "w-1"): Promise<HTMLElement> => {
	const {container} = render(mount(window));
	await settle();
	fireEvent.keyDown(
		screen.getAllByRole("combobox", {name: "AI agent sessions"})[0] as HTMLElement,
		{
			key: "Enter",
		},
	);
	await settle();
	return container;
};

const item = (id: string): TranscriptItemWire => ({
	kind: "user",
	id,
	timestamp: 1,
	text: `turn ${id}`,
});

/** A page of `count` items ending at `next`, named so the assertions can read the order back. */
const pageOf = (from: number, count: number, next: string | null): SessionTranscript => ({
	items: Array.from({length: count}, (_, index) => item(`m-${from + index}`)),
	next,
});

const answer = async (index: number, reply: (id: string) => SpellReply): Promise<void> => {
	const call = parked[index];
	if (call === undefined) throw new Error(`no call parked at ${index}`);
	await act(async () => {
		call.answer(reply(call.spell.id));
	});
};

const older = (): HTMLElement | null => screen.queryByRole("button", {name: "Load older messages"});

const texts = (container: HTMLElement): ReadonlyArray<string> =>
	within(container)
		.getAllByRole("listitem")
		.map((row) => row.textContent ?? "");

beforeEach(() => {
	parked = [];
});

describe("the scripted socket", () => {
	it("refuses an unregistered path instead of parking it, so a mis-addressed call cannot pass", async () => {
		const bare = sessionTranscriptCall({
			programId: claudeSession.programId,
			sessionId: claudeSession.sessionId,
			cwd: claudeSession.folder ?? "",
			before: null,
			limit: 50,
		});
		const misaddressed = new SpellCall({...bare, path: [...SESSION_TRANSCRIPT_PATH]});

		const reply = await Effect.runPromise(call(misaddressed));

		expect(parked).toHaveLength(0);
		expect(reply.ok).toBe(false);
		expect(reply.ok === false && reply.error.tag).toBe("tuval/commands/UnknownSpell");
	});
});

describe("picking a row", () => {
	it("sends that row's whole address, the newest end of the transcript, and one bounded page", async () => {
		await openSession();

		expect(parked).toHaveLength(1);
		// The program-prefixed address, because that is where the registry holds the spell; the bare
		// `session.transcript` is refused by the socket above and reaches nothing (#8238).
		expect([...(parked[0]?.spell.path ?? [])]).toEqual([...SESSION_TRANSCRIPT_CALL_PATH]);
		expect([...(parked[0]?.spell.path ?? [])].slice(1)).toEqual([...SESSION_TRANSCRIPT_PATH]);
		expect(parked[0]?.spell.args).toEqual({
			programId: claudeSession.programId,
			sessionId: claudeSession.sessionId,
			cwd: claudeSession.folder,
			before: null,
			limit: 50,
		});
		expect(parked[0]?.spell.window).toBe("w-1");
	});

	it("renders the decoded page in place of the reading sentence", async () => {
		const container = await openSession();
		await answer(0, (id) => ok(id, pageOf(1, 2, null)));

		expect(texts(container)).toEqual(["userturn m-1", "userturn m-2"]);
		expect(screen.queryByText("Reading this session's transcript…")).toBeNull();
	});

	it("keeps reading while a reply for another call arrives", async () => {
		await openSession();
		await answer(0, () => ok("another-call", pageOf(1, 2, null)));

		expect(screen.getByText("Reading this session's transcript…")).toBeTruthy();
	});

	it("renders a refused first page as a refusal, never as an empty session", async () => {
		await openSession();
		await answer(0, (id) => refusal(id, NOT_FOUND));

		expect(screen.getByRole("alert").textContent).toContain('no session "c-1" is stored');
		expect(screen.queryByText("This session holds no messages yet.")).toBeNull();
		expect(screen.queryByRole("combobox", {name: "Write a message to the agent"})).toBeNull();
	});

	it("renders a result it cannot decode as a refusal rather than an empty session", async () => {
		await openSession();
		await answer(0, (id) => ok(id, {items: [{kind: "nonsense"}], next: null}));

		expect(screen.getByRole("alert").textContent).toContain("cannot read as a transcript page");
		expect(screen.queryByText("This session holds no messages yet.")).toBeNull();
	});

	it("offers no older affordance on a session whose first page is the whole of it", async () => {
		await openSession();
		await answer(0, (id) => ok(id, pageOf(1, 2, null)));

		expect(older()).toBeNull();
	});
});

describe("paging past the newest fifty", () => {
	it("asks for the reported cursor and keeps what is already on screen", async () => {
		const container = await openSession();
		await answer(0, (id) => ok(id, pageOf(51, 50, "m-51")));

		expect(texts(container)).toHaveLength(50);
		await act(async () => {
			fireEvent.click(older() as HTMLElement);
		});

		expect(parked).toHaveLength(2);
		expect(parked[1]?.spell.args).toMatchObject({before: "m-51", limit: 50});
		expect(screen.getByText("Reading older messages…")).toBeTruthy();
		expect(texts(container)).toHaveLength(50);
	});

	it("puts the older page before the held one, without repeating an overlapping item", async () => {
		const container = await openSession();
		await answer(0, (id) => ok(id, pageOf(51, 50, "m-51")));
		await act(async () => {
			fireEvent.click(older() as HTMLElement);
		});
		// The store re-reads the cursor's own row, so `m-51` arrives in both pages.
		await answer(1, (id) =>
			ok(id, {items: [...pageOf(1, 50, "m-1").items, item("m-51")], next: null}),
		);

		const rendered = texts(container);
		expect(rendered).toHaveLength(100);
		expect(rendered[0]).toBe("userturn m-1");
		expect(rendered[49]).toBe("userturn m-50");
		expect(rendered[50]).toBe("userturn m-51");
		expect(new Set(rendered).size).toBe(100);
	});

	it("removes the affordance once a page reaches the beginning of history", async () => {
		await openSession();
		await answer(0, (id) => ok(id, pageOf(51, 50, "m-51")));
		await act(async () => {
			fireEvent.click(older() as HTMLElement);
		});
		await answer(1, (id) => ok(id, pageOf(1, 50, null)));

		expect(older()).toBeNull();
		expect(screen.queryByRole("button", {name: "Try the older messages again"})).toBeNull();
	});

	it("never asks for the whole store: three pages are three bounded calls", async () => {
		await openSession();
		await answer(0, (id) => ok(id, pageOf(101, 50, "m-101")));
		await act(async () => {
			fireEvent.click(older() as HTMLElement);
		});
		await answer(1, (id) => ok(id, pageOf(51, 50, "m-51")));
		await act(async () => {
			fireEvent.click(older() as HTMLElement);
		});
		await answer(2, (id) => ok(id, pageOf(1, 50, null)));

		expect(parked.map((sent) => sent.spell.args)).toEqual([
			expect.objectContaining({before: null, limit: 50}),
			expect.objectContaining({before: "m-101", limit: 50}),
			expect.objectContaining({before: "m-51", limit: 50}),
		]);
	});
});

describe("an older page that fails", () => {
	const failFirstOlder = async (): Promise<HTMLElement> => {
		const container = await openSession();
		await answer(0, (id) => ok(id, pageOf(51, 50, "m-51")));
		await act(async () => {
			fireEvent.click(older() as HTMLElement);
		});
		await answer(1, (id) => refusal(id, NOT_FOUND));
		return container;
	};

	it("leaves the history readable and says what failed", async () => {
		const container = await failFirstOlder();

		expect(texts(container)).toHaveLength(50);
		expect(screen.getByRole("alert").textContent).toContain("could not be read");
		expect(screen.getByRole("alert").textContent).toContain('no session "c-1" is stored');
	});

	it("retries the same cursor rather than advancing past the missing page", async () => {
		const container = await failFirstOlder();
		await act(async () => {
			fireEvent.click(screen.getByRole("button", {name: "Try the older messages again"}));
		});

		expect(parked).toHaveLength(3);
		expect(parked[2]?.spell.args).toMatchObject({before: "m-51"});
		await answer(2, (id) => ok(id, pageOf(1, 50, null)));
		expect(texts(container)).toHaveLength(100);
		expect(screen.queryByRole("alert")).toBeNull();
	});
});

describe("scoping", () => {
	it("drops a reply for a read the operator has already left", async () => {
		const container = await openSession();
		await act(async () => {
			fireEvent.click(screen.getByRole("button", {name: "Back to the session list"}));
		});
		fireEvent.keyDown(
			screen.getAllByRole("combobox", {name: "AI agent sessions"})[0] as HTMLElement,
			{
				key: "Enter",
			},
		);
		await settle();

		expect(parked).toHaveLength(2);
		await answer(0, (id) => ok(id, {items: [item("stale")], next: null}));
		await answer(1, (id) => ok(id, {items: [item("fresh")], next: null}));

		expect(texts(container)).toEqual(["userturn fresh"]);
	});

	it("keeps two windows' reads and histories apart", async () => {
		const left = await openSession("w-1");
		const right = await openSession("w-2");

		expect(parked.map((sent) => sent.spell.window)).toEqual(["w-1", "w-2"]);
		await answer(0, (id) => ok(id, {items: [item("left")], next: null}));
		await answer(1, (id) => ok(id, {items: [item("right")], next: null}));

		expect(texts(left)).toEqual(["userturn left"]);
		expect(texts(right)).toEqual(["userturn right"]);
	});
});

describe("the read-only contract", () => {
	it("spends the whole read and both pagings on `session.transcript` and nothing else", async () => {
		await openSession();
		await answer(0, (id) => ok(id, pageOf(51, 50, "m-51")));
		await act(async () => {
			fireEvent.click(older() as HTMLElement);
		});
		await answer(1, (id) => ok(id, pageOf(1, 50, null)));

		expect(new Set(parked.map((sent) => sent.spell.path.join(".")))).toEqual(
			new Set([SESSION_TRANSCRIPT_CALL_PATH.join(".")]),
		);
	});
});

const failRead = async (index: number): Promise<void> => {
	const pending = parked[index];
	if (pending === undefined) throw new Error("missing transcript call");
	await act(async () => {
		pending.fail();
	});
};

describe("transport read failures", () => {
	it("leaves the first read recoverable until one explicit correlated retry succeeds", async () => {
		const container = await openSession();
		expect(screen.queryByRole("combobox", {name: "Write a message to the agent"})).toBeNull();
		await failRead(0);
		expect(screen.queryByRole("combobox", {name: "Write a message to the agent"})).toBeNull();
		expect(screen.queryByText("Reading this session's transcript…")).toBeNull();
		expect(screen.getByRole("alert").textContent).toContain(
			"This transcript page could not be read",
		);
		await settle();
		expect(parked).toHaveLength(1);
		const retry = screen.getByRole("button", {name: "Try reading this transcript again"});
		await act(async () => {
			fireEvent.click(retry);
			fireEvent.click(retry);
		});
		expect(parked).toHaveLength(2);
		expect(parked[1]?.spell.args).toEqual(parked[0]?.spell.args);
		expect(parked[1]?.spell.id).not.toBe(parked[0]?.spell.id);
		expect(parked[1]?.spell.window).toBe("w-1");
		expect(screen.queryByRole("alert")).toBeNull();
		expect(screen.getByText("Reading this session's transcript…")).toBeTruthy();
		expect(screen.queryByRole("combobox", {name: "Write a message to the agent"})).toBeNull();
		await answer(1, (id) => ok(id, pageOf(1, 2, null)));
		expect(screen.getByRole("combobox", {name: "Write a message to the agent"})).toBeTruthy();
		expect(texts(container)).toEqual(["userturn m-1", "userturn m-2"]);
		expect(new Set(parked.map(({spell}) => spell.path.join(".")))).toEqual(
			new Set([SESSION_TRANSCRIPT_CALL_PATH.join(".")]),
		);
	});

	it("retains older history and its cursor across repeated failures and explicit retries", async () => {
		const container = await openSession();
		await answer(0, (id) => ok(id, pageOf(3, 2, "m-3")));
		fireEvent.click(older() as HTMLElement);
		await settle();
		await failRead(1);
		expect(texts(container)).toEqual(["userturn m-3", "userturn m-4"]);
		expect(screen.queryByText("Reading older messages…")).toBeNull();
		const retry = screen.getByRole("button", {name: "Try the older messages again"});
		expect(retry.hasAttribute("disabled")).toBe(false);
		await settle();
		expect(parked).toHaveLength(2);
		await act(async () => {
			fireEvent.click(retry);
			fireEvent.click(retry);
		});
		expect(parked).toHaveLength(3);
		expect(parked[2]?.spell.args).toEqual(parked[1]?.spell.args);
		expect(parked[2]?.spell.id).not.toBe(parked[1]?.spell.id);
		await failRead(2);
		fireEvent.click(screen.getByRole("button", {name: "Try the older messages again"}));
		await settle();
		expect(parked[3]?.spell.args).toMatchObject({before: "m-3"});
		await answer(3, (id) => ok(id, pageOf(1, 2, null)));
		expect(texts(container)).toEqual([
			"userturn m-1",
			"userturn m-2",
			"userturn m-3",
			"userturn m-4",
		]);
		expect(screen.queryByRole("alert")).toBeNull();
		expect(older()).toBeNull();
	});

	it("interrupts a left read silently and ignores its late failure after reopening", async () => {
		const container = await openSession();
		fireEvent.click(screen.getByRole("button", {name: "Back to the session list"}));
		await settle();
		expect(parked[0]?.interrupted).toBe(true);
		expect(screen.queryByRole("alert")).toBeNull();
		fireEvent.keyDown(screen.getByRole("combobox", {name: "AI agent sessions"}), {key: "Enter"});
		await settle();
		await failRead(0);
		expect(screen.queryByRole("alert")).toBeNull();
		expect(screen.getByText("Reading this session's transcript…")).toBeTruthy();
		await answer(1, (id) => ok(id, pageOf(1, 1, null)));
		expect(texts(container)).toEqual(["userturn m-1"]);
	});

	it("interrupts an older read on unmount without retrying or leaking a failure", async () => {
		await openSession();
		await answer(0, (id) => ok(id, pageOf(3, 2, "m-3")));
		fireEvent.click(older() as HTMLElement);
		await settle();
		cleanup();
		await settle();
		expect(parked[1]?.interrupted).toBe(true);
		await failRead(1);
		expect(parked).toHaveLength(2);
		expect(screen.queryByRole("alert")).toBeNull();
	});
});
