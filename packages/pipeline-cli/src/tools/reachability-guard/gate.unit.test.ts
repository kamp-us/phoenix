/**
 * `checkReachability` over a fake repo dir — the filesystem-seam test (ADR 0173, #2529).
 * The pure verdict (reachable / unreachable / exempt / unknown / zero-scope) is covered in
 * `reachability-guard.unit.test.ts`; this crosses the IO gate over a real temp dir,
 * asserting the exit-code contract from observable outcomes — never by spawning the bin.
 *
 * The working proof: a flag with a consuming `.tsx` + a `@journey`-tagged spec SUCCEEDS;
 * the same tree with the consumer removed `CheckFailed` (the reactions-class falsification).
 */
import {mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {NodeServices} from "@effect/platform-node";
import {afterEach, beforeEach, describe, expect, it} from "@effect/vitest";
import {Cause, Effect, Exit, type FileSystem, type Path} from "effect";
import {CheckFailed, checkReachability} from "./gate.ts";

let root: string;
// A second temp tree OUTSIDE `root`, so anything the walk reaches in it was reached
// through a symlink planted in `root` and not by ordinary recursion.
let outside: string;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "reachability-guard-gate-"));
	outside = mkdtempSync(join(tmpdir(), "reachability-guard-outside-"));
});
afterEach(() => {
	rmSync(root, {recursive: true, force: true});
	rmSync(outside, {recursive: true, force: true});
});

const KEYS_DIR = join("apps", "web", "src", "flags");
const COMPONENTS_DIR = join("apps", "web", "src", "components");
const E2E_DIR = join("apps", "web", "tests", "e2e");

const write = (rel: string, contents: string) => {
	const abs = join(root, rel);
	mkdirSync(join(abs, ".."), {recursive: true});
	writeFileSync(abs, contents, "utf8");
};

const writeKeys = (
	rows: ReadonlyArray<{constantName: string; flagKey: string; exemptReason?: string}>,
) => {
	const body = rows
		.map((r) => {
			const doc = r.exemptReason
				? `/**\n * A flag.\n * @reachability-exempt: ${r.exemptReason}\n */\n`
				: "/** A flag. */\n";
			return `${doc}export const ${r.constantName} = "${r.flagKey}";`;
		})
		.join("\n");
	write(join(KEYS_DIR, "keys.ts"), `${body}\n`);
};

const consumerSource = (constantName: string) =>
	`import {${constantName}} from "../flags/keys";\nexport const C = () => <FlagGate flag={${constantName}} />;\n`;

const writeConsumer = (file: string, constantName: string) =>
	write(join(COMPONENTS_DIR, file), consumerSource(constantName));

/** `writeConsumer`, addressed absolutely — lets a fixture live outside `root`. */
const writeConsumerAt = (abs: string, constantName: string) => {
	mkdirSync(join(abs, ".."), {recursive: true});
	writeFileSync(abs, consumerSource(constantName), "utf8");
};

const writeJourneySpec = (file: string, flagKey: string) =>
	write(
		join(E2E_DIR, file),
		`test.describe("some journey @journey:${flagKey}", () => { test("x", () => {}); });\n`,
	);

// The gate Effects require the `FileSystem | Path` seam (v4 platform migration, #3471);
// provide the live Node layer — the same NodeServices.layer run.ts gives the bin — so these
// real-temp-dir IO tests exercise the actual disk path they assert over.
const run = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>) =>
	Effect.runPromiseExit(Effect.provide(effect, NodeServices.layer));
const isCheckFailed = (exit: Exit.Exit<unknown, unknown>): boolean =>
	Exit.isFailure(exit) && Cause.squash(exit.cause) instanceof CheckFailed;

