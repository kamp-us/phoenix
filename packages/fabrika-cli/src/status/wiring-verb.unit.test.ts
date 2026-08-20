/**
 * `status wiring` in-process: the three states, and that a probe nobody could perform never renders
 * as the proven negative it did not establish.
 *
 * The case that matters is the middle one — a repo where the CLI answers and no skill loads was
 * green on every other status surface for two days (#6443).
 */
import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {fakeFs} from "../fakes.test-support.ts";
import {ANSWER} from "../verb.ts";
import {PRECONDITION_UNKNOWN} from "./codes.ts";
import {readNow} from "./fields.ts";
import {wiringField} from "./open-verb.ts";
import {
	readWiringSource,
	repoWiringSource,
	runWiring,
	SETTINGS_PATH,
	type WiringSource,
	wiringOf,
} from "./wiring-verb.ts";

const AS_OF = readNow("2026-08-20T00:00:00Z");
const ROOT = "/repo";
const TARGET = `${ROOT}/${SETTINGS_PATH}`;

const text = (settings: unknown): WiringSource => ({
	_tag: "Text",
	text: JSON.stringify(settings),
});

const run = (source: WiringSource, json = false) =>
	runWiring({source, read: wiringOf(source), asOf: AS_OF, json});

describe("wiringOf", () => {
	it("reads a repo whose settings enable fabrika as wired, naming the marketplace source", () => {
		const read = wiringOf(text({enabledPlugins: {"fabrika@kampus": true, "other@kampus": false}}));
		expect(read.state).toBe("wired");
		expect(read.entry).toBe("fabrika@kampus");
		expect(read.marketplace).toBe("kampus");
	});

	it("reads an absent settings.json as unwired, not as unknown", () => {
		const read = wiringOf({_tag: "Absent"});
		expect(read.state).toBe("unwired");
		expect(read.detail).toContain("no fabrika skill can load");
	});

	it("reads a settings.json that enables other plugins but not fabrika as unwired", () => {
		const read = wiringOf(text({enabledPlugins: {"kampus-pipeline@kampus": true}}));
		expect(read.state).toBe("unwired");
		expect(read.entry).toBeNull();
		expect(read.detail).toContain("1 other plugin(s)");
	});

	it("reads a fabrika entry switched off as unwired, carrying the key that says so", () => {
		const read = wiringOf(text({enabledPlugins: {"fabrika@kampus": false}}));
		expect(read.state).toBe("unwired");
		expect(read.entry).toBe("fabrika@kampus");
		expect(read.detail).toContain("switched off");
	});

	it("reads a settings.json with no enabledPlugins block at all as unwired", () => {
		const read = wiringOf(text({env: {}}));
		expect(read.state).toBe("unwired");
		expect(read.detail).toContain("no enabledPlugins block");
	});

	/**
	 * The demlik shape's near miss: an entry naming no marketplace resolves to no plugin, so calling
	 * it wired would green a session that loads nothing.
	 */
	it("reads a bare `fabrika` key naming no marketplace as unwired", () => {
		const read = wiringOf(text({enabledPlugins: {fabrika: true}}));
		expect(read.state).toBe("unwired");
		expect(read.entry).toBe("fabrika");
		expect(read.marketplace).toBeNull();
		expect(read.detail).toContain("no marketplace source");
	});

	it("reads a file it could not open as unknown, carrying the reason", () => {
		const read = wiringOf({_tag: "Unreadable", reason: "EACCES: permission denied"});
		expect(read.state).toBe("unknown");
		expect(read.detail).toContain("EACCES");
	});

	it("reads bytes that are not JSON as unknown, never unwired", () => {
		const read = wiringOf({_tag: "Text", text: "{ not json"});
		expect(read.state).toBe("unknown");
		expect(read.entry).toBeNull();
	});

	it("reads a settings.json that is not a JSON object as unknown", () => {
		expect(wiringOf({_tag: "Text", text: "[]"}).state).toBe("unknown");
	});

	it("reads a non-object enabledPlugins as unknown", () => {
		expect(wiringOf(text({enabledPlugins: "fabrika"})).state).toBe("unknown");
	});

	it("reads a fabrika entry that is neither true nor false as unknown", () => {
		const read = wiringOf(text({enabledPlugins: {"fabrika@kampus": "yes"}}));
		expect(read.state).toBe("unknown");
		expect(read.detail).toContain("neither true nor false");
	});
});

