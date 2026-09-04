/**
 * `guard design-inventory check` / `generate`'s IO boundary and exit taxonomy, over a scripted
 * filesystem.
 *
 * The round-trip case is the load-bearing one: `check` is only meaningful because `generate`
 * produces exactly what it compares against, so the two are asserted against each other rather than
 * each against a hand-written expectation that could drift from the other.
 */
import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {type FakeFsOptions, fakeFs} from "../fakes.test-support.ts";
import {PRECONDITION_UNKNOWN, VIOLATION, ZERO_SCOPE} from "./codes.ts";
import {INVENTORY_ARTIFACT, NORMATIVE_MANIFEST} from "./design-inventory.ts";
import {runDesignInventoryCheck, runDesignInventoryGenerate} from "./design-inventory-verb.ts";

const ROOT = "/repo";
const UI = `${ROOT}/packages/design/src`;
const ARTIFACT = `${ROOT}/${INVENTORY_ARTIFACT}`;
const MANIFEST = `${ROOT}/${NORMATIVE_MANIFEST}`;

const options = {root: ROOT, cwd: ROOT, env: {}} as const;

const ALERT = "/**\n * @component Alert\n * @whenToUse For an attention message.\n */\n";

const tree = (over: FakeFsOptions = {}): FakeFsOptions => ({
	directories: [UI],
	dirs: {[UI]: ["Alert.tsx", "Alert.test.tsx", "Alert.css"]},
	files: {
		[`${UI}/Alert.tsx`]: ALERT,
		[`${UI}/Alert.test.tsx`]: "/**\n * @component NotAPrimitive\n */\n",
		[`${UI}/Alert.css`]: ".a {}",
		[MANIFEST]: "# the law\n",
		...over.files,
	},
	...(over.unreadable ? {unreadable: over.unreadable} : {}),
	...(over.unwritable ? {unwritable: over.unwritable} : {}),
});

describe("runDesignInventoryGenerate", () => {
	it("writes the inventory and leaves the normative manifest untouched", async () => {
		const fake = fakeFs(tree());
		const outcome = await Effect.runPromise(
			Effect.provide(runDesignInventoryGenerate(options), fake.layer),
		);
		expect(outcome.code).toBe(0);
		expect(fake.written.get(ARTIFACT)).toContain("## Alert");
		expect(fake.written.has(MANIFEST)).toBe(false);
	});

	// A `.test.tsx` beside a primitive must not enter the inventory, or the artifact documents
	// components that do not ship.
	it("skips a test file even when it carries a @component tag", async () => {
		const fake = fakeFs(tree());
		await Effect.runPromise(Effect.provide(runDesignInventoryGenerate(options), fake.layer));
		expect(fake.written.get(ARTIFACT)).not.toContain("NotAPrimitive");
	});

	it("fails closed when no primitive is annotated", async () => {
		const outcome = await Effect.runPromise(
			Effect.provide(
				runDesignInventoryGenerate(options),
				fakeFs(tree({files: {[`${UI}/Alert.tsx`]: "export const Alert = () => null;"}})).layer,
			),
		);
		expect(outcome.code).toBe(ZERO_SCOPE);
	});

	it("is UNKNOWN when the write does not land", async () => {
		const outcome = await Effect.runPromise(
			Effect.provide(
				runDesignInventoryGenerate(options),
				fakeFs(tree({unwritable: [ARTIFACT]})).layer,
			),
		);
		expect(outcome.code).toBe(PRECONDITION_UNKNOWN);
	});
});

describe("runDesignInventoryCheck", () => {
	it("passes what generate just wrote", async () => {
		const fake = fakeFs(tree());
		await Effect.runPromise(Effect.provide(runDesignInventoryGenerate(options), fake.layer));
		const outcome = await Effect.runPromise(
			Effect.provide(runDesignInventoryCheck(options), fake.layer),
		);
		expect(outcome.code).toBe(0);
		expect(outcome.stdout).toContain("is fresh");
	});

	it("seats a stale artifact on the violation code with nothing on stdout", async () => {
		const outcome = await Effect.runPromise(
			Effect.provide(
				runDesignInventoryCheck(options),
				fakeFs(tree({files: {[ARTIFACT]: "# stale\n"}})).layer,
			),
		);
		expect(outcome.code).toBe(VIOLATION);
		expect(outcome.stdout).toBe("");
		expect(outcome.stderr.join("\n")).toContain("drifted");
	});

	// A missing artifact is a stale one, not a zero scope: the primitives were read fine.
	it("reds a missing artifact as drift", async () => {
		const outcome = await Effect.runPromise(
			Effect.provide(runDesignInventoryCheck(options), fakeFs(tree()).layer),
		);
		expect(outcome.code).toBe(VIOLATION);
		expect(outcome.stderr.join("\n")).toContain("is missing");
	});

	it("annotates the artifact under Actions", async () => {
		const outcome = await Effect.runPromise(
			Effect.provide(
				runDesignInventoryCheck({...options, env: {GITHUB_ACTIONS: "true"}}),
				fakeFs(tree({files: {[ARTIFACT]: "# stale\n"}})).layer,
			),
		);
		expect(outcome.stderr.some((l) => l.startsWith(`::error file=${INVENTORY_ARTIFACT}::`))).toBe(
			true,
		);
	});

	it("fails closed when no primitive is annotated", async () => {
		const outcome = await Effect.runPromise(
			Effect.provide(
				runDesignInventoryCheck(options),
				fakeFs(tree({files: {[`${UI}/Alert.tsx`]: "export const Alert = () => null;"}})).layer,
			),
		);
		expect(outcome.code).toBe(ZERO_SCOPE);
	});

	it("is UNKNOWN when a primitive cannot be read", async () => {
		const outcome = await Effect.runPromise(
			Effect.provide(
				runDesignInventoryCheck(options),
				fakeFs(tree({unreadable: [`${UI}/Alert.tsx`]})).layer,
			),
		);
		expect(outcome.code).toBe(PRECONDITION_UNKNOWN);
	});
});
