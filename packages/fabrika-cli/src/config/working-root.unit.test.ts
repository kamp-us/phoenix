import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {fakeFs} from "../fakes.test-support.ts";
import {repoConfigSource} from "./working-root.ts";

const at = (options: Parameters<typeof fakeFs>[0], cwd = "/repo/apps/web") =>
	Effect.runPromise(Effect.provide(repoConfigSource(cwd), fakeFs(options).layer));

describe("repoConfigSource keeps a failed discovery apart from one that found nothing", () => {
	it("is Text when the discovered root holds a config", async () => {
		const source = await at({
			files: {
				"/repo/package.json": '{"workspaces":["apps/*"]}',
				"/repo/apps/web/package.json": "{}",
				"/repo/.fabrika.jsonc": '{"docLeakExempt":["/CLAUDE.md"]}',
			},
		});
		expect(source).toEqual({_tag: "Text", text: '{"docLeakExempt":["/CLAUDE.md"]}'});
	});

	// The legitimate fall to the cwd: discovery ran, answered "no repo root here", and the cwd is a
	// real directory that genuinely holds no config. Absent is right and the shipped defaults are the
	// right resolution.
	it("is Absent when discovery succeeded and found no repo root", async () => {
		expect(await at({})).toEqual({_tag: "Absent"});
	});

	// The arm this reader exists for: a discovery that FAILED proves nothing about what the repo
	// declared, so it must not collapse to the cwd and read back as "this repo declared nothing".
	it("is Unreadable — never Absent — when the discovery itself failed", async () => {
		const source = await at({
			files: {"/repo/package.json": "{}", "/repo/apps/web/package.json": "{}"},
			unreadable: ["/repo/package.json"],
		});
		expect(source._tag).toBe("Unreadable");
	});
});