describe("runWiring", () => {
	it("answers the wired state on one line at exit 0", () => {
		const outcome = run(text({enabledPlugins: {"fabrika@kampus": true}}));
		expect(outcome.code).toBe(ANSWER);
		expect(outcome.stdout.split("\t").slice(0, 4)).toEqual([
			"wiring",
			"wired",
			"fabrika@kampus",
			"kampus",
		]);
		expect(outcome.stdout).toContain("2026-08-20T00:00:00Z");
	});

	it("answers the proven negative at exit 0 with `unwired` on stdout", () => {
		const outcome = run({_tag: "Absent"});
		expect(outcome.code).toBe(ANSWER);
		expect(outcome.stdout.startsWith("wiring\tunwired\t-\t-\t")).toBe(true);
		expect(outcome.stderr.join(" ")).toContain("is unwired");
	});

	it("refuses an unperformable probe on 11 with NOTHING on stdout", () => {
		const outcome = run({_tag: "Unreadable", reason: "EISDIR"});
		expect(outcome.code).toBe(PRECONDITION_UNKNOWN);
		expect(outcome.stdout).toBe("");
		expect(outcome.stderr.join(" ")).toContain("UNKNOWN, never unwired and never green");
	});

	it("emits the result object under --json", () => {
		const outcome = run(text({enabledPlugins: {"fabrika@kampus": true}}), true);
		expect(JSON.parse(outcome.stdout)).toMatchObject({
			outcome: "wired",
			path: SETTINGS_PATH,
			entry: "fabrika@kampus",
			marketplace: "kampus",
		});
	});
});

describe("the wiring field inside status open", () => {
	it("carries a proven-off plugin as `unwired`, not as the composite's `unknown`", () => {
		const field = wiringField(wiringOf({_tag: "Absent"}), AS_OF);
		expect(field.state).toBe("unwired");
		expect(field.source).toBe(SETTINGS_PATH);
		expect(field.asOf.at).toBe(AS_OF.at);
	});

	it("drops the freshness token when the probe could not be performed", () => {
		const field = wiringField(wiringOf({_tag: "Unreadable", reason: "EACCES"}), AS_OF);
		expect(field.state).toBe("unknown");
		expect(field.asOf.at).toBeNull();
	});
});

describe("the read itself", () => {
	const open = (options: Parameters<typeof fakeFs>[0], root = ROOT) => {
		const fs = fakeFs(options);
		return Effect.runPromise(Effect.provide(readWiringSource(root), fs.layer)).then((found) => ({
			found,
			written: fs.written,
		}));
	};

	it("reads the file under the named root and writes nothing", async () => {
		const {found, written} = await open({
			files: {[TARGET]: '{"enabledPlugins":{"fabrika@kampus":true}}'},
		});
		expect(wiringOf(found).state).toBe("wired");
		expect(written.size).toBe(0);
	});

	it("reports an absent file as Absent and writes nothing", async () => {
		const {found, written} = await open({directories: [ROOT]});
		expect(found._tag).toBe("Absent");
		expect(written.size).toBe(0);
	});

	it("reports a file it could not open as Unreadable, never as Absent", async () => {
		const {found} = await open({files: {[TARGET]: "{}"}, unreadable: [TARGET]});
		expect(found._tag).toBe("Unreadable");
	});

	it("reports a probe that itself failed as Unreadable", async () => {
		const {found} = await open({unprobeable: [TARGET]});
		expect(found._tag).toBe("Unreadable");
	});

	/**
	 * A repo root nobody could locate must not fall back to the cwd: finding no file there would
	 * answer "this repo enables nothing" about a repo that was never opened.
	 */
	it("reports an unresolvable repo root as Unreadable, never as an absent settings.json", async () => {
		const fs = fakeFs({unprobeable: ["/nowhere/deep/package.json"]});
		const found = await Effect.runPromise(
			Effect.provide(repoWiringSource("/nowhere/deep"), fs.layer),
		);
		expect(found._tag).toBe("Unreadable");
		expect(wiringOf(found).state).toBe("unknown");
	});
});
