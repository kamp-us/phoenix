/**
 * `generateInventory` / `writeDescriptiveArtifact` over a fake repo dir — the
 * filesystem-seam test (#3155, ADR 0194). The pure parse/verdict/firewall-predicate is
 * covered in `design-inventory.unit.test.ts`; this crosses the IO gate over a real temp
 * dir, asserting the exit-code contract AND the firewall enforcement from observable
 * outcomes — never by spawning the bin.
 *
 * The firewall proof (AC 3): the write seam WRITES the descriptive inventory and REFUSES
 * the normative manifest — a `writeDescriptiveArtifact` at the manifest path is a
 * `FirewallViolation` that leaves no file behind, and a full `generateInventory` run only
 * ever creates `design-system-inventory.md`, never touches `design-system-manifest.md`.
 */
import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach, beforeEach, describe, expect, it} from "@effect/vitest";
import {Cause, Effect, Exit} from "effect";
import {INVENTORY_ARTIFACT, NORMATIVE_MANIFEST} from "./design-inventory.ts";
import {
	CheckFailed,
	FirewallViolation,
	generateInventory,
	writeDescriptiveArtifact,
} from "./gate.ts";

const COMPONENTS_DIR = join("apps", "web", "src", "components", "ui");

let root: string;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "design-inventory-gate-"));
});
afterEach(() => {
	rmSync(root, {recursive: true, force: true});
});

const writePrimitive = (name: string, content: string) => {
	const dir = join(root, COMPONENTS_DIR);
	mkdirSync(dir, {recursive: true});
	writeFileSync(join(dir, name), content, "utf8");
};

const annotated = (component: string) => `/**
 * @component ${component}
 * @whenToUse The ${component} primitive.
 * @slot children Its content.
 */
export const ${component} = () => null;
`;

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromiseExit(effect);

const isFailureOf = (
	exit: Exit.Exit<unknown, unknown>,
	ctor: new (...a: never[]) => object,
): boolean => Exit.isFailure(exit) && Cause.squash(exit.cause) instanceof ctor;

describe("generateInventory — the extractor over a fake repo dir", () => {
	it("WRITES the descriptive inventory artifact from the annotated primitives", async () => {
		writePrimitive("Button.tsx", annotated("Button"));
		writePrimitive("Card.tsx", annotated("Card"));
		const exit = await run(generateInventory(root, {stdout: false, check: false}));
		expect(Exit.isSuccess(exit)).toBe(true);
		const artifact = readFileSync(join(root, INVENTORY_ARTIFACT), "utf8");
		expect(artifact).toContain("## Button");
		expect(artifact).toContain("## Card");
	});

	it("skips .test.tsx and .css — only .tsx primitives are extracted", async () => {
		writePrimitive("Button.tsx", annotated("Button"));
		writePrimitive("Button.test.tsx", annotated("ButtonTest"));
		writePrimitive("Button.css", ".kp-btn{}");
		const exit = await run(generateInventory(root, {stdout: false, check: false}));
		expect(Exit.isSuccess(exit)).toBe(true);
		const artifact = readFileSync(join(root, INVENTORY_ARTIFACT), "utf8");
		expect(artifact).toContain("## Button");
		expect(artifact).not.toContain("ButtonTest");
	});

	it("FAILS (CheckFailed, fail-closed) when zero annotated primitives are in scope", async () => {
		writePrimitive("plain.tsx", "export const x = 1;\n");
		const exit = await run(generateInventory(root, {stdout: false, check: false}));
		expect(isFailureOf(exit, CheckFailed)).toBe(true);
	});

	it("--stdout prints WITHOUT writing the artifact", async () => {
		writePrimitive("Button.tsx", annotated("Button"));
		const exit = await run(generateInventory(root, {stdout: true, check: false}));
		expect(Exit.isSuccess(exit)).toBe(true);
		expect(existsSync(join(root, INVENTORY_ARTIFACT))).toBe(false);
	});

	it("--check SUCCEEDS on a fresh committed artifact and FAILS on drift", async () => {
		writePrimitive("Button.tsx", annotated("Button"));
		// generate + commit the artifact, then --check must be clean
		await run(generateInventory(root, {stdout: false, check: false}));
		const fresh = await run(generateInventory(root, {stdout: false, check: true}));
		expect(Exit.isSuccess(fresh)).toBe(true);
		// mutate a primitive so the committed artifact goes stale → --check reds
		writePrimitive("Button.tsx", annotated("Renamed"));
		const drifted = await run(generateInventory(root, {stdout: false, check: true}));
		expect(isFailureOf(drifted, CheckFailed)).toBe(true);
	});
});

describe("writeDescriptiveArtifact — the descriptive/normative firewall (AC 3, ADR 0194)", () => {
	it("WRITES the descriptive inventory target", async () => {
		const exit = await run(writeDescriptiveArtifact(root, INVENTORY_ARTIFACT, "# inventory\n"));
		expect(Exit.isSuccess(exit)).toBe(true);
		expect(readFileSync(join(root, INVENTORY_ARTIFACT), "utf8")).toBe("# inventory\n");
	});

	it("REFUSES (FirewallViolation) a write to the normative manifest — no file written", async () => {
		const exit = await run(writeDescriptiveArtifact(root, NORMATIVE_MANIFEST, "# HIJACKED LAW\n"));
		expect(isFailureOf(exit, FirewallViolation)).toBe(true);
		expect(existsSync(join(root, NORMATIVE_MANIFEST))).toBe(false);
	});

	it("a full generate run never creates or mutates the manifest", async () => {
		writePrimitive("Button.tsx", annotated("Button"));
		// a pre-existing founder-authored manifest must survive an extractor run byte-for-byte
		const law = "# design law\nFOUNDER-AUTHORED — the four pillars.\n";
		writeFileSync(join(root, NORMATIVE_MANIFEST), law, "utf8");
		await run(generateInventory(root, {stdout: false, check: false}));
		expect(readFileSync(join(root, NORMATIVE_MANIFEST), "utf8")).toBe(law);
	});
});
