/**
 * The machine-local layer: precedence, whole replacement, the allow-list, and the two arms an
 * unreadable local file may never collapse into.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/9020#issuecomment-5625285600
 */
import {describe, expect, it} from "vitest";
import {CONFIG_PATH, LOCAL_CONFIG_PATH, readDocument} from "./document.ts";
import {type Decoded, type KeyGroup, register, resolveKey} from "./key-group.ts";
import {CAP_CLEAR_AUTHORS} from "./keys/cap-clear-authors.ts";
import {CODE_VALIDATORS} from "./keys/code-validators.ts";
import {GOVERNED_ROOTS} from "./keys/governed-roots.ts";
import {
	LANE_CONCURRENCY_CAP,
	laneConcurrencyCapKey,
	SHIPPED_LANE_CONCURRENCY_CAP,
} from "./keys/lane-concurrency-cap.ts";
import {type ConfigLayers, loadConfig, loadLayeredConfig, resolve} from "./load.ts";
import {machineLocalKeys} from "./machine-local.ts";
import {KEY_GROUPS} from "./registry.ts";

const layers = (tracked: string | null, local: string | null): ConfigLayers => ({
	tracked: tracked === null ? {_tag: "Absent"} : {_tag: "Text", text: tracked},
	local: local === null ? {_tag: "Absent"} : {_tag: "Text", text: local},
});

const documentsOf = (input: ConfigLayers) => ({
	tracked: readDocument(input.tracked, CONFIG_PATH),
	local: readDocument(input.local, LOCAL_CONFIG_PATH),
});

const cap = (tracked: string | null, local: string | null) =>
	resolve(loadLayeredConfig(layers(tracked, local)), laneConcurrencyCapKey);

describe("the machine-local file", () => {
	it("is read by the same comment-stripping parser as the tracked one", () => {
		expect(
			cap(null, `{\n\t// this laptop drives ten lanes\n\t"${LANE_CONCURRENCY_CAP}": 10\n}\n`),
		).toEqual({_tag: "Declared", layer: "local", value: 10});
	});

	it("wins over a different tracked value, per key", () => {
		expect(cap(`{"${LANE_CONCURRENCY_CAP}": 2}`, `{"${LANE_CONCURRENCY_CAP}": 10}`)).toEqual({
			_tag: "Declared",
			layer: "local",
			value: 10,
		});
	});

	it("falls to the tracked value where it declares the key and the machine does not", () => {
		expect(cap(`{"${LANE_CONCURRENCY_CAP}": 2}`, "{}")).toEqual({
			_tag: "Declared",
			layer: "tracked",
			value: 2,
		});
	});

	it("falls to the shipped default where neither file declares the key", () => {
		const resolved = cap("{}", "{}");
		expect(resolved._tag).toBe("Default");
		expect(resolved._tag === "Default" && resolved.value).toBe(SHIPPED_LANE_CONCURRENCY_CAP);
	});

	it("leaves every other key on the tracked layer it was declared in", () => {
		const load = loadLayeredConfig(
			layers(`{"${GOVERNED_ROOTS}": ["${CONFIG_PATH}"]}`, `{"${LANE_CONCURRENCY_CAP}": 10}`),
		);
		expect(load._tag).toBe("Config");
		const roots = KEY_GROUPS.find((one) => one.key === GOVERNED_ROOTS);
		expect(load._tag === "Config" && roots?.resolve(load.documents)).toEqual({
			_tag: "Declared",
			layer: "tracked",
			value: [CONFIG_PATH],
		});
	});
});

/**
 * A shipped machine-local key with an object or array value would prove this directly; there is
 * exactly one and it holds a number, so the shape is declared here instead. The merge path is what
 * is under test, and it is the same one for every key.
 */
describe("a local value replaces the tracked one whole", () => {
	const decode = (raw: unknown): Decoded<ReadonlyArray<string>> =>
		Array.isArray(raw) && raw.every((one) => typeof one === "string")
			? {_tag: "Value", value: raw}
			: {_tag: "Malformed", reason: "not a list of strings"};

	const listKey: KeyGroup<ReadonlyArray<string>> = {
		key: "testOnlyList",
		shippedDefault: [],
		machineLocal: true,
		decode,
	};

	it("replaces an array rather than concatenating the two", () => {
		const resolved = resolveKey(
			documentsOf(layers('{"testOnlyList": ["a", "b"]}', '{"testOnlyList": ["c"]}')),
			listKey,
		);
		expect(resolved).toEqual({_tag: "Declared", layer: "local", value: ["c"]});
	});

	it("replaces an object rather than merging its properties", () => {
		const objectKey: KeyGroup<Record<string, unknown>> = {
			key: "testOnlyObject",
			shippedDefault: {},
			machineLocal: true,
			decode: (raw) =>
				typeof raw === "object" && raw !== null && !Array.isArray(raw)
					? {_tag: "Value", value: raw as Record<string, unknown>}
					: {_tag: "Malformed", reason: "not an object"},
		};
		const resolved = resolveKey(
			documentsOf(layers('{"testOnlyObject": {"a": 1, "b": 2}}', '{"testOnlyObject": {"b": 9}}')),
			objectKey,
		);
		expect(resolved).toEqual({_tag: "Declared", layer: "local", value: {b: 9}});
	});

	it("carries the eligibility through `register` rather than leaving it on the key group", () => {
		expect(register(listKey).machineLocal).toBe(true);
		expect(
			register({key: "testOnlyPlain", shippedDefault: 0, decode: () => ({_tag: "Value", value: 0})})
				.machineLocal,
		).toBe(false);
	});
});

