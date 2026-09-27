import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {INCOMPLETE_REGISTRY, IO_UNKNOWN, SCHEMA_DRIFT} from "./codes.ts";
import {
	assembleLocalSchema,
	assembleSchema,
	CONFIG_SCHEMA_FILE,
	LOCAL_CONFIG_SCHEMA_FILE,
	serializeSchema,
} from "./json-schema.ts";
import {type KeyGroup, register} from "./key-group.ts";
import {KEY_GROUPS} from "./registry.ts";
import {runSchema, type SchemaRead, type SchemaRoot, type SchemaSave} from "./schema-verb.ts";

const complete = assembleSchema(KEY_GROUPS);
if (complete._tag !== "Complete") throw new Error("fixture: registry is not complete");
const committed = serializeSchema(complete.schema);

const completeLocal = assembleLocalSchema(KEY_GROUPS);
if (completeLocal._tag !== "Complete") throw new Error("fixture: local registry is not complete");
const committedLocal = serializeSchema(completeLocal.schema);

/** The bytes each committed file holds when both agree — the fixture a drift case perturbs. */
const AGREEING_READS: Readonly<Record<string, SchemaRead>> = {
	[CONFIG_SCHEMA_FILE]: {_tag: "Text", text: committed},
	[LOCAL_CONFIG_SCHEMA_FILE]: {_tag: "Text", text: committedLocal},
};

// The count is read off the registry, not written down: a new key is a one-line registration, and a
// literal here turns that into a two-file change with no extra assurance.
const KEY_COUNT = KEY_GROUPS.length;

const AT_ROOT: SchemaRoot = {_tag: "Root", root: "/repo"};

/** One recorded write: which file it landed in, and the bytes. */
interface Save {
	readonly file: string;
	readonly text: string;
}

const run = (opts: {
	write: boolean;
	/** One answer for every file, or the per-file answers. */
	read: SchemaRead | Readonly<Record<string, SchemaRead>>;
	save?: (text: string) => SchemaSave;
	root?: SchemaRoot;
}) => {
	const saves: Array<Save> = [];
	const reads: string[] = [];
	const one = opts.read;
	const isOneRead = (value: typeof one): value is SchemaRead =>
		typeof (value as {_tag?: unknown})._tag === "string";
	const readFor = (file: string): SchemaRead =>
		isOneRead(one) ? one : (one[file] ?? {_tag: "Absent"});
	const outcome = Effect.runSync(
		runSchema({
			write: opts.write,
			json: false,
			registrations: KEY_GROUPS,
			root: opts.root ?? AT_ROOT,
			read: (root, file) => {
				reads.push(`${root}/${file}`);
				return Effect.succeed(readFor(file));
			},
			save: (_root, file, text) => {
				saves.push({file, text});
				return Effect.succeed(opts.save ? opts.save(text) : ({_tag: "Saved"} satisfies SchemaSave));
			},
		}),
	);
	return {outcome, saves, reads};
};

/** The bytes of one committed file, with the rest left agreeing. */
const onlyDiffers = (file: string, read: SchemaRead): Readonly<Record<string, SchemaRead>> => ({
	...AGREEING_READS,
	[file]: read,
});

const noFragment: KeyGroup<string> = {
	key: "no-fragment",
	shippedDefault: "",
	decode: () => ({_tag: "Value", value: ""}),
};

describe("reconcile", () => {
	it("agrees when both committed files match their assembled schemas", () => {
		const {outcome} = run({write: false, read: AGREEING_READS});
		expect(outcome.code).toBe(0);
		expect(outcome.stdout).toContain(`schema\tagrees\t${KEY_COUNT}`);
		expect(outcome.stdout).toContain(`file\t${CONFIG_SCHEMA_FILE}\tagrees\t${KEY_COUNT}`);
		expect(outcome.stdout).toContain(`file\t${LOCAL_CONFIG_SCHEMA_FILE}\tagrees\t1`);
	});

	it("agrees whatever the committed file's whitespace, comparing content not bytes", () => {
		const {outcome} = run({
			write: false,
			read: onlyDiffers(CONFIG_SCHEMA_FILE, {
				_tag: "Text",
				text: JSON.stringify(complete.schema, null, 4),
			}),
		});
		expect(outcome.code).toBe(0);
	});

	it("reds drift when the committed content differs", () => {
		const stale = JSON.stringify({...complete.schema, title: "changed"});
		const {outcome} = run({
			write: false,
			read: onlyDiffers(CONFIG_SCHEMA_FILE, {_tag: "Text", text: stale}),
		});
		expect(outcome.code).toBe(SCHEMA_DRIFT);
		expect(outcome.stdout).toBe("");
	});

	it("reds drift when only the machine-local schema is stale", () => {
		const stale = JSON.stringify({...completeLocal.schema, title: "changed"});
		const {outcome} = run({
			write: false,
			read: onlyDiffers(LOCAL_CONFIG_SCHEMA_FILE, {_tag: "Text", text: stale}),
		});
		expect(outcome.code).toBe(SCHEMA_DRIFT);
		expect(outcome.stderr.some((line) => line.includes(LOCAL_CONFIG_SCHEMA_FILE))).toBe(true);
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
	it("renders both files from the registry and reports written", () => {
		const {outcome, saves} = run({write: true, read: {_tag: "Absent"}});
		expect(outcome.code).toBe(0);
		expect(outcome.stdout).toContain(`schema\twritten\t${KEY_COUNT}`);
		expect(saves).toEqual([
			{file: CONFIG_SCHEMA_FILE, text: committed},
			{file: LOCAL_CONFIG_SCHEMA_FILE, text: committedLocal},
		]);
	});

	it("narrows the machine-local document to the keys a machine may declare", () => {
		expect(Object.keys(completeLocal.schema.properties).sort()).toEqual([
			"$schema",
			"laneConcurrencyCap",
		]);
		expect(completeLocal.schema.additionalProperties).toBe(false);
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
