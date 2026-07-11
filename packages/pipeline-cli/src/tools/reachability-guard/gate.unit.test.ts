/**
 * `checkReachability` over a fake repo dir — the filesystem-seam test (ADR 0173, #2529).
 * The pure verdict (reachable / unreachable / exempt / unknown / zero-scope) is covered in
 * `reachability-guard.unit.test.ts`; this crosses the IO gate over a real temp dir,
 * asserting the exit-code contract from observable outcomes — never by spawning the bin.
 *
 * The working proof: a flag with a consuming `.tsx` + a `@journey`-tagged spec SUCCEEDS;
 * the same tree with the consumer removed `CheckFailed` (the reactions-class falsification).
 */
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach, beforeEach, describe, expect, it} from "@effect/vitest";
import {Cause, Effect, Exit} from "effect";
import {CheckFailed, checkReachability} from "./gate.ts";

let root: string;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "reachability-guard-gate-"));
});
afterEach(() => {
	rmSync(root, {recursive: true, force: true});
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

const writeConsumer = (file: string, constantName: string) =>
	write(
		join(COMPONENTS_DIR, file),
		`import {${constantName}} from "../flags/keys";\nexport const C = () => <FlagGate flag={${constantName}} />;\n`,
	);

const writeJourneySpec = (file: string, flagKey: string) =>
	write(
		join(E2E_DIR, file),
		`test.describe("some journey @journey:${flagKey}", () => { test("x", () => {}); });\n`,
	);

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromiseExit(effect);
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

	it("FAILS (CheckFailed, fail-closed) when keys.ts parses zero flag definitions", async () => {
		write(join(KEYS_DIR, "keys.ts"), "export const notAFlag = 1;\n");
		mkdirSync(join(root, COMPONENTS_DIR), {recursive: true});
		mkdirSync(join(root, E2E_DIR), {recursive: true});
		const exit = await run(checkReachability(root, "phoenix-reactions"));
		expect(isCheckFailed(exit)).toBe(true);
	});
});