describe("the allow-list", () => {
	it("is `laneConcurrencyCap` and nothing else across the shipped registry", () => {
		expect(machineLocalKeys(KEY_GROUPS)).toEqual([LANE_CONCURRENCY_CAP]);
	});

	const refusedFor = (key: string, value: string) => {
		const load = loadLayeredConfig(layers(null, `{"${key}": ${value}}`));
		expect(load._tag).toBe("Refused");
		return load._tag === "Refused" ? load.reason : "";
	};

	it("refuses the whole load over an authority key, naming it", () => {
		const reason = refusedFor(CAP_CLEAR_AUTHORS, '["@octocat"]');
		expect(reason).toContain(CAP_CLEAR_AUTHORS);
		expect(reason).toContain(LOCAL_CONFIG_PATH);
	});

	it("refuses the whole load over a gate-scope key, naming it", () => {
		expect(refusedFor(GOVERNED_ROOTS, `["docs/adr/"]`)).toContain(GOVERNED_ROOTS);
	});

	it("refuses the whole load over a key naming a command fabrika spawns", () => {
		expect(refusedFor(CODE_VALIDATORS, '[{"command": ["true"]}]')).toContain(CODE_VALIDATORS);
	});

	it("leaves no key readable off the refused load, not even an eligible one", () => {
		const load = loadLayeredConfig(
			layers(
				`{"${LANE_CONCURRENCY_CAP}": 2}`,
				`{"${LANE_CONCURRENCY_CAP}": 10, "${GOVERNED_ROOTS}": ["docs/adr/"]}`,
			),
		);
		expect(resolve(load, laneConcurrencyCapKey)._tag).toBe("Malformed");
		for (const group of KEY_GROUPS) {
			expect(load._tag === "Config" ? group.resolve(load.documents)._tag : "Malformed").toBe(
				"Malformed",
			);
		}
	});

	it("admits the `$schema` self-pointer, which an editor writes", () => {
		const load = loadLayeredConfig(
			layers(null, `{"$schema": "./.fabrika.local.schema.json", "${LANE_CONCURRENCY_CAP}": 10}`),
		);
		expect(load._tag).toBe("Config");
		expect(resolve(load, laneConcurrencyCapKey)).toEqual({
			_tag: "Declared",
			layer: "local",
			value: 10,
		});
	});
});

describe("an unreadable machine-local file", () => {
	it("resolves every key UNKNOWN rather than falling through to the tracked value", () => {
		const load = loadLayeredConfig({
			tracked: {_tag: "Text", text: `{"${LANE_CONCURRENCY_CAP}": 2}`},
			local: {_tag: "Unreadable", reason: "EACCES: permission denied"},
		});
		expect(load._tag).toBe("Config");
		expect(resolve(load, laneConcurrencyCapKey)).toEqual({
			_tag: "Unknown",
			reason: "EACCES: permission denied",
		});
	});

	it("is UNKNOWN when it read but is not a JSON object, never the tracked value", () => {
		const load = loadLayeredConfig(layers(`{"${LANE_CONCURRENCY_CAP}": 2}`, "[]"));
		const resolved = resolve(load, laneConcurrencyCapKey);
		expect(resolved._tag).toBe("Unknown");
		expect(resolved._tag === "Unknown" && resolved.reason).toContain(LOCAL_CONFIG_PATH);
	});

	it("still resolves the tracked layer normally when it is simply absent", () => {
		expect(cap(`{"${LANE_CONCURRENCY_CAP}": 2}`, null)).toEqual({
			_tag: "Declared",
			layer: "tracked",
			value: 2,
		});
	});
});

/**
 * `build clearances` and every other `readFileAtRef` caller opens the bytes itself and hands them to
 * `loadConfig`. A local file does not exist at a ref and cannot be fetched at one, so that door has
 * to resolve `local: Absent` by construction — no gate's verdict is reachable from a file no
 * reviewer ever sees, even if the allow-list were someday wrong.
 */
describe("the one-source door every ref-based read takes", () => {
	it("resolves a local layer that is absent by construction, never one it opened", () => {
		const load = loadConfig({_tag: "Text", text: `{"${LANE_CONCURRENCY_CAP}": 2}`});
		expect(load._tag === "Config" && load.documents.local).toEqual({_tag: "Absent"});
		expect(resolve(load, laneConcurrencyCapKey)).toEqual({
			_tag: "Declared",
			layer: "tracked",
			value: 2,
		});
	});

	it("takes one source, so no caller of it can pass a second", () => {
		expect(loadConfig.length).toBe(1);
	});
});
