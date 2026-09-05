import {Duration, Result} from "effect";
import {describe, expect, it} from "vitest";
import {idle, route} from "./router.ts";
import {normalize} from "./syntax.ts";
import {
	applyKeysConfig,
	CommandName,
	defaultPrefixTable,
	type KeysConfig,
	normalizeSequence,
} from "./table.ts";

const rows = defaultPrefixTable.bindings.map(
	(binding) => [binding.sequence, binding.command, binding.repeatable] as const,
);

describe("defaultPrefixTable", () => {
	it("is exactly the founder's tmux bindings", () => {
		expect(defaultPrefixTable.prefix).toBe("<c-b>");
		expect(Duration.toMillis(defaultPrefixTable.repeatTimeout)).toBe(500);
		expect(Object.keys(defaultPrefixTable).sort()).toEqual(["bindings", "prefix", "repeatTimeout"]);
		expect(rows).toEqual([
			["|", "window:split-vertical", false],
			["-", "window:split-horizontal", false],
			["h", "window:focus-left", false],
			["j", "window:focus-down", false],
			["k", "window:focus-up", false],
			["l", "window:focus-right", false],
			["<arrowleft>", "window:focus-left", false],
			["<arrowdown>", "window:focus-down", false],
			["<arrowup>", "window:focus-up", false],
			["<arrowright>", "window:focus-right", false],
			["z", "window:zoom", false],
			["x", "window:close", false],
			["N", "workspace:create", false],
			["<c-h>", "workspace:previous", true],
			["<c-l>", "workspace:next", true],
			[":", "command:open", false],
			["r", "config:reload", false],
		]);
	});

	it("leaves the stock tmux splits unbound, as the ruling says", () => {
		const sequences = defaultPrefixTable.bindings.map((binding) => binding.sequence);
		expect(sequences).not.toContain("%");
		expect(sequences).not.toContain('"');
	});

	it("spells every sequence and the prefix the way the router will", () => {
		expect(Result.getOrThrow(normalize(defaultPrefixTable.prefix))).toBe(defaultPrefixTable.prefix);
		for (const binding of defaultPrefixTable.bindings) {
			expect(Result.getOrThrow(normalizeSequence(binding.sequence)).join("")).toBe(
				binding.sequence,
			);
		}
	});
});

describe("normalizeSequence()", () => {
	it("splits a sequence into its keys, each in its one spelling", () => {
		expect(Result.getOrThrow(normalizeSequence("<C-b>x"))).toEqual(["<c-b>", "x"]);
		expect(Result.getOrThrow(normalizeSequence("<Left>"))).toEqual(["<arrowleft>"]);
	});

	it("refuses a sequence the key grammar cannot read, naming it and why", () => {
		const refusal = Result.merge(normalizeSequence("<ctrl-a>"));
		expect(refusal).toEqual({
			_tag: "UnreadableSequenceError",
			sequence: "<ctrl-a>",
			reason: "Invalid key: <ctrl-a>",
			message: 'unreadable key sequence "<ctrl-a>": Invalid key: <ctrl-a>',
		});
	});

	it("refuses the empty sequence", () => {
		expect(Result.merge(normalizeSequence(""))).toMatchObject({reason: "empty sequence"});
	});

	it("refuses a sequence whose keys spell nothing, not just an empty input", () => {
		expect(Result.merge(normalizeSequence("<Shift>"))).toMatchObject({
			sequence: "<Shift>",
			reason: "Invalid key: <Shift>",
		});
	});
});

describe("applyKeysConfig()", () => {
	it("refuses a prefix that spells no key, and keeps the table it had", () => {
		// `<Shift>` used to be stored as the empty prefix, which the router can never match — the
		// shell was silently unarmable for the rest of the session (#7499).
		expect(Result.merge(applyKeysConfig(defaultPrefixTable, {prefix: "<Shift>"}))).toMatchObject({
			_tag: "UnreadableSequenceError",
			sequence: "<Shift>",
		});
	});

	it("replaces a binding with the same sequence in place, and appends a new one", () => {
		const table = Result.getOrThrow(
			applyKeysConfig(defaultPrefixTable, {
				bindings: [
					{sequence: "x", command: CommandName.make("workspace:remove"), repeatable: false},
					{sequence: "%", command: CommandName.make("window:split-vertical"), repeatable: false},
				],
			}),
		);
		expect(table.bindings).toHaveLength(defaultPrefixTable.bindings.length + 1);
		expect(route(table, route(table, idle, {key: "b", ctrlKey: true}).next, {key: "x"})).toEqual({
			_tag: "Command",
			name: CommandName.make("workspace:remove"),
			next: idle,
		});
		expect(table.bindings.at(-1)).toEqual({
			sequence: "%",
			command: "window:split-vertical",
			repeatable: false,
		});
	});

	it("matches a rebind however the config spells the modifiers", () => {
		const table = Result.getOrThrow(
			applyKeysConfig(defaultPrefixTable, {
				bindings: [
					{sequence: "<C-l>", command: CommandName.make("window:close"), repeatable: false},
				],
			}),
		);
		expect(table.bindings).toHaveLength(defaultPrefixTable.bindings.length);
		expect(table.bindings.find((binding) => binding.sequence === "<C-l>")).toEqual({
			sequence: "<C-l>",
			command: "window:close",
			repeatable: false,
		});
		expect(table.bindings.map((binding) => binding.command)).not.toContain("workspace:next");
	});

	it("changes the prefix, and the new prefix is what arms the shell", () => {
		const table = Result.getOrThrow(applyKeysConfig(defaultPrefixTable, {prefix: "<C-a>"}));
		expect(table.prefix).toBe("<c-a>");
		expect(route(table, idle, {key: "a", ctrlKey: true})._tag).toBe("Arm");
		expect(route(table, idle, {key: "b", ctrlKey: true})).toEqual({
			_tag: "ToWindow",
			key: "<c-b>",
			next: idle,
		});
	});

	it("takes the repeat window a config sets, and merges no other duration (#7842)", () => {
		const table = Result.getOrThrow(
			applyKeysConfig(defaultPrefixTable, {repeatTimeout: Duration.millis(250)}),
		);
		expect(Duration.toMillis(table.repeatTimeout)).toBe(250);
		expect(Object.keys(table).sort()).toEqual(["bindings", "prefix", "repeatTimeout"]);
	});

	// The type says a config cannot name an arm timeout; this says the merge does not carry an
	// untyped one through either, so a JS config module cannot smuggle a bounded arm back in.
	it("drops an arm timeout a config module smuggles past the type", () => {
		const table = Result.getOrThrow(
			applyKeysConfig(defaultPrefixTable, {armTimeout: Duration.millis(1000)} as KeysConfig),
		);
		expect(Object.keys(table).sort()).toEqual(["bindings", "prefix", "repeatTimeout"]);
	});

	it("refuses the whole config on one unreadable sequence, so no table is half-applied", () => {
		const refused = applyKeysConfig(defaultPrefixTable, {
			bindings: [
				{sequence: "z", command: CommandName.make("window:close"), repeatable: false},
				{sequence: "<ctrl-a>", command: CommandName.make("window:close"), repeatable: false},
			],
		});
		expect(Result.isFailure(refused)).toBe(true);
		expect(Result.merge(refused)).toMatchObject({
			_tag: "UnreadableSequenceError",
			sequence: "<ctrl-a>",
		});
	});

	it("refuses a prefix the key grammar cannot read", () => {
		expect(Result.merge(applyKeysConfig(defaultPrefixTable, {prefix: "ab"}))).toMatchObject({
			_tag: "UnreadableSequenceError",
			sequence: "ab",
		});
	});
});
