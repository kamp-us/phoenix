import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {INCOMPLETE_REGISTRY, IO_UNKNOWN, SCHEMA_DRIFT} from "./codes.ts";
import {assembleSchema, serializeSchema} from "./json-schema.ts";
import {type KeyGroup, register} from "./key-group.ts";
import {KEY_GROUPS} from "./registry.ts";
import {runSchema, type SchemaRead, type SchemaRoot, type SchemaSave} from "./schema-verb.ts";

const complete = assembleSchema(KEY_GROUPS);
if (complete._tag !== "Complete") throw new Error("fixture: registry is not complete");
const committed = serializeSchema(complete.schema);

const AT_ROOT: SchemaRoot = {_tag: "Root", root: "/repo"};

const run = (opts: {
	write: boolean;
	read: SchemaRead;
	save?: (text: string) => SchemaSave;
	root?: SchemaRoot;
}) => {
	const saves: string[] = [];
	const reads: string[] = [];
	const outcome = Effect.runSync(
		runSchema({
			write: opts.write,
			json: false,
			registrations: KEY_GROUPS,
			root: opts.root ?? AT_ROOT,
			read: (root) => {
				reads.push(root);
				return Effect.succeed(opts.read);
			},
			save: (_root, text) => {
				saves.push(text);
				return Effect.succeed(opts.save ? opts.save(text) : ({_tag: "Saved"} satisfies SchemaSave));
			},
		}),
	);
	return {outcome, saves, reads};
};

const noFragment: KeyGroup<string> = {
	key: "no-fragment",
	shippedDefault: "",
	decode: () => ({_tag: "Value", value: ""}),
};

describe("reconcile", () => {
	it("agrees when the committed file matches the assembled schema", () => {
		const {outcome} = run({write: false, read: {_tag: "Text", text: committed}});
		expect(outcome.code).toBe(0);
		expect(outcome.stdout).toContain("schema\tagrees\t16");
	});

	it("agrees whatever the committed file's whitespace, comparing content not bytes", () => {
		const reformatted = JSON.stringify(complete.schema, null, 4);
		const {outcome} = run({write: false, read: {_tag: "Text", text: reformatted}});
		expect(outcome.code).toBe(0);
	});

	it("reds drift when the committed content differs", () => {
		const stale = JSON.stringify({...complete.schema, title: "changed"});
		const {outcome} = run({write: false, read: {_tag: "Text", text: stale}});
		expect(outcome.code).toBe(SCHEMA_DRIFT);
		expect(outcome.stdout).toBe("");
	});

	it("reds drift on an absent file — the schema was never committed", () => {
		const {outcome} = run({write: false, read: {_tag: "Absent"}});
		expect(outcome.code).toBe(SCHEMA_DRIFT);
		expect(outcome.stderr.some((line) => line.includes("not committed"))).toBe(true);
	});

	it("reds drift on committed bytes that are not JSON at all", () => {
		const {outcome} = run({write: false, read: {_tag: "Text", text: "not json {"}});
		expect(outcome.code).toBe(SCHEMA_DRIFT);
	});

	it("is UNKNOWN when the file could not be read — never drift", () => {
		const {outcome} = run({write: false, read: {_tag: "Failed", reason: "EACCES"}});
		expect(outcome.code).toBe(IO_UNKNOWN);
		expect(outcome.stderr.some((line) => line.includes("EACCES"))).toBe(true);
	});
});

describe("write", () => {
	it("renders the file from the registry and reports written", () => {
		const {outcome, saves} = run({write: true, read: {_tag: "Absent"}});
		expect(outcome.code).toBe(0);
		expect(outcome.stdout).toContain("schema\twritten\t16");
		expect(saves).toHaveLength(1);
		expect(saves[0]).toBe(committed);
	});

	it("is UNKNOWN when the write fails", () => {
		const {outcome} = run({
			write: true,
			read: {_tag: "Absent"},
			save: () => ({_tag: "Failed", reason: "ENOSPC"}),
		});
		expect(outcome.code).toBe(IO_UNKNOWN);
	});
});

describe("a repo root nobody located", () => {
	const unlocated: SchemaRoot = {_tag: "Unlocated", reason: "EACCES walking above /somewhere"};

	it("is UNKNOWN on the reconcile, never drift, and reads no file", () => {
		const {outcome, reads} = run({write: false, read: {_tag: "Absent"}, root: unlocated});
		expect(outcome.code).toBe(IO_UNKNOWN);
		expect(outcome.code).not.toBe(SCHEMA_DRIFT);
		expect(outcome.stderr.some((line) => line.includes("EACCES walking above"))).toBe(true);
		expect(reads).toHaveLength(0);
	});

	it("is UNKNOWN on --write, and renders the file nowhere", () => {
		const {outcome, saves} = run({write: true, read: {_tag: "Absent"}, root: unlocated});
		expect(outcome.code).toBe(IO_UNKNOWN);
		expect(saves).toHaveLength(0);
	});
});

describe("an incomplete registry refuses before touching the file", () => {
	it("names the key with no fragment", () => {
		const saves: string[] = [];
		const outcome = Effect.runSync(
			runSchema({
				write: true,
				json: false,
				registrations: [...KEY_GROUPS, register(noFragment)],
				root: AT_ROOT,
				read: () => Effect.succeed({_tag: "Absent"} satisfies SchemaRead),
				save: (_root, text) => {
					saves.push(text);
					return Effect.succeed({_tag: "Saved"} satisfies SchemaSave);
				},
			}),
		);
		expect(outcome.code).toBe(INCOMPLETE_REGISTRY);
		expect(outcome.stderr.some((line) => line.includes("no-fragment"))).toBe(true);
		expect(saves).toHaveLength(0);
	});
});
