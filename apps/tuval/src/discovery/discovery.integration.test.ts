/**
 * A second `tuval` finding a running desk and opening a project into it (#9696): a scratch-home
 * desk serves its transport and page and advertises itself, and the command's own steps — sight,
 * decide, open — reach it over the real launch endpoint and socket. The trust question the open
 * raises is answered the way a page answers it, through the kernel's `TrustPrompts`.
 */

import {mkdirSync, mkdtempSync, realpathSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";
import {NodeFileSystem} from "@effect/platform-node";
import {assert, describe, it} from "@effect/vitest";
import {Context, Effect, Fiber, Option, Stream} from "effect";
import {boot, projectConfig, projectDir} from "../boot.ts";
import {servePage} from "../page/dev-server.ts";
import {Projects} from "../projects/Projects.ts";
import {TrustPrompts} from "../projects/TrustPrompts.ts";
import {scratchHome, trustFolders} from "../scratch-home.ts";
import {serveDesk} from "../shell/host/index.ts";
import {decide} from "./decide.ts";
import {openInDesk, renderOpenReply} from "./reach.ts";
import {advertiseDesk, readDeskRecord, writeDeskRecord} from "./record.ts";
import {DeskProbe, sightDesk} from "./sighting.ts";

const TIMEOUT = 60_000;
const appRoot = dirname(dirname(import.meta.dirname));

const fixture = (name: string) =>
	fileURLToPath(new URL(`../config-fixtures/${name}.ts`, import.meta.url));

const projectWith = (name: string): string => {
	const folder = realpathSync(mkdtempSync(join(tmpdir(), "tuval-project-")));
	mkdirSync(projectDir(folder));
	writeFileSync(projectConfig(folder), `export {default} from ${JSON.stringify(fixture(name))};\n`);
	return folder;
};

/** A desk booted under `home` on `first`, serving its socket and page and advertising itself. */
const runningDesk = (home: string, first: string) =>
	Effect.gen(function* () {
		// Trusted by a desk that ran before, so the boot opens it with no question (#9977).
		trustFolders(home, [first]);
		const booted = yield* boot({global: fixture("log-global"), project: first, home});
		const transport = yield* serveDesk({kernel: booted.kernel, port: 0, table: booted.keyTable});
		const page = yield* servePage({
			root: appRoot,
			transport,
			port: 0,
			moduleRenderers: booted.moduleRenderers,
		});
		yield* advertiseDesk(home, page.url);
		return {kernel: booted.kernel, page};
	});

describe("tuval open against a running desk", () => {
	it.live(
		"finds the desk through its record and opens the folder in it, asking trust first",
		() =>
			Effect.gen(function* () {
				const home = scratchHome("discovery-open");
				const first = projectWith("planned-counter");
				const second = projectWith("counter-into-global-log");
				const {kernel, page} = yield* runningDesk(home, first);

				const sighting = yield* sightDesk(home);
				assert.strictEqual(sighting._tag, "Live");
				const shown = decide({_tag: "Show", project: first, startFlags: false}, sighting);
				assert.deepStrictEqual(shown, {
					_tag: "Forward",
					desk: {version: 1, pid: process.pid, page: page.url},
					startFlagsIgnored: false,
				});

				const action = decide({_tag: "Open", folder: second}, sighting);
				if (action._tag !== "OpenIn") return assert.fail(`expected OpenIn, got ${action._tag}`);
				const opening = yield* Effect.forkChild(openInDesk(action.launchUrl, action.folder));

				// The open waits on the page's "Trust this folder?", the first time this folder opens.
				const prompts = Context.get(kernel, TrustPrompts);
				const prompt = yield* prompts.pending.pipe(
					Stream.map((pending) => pending.find((one) => one.folder === second)),
					Stream.filter((one) => one !== undefined),
					Stream.runHead,
					Effect.map(Option.getOrThrow),
				);
				assert.isTrue(yield* prompts.answer(prompt.question, "trust"));

				const reply = yield* Fiber.join(opening);
				const rendered = renderOpenReply(second, reply);
				assert.isTrue(rendered.opened, JSON.stringify(reply));
				const open = yield* Context.get(kernel, Projects).list;
				assert.deepStrictEqual(
					open.map((project) => project.folder),
					[first, second],
				);
			}).pipe(Effect.scoped, Effect.provide([NodeFileSystem.layer, DeskProbe.layer])),
		TIMEOUT,
	);

	it.live(
		"reports the desk's refusal when the folder is not trusted, and opens nothing",
		() =>
			Effect.gen(function* () {
				const home = scratchHome("discovery-refused");
				const first = projectWith("planned-counter");
				const second = projectWith("counter-into-global-log");
				const {kernel} = yield* runningDesk(home, first);

				const action = decide({_tag: "Open", folder: second}, yield* sightDesk(home));
				if (action._tag !== "OpenIn") return assert.fail(`expected OpenIn, got ${action._tag}`);
				const opening = yield* Effect.forkChild(openInDesk(action.launchUrl, action.folder));
				const prompts = Context.get(kernel, TrustPrompts);
				const prompt = yield* prompts.pending.pipe(
					Stream.map((pending) => pending.find((one) => one.folder === second)),
					Stream.filter((one) => one !== undefined),
					Stream.runHead,
					Effect.map(Option.getOrThrow),
				);
				yield* prompts.answer(prompt.question, "refuse");

				const rendered = renderOpenReply(second, yield* Fiber.join(opening));
				assert.isFalse(rendered.opened);
				assert.include(rendered.lines.join("\n"), "was not trusted");
				const open = yield* Context.get(kernel, Projects).list;
				assert.deepStrictEqual(
					open.map((project) => project.folder),
					[first],
				);
			}).pipe(Effect.scoped, Effect.provide([NodeFileSystem.layer, DeskProbe.layer])),
		TIMEOUT,
	);
});

describe("a desk that stopped", () => {
	it.live(
		"takes its record away, and a record a crash left behind is stale",
		() =>
			Effect.gen(function* () {
				const home = scratchHome("discovery-stopped");
				const first = projectWith("planned-counter");
				const page = yield* Effect.scoped(
					Effect.map(runningDesk(home, first), (desk) => desk.page.url),
				);
				assert.deepStrictEqual(yield* readDeskRecord(home), {_tag: "Absent"});

				// What a crash leaves: the record of a desk whose page no longer answers.
				yield* writeDeskRecord(home, {version: 1, pid: process.pid, page});
				const sighting = yield* sightDesk(home);
				assert.strictEqual(sighting._tag, "Stale");
				const action = decide({_tag: "Open", folder: first}, sighting);
				assert.isTrue(action._tag === "Start" && action.stale !== null);
			}).pipe(Effect.provide([NodeFileSystem.layer, DeskProbe.layer])),
		TIMEOUT,
	);
});
