/**
 * The studio: every side effect a batch performs — reading reel scripts, writing soundtracks,
 * bundling and rendering through Remotion, writing the caption a poster pastes. The machine
 * decides; this does.
 */
import {createHash} from "node:crypto";
import {readdir, readFile, stat} from "node:fs/promises";
import {join, resolve} from "node:path";
import {bundle} from "@remotion/bundler";
import {renderMedia, selectComposition} from "@remotion/renderer";
import {Console, Context, Effect, FileSystem, Layer} from "effect";
import * as Schema from "effect/Schema";
import {synthesize} from "./audio.ts";
import {decodeReel, type Reel} from "./reel.ts";
import {soundtrackFile} from "./soundtrack-file.ts";
import {FPS, judgeReel, planTimeline} from "./timeline.ts";

export class StudioError extends Schema.TaggedError<StudioError>()("@kampus/reels/StudioError", {
	step: Schema.String,
	message: Schema.String,
}) {}

/** Where a studio reads scripts and writes its work. */
export interface StudioPaths {
	readonly content: string;
	readonly publicDir: string;
	readonly out: string;
	readonly entryPoint: string;
	/** A Chrome or headless shell to render with; absent lets Remotion fetch its own. */
	readonly browser: string | undefined;
}

export class Studio extends Context.Service<
	Studio,
	{
		readonly reels: Effect.Effect<ReadonlyArray<Reel>, StudioError>;
		/** The hash of everything a render depends on besides the script: the engine's own source. */
		readonly engineHash: Effect.Effect<string, StudioError>;
		readonly soundtrack: (reel: Reel) => Effect.Effect<string, StudioError>;
		readonly bundle: Effect.Effect<string, StudioError>;
		readonly render: (
			reel: Reel,
			serveUrl: string,
		) => Effect.Effect<{readonly video: string; readonly seconds: number}, StudioError>;
		readonly caption: (reel: Reel, video: string) => Effect.Effect<string, StudioError>;
	}
>()("@kampus/reels/Studio") {}

const attempt = <A>(step: string, run: () => Promise<A>) =>
	Effect.tryPromise({
		try: run,
		catch: (cause) =>
			new StudioError({step, message: cause instanceof Error ? cause.message : String(cause)}),
	});

/** The text a poster pastes under the video: title, description, hashtags. */
export const captionText = (reel: Reel): string =>
	`${reel.title}\n\n${reel.description}\n\n${reel.hashtags.join(" ")}\n`;

const ENGINE_SOURCES = ["composition", "audio.ts", "markup.ts", "timeline.ts", "reel.ts"];

const listFiles = async (path: string): Promise<ReadonlyArray<string>> => {
	if (!(await stat(path)).isDirectory()) return [path];
	const entries = await readdir(path, {recursive: true, withFileTypes: true});
	return entries
		.filter((entry) => entry.isFile())
		.map((entry) => join(entry.parentPath, entry.name))
		.sort();
};

export const StudioLive = (paths: StudioPaths) =>
	Layer.effect(Studio)(
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const write = (step: string, path: string, bytes: Uint8Array) =>
				fs.makeDirectory(resolve(path, ".."), {recursive: true}).pipe(
					Effect.andThen(fs.writeFile(path, bytes)),
					Effect.mapError((cause) => new StudioError({step, message: cause.message})),
				);

			const reels = Effect.gen(function* () {
				const names = yield* attempt("read content", () => readdir(paths.content));
				const decoded: Array<Reel> = [];
				for (const name of names.filter((file) => file.endsWith(".json")).sort()) {
					const raw = yield* attempt(`read ${name}`, () =>
						readFile(join(paths.content, name), "utf8"),
					);
					const json = yield* Effect.try({
						try: () => JSON.parse(raw) as unknown,
						catch: () => new StudioError({step: `parse ${name}`, message: "not JSON"}),
					});
					const reel = yield* decodeReel(json).pipe(
						Effect.mapError(
							(cause) => new StudioError({step: `decode ${name}`, message: cause.message}),
						),
					);
					if (`${reel.id}.json` !== name) {
						return yield* new StudioError({
							step: `decode ${name}`,
							message: `id "${reel.id}" does not match its file name`,
						});
					}
					decoded.push(reel);
				}
				return decoded;
			});

			const engineHash = attempt("hash engine", async () => {
				const hash = createHash("sha256");
				for (const source of ENGINE_SOURCES) {
					for (const file of await listFiles(join(import.meta.dirname, source))) {
						hash.update(file.slice(import.meta.dirname.length));
						hash.update(await readFile(file));
					}
				}
				return hash.digest("hex").slice(0, 16);
			});

			const soundtrack = (reel: Reel) =>
				Effect.gen(function* () {
					const file = soundtrackFile(reel.id);
					yield* write(
						"soundtrack",
						join(paths.publicDir, file),
						synthesize(reel, planTimeline(reel)),
					);
					return file;
				});

			const bundled = attempt("bundle", () =>
				bundle({entryPoint: paths.entryPoint, publicDir: paths.publicDir, enableCaching: true}),
			);

			const render = (reel: Reel, serveUrl: string) =>
				Effect.gen(function* () {
					const verdict = judgeReel(reel);
					if (verdict._tag === "Refused") {
						return yield* new StudioError({step: "judge", message: verdict.reasons.join("; ")});
					}
					const inputProps = {reel, soundtrack: soundtrackFile(reel.id)};
					const browser = paths.browser === undefined ? {} : {browserExecutable: paths.browser};
					const composition = yield* attempt("select composition", () =>
						selectComposition({
							serveUrl,
							id: reel.id,
							inputProps,
							...browser,
							chromeMode: "headless-shell",
							logLevel: "error",
						}),
					);
					const video = join(paths.out, `${reel.id}.mp4`);
					let reported = -1;
					yield* attempt("render", () =>
						renderMedia({
							composition,
							serveUrl,
							codec: "h264",
							crf: 20,
							outputLocation: video,
							inputProps,
							...browser,
							chromeMode: "headless-shell",
							logLevel: "error",
							onProgress: ({progress}) => {
								const step = Math.floor(progress * 4);
								if (step > reported) {
									reported = step;
									process.stderr.write(`reels: ${reel.id} ${Math.round(progress * 100)}%\n`);
								}
							},
						}),
					);
					return {video, seconds: composition.durationInFrames / FPS};
				});

			const caption = (reel: Reel, video: string) =>
				Effect.gen(function* () {
					const path = video.replace(/\.mp4$/, ".txt");
					yield* write("caption", path, new TextEncoder().encode(captionText(reel)));
					return path;
				});

			yield* Console.log(`reels: content ${paths.content} → ${paths.out}`);
			return {reels, engineHash, soundtrack, bundle: bundled, render, caption};
		}),
	);
