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
import {NodeRuntime, NodeServices} from "@effect/platform-node";
import {Config, Console, Effect, Redacted} from "effect";
import {Command, Flag} from "effect/unstable/cli";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
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

const cli = Command.make("design-capture").pipe(
	Command.withSubcommands([capture]),
	Command.withDescription(
		"Playwright-capture + GitHub user-attachments upload for the review-design gate (ADR 0165)",
	),
);

cli.pipe(Command.run({version: "0.0.0"}), Effect.provide(NodeServices.layer), NodeRuntime.runMain);
