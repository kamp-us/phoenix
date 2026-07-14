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
import {readFileSync, writeFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {NodeRuntime, NodeServices} from "@effect/platform-node";
import {DoormanClientLive, resolveApiKey} from "@kampus/depo";
import {Config, Console, Effect, Layer, Redacted} from "effect";
import {Command, Flag} from "effect/unstable/cli";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import {applyBlessing, parseBlessDecisions, renderBlessingGallery} from "./blessing-surface.ts";
import {renderCandidateSet} from "./candidate-render.ts";
import {parseCandidateSet, serializeCandidateSet} from "./candidate-set.ts";
import {loadGoldenPointer, serializeGoldenPointer} from "./golden-fs.ts";
import {blessSurface} from "./golden-pointer.ts";
import {storeGolden} from "./golden-store.ts";
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

// --- render-candidates: the candidate-render step (#2961) ------------------------

const termSlugFlag = Flag.string("term-slug").pipe(
	Flag.withDescription(
		"the seeded sözlük term slug to render the term page at (a real term on the preview)",
	),
);

const forcedFlagFlag = Flag.string("flag").pipe(
	Flag.withDescription(
		'the forced flag state the preview is rendered under, "<key>=on|off" (repeatable) — recorded as candidate-set provenance',
	),
	Flag.atLeast(0),
);

const tokenFlag = Flag.string("token").pipe(
	Flag.withDefault(""),
	Flag.withDescription(
		"depo pasaport apiKey (else KAMPUS_TOKEN or ~/.config/kampus/token, ADR 0045)",
	),
);

const emitFlag = Flag.string("emit").pipe(
	Flag.withDefault(""),
	Flag.withDescription(
		"also write the serialized candidate set to this path (stdout gets it either way)",
	),
);

/** Parse a `<key>=on|off` provenance flag token; a malformed token is a caller bug. */
const parseForcedFlag = (token: string): readonly [string, boolean] => {
	const eq = token.indexOf("=");
	const key = eq <= 0 ? "" : token.slice(0, eq).trim();
	const raw =
		eq <= 0
			? ""
			: token
					.slice(eq + 1)
					.trim()
					.toLowerCase();
	if (key.length === 0) {
		throw new Error(`design-capture: --flag must be "<key>=on|off", got: ${token}`);
	}
	if (raw === "on" || raw === "true" || raw === "1") return [key, true];
	if (raw === "off" || raw === "false" || raw === "0") return [key, false];
	throw new Error(`design-capture: --flag value must be on/off, got: ${token}`);
};

// The depo write layer for the store leg — DoormanClientLive over fetch. Golden bytes
// go to the content-addressed store the pointer references (ADR 0183 §1), so a
// candidate's emitted sha256 IS what a later bless commits (§5 no-re-render guard).
const DepoLive = DoormanClientLive.pipe(Layer.provide(FetchHttpClient.layer));

const renderCandidates = Command.make(
	"render-candidates",
	{
		previewUrl: previewUrlFlag,
		termSlug: termSlugFlag,
		out: outFlag,
		flag: forcedFlagFlag,
		token: tokenFlag,
		emit: emitFlag,
	},
	Effect.fn(function* ({previewUrl, termSlug, out, flag, token, emit}) {
		const apiKey = yield* resolveApiKey(token.length === 0 ? undefined : token);
		const forcedFlags = Object.fromEntries(flag.map(parseForcedFlag));
		const set = yield* renderCandidateSet(
			{previewUrl, params: {termSlug}, outDir: out, forcedFlags},
			{
				store: (pngBytes) => storeGolden({apiKey, pngBytes}).pipe(Effect.provide(DepoLive)),
			},
		);
		const serialized = serializeCandidateSet(set);
		if (emit.length > 0) {
			writeFileSync(emit, serialized);
		}
		// stdout is the candidate set — the input the blessing surface (#2962) consumes.
		yield* Console.log(serialized);
	}),
).pipe(
	Command.withDescription(
		"Render the founder priority surfaces over a flag-forced preview into a blessing candidate set (#2961)",
	),
);

// --- the blessing surface: gallery + bless-set (#2962) ---------------------------

const setFlag = Flag.string("set").pipe(
	Flag.withDescription("path to the serialized candidate set (render-candidates --emit output)"),
);

// golden-gallery: render the founder-facing GitHub gallery comment from a candidate set
// (ADR 0183 §5, option a). Emits markdown on stdout for the operator to post on the PR;
// the founder marks each surface approve/redline in the copied decision template.
const gallery = Command.make(
	"golden-gallery",
	{set: setFlag},
	Effect.fn(function* ({set}) {
		const candidateSet = parseCandidateSet(readFileSync(set, "utf8"));
		yield* Console.log(renderBlessingGallery(candidateSet));
	}),
).pipe(
	Command.withDescription(
		"Render the founder blessing gallery comment from a candidate set (#2962, ADR 0183)",
	),
);

const decisionsFlag = Flag.string("decisions").pipe(
	Flag.withDescription(
		"path to the founder's filled-in decision block (one `<surfaceId> approve|redline` per line)",
	),
);

// golden-bless-set: fold the founder's approve/redline verdicts into a golden-pointer
// move — bless every approved candidate to the sha256 it carries in the SET (the ADR
// 0183 §5 no-re-render guard: never a re-render, the committed sha is exactly what the
// founder saw), leave redlined ones out, and write the committed pointer. A re-bless is
// the same fold over the existing pointer (story 9's explicit committed update).
const blessSet = Command.make(
	"golden-bless-set",
	{set: setFlag, decisions: decisionsFlag, pointer: pointerFlag},
	Effect.fn(function* ({set, decisions, pointer}) {
		const candidateSet = parseCandidateSet(readFileSync(set, "utf8"));
		const founderDecisions = parseBlessDecisions(readFileSync(decisions, "utf8"));
		const blessedDate = new Date().toISOString().slice(0, 10);
		const result = applyBlessing({
			set: candidateSet,
			decisions: founderDecisions,
			blessedDate,
			pointer: loadGoldenPointer(pointer),
		});
		writeFileSync(pointer, serializeGoldenPointer(result.pointer));
		for (const b of result.blessed) {
			yield* Console.log(`design-capture: blessed ${b.surfaceId} → depo ${b.sha256}.png`);
		}
		for (const surfaceId of result.redlined) {
			yield* Console.log(`design-capture: redlined ${surfaceId} (not blessed)`);
		}
		yield* Console.log(
			`design-capture: committed ${result.blessed.length} golden(s) (${blessedDate}) → ${pointer}`,
		);
	}),
).pipe(
	Command.withDescription(
		"Commit the founder's blessed candidate set into the golden pointer (#2962, ADR 0183)",
	),
);

const cli = Command.make("design-capture").pipe(
	Command.withSubcommands([capture, bless, renderCandidates, gallery, blessSet]),
	Command.withDescription(
		"Playwright-capture + golden-baseline (store/resolve/diff) for the review-design gate (ADR 0165/0183)",
	),
);

cli.pipe(Command.run({version: "0.0.0"}), Effect.provide(NodeServices.layer), NodeRuntime.runMain);
