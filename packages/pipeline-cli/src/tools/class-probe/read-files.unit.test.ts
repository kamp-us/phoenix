/**
 * `readFiles`' `--files-from` branch over a substituted `FileSystem` — the three outcomes that
 * used to collapse into two (#4061). No real disk: the seam is the whole filesystem
 * (`.patterns/effect-platform-access.md`).
 */

import {Effect, FileSystem, Option, PlatformError} from "effect";
import {describe, expect, it} from "vitest";
import {readFiles} from "./command.ts";

const FILES_FROM = "changed.txt";

const unreadable = FileSystem.layerNoop({
	readFileString: (path: string) =>
		Effect.fail(
			PlatformError.systemError({
				_tag: "NotFound",
				module: "FileSystem",
				method: "readFileString",
				pathOrDescriptor: path,
			}),
		),
});

const readable = (contents: string) =>
	FileSystem.layerNoop({readFileString: () => Effect.succeed(contents)});

const run = (layer: ReturnType<typeof readable>) =>
	Effect.runPromise(Effect.provide(readFiles(Option.some(FILES_FROM)), layer));

describe("readFiles --files-from — an unreadable path never reads as an empty one (#4061)", () => {
	it("resolves an UNREADABLE path to null, not to zero files", async () => {
		await expect(run(unreadable)).resolves.toBeNull();
	});

	it("resolves a readable-but-EMPTY file to [] — a distinct value from the unreadable null", async () => {
		await expect(run(readable(""))).resolves.toEqual([]);
	});

	it("resolves a readable NON-EMPTY file to its trimmed, blank-stripped lines", async () => {
		await expect(run(readable("apps/web/src/a.tsx\n\n  DEVELOPMENT.md  \n"))).resolves.toEqual([
			"apps/web/src/a.tsx",
			"DEVELOPMENT.md",
		]);
	});
});