describe("checkReachability — the exit-code gate over a fake repo dir", () => {
	it("SUCCEEDS when a .tsx consumes the constant AND a journey spec is registered (the proof)", async () => {
		writeKeys([{constantName: "PHOENIX_REACTIONS", flagKey: "phoenix-reactions"}]);
		writeConsumer("ReactionBar.tsx", "PHOENIX_REACTIONS");
		writeJourneySpec("28-reactions.spec.ts", "phoenix-reactions");
		const exit = await run(checkReachability(root, "phoenix-reactions"));
		expect(Exit.isSuccess(exit)).toBe(true);
	});

	it("FAILS (CheckFailed) when no .tsx consumes the constant (the reactions-class falsification)", async () => {
		writeKeys([{constantName: "PHOENIX_REACTIONS", flagKey: "phoenix-reactions"}]);
		// journey registered, but NO consuming component ⇒ unreachable on the UI slice
		writeJourneySpec("28-reactions.spec.ts", "phoenix-reactions");
		const exit = await run(checkReachability(root, "phoenix-reactions"));
		expect(isCheckFailed(exit)).toBe(true);
	});

	it("FAILS (CheckFailed) when no spec registers the journey", async () => {
		writeKeys([{constantName: "PHOENIX_REACTIONS", flagKey: "phoenix-reactions"}]);
		writeConsumer("ReactionBar.tsx", "PHOENIX_REACTIONS");
		const exit = await run(checkReachability(root, "phoenix-reactions"));
		expect(isCheckFailed(exit)).toBe(true);
	});

	it("SUCCEEDS for a UI-less flag marked @reachability-exempt, with neither consumer nor journey", async () => {
		writeKeys([
			{
				constantName: "PANO_FEED_EDGE_CACHE",
				flagKey: "pano-feed-edge-cache",
				exemptReason: "infra edge-cache flag — no user-facing surface by design.",
			},
		]);
		const exit = await run(checkReachability(root, "pano-feed-edge-cache"));
		expect(Exit.isSuccess(exit)).toBe(true);
	});

	it("FAILS (CheckFailed) for an unknown/unclassified flag key", async () => {
		writeKeys([{constantName: "PHOENIX_REACTIONS", flagKey: "phoenix-reactions"}]);
		writeConsumer("ReactionBar.tsx", "PHOENIX_REACTIONS");
		writeJourneySpec("28-reactions.spec.ts", "phoenix-reactions");
		const exit = await run(checkReachability(root, "not-a-real-flag"));
		expect(isCheckFailed(exit)).toBe(true);
	});

	// The walk's traversal semantics are part of the exit-code contract, so they get pinned
	// here: a symlinked DIR is out of scope while a symlinked FILE is in scope, matching the
	// pre-migration lstat-based (`Dirent`) walk. The first of these is the one that matters —
	// both reachability tests are negations, so a wider walk can only flip a real RED to green.
	it("does NOT recurse a symlinked directory — a consumer only reachable through one leaves the flag UNREACHABLE", async () => {
		writeKeys([{constantName: "PHOENIX_REACTIONS", flagKey: "phoenix-reactions"}]);
		writeJourneySpec("28-reactions.spec.ts", "phoenix-reactions");
		writeConsumerAt(join(outside, "ReactionBar.tsx"), "PHOENIX_REACTIONS");
		mkdirSync(join(root, "apps", "web", "src"), {recursive: true});
		symlinkSync(outside, join(root, "apps", "web", "src", "linked"), "dir");
		const exit = await run(checkReachability(root, "phoenix-reactions"));
		expect(isCheckFailed(exit)).toBe(true);
	});

	it("DOES read a symlinked .tsx — a consumer behind a linked file still makes the flag reachable", async () => {
		writeKeys([{constantName: "PHOENIX_REACTIONS", flagKey: "phoenix-reactions"}]);
		writeJourneySpec("28-reactions.spec.ts", "phoenix-reactions");
		writeConsumerAt(join(outside, "ReactionBar.tsx"), "PHOENIX_REACTIONS");
		mkdirSync(join(root, COMPONENTS_DIR), {recursive: true});
		symlinkSync(join(outside, "ReactionBar.tsx"), join(root, COMPONENTS_DIR, "ReactionBar.tsx"));
		const exit = await run(checkReachability(root, "phoenix-reactions"));
		expect(Exit.isSuccess(exit)).toBe(true);
	});

	it("tolerates a broken symlink under the walk root (never stats a link — as at base)", async () => {
		writeKeys([{constantName: "PHOENIX_REACTIONS", flagKey: "phoenix-reactions"}]);
		writeConsumer("ReactionBar.tsx", "PHOENIX_REACTIONS");
		writeJourneySpec("28-reactions.spec.ts", "phoenix-reactions");
		symlinkSync(join(root, "does-not-exist"), join(root, "apps", "web", "src", "dangling"));
		const exit = await run(checkReachability(root, "phoenix-reactions"));
		expect(Exit.isSuccess(exit)).toBe(true);
	});

	it("terminates on a symlink cycle under the walk root (a link-to-dir is never recursed)", async () => {
		writeKeys([{constantName: "PHOENIX_REACTIONS", flagKey: "phoenix-reactions"}]);
		writeConsumer("ReactionBar.tsx", "PHOENIX_REACTIONS");
		writeJourneySpec("28-reactions.spec.ts", "phoenix-reactions");
		const src = join(root, "apps", "web", "src");
		symlinkSync(src, join(src, "loop"), "dir");
		const exit = await run(checkReachability(root, "phoenix-reactions"));
		expect(Exit.isSuccess(exit)).toBe(true);
	}, 30_000);

	it("FAILS (CheckFailed, fail-closed) when keys.ts parses zero flag definitions", async () => {
		write(join(KEYS_DIR, "keys.ts"), "export const notAFlag = 1;\n");
		mkdirSync(join(root, COMPONENTS_DIR), {recursive: true});
		mkdirSync(join(root, E2E_DIR), {recursive: true});
		const exit = await run(checkReachability(root, "phoenix-reactions"));
		expect(isCheckFailed(exit)).toBe(true);
	});
});
