/** Which of the two shapes a brief's `fabrika:` field takes, and why each is right (#6012). */
import {NodeServices} from "@effect/platform-node";
import {Effect, Path} from "effect";
import {describe, expect, it} from "vitest";
import {type EntrypointRead, entrypointFor, resolveEntrypoint} from "./entrypoint.ts";
import type {SelfOrigin} from "./root.ts";

const answerFor = (origin: SelfOrigin, binPath: string): string =>
	Effect.runSync(
		Effect.gen(function* () {
			return entrypointFor(yield* Path.Path, origin, binPath);
		}).pipe(Effect.provide(Path.layer)),
	);

const resolved = (moduleDir?: string): Promise<EntrypointRead> =>
	Effect.runPromise(
		Effect.provide(
			moduleDir === undefined ? resolveEntrypoint() : resolveEntrypoint(moduleDir),
			NodeServices.layer,
		),
	);

describe("entrypointFor", () => {
	it("answers repo-relative for a checkout, so the shell runs its own worktree's copy (#5679)", () => {
		expect(
			answerFor(
				{_tag: "checkout", root: "/home/dev/fabrika"},
				"/home/dev/fabrika/packages/fabrika-cli/src/bin.ts",
			),
		).toBe("packages/fabrika-cli/src/bin.ts");
	});

	it("answers absolute for an installed copy, which a worktree has no node_modules for", () => {
		const bin = "/home/dev/demlik/node_modules/@kampus/fabrika-cli/dist/bin.js";
		expect(answerFor({_tag: "no-checkout"}, bin)).toBe(bin);
	});

	it("falls back to absolute when the bin lies outside the checkout it was placed in", () => {
		const bin = "/elsewhere/fabrika-cli/src/bin.ts";
		expect(answerFor({_tag: "checkout", root: "/home/dev/fabrika"}, bin)).toBe(bin);
	});
});

describe("resolveEntrypoint, against this running copy", () => {
	it("resolves a node-runnable entrypoint off the package manifest", async () => {
		const read = await resolved();
		expect(read._tag).toBe("Entrypoint");
		if (read._tag !== "Entrypoint") return;
		expect(read.entrypoint).toMatch(/bin\.[jt]s$/);
	});

	it("says why rather than guessing when the package root is not on disk", async () => {
		const read = await resolved("/nope/does/not/exist/src/delegate");
		expect(read).toMatchObject({_tag: "Unresolved"});
	});
});
