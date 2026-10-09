#!/usr/bin/env node
/**
 * `reels check` judges every script against the medium; `reels render` runs a batch through
 * the reels machine; `reels soundtracks` writes the soundtracks Studio previews play.
 */
import {existsSync, readdirSync} from "node:fs";
import {join, resolve} from "node:path";
import {NodeRuntime, NodeServices} from "@effect/platform-node";
import {Console, Effect, Layer} from "effect";
import {Argument, Command, Flag} from "effect/unstable/cli";
import {runBatch} from "./pipeline.ts";
import {Studio, StudioError, StudioLive} from "./studio.ts";
import {judgeReel} from "./timeline.ts";

const ROOT = resolve(import.meta.dirname, "..");

/** The headless shell Playwright installs, when this machine has one. */
const findBrowser = (): string | undefined => {
	const fromEnv = process.env.REELS_BROWSER;
	if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
	const base = process.env.PLAYWRIGHT_BROWSERS_PATH;
	if (base === undefined || !existsSync(base)) return undefined;
	const shell = readdirSync(base)
		.filter((name) => name.startsWith("chromium_headless_shell-"))
		.sort()
		.at(-1);
	const path =
		shell === undefined ? undefined : join(base, shell, "chrome-linux", "headless_shell");
	return path !== undefined && existsSync(path) ? path : undefined;
};

const contentFlag = Flag.string("content").pipe(
	Flag.withDefault(join(ROOT, "content")),
	Flag.withDescription("the directory of reel scripts, one <id>.json each"),
);
const outFlag = Flag.string("out").pipe(
	Flag.withDefault(join(ROOT, "out")),
	Flag.withDescription("where videos, captions and the batch ledger are written"),
);

const studioLayer = (content: string, out: string) =>
	StudioLive({
		content,
		out,
		publicDir: join(ROOT, "public"),
		entryPoint: join(ROOT, "src", "composition", "index.ts"),
		browser: findBrowser(),
	}).pipe(Layer.provideMerge(NodeServices.layer));

const check = Command.make("check", {content: contentFlag}, ({content}) =>
	Effect.gen(function* () {
		const studio = yield* Studio;
		const reels = yield* studio.reels;
		let refused = 0;
		for (const reel of reels) {
			const verdict = judgeReel(reel);
			if (verdict._tag === "Fits") {
				yield* Console.log(`✓ ${reel.id} ${verdict.seconds.toFixed(1)}s`);
			} else {
				refused++;
				yield* Console.log(
					`✗ ${reel.id}\n${verdict.reasons.map((reason) => `    ${reason}`).join("\n")}`,
				);
			}
		}
		if (refused > 0)
			return yield* new StudioError({step: "check", message: `${refused} reel(s) refused`});
	}).pipe(Effect.provide(studioLayer(content, join(ROOT, "out")))),
).pipe(Command.withDescription("Judge every reel script against the vertical short-form medium"));

const soundtracks = Command.make("soundtracks", {content: contentFlag}, ({content}) =>
	Effect.gen(function* () {
		const studio = yield* Studio;
		for (const reel of yield* studio.reels) {
			yield* Console.log(`♪ ${yield* studio.soundtrack(reel)}`);
		}
	}).pipe(Effect.provide(studioLayer(content, join(ROOT, "out")))),
).pipe(Command.withDescription("Write every reel's soundtrack into public/ for Studio previews"));

const render = Command.make(
	"render",
	{
		ids: Argument.string("id").pipe(
			Argument.variadic(),
			Argument.withDescription("reel ids to render; none renders all"),
		),
		content: contentFlag,
		out: outFlag,
		force: Flag.boolean("force").pipe(
			Flag.withDefault(false),
			Flag.withDescription("render even when the ledger has it"),
		),
		concurrency: Flag.integer("concurrency").pipe(
			Flag.withDefault(1),
			Flag.withDescription("reels rendered at once"),
		),
	},
	({ids, content, out, force, concurrency}) =>
		Effect.gen(function* () {
			const result = yield* runBatch({
				only: ids,
				force,
				concurrency,
				ledger: join(out, "ledger.json"),
			});
			for (const id of result.unknown) yield* Console.log(`? ${id} has no script`);
			let failed = 0;
			for (const [id, outcome] of Object.entries(result.outcomes)) {
				if (outcome.status === "rendered") {
					yield* Console.log(`✓ ${id} ${outcome.seconds.toFixed(1)}s → ${outcome.video}`);
				} else if (outcome.status === "unchanged") {
					yield* Console.log(`= ${id} unchanged → ${outcome.video}`);
				} else {
					failed++;
					yield* Console.log(`✗ ${id} after ${outcome.attempts} attempt(s): ${outcome.error}`);
				}
			}
			if (failed > 0)
				return yield* new StudioError({step: "render", message: `${failed} reel(s) failed`});
		}).pipe(Effect.scoped, Effect.provide(studioLayer(content, out))),
).pipe(
	Command.withDescription(
		"Render reels to MP4 with a caption file each; unchanged reels are skipped",
	),
);

const cli = Command.make("reels").pipe(
	Command.withSubcommands([check, soundtracks, render]),
	Command.withDescription("Vertical short-form videos for fabrika and tuval"),
);

cli.pipe(Command.run({version: "0.0.0"}), Effect.provide(NodeServices.layer), NodeRuntime.runMain);
