/**
 * The state leaf: the status line both halves draw, the state→view mapping the window renders, and
 * the predicate the page admits a state through.
 *
 * Pure, so this is a unit test rather than a render test — which is the whole reason `workspaceView`
 * exists as a function instead of as JSX: what the window shows is decided here.
 */

import {describe, expect, it} from "vitest";
import {
	byName,
	closeEvent,
	discardEvent,
	isLive,
	isWorkspaceState,
	LIMIT,
	openEvent,
	REFUSAL_LIMIT,
	type Refusal,
	recorded,
	refused,
	statusLine,
	takenPorts,
	UNATTRIBUTED_LIMIT,
	unowned,
	type WorkspaceRecord,
	type WorkspaceState,
	workspaceView,
} from "./state.ts";

const SEVEN = new Date(2026, 8, 10, 7, 0, 12).getTime();

const record = (over: Partial<WorkspaceRecord> = {}): WorkspaceRecord => ({
	name: "feature-x",
	path: "/repo/.workspaces/feature-x",
	branch: "can/feature-x",
	port: 5174,
	status: "open",
	agent: null,
	detail: null,
	openedAt: SEVEN,
	...over,
});

const state = (over: Partial<WorkspaceState> = {}): WorkspaceState => ({
	repo: "/repo",
	repoName: "repo",
	root: "/repo/.workspaces",
	base: "origin/main",
	workspaces: [],
	pending: null,
	seq: 0,
	spawningFor: null,
	refusals: [],
	unattributed: [],
	...over,
});

const refusal = (over: Partial<Refusal> = {}): Refusal => ({
	name: "feature-x",
	reason: "duplicate",
	at: SEVEN,
	...over,
});

describe("the status line", () => {
	it("says nothing is open when nothing is", () => {
		expect(statusLine(state())).toBe("0 open · nothing open");
	});

	it("counts what is open and spells out the newest, with its port", () => {
		expect(
			statusLine(
				state({
					workspaces: [record(), record({name: "bugfix", port: 5175})],
				}),
			),
		).toBe("2 open · feature-x :5174 idle");
	});

	it("says `running` for a workspace holding an agent", () => {
		expect(statusLine(state({workspaces: [record({agent: "proc-a" as never})]}))).toBe(
			"1 open · feature-x :5174 running",
		);
	});

	it("says what is in flight, by name, over everything else", () => {
		expect(
			statusLine(
				state({
					workspaces: [record()],
					pending: {kind: "open", seq: 1, name: "bugfix", prompt: ""},
				}),
			),
		).toBe("1 open · provisioning bugfix");
		expect(
			statusLine(
				state({
					workspaces: [record()],
					pending: {
						kind: "close",
						seq: 2,
						name: "feature-x",
						force: false,
						stopping: null,
					},
				}),
			),
		).toBe("1 open · closing feature-x");
		expect(
			statusLine(
				state({
					workspaces: [record()],
					pending: {kind: "reconcile", seq: 3},
				}),
			),
		).toBe("1 open · reconciling");
	});

	it("says the newest refusal, because a refusal that says nothing is a button that did nothing", () => {
		expect(statusLine(state({refusals: [refusal({reason: "limit"})]}))).toBe(
			"0 open · nothing open · refused feature-x: limit",
		);
		// An empty name is one of the four refusals, so it gets a word rather than a blank.
		expect(statusLine(state({refusals: [refusal({name: "", reason: "name"})]}))).toBe(
			"0 open · nothing open · refused (unnamed): name",
		);
	});

	it("counts the replies it could not tell apart, and never hides them", () => {
		expect(
			statusLine(
				state({
					workspaces: [record()],
					unattributed: [
						{text: "done", at: SEVEN},
						{text: "also done", at: SEVEN},
					],
				}),
			),
		).toBe("1 open · feature-x :5174 idle · 2 unattributed");
	});

	it("does not count a gone or failed workspace as open, and says which it is", () => {
		expect(statusLine(state({workspaces: [record({status: "gone"})]}))).toBe(
			"0 open · nothing open",
		);
		expect(statusLine(state({workspaces: [record({status: "failed"})]}))).toBe(
			"0 open · nothing open",
		);
	});
});

describe("the bookkeeping helpers", () => {
	it("bounds the list at LIMIT, newest first", () => {
		let list: ReadonlyArray<WorkspaceRecord> = [];
		for (let index = 0; index < LIMIT + 3; index += 1) {
			list = recorded(list, record({name: `w${index}`}));
		}
		expect(list).toHaveLength(LIMIT);
		expect(list[0]?.name).toBe(`w${LIMIT + 2}`);
	});

	it("bounds the refusal list and the unattributed list, newest first", () => {
		let refusals: ReadonlyArray<Refusal> = [];
		for (let index = 0; index < REFUSAL_LIMIT + 3; index += 1) {
			refusals = refused(refusals, refusal({name: `w${index}`}));
		}
		expect(refusals).toHaveLength(REFUSAL_LIMIT);
		expect(refusals[0]?.name).toBe(`w${REFUSAL_LIMIT + 2}`);

		let results: ReadonlyArray<{text: string; at: number}> = [];
		for (let index = 0; index < UNATTRIBUTED_LIMIT + 3; index += 1) {
			results = unowned(results, {text: `t${index}`, at: SEVEN});
		}
		expect(results).toHaveLength(UNATTRIBUTED_LIMIT);
		expect(results[0]?.text).toBe(`t${UNATTRIBUTED_LIMIT + 2}`);
	});

	it("finds by name, and answers nothing for one it does not hold", () => {
		const held = state({workspaces: [record()]});
		expect(byName(held, "feature-x")?.port).toBe(5174);
		expect(byName(held, "never")).toBeUndefined();
	});

	it("counts only live workspaces' ports as taken, so a gone one frees its port", () => {
		expect(
			takenPorts(
				state({
					workspaces: [
						record({port: 5174}),
						record({name: "gone-one", port: 5175, status: "gone"}),
						record({name: "no-port", port: null}),
					],
				}),
			),
		).toEqual([5174]);
	});

	it("calls provisioning, open and closing live, and gone and failed not", () => {
		expect(
			(["provisioning", "open", "closing", "failed", "gone"] as const).map((status) =>
				isLive(record({status})),
			),
		).toEqual([true, true, true, false, false]);
	});
});

