import {Effect, Schema} from "effect";
import {describe, expect, it} from "vitest";
import {RegistryDescription} from "../../protocol/registry-description.ts";
import {scope, table} from "../core/fixtures.ts";
import {helpSpell, segmentsOf} from "../core/help.ts";
import {spellDescribe} from "../core/spell.ts";
import {buildRegistry, describeSpell, SpellRegistry} from "../registry.ts";
import {REST_PARAMETER_ANNOTATION, RestParameter} from "../rest-parameter.ts";
import {defineSpell} from "../spell.ts";
import {complete} from "./complete.ts";
import {registry, snapshot} from "./fixtures.ts";
import {parse} from "./parse.ts";
import {buildSpellIndex, InvalidRestParameter, readParams} from "./spell-index.ts";

const document = (params: Schema.Top) =>
	Schema.toJsonSchemaDocument(params, {
		includeAnnotationKey: (key) => key === REST_PARAMETER_ANNOTATION,
	});

const echo = (params: Schema.Top) =>
	defineSpell({
		path: ["echo"],
		describe: "Return the supplied text.",
		params,
		result: Schema.Unknown,
		execute: (args: unknown) => Effect.succeed(args),
		capabilities: [],
	});

const indexFor = (params: Schema.Top) =>
	buildSpellIndex([
		{path: ["echo"], describe: "Return text.", params: document(params), capabilities: []},
	]);

describe("rest declarations", () => {
	it("keeps optionality, annotations and rest through registration and the wire", () => {
		const built = Effect.runSync(buildRegistry({core: [helpSpell, spellDescribe], programs: []}));
		const codec = Schema.toCodecJson(RegistryDescription);
		const wire = Schema.encodeSync(codec)(built.rows.map(describeSpell));
		const descriptions = Schema.decodeUnknownSync(codec)(wire);
		expect(descriptions.map((row) => readParams(row.params))).toEqual([
			[{name: "path", required: false, rest: true}],
			[{name: "path", required: true, rest: true}],
		]);
		const annotated = Effect.runSync(
			buildRegistry({
				core: [
					echo(
						Schema.Struct({text: RestParameter.annotate({description: "Text", unrelated: true})}),
					),
				],
				programs: [],
			}),
		);
		expect(annotated.rows[0]?.paramsDocument.schema.properties).toEqual({
			text: {type: "string", description: "Text", "x-command-rest": true},
		});
	});

	it("reads rest through a referenced property and a referenced root", () => {
		const params = Schema.Struct({
			text: Schema.optionalKey(RestParameter.annotate({identifier: "RestText"})),
		}).annotate({identifier: "RestArgs"});
		expect(readParams(document(params))).toEqual([{name: "text", required: false, rest: true}]);
	});

	it.each([
		Schema.Struct({text: RestParameter, after: Schema.String}),
		Schema.Struct({first: RestParameter, second: RestParameter}),
		Schema.Struct({text: Schema.Boolean.annotate({"x-command-rest": true})}),
		Schema.Struct({text: Schema.Literals(["one", "two"]).annotate({"x-command-rest": true})}),
		Schema.Struct({text: Schema.String.annotate({"x-command-rest": "yes"})}),
	])("rejects invalid rest declarations when building the index and registry", (params) => {
		expect(() => indexFor(params)).toThrow(InvalidRestParameter);
		const failure = Effect.runSync(
			Effect.flip(buildRegistry({core: [echo(params)], programs: []})),
		);
		expect(failure._tag).toBe("tuval/commands/SpellNotDescribable");
		expect(failure.message).toContain("rest parameter");
	});
});

describe("rest binding", () => {
	const index = indexFor(Schema.Struct({mode: Schema.String, text: RestParameter}));

	it.each([
		["echo plain two words", "two words"],
		["echo plain two words ", "two words"],
		['echo plain ""', ""],
		['echo plain hello ""', "hello "],
		['echo plain "two  spaces" next', "two  spaces next"],
		["echo plain file.name mode=value text=more", "file.name mode=value text=more"],
		["echo mode=plain text=two words", "two words"],
		['echo plain say\\ \\"hi\\" now', 'say "hi" now'],
	])("binds %s without rewriting its contents", (line, text) => {
		expect(parse(line, index, snapshot)).toEqual({
			_tag: "Complete",
			call: {path: ["echo"], args: {mode: "plain", text}},
		});
	});

	it("requires the preceding arguments even when rest is addressed by name first", () => {
		expect(parse("echo text=hello mode=plain", index, snapshot)).toMatchObject({
			_tag: "Partial",
			cursorArg: {name: "mode"},
		});
	});

	it("leaves unannotated surplus and rebinding refusals unchanged", () => {
		expect(parse("workspace rename a b c", registry, snapshot)).toEqual({
			_tag: "Refused",
			position: 21,
			expected: "no further arguments",
		});
		expect(parse("echo mode=plain mode=other", index, snapshot)).toMatchObject({
			_tag: "Refused",
			expected: "mode is already bound",
		});
	});

	it("keeps every prefix of a multiword line usable", () => {
		const line = 'echo plain "two  spaces" file.name text=value';
		for (let length = 0; length <= line.length; length += 1) {
			expect(parse(line.slice(0, length), index, snapshot)._tag).not.toBe("Refused");
		}
	});

	it("offers no candidates anywhere in rest, even for a live-value parameter name", () => {
		const liveName = indexFor(Schema.Struct({workspace: RestParameter}));
		for (const line of [
			"echo ",
			"echo scr",
			"echo scratch ",
			"echo scratch ws",
			'echo "scratch ws',
		]) {
			expect(complete(line, liveName, snapshot)).toEqual([]);
		}
		expect(parse("echo ", liveName, snapshot)).toMatchObject({_tag: "Partial"});
		expect(
			parse("echo", indexFor(Schema.Struct({text: Schema.optionalKey(RestParameter)})), snapshot),
		).toMatchObject({_tag: "Complete", call: {args: {}}});
	});
});

describe("discovery command paths", () => {
	const built = Effect.runSync(table);
	const index = buildSpellIndex(built.rows.map(describeSpell));

	it.each([
		"window close",
		'"window close"',
		"window.close",
	])("help and spell describe resolve %s to the same registered command", (value) => {
		const help = parse(`help ${value}`, index, snapshot);
		const describe = parse(`spell describe ${value}`, index, snapshot);
		expect(help._tag).toBe("Complete");
		expect(describe._tag).toBe("Complete");
		if (help._tag !== "Complete" || describe._tag !== "Complete") return;
		const args = Schema.decodeUnknownSync(spellDescribe.params)(describe.call.args);
		expect(segmentsOf(args.path)).toEqual(["window", "close"]);
		const found = Effect.runSync(
			spellDescribe.execute(args, scope).pipe(Effect.provide(SpellRegistry.layer(built))),
		);
		expect(found.path).toEqual(["window", "close"]);
		const rows = Effect.runSync(
			helpSpell
				.execute(Schema.decodeUnknownSync(helpSpell.params)(help.call.args), scope)
				.pipe(Effect.provide(SpellRegistry.layer(built))),
		);
		expect(rows.map((row) => row.path)).toEqual(["window close"]);
	});
});
