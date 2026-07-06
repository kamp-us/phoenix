/**
 * `review-capture run` — the CI-/skill-callable surface (ADR 0165, #2247).
 *
 * Captures the changed UI surfaces of a PR over its EXISTING per-PR preview
 * deploy and uploads each PNG to GitHub user-attachments, printing the per-shot
 * evidence as JSON on stdout for the review-design skill (#2246) to embed in its
 * SHA-bound marker comment. Mechanical-tooling idiom (`effect/unstable/cli`, pure
 * core + thin bin), never an ad-hoc script.
 *
 *   node src/bin.ts run \
 *     --preview-url https://pr-123.web.kamp.us \
 *     --surfaces '[{"label":"sozluk-home","route":"/sozluk"}]' \
 *     --repository-id 1234177275
 *
 * `$GITHUB_TOKEN` (a user/GITHUB_TOKEN with write on the target repo) authorizes
 * the undocumented upload endpoint — read as a redacted Config, never a flag.
 */
import {NodeRuntime, NodeServices} from "@effect/platform-node";
import {Config, Console, Effect, Redacted} from "effect";
import {Command, Flag} from "effect/unstable/cli";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import {captureAndUpload} from "./orchestrate.ts";
import type {Surface} from "./plan.ts";

const previewUrlFlag = Flag.string("preview-url").pipe(
	Flag.withDescription("the per-PR preview-deploy base URL to capture over"),
);

const surfacesFlag = Flag.string("surfaces").pipe(
	Flag.withDescription('JSON array of surfaces to shoot, e.g. [{"label":"x","route":"/x"}]'),
);

const repositoryIdFlag = Flag.string("repository-id").pipe(
	Flag.withDescription("target repo numeric id (gh api repos/OWNER/REPO --jq .id)"),
);

const parseSurfaces = (raw: string): readonly Surface[] => {
	const parsed: unknown = JSON.parse(raw);
	if (!Array.isArray(parsed)) throw new Error("--surfaces must be a JSON array");
	return parsed.map((s, i) => {
		if (typeof s !== "object" || s === null) throw new Error(`--surfaces[${i}] is not an object`);
		const rec = s as Record<string, unknown>;
		if (typeof rec.label !== "string" || typeof rec.route !== "string") {
			throw new Error(`--surfaces[${i}] needs string "label" and "route"`);
		}
		return {label: rec.label, route: rec.route};
	});
};

const run = Command.make(
	"run",
	{previewUrl: previewUrlFlag, surfaces: surfacesFlag, repositoryId: repositoryIdFlag},
	Effect.fn(function* ({previewUrl, surfaces, repositoryId}) {
		const token = yield* Config.redacted("GITHUB_TOKEN");
		const repoId = Number(repositoryId);
		if (!Number.isInteger(repoId)) {
			return yield* Effect.die(
				new Error(`--repository-id must be an integer, got ${repositoryId}`),
			);
		}
		const evidence = yield* captureAndUpload({
			previewUrl,
			surfaces: parseSurfaces(surfaces),
			repositoryId: repoId,
			token: Redacted.value(token),
		}).pipe(Effect.provide(FetchHttpClient.layer));
		yield* Console.log(JSON.stringify(evidence, null, 2));
	}),
).pipe(Command.withDescription("Capture a PR's changed surfaces over its preview and host them"));

const cli = Command.make("review-capture").pipe(
	Command.withSubcommands([run]),
	Command.withDescription(
		"Playwright-capture + GitHub user-attachments upload for the review-design gate (ADR 0165)",
	),
);

cli.pipe(Command.run({version: "0.0.0"}), Effect.provide(NodeServices.layer), NodeRuntime.runMain);