describe("the window's view", () => {
	it("resolves each declared input into a line the window can draw", () => {
		const view = workspaceView(
			state({
				workspaces: [record({agent: "proc-a" as never, detail: "two files"})],
			}),
		);
		expect(view.repoName).toBe("repo");
		expect(view.rows).toEqual([
			{
				key: `feature-x-${SEVEN}`,
				name: "feature-x",
				path: "/repo/.workspaces/feature-x",
				branch: "can/feature-x",
				port: ":5174",
				status: "open",
				agent: "running",
				detail: "two files",
				closable: true,
			},
		]);
	});

	it("shows an em dash where there is no port yet", () => {
		expect(
			workspaceView(state({workspaces: [record({port: null, status: "provisioning"})]})).rows[0]
				?.port,
		).toBe("—");
	});

	it("disables every control while something is in flight", () => {
		const view = workspaceView(
			state({
				workspaces: [record()],
				pending: {
					kind: "close",
					seq: 1,
					name: "feature-x",
					force: false,
					stopping: null,
				},
			}),
		);
		expect(view.busy).toBe(true);
		expect(view.canOpen).toBe(false);
		expect(view.rows[0]?.closable).toBe(false);
	});

	it("refuses another open at the bound", () => {
		const full = Array.from({length: LIMIT}, (_, index) => record({name: `w${index}`}));
		expect(workspaceView(state({workspaces: full})).canOpen).toBe(false);
		expect(workspaceView(state({workspaces: full.slice(1)})).canOpen).toBe(true);
	});

	it("spells a refusal out, where the status line only had room for one word", () => {
		const view = workspaceView(state({refusals: [refusal({name: "", reason: "name"})]}));
		expect(view.refusals).toEqual([
			{
				key: `${SEVEN}-0`,
				name: "(unnamed)",
				text: "not a name a branch and a directory can both be called",
			},
		]);
	});

	it("shows the unowned replies with the one line saying why they are unowned", () => {
		const view = workspaceView(state({unattributed: [{text: "done, two files", at: SEVEN}]}));
		expect(view.unattributed).toEqual([{key: `${SEVEN}-0`, text: "done, two files"}]);
		expect(view.unattributedNote).toContain("a reply carries no sender");
		expect(workspaceView(state()).unattributedNote).toBe("");
	});

	it("names the spell in its empty line, so the window teaches the palette", () => {
		expect(workspaceView(state()).empty).toContain(":workspace open <name>");
	});

	it("draws the same sentence the tile does, from the same function", () => {
		const held = state({workspaces: [record()]});
		expect(workspaceView(held).status).toBe(statusLine(held));
	});
});

describe("the predicate the page admits a state through", () => {
	it("admits a real one", () => {
		expect(isWorkspaceState(state({workspaces: [record()]}))).toBe(true);
	});

	it("refuses a state from a kernel one commit older, rather than throwing in React", () => {
		const {repoName: _dropped, ...older} = state();
		expect(isWorkspaceState(older)).toBe(false);
		expect(isWorkspaceState(null)).toBe(false);
		expect(isWorkspaceState("workspace")).toBe(false);
	});

	it("refuses a state whose refusal or unattributed list is not one", () => {
		expect(isWorkspaceState({...state(), refusals: [{name: "x"}]})).toBe(false);
		expect(
			isWorkspaceState({
				...state(),
				refusals: [refusal({reason: "sleepy" as never})],
			}),
		).toBe(false);
		expect(isWorkspaceState({...state(), unattributed: [{text: 7, at: 1}]})).toBe(false);
	});

	it("refuses a record whose status is not one of the five", () => {
		expect(isWorkspaceState(state({workspaces: [record({status: "sleeping" as never})]}))).toBe(
			false,
		);
	});
});

describe("the events the window's controls send", () => {
	it("builds the same arrivals the two spells put on the two ports", () => {
		expect(openEvent("feature-x")).toEqual({
			type: "open",
			payload: {name: "feature-x"},
		});
		expect(closeEvent("feature-x")).toEqual({
			type: "close",
			payload: {name: "feature-x"},
		});
	});

	it("keeps the forcing one a different event with a different name", () => {
		// The Close button reaches `closeEvent` and nothing else; there is no flag on it that forces.
		expect(discardEvent("feature-x")).toEqual({
			type: "discard",
			payload: {name: "feature-x"},
		});
		expect(closeEvent("feature-x").type).not.toBe(discardEvent("feature-x").type);
	});

	it("hands back a fresh object each time, so no caller holds a shared one", () => {
		expect(openEvent("a")).not.toBe(openEvent("a"));
	});
});
