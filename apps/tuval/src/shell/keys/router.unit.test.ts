import {Duration, Result} from "effect";
import {describe, expect, it} from "vitest";
import {idle, type PrefixState, type RouteAnswer, route} from "./router.ts";
import type {Key} from "./syntax.ts";
import {applyKeysConfig, CommandName, defaultPrefixTable, type PrefixTable} from "./table.ts";

const table = defaultPrefixTable;

const ctrl = (key: string) => ({key, ctrlKey: true});

/** Every key of `sequence` in order, each against the state the last answer left behind. */
const walk = (
	from: PrefixState,
	events: ReadonlyArray<Key>,
	on: PrefixTable = table,
): ReadonlyArray<RouteAnswer> => {
	let state = from;
	const answers: Array<RouteAnswer> = [];
	for (const event of events) {
		const answer = route(on, state, event);
		answers.push(answer);
		state = answer.next;
	}
	return answers;
};

const armed = route(table, idle, ctrl("b")).next;

describe("route() with the prefix unarmed", () => {
	it("sends every key to the focused window", () => {
		for (const [event, key] of [
			[{key: "a"}, "a"],
			[{key: "Z", shiftKey: true}, "Z"],
			[{key: "1"}, "1"],
			[{key: ":"}, ":"],
			[{key: "|"}, "|"],
			[ctrl("w"), "<c-w>"],
			[{key: "ArrowLeft"}, "<arrowleft>"],
			[{key: "Enter"}, "<enter>"],
		] as const) {
			expect(route(table, idle, event)).toEqual({_tag: "ToWindow", key, next: idle});
		}
	});

	it("keeps a bound sequence's key for the window until the prefix arms", () => {
		// `x` is `window:close` after the prefix; on its own it is text the window wants.
		expect(route(table, idle, {key: "x"})).toEqual({_tag: "ToWindow", key: "x", next: idle});
	});

	it("arms on the prefix, and the armed state carries no window: it waits forever (#7842)", () => {
		const answer = route(table, idle, ctrl("b"));
		expect(answer._tag).toBe("Arm");
		expect(answer.next).toEqual({_tag: "Armed", pending: [], repeatWindow: null});
	});
});

describe("route() with the prefix armed", () => {
	it("fires the bound command and disarms", () => {
		expect(route(table, armed, {key: "x"})).toEqual({
			_tag: "Command",
			name: CommandName.make("window:close"),
			next: idle,
		});
	});

	it("drops an unbound sequence and disarms, never forwarding it", () => {
		expect(route(table, armed, {key: "q"})).toEqual({
			_tag: "Unbound",
			sequence: "q",
			next: idle,
		});
	});

	it("arms for exactly one sequence: the key after a command goes to the window", () => {
		const [command, after] = walk(idle, [ctrl("b"), {key: "x"}, {key: "x"}]).slice(1);
		expect(command?._tag).toBe("Command");
		expect(after).toEqual({_tag: "ToWindow", key: "x", next: idle});
	});

	it("reads a chord and a bare character the same way", () => {
		expect(route(table, armed, ctrl("h"))).toEqual({
			_tag: "Command",
			name: CommandName.make("workspace:previous"),
			next: {_tag: "Armed", pending: [], repeatWindow: table.repeatTimeout},
		});
	});
});

describe("route() and repeatable bindings", () => {
	it("keeps the prefix armed for the repeat window, so one prefix walks two workspaces", () => {
		const answers = walk(idle, [ctrl("b"), ctrl("l"), ctrl("l")]);
		expect(answers.map((answer) => answer._tag)).toEqual(["Arm", "Command", "Command"]);
		const [, first, second] = answers;
		expect(first).toMatchObject({name: CommandName.make("workspace:next")});
		expect(second).toMatchObject({name: CommandName.make("workspace:next")});
		expect(first?.next).toEqual({_tag: "Armed", pending: [], repeatWindow: table.repeatTimeout});
		expect(Duration.toMillis(table.repeatTimeout)).toBe(500);
	});

	it("disarms at once after a command that is not repeatable", () => {
		const answers = walk(idle, [ctrl("b"), {key: "j"}, {key: "j"}]);
		expect(answers.map((answer) => answer._tag)).toEqual(["Arm", "Command", "ToWindow"]);
	});

	it("drops an unbound key inside the repeat window and disarms", () => {
		const answers = walk(idle, [ctrl("b"), ctrl("l"), {key: "q"}]);
		expect(answers.at(-1)).toEqual({_tag: "Unbound", sequence: "q", next: idle});
	});
});

describe("route() and multi-key sequences", () => {
	const twoKey = Result.getOrThrow(
		applyKeysConfig(table, {
			bindings: [{sequence: "gt", command: CommandName.make("workspace:next"), repeatable: false}],
		}),
	);

	it("answers pending while the sequence is still the start of a binding", () => {
		const answers = walk(idle, [ctrl("b"), {key: "g"}, {key: "t"}], twoKey);
		expect(answers.map((answer) => answer._tag)).toEqual(["Arm", "Pending", "Command"]);
		expect(answers[1]?.next).toEqual({
			_tag: "Armed",
			pending: ["g"],
			repeatWindow: null,
		});
	});

	it("drops the whole sequence once no binding can still match", () => {
		const answers = walk(idle, [ctrl("b"), {key: "g"}, {key: "z"}], twoKey);
		expect(answers.at(-1)).toEqual({_tag: "Unbound", sequence: "gz", next: idle});
	});
});

describe("route() and keys that name nothing", () => {
	it("leaves the state untouched on a bare modifier press", () => {
		for (const state of [idle, armed]) {
			for (const key of ["Control", "Shift", "Alt", "Meta", "Unidentified"]) {
				expect(route(table, state, {key})).toEqual({_tag: "Pending", next: state});
			}
		}
	});
});
