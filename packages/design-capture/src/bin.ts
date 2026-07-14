/**
 * `design-capture capture` — the CI-/skill-callable surface (ADR 0165, #2247),
 * driven by the review-design skill (#2246):
 *
 *   node packages/design-capture/src/bin.ts capture \
 *     --preview-url https://pr-123.web.kamp.us \
 *     --surface "/sozluk" [--surface "/sozluk:empty" ...] \
 *     --out <dir> \
 *     --repo-id 1234177275
 *
 * Captures each changed surface over the EXISTING per-PR preview deploy, writes
 * the PNG bytes under `--out`, uploads each to GitHub user-attachments, and
 * prints a JSON array of per-surface records
 * `{ surface, route, state, localPath, hostedUrl, uploadError }` on stdout — the
 * contract the review-design skill judges (`localPath`) and embeds (`hostedUrl`).
 * Mechanical-tooling idiom (`effect/unstable/cli`, pure core + thin bin).
 *
 * `$GITHUB_TOKEN` (a user/GITHUB_TOKEN with write on the target repo) authorizes
 * the undocumented upload endpoint — read as a redacted Config, never a flag.
 */
import {writeFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {NodeRuntime, NodeServices} from "@effect/platform-node";
import {Config, Console, Effect, Redacted} from "effect";
import {Command, Flag} from "effect/unstable/cli";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import {loadGoldenPointer, serializeGoldenPointer} from "./golden-fs.ts";
import {blessSurface} from "./golden-pointer.ts";
import {captureAndUpload} from "./orchestrate.ts";
import {renderCrashFailure} from "./page-errors.ts";
import {parseSurfaceSpec} from "./plan.ts";

const previewUrlFlag = Flag.string("preview-url").pipe(
	Flag.withDescription("the per-PR preview-deploy base URL to capture over"),
);

const surfaceFlag = Flag.string("surface").pipe(
	Flag.withDescription(
		'a surface to shoot, "<route>[:state]" (repeatable), e.g. /sozluk or /sozluk:empty',
	),
	Flag.atLeast(1),
);

const outFlag = Flag.string("out").pipe(
	Flag.withDescription("output directory for the captured PNG bytes"),
);

const repoIdFlag = Flag.string("repo-id").pipe(
	Flag.withDescription("target repo numeric id (gh api repos/OWNER/REPO --jq .id)"),
);

const capture = Command.make(
	"capture",
	{previewUrl: previewUrlFlag, surface: surfaceFlag, out: outFlag, repoId: repoIdFlag},
	Effect.fn(function* ({previewUrl, surface, out, repoId}) {
		const token = yield* Config.redacted("GITHUB_TOKEN");
		const repositoryId = Number(repoId);
		if (!Number.isInteger(repositoryId)) {
			return yield* Effect.die(new Error(`--repo-id must be an integer, got ${repoId}`));
		}
		const records = yield* captureAndUpload({
			previewUrl,
			surfaces: surface.map(parseSurfaceSpec),
			outDir: out,
			repositoryId,
			token: Redacted.value(token),
		}).pipe(Effect.provide(FetchHttpClient.layer));
		yield* Console.log(JSON.stringify(records, null, 2));
		// stdout stays the clean JSON array (the gate's input); the crash summary
		// goes to stderr as a loud operator signal without perturbing the contract.
		const crash = renderCrashFailure(records);
		if (crash !== null) {
			yield* Console.error(`design-capture: render FAILED — ${crash}`);
		}
	}),
).pipe(Command.withDescription("Capture a PR's changed surfaces over its preview and host them"));

// The committed golden pointer, co-located with the package (the migrations-guard
// migration-hashes.json shape, ADR 0108/0183 §4). Resolved relative to src/ so the
// bless runs the same from any CWD.
const DEFAULT_POINTER = fileURLToPath(new URL("../golden-pointer.json", import.meta.url));

const pointerFlag = Flag.string("pointer").pipe(
	Flag.withDefault(DEFAULT_POINTER),
	Flag.withDescription("path to the committed golden pointer file (golden-pointer.json)"),
);

const blessSurfaceFlag = Flag.string("surface").pipe(
	Flag.withDescription(
		'the surface-id to (re-)bless, "<route>[:state]" (e.g. /sozluk or /sozluk:empty)',
	),
);

const blessShaFlag = Flag.string("sha256").pipe(
	Flag.withDescription(
		"the 64-hex depo content-address of the APPROVED golden bytes (already PUT to depo)",
	),
);

const blessIntentFlag = Flag.string("intent").pipe(
	Flag.withDescription("human note: what this golden captures / why it was (re-)blessed"),
);

// Move the git pointer to an already-approved depo sha — the audited `bless`, the
// golden analogue of migrations-guard's `baseline` (ADR 0183 §4/§5). Pure + fs: it
// records the sha the founder approved in the gallery comment; it does NOT re-render
// or re-store bytes (the no-re-render guard — the approved sha IS the committed sha).
const bless = Command.make(
	"golden-bless",
	{pointer: pointerFlag, surface: blessSurfaceFlag, sha256: blessShaFlag, intent: blessIntentFlag},
	Effect.fn(function* ({pointer, surface, sha256, intent}) {
		const blessedDate = new Date().toISOString().slice(0, 10);
		const next = blessSurface(loadGoldenPointer(pointer), {
			surfaceId: surface,
			sha256,
			blessedDate,
			intent,
		});
		writeFileSync(pointer, serializeGoldenPointer(next));
		yield* Console.log(
			`design-capture: blessed ${surface} → depo ${sha256}.png (${blessedDate}) → ${pointer}`,
		);
	}),
).pipe(
	Command.withDescription(
		"Move the git golden pointer for a surface to an approved depo sha256 (the audited re-bless, ADR 0183)",
	),
);

const cli = Command.make("design-capture").pipe(
	Command.withSubcommands([capture, bless]),
	Command.withDescription(
		"Playwright-capture + golden-baseline (store/resolve/diff) for the review-design gate (ADR 0165/0183)",
	),
);

cli.pipe(Command.run({version: "0.0.0"}), Effect.provide(NodeServices.layer), NodeRuntime.runMain);
