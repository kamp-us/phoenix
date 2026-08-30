/**
 * `review-ui post` — the single sanctioned `review-ui` verdict emit.
 *
 * Eight steps, each gating the next: re-resolve the live head, read the evidence set through its
 * manifest, require a `render` receipt for preview evidence or re-download the exact CI artifact
 * selected by the governed workflow/run/check/artifact tuple, byte-compare every CI member,
 * re-validate every capture, **verify-upload every capture before anything posts**, compose through the wire
 * format with complete provenance, leak-scan the assembled comment, upsert one
 * comment for this namespace under this carrier, and read it back from live PR state.
 *
 * Step 4 is this verb's reason to exist. The capture package's upload leg is `never`-typed by
 * contract — every transport failure degrades to `{hostedUrl: null, uploadError}` and no consumer
 * ever read `uploadError` — so a 100%-failed evidence channel decorated months of PASSes (#3925).
 * Here a failed upload or a failed verification is `17` and **nothing is posted**: ADR 0165's
 * judge-the-local-bytes still stands (the pixels you judged were local), but the *marker* does not
 * land over a broken evidence channel.
 *
 * There is no `--namespace`. This group emits `review-ui` and nothing else, so a
 * misdirected-namespace write is unrepresentable rather than refused.
 */
import {Effect, type FileSystem, Path, Result} from "effect";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {validateCaptureBytes} from "../capture/png.ts";
import {exists, readFile} from "../io/fs.ts";
import {createComment, getComment, listComments} from "../io/issues.ts";
import {isRecord, parseJson} from "../io/json.ts";
import {patchComment, viewerLogin} from "../io/pulls.ts";
import type {StdinRead} from "../io/stdin.ts";
import {normalizeForReadback} from "../report/compose.ts";
import {emitAdvisory, readAdvisory, reviewedHeadLine} from "../review/advisory.ts";
import {type AuthoredSurface, leakRefusal, readAuthored} from "../review/authored.ts";
import {openPull, resolveTargetRepo, scannedLine} from "../review/target.ts";
import {commitShaAtRef, defaultBranch, readFileAtRef} from "../ship/github.ts";
import {answer, FAILED, refuse, type VerbOutcome} from "../verb.ts";
import {
	emit as emitMarker,
	headSha,
	type Polarity,
	read as readMarker,
	clause as toClause,
} from "../wire/verdict-marker.ts";
import {fetchCiBundle} from "./ci-github.ts";
import {
	INVALID_CAPTURE,
	MALFORMED_DOCUMENT,
	OFF_VOCABULARY,
	PRECONDITION_UNKNOWN,
	READBACK_MISMATCH,
	RENDER_CRASHED,
	STALE_TREE,
	UPLOAD_FAILED,
	WRITE_UNKNOWN,
} from "./codes.ts";
import {
	CI_PROVENANCE_RECEIPT,
	declarationDigest,
	LOCALHOST_DECLARATIONS_PATH,
	parseCiCaptureManifest,
	parseLocalhostDeclarations,
	parseValidatedCiProvenance,
	type ValidatedCiProvenance,
} from "./localhost-evidence.ts";
import {
	type CaptureEntry,
	manifestPath,
	PREVIEW_PROVENANCE_RECEIPT,
	type PreviewProvenance,
	parseManifest,
	parsePreviewProvenance,
	previewProvenanceKeyPath,
	readCaptureBytes,
	setDirectory,
	sha256Hex,
	verifyPreviewProvenance,
} from "./manifest.ts";
import {resolvePreview} from "./preview.ts";

const VERB = "review-ui post";

/** This group's one namespace — an input nowhere, so it can never be aimed elsewhere. */
export const NAMESPACE = "review-ui";

const SURFACE: AuthoredSurface = {
	verb: VERB,
	noun: "the assembled comment",
	emptyMessage: `${VERB}: no body on stdin — an empty verdict reads as ungated; pipe the verdict body in.`,
	bareAtMessage: `${VERB}: the body is a bare "@" path reference — the body never arrived. Send its bytes on stdin.`,
	leakCorrection: "cite it repo-relative or by class root.",
};

export type Carrier = "marker" | "advisory";

/** One capture's upload, verified — or the reason it is not evidence anybody can see. */
export type UploadResult =
	| {readonly _tag: "Hosted"; readonly url: string}
	| {readonly _tag: "Failed"; readonly reason: string};

export interface UploadRequest {
	readonly repo: string;
	readonly fileName: string;
	readonly bytes: Uint8Array;
}

/**
 * The evidence-upload seam: upload one capture and **probe it back**, individually.
 *
 * Injected so the refusal path is testable without the network, and so the two tiers the contract
 * names (a repo-declared store, else the GitHub user-attachment tier) are a wiring choice rather
 * than a branch inside the verb.
 */
export type UploadLeg = (
	request: UploadRequest,
) => Effect.Effect<
	UploadResult,
	never,
	HttpClient.HttpClient | ChildProcessSpawner.ChildProcessSpawner
>;

export interface PostOptions {
	readonly pr: number;
	readonly polarity: string;
	readonly sha: string;
	readonly clause: string;
	/** The `review-ui render` capture-set name whose verified upload is this verdict's evidence. */
	readonly evidence: string;
	readonly carrier: string;
	readonly repo: string | null;
	readonly env: Readonly<Record<string, string | undefined>>;
	readonly stdin: Effect.Effect<StdinRead>;
	/** The OS temp root the set path hangs off — the same port `render` takes. */
	readonly tmpRoot: string;
	/**
	 * Where the tier-choice document is read from: the **reviewer's own checked-out tree**, never
	 * the PR head, which this skill never checks out.
	 */
	readonly harnessPath: string;
	readonly upload: UploadLeg;
	readonly fetchCiBundle?: typeof fetchCiBundle;
}

/** Either side may be abbreviated, so the match is a prefix in whichever direction is shorter. */
const prefixMatch = (a: string, b: string): boolean => a.startsWith(b) || b.startsWith(a);

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean =>
	a.byteLength === b.byteLength && a.every((value, index) => value === b[index]);

const unreadable = (what: string, pr: number, reason: string): VerbOutcome =>
	refuse(
		PRECONDITION_UNKNOWN,
		`${VERB}: cannot read ${what} for #${pr}: ${reason} — nothing was uploaded or posted.`,
	);

/**
 * Whether a comment already holds this namespace's verdict **under this carrier** — the upsert key.
 *
 * Per carrier because the two anchor on different bytes: an advisory withholds the SHA from its
 * first line by design (ADR 0111), so a marker-only match never finds a prior advisory and every
 * §CP re-post would stack a second comment (#4992).
 */
const carriesNamespace = (body: string, carrier: Carrier): boolean => {
	if (carrier === "advisory") return readAdvisory(body)?.namespace === NAMESPACE;
	const parsed = readMarker(body);
	return parsed._tag === "Found" && parsed.value.namespace === NAMESPACE;
};

/** Why the read-back does not show what was posted, or `null` when it does. */
const mismatchOf = (
	body: string,
	posted: {readonly polarity: string; readonly sha: string; readonly clause: string},
	carrier: Carrier,
	composed: string,
): string | null => {
	const normalized = normalizeForReadback(body);
	const bytes =
		normalized === normalizeForReadback(composed)
			? null
			: "the comment's bytes are not the ones that were sent";
	if (carrier === "advisory") {
		const advisory = readAdvisory(normalized);
		if (advisory === null) return "the advisory first line or its Reviewed-head: line is not there";
		if (advisory.namespace !== NAMESPACE) {
			return `namespace ${advisory.namespace}, expected ${NAMESPACE}`;
		}
		if (advisory.sha !== posted.sha) return `Reviewed-head ${advisory.sha}, expected ${posted.sha}`;
		return bytes;
	}
	const parsed = readMarker(normalized);
	if (parsed._tag !== "Found") return parsed.reason;
	const marker = parsed.value;
	if (marker.namespace !== NAMESPACE) return `namespace ${marker.namespace}, expected ${NAMESPACE}`;
	if (marker.polarity !== posted.polarity) {
		return `polarity ${marker.polarity}, expected ${posted.polarity}`;
	}
	if (marker.sha !== posted.sha) return `sha ${marker.sha}, expected ${posted.sha}`;
	if (marker.clause !== posted.clause) {
		return `clause "${marker.clause}", expected "${posted.clause}"`;
	}
	return bytes;
};

/** The evidence gallery: per surface, the **verified** hosted URL — never a local path. */
const gallery = (hosted: ReadonlyArray<readonly [CaptureEntry, string]>): string =>
	[
		"## Evidence",
		"",
		...hosted.flatMap(([entry, url]) => [
			`### ${entry.surface}`,
			"",
			`![${entry.surface}](${url})`,
			"",
		]),
	]
		.join("\n")
		.replace(/\n+$/, "");

/**
 * Which evidence tier this repo declares, read whole (`4` on a document that does not satisfy its
 * schema) — the `ui evidence` whole-file rule.
 *
 * An absent `design-harness.json` is the **attachment tier**, a first-class state and not a defect:
 * a repo that declares no store hosts its evidence on GitHub.
 */
type TierChoice =
	| {readonly _tag: "Attachment"}
	| {readonly _tag: "DeclaredStore"; readonly kind: string}
	| {readonly _tag: "Malformed"; readonly reason: string}
	| {readonly _tag: "Unreadable"; readonly reason: string};

const readTierChoice = (
	path: string,
): Effect.Effect<TierChoice, never, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const present = yield* Effect.result(exists(path));
		if (Result.isFailure(present)) {
			return {_tag: "Unreadable" as const, reason: present.failure.reason};
		}
		if (!present.success) return {_tag: "Attachment" as const};
		const text = yield* Effect.result(readFile(path));
		if (Result.isFailure(text)) {
			return {_tag: "Unreadable" as const, reason: text.failure.reason};
		}
		const parsed = parseJson(text.success);
		if (!isRecord(parsed)) {
			return {_tag: "Malformed" as const, reason: "not a JSON object"};
		}
		const store = parsed.evidenceStore;
		if (store === undefined) return {_tag: "Attachment" as const};
		if (!isRecord(store) || typeof store.kind !== "string") {
			return {_tag: "Malformed" as const, reason: "evidenceStore declares no string kind"};
		}
		return {_tag: "DeclaredStore" as const, kind: store.kind};
	});

export const runPost = (
	options: PostOptions,
): Effect.Effect<
	VerbOutcome,
	never,
	| HttpClient.HttpClient
	| ChildProcessSpawner.ChildProcessSpawner
	| FileSystem.FileSystem
	| Path.Path
> =>
	Effect.gen(function* () {
		const {pr} = options;
		if (!Number.isInteger(pr) || pr <= 0) {
			return refuse(FAILED, `${VERB}: ${pr} is not a pull-request number.`);
		}
		const polarity = options.polarity.toUpperCase();
		if (polarity !== "PASS" && polarity !== "FAIL") {
			return refuse(
				OFF_VOCABULARY,
				`${VERB}: --polarity must be PASS or FAIL — got "${options.polarity}".`,
			);
		}
		const carrier = options.carrier.toLowerCase();
		if (carrier !== "marker" && carrier !== "advisory") {
			return refuse(
				OFF_VOCABULARY,
				`${VERB}: --carrier must be marker or advisory — got "${options.carrier}".`,
			);
		}
		if (carrier === "advisory" && polarity === "FAIL") {
			return refuse(
				OFF_VOCABULARY,
				`${VERB}: --carrier advisory is a PASS path only — post the FAIL marker instead.`,
			);
		}
		const inspected = headSha(options.sha);
		if (inspected === null) {
			return refuse(
				OFF_VOCABULARY,
				`${VERB}: --sha "${options.sha}" is not a head SHA — expected 7–40 hex characters.`,
			);
		}
		const clause = toClause(options.clause);
		if (clause === null) {
			return refuse(
				OFF_VOCABULARY,
				`${VERB}: --clause is blank — a verdict with no clause says nothing to a human.`,
			);
		}

		const resolved = yield* resolveTargetRepo(VERB, options.repo, options.env);
		if (resolved._tag === "Refused") return resolved.outcome;
		const repo = resolved.repo;

		const authored = readAuthored(SURFACE, yield* options.stdin);
		if (authored._tag === "Refused") return authored.outcome;

		// Step 1 — the verdict binds the tree it was formed over, or it is re-reviewed, never re-bound.
		const target = yield* openPull(VERB, repo, pr, {
			requireOpen: true,
			closedReason: "a verdict on a closed PR gates nothing.",
			requireFiles: false,
			unknownMessage: (reason) =>
				`${VERB}: cannot read the PR for #${pr}: ${reason} — nothing was uploaded or posted.`,
		});
		if (target._tag === "Refused") return target.outcome;
		const live = target.pull.headSha;
		if (!prefixMatch(live, inspected)) {
			return refuse(
				STALE_TREE,
				`${VERB}: the live head is ${live}, not ${inspected} — the tree you judged is gone; re-review at ${live} (ADR 0058).`,
			);
		}

		// Step 2 — the set is whatever its manifest says it is; an evidence-less verdict must not land.
		const setDir = setDirectory(options.tmpRoot, pr, live, options.evidence);
		const document = yield* Effect.result(readFile(manifestPath(setDir)));
		if (Result.isFailure(document)) {
			return refuse(
				MALFORMED_DOCUMENT,
				`${VERB}: evidence set "${options.evidence}" has no readable manifest.json (${document.failure.reason}) — a set without its manifest is not a set; re-run the sanctioned producer (review-ui render or review-ui fetch).`,
			);
		}
		const raw = parseJson(document.success);
		const ciDocument = isRecord(raw) && raw.source === "github-actions";
		const requiresCiProvenance = ciDocument;
		const ciRead = ciDocument ? parseCiCaptureManifest(document.success) : null;
		const previewRead = ciDocument ? null : parseManifest(document.success);
		const malformed =
			ciRead?._tag === "Malformed"
				? ciRead.reason
				: previewRead?._tag === "Malformed"
					? previewRead.reason
					: null;
		if (malformed !== null) {
			return refuse(
				MALFORMED_DOCUMENT,
				`${VERB}: evidence set "${options.evidence}" has no readable manifest.json (${malformed}) — a set without its manifest is not a set; re-run the sanctioned producer (review-ui render or review-ui fetch).`,
			);
		}
		const manifest =
			ciRead?._tag === "Manifest"
				? ciRead.value
				: previewRead?._tag === "Manifest"
					? previewRead.value
					: null;
		if (manifest === null) {
			return refuse(
				MALFORMED_DOCUMENT,
				`${VERB}: evidence set "${options.evidence}" has no readable manifest.json.`,
			);
		}
		let trustedCiProvenance: ValidatedCiProvenance | null = null;
		let trustedPreviewProvenance: PreviewProvenance | null = null;
		if (!requiresCiProvenance) {
			const previewManifest = previewRead?._tag === "Manifest" ? previewRead.value : null;
			if (previewManifest === null) {
				return refuse(
					MALFORMED_DOCUMENT,
					`${VERB}: preview evidence set "${options.evidence}" has no readable preview manifest.`,
				);
			}
			const receiptRead = yield* Effect.result(readFile(`${setDir}/${PREVIEW_PROVENANCE_RECEIPT}`));
			if (Result.isFailure(receiptRead)) {
				return refuse(
					MALFORMED_DOCUMENT,
					`${VERB}: preview evidence set "${options.evidence}" has no review-ui render provenance receipt — route-shaped local captures are not evidence.`,
				);
			}
			const receipt = parsePreviewProvenance(receiptRead.success);
			const keyRead =
				receipt === null
					? null
					: yield* Effect.result(
							readFile(previewProvenanceKeyPath(options.tmpRoot, receipt.keyId)),
						);
			const manifestHash = sha256Hex(new TextEncoder().encode(document.success));
			if (
				receipt === null ||
				keyRead === null ||
				Result.isFailure(keyRead) ||
				!verifyPreviewProvenance(receipt, keyRead.success) ||
				receipt.repository !== repo ||
				receipt.pr !== pr ||
				receipt.head !== previewManifest.head ||
				receipt.previewUrl !== previewManifest.previewUrl ||
				receipt.manifestSha256 !== manifestHash ||
				previewManifest.pr !== pr ||
				previewManifest.set !== options.evidence ||
				previewManifest.captures.some((capture) => !capture.surface.startsWith("/"))
			) {
				return refuse(
					MALFORMED_DOCUMENT,
					`${VERB}: preview evidence set "${options.evidence}" does not match its review-ui render provenance receipt.`,
				);
			}
			trustedPreviewProvenance = receipt;
		}
		if (requiresCiProvenance) {
			const receiptRead = yield* Effect.result(readFile(`${setDir}/${CI_PROVENANCE_RECEIPT}`));
			if (Result.isFailure(receiptRead)) {
				return refuse(
					MALFORMED_DOCUMENT,
					`${VERB}: CI evidence set "${options.evidence}" has no consumer-validated provenance receipt — a builder-authored manifest is not evidence.`,
				);
			}
			const receipt = parseValidatedCiProvenance(receiptRead.success);
			const ciManifest = ciRead?._tag === "Manifest" ? ciRead.value : null;
			const manifestHash = sha256Hex(new TextEncoder().encode(document.success));
			if (
				receipt === null ||
				ciManifest === null ||
				receipt.repository !== repo ||
				receipt.pr !== pr ||
				receipt.head !== live ||
				receipt.harness !== ciManifest.harness ||
				receipt.runId !== ciManifest.producer.runId ||
				receipt.manifestSha256 !== manifestHash
			) {
				return refuse(
					MALFORMED_DOCUMENT,
					`${VERB}: CI evidence set "${options.evidence}" does not match its consumer-validated provenance receipt.`,
				);
			}

			const base = yield* defaultBranch(repo);
			if (base._tag === "Failure") {
				return refuse(
					PRECONDITION_UNKNOWN,
					`${VERB}: cannot revalidate CI provenance because the default branch is unreadable (${base.reason}).`,
				);
			}
			const authorityRevision = yield* commitShaAtRef(repo, base.value);
			if (authorityRevision._tag === "Failure") {
				return refuse(
					PRECONDITION_UNKNOWN,
					`${VERB}: cannot revalidate CI provenance because the exact default-branch authority revision is unreadable (${authorityRevision.reason}).`,
				);
			}
			const authority = yield* readFileAtRef(
				repo,
				LOCALHOST_DECLARATIONS_PATH,
				authorityRevision.value,
			);
			if (authority._tag !== "Present") {
				return refuse(
					authority._tag === "Absent" ? MALFORMED_DOCUMENT : PRECONDITION_UNKNOWN,
					`${VERB}: cannot revalidate CI provenance because the governed declaration is ${authority._tag === "Absent" ? "absent" : `unreadable (${authority.reason})`}.`,
				);
			}
			const declarations = parseLocalhostDeclarations(authority.value);
			if (declarations._tag === "Malformed") {
				return refuse(
					MALFORMED_DOCUMENT,
					`${VERB}: cannot revalidate CI provenance because the governed declaration is malformed (${declarations.reason}).`,
				);
			}
			const harness = declarations.value.harnesses.find((entry) => entry.id === receipt.harness);
			if (
				harness === undefined ||
				ciManifest.declarationSha256 !== declarationDigest(authority.value) ||
				ciManifest.producer.workflow !== harness.workflow ||
				ciManifest.producer.check !== harness.check ||
				ciManifest.producer.event !== harness.event ||
				ciManifest.producer.artifact !== harness.artifact ||
				ciManifest.producer.authorityHead !== authorityRevision.value
			) {
				return refuse(
					MALFORMED_DOCUMENT,
					`${VERB}: CI evidence set "${options.evidence}" no longer matches the governed producer declaration.`,
				);
			}
			const bundle = yield* (options.fetchCiBundle ?? fetchCiBundle)(
				repo,
				pr,
				live,
				authorityRevision.value,
				harness,
				options.tmpRoot,
			);
			if (bundle._tag === "Failure") {
				return refuse(
					PRECONDITION_UNKNOWN,
					`${VERB}: trusted CI artifact could not be re-downloaded (${bundle.reason}).`,
				);
			}
			if (
				bundle.value.runId !== receipt.runId ||
				bundle.value.checkId !== receipt.checkId ||
				bundle.value.artifactId !== receipt.artifactId ||
				bundle.value.artifactName !== harness.artifact ||
				bundle.value.authorityHead !== authorityRevision.value
			) {
				return refuse(
					MALFORMED_DOCUMENT,
					`${VERB}: CI evidence set "${options.evidence}" receipt does not match the trusted run, check, and artifact identities.`,
				);
			}
			if (
				!sameBytes(
					new TextEncoder().encode(bundle.value.manifestText),
					new TextEncoder().encode(document.success),
				)
			) {
				return refuse(
					MALFORMED_DOCUMENT,
					`${VERB}: CI evidence set "${options.evidence}" manifest does not byte-match the exact re-downloaded GitHub artifact.`,
				);
			}
			for (const capture of ciManifest.captures) {
				const remote = yield* readCaptureBytes(`${bundle.value.directory}/${capture.path}`);
				const local = yield* readCaptureBytes(`${setDir}/${capture.path}`);
				if (remote._tag === "Unreadable") {
					return unreadable(
						`capture "${capture.surface}" while byte-comparing the exact CI artifact`,
						pr,
						remote.reason,
					);
				}
				if (local._tag === "Unreadable") {
					return unreadable(
						`capture "${capture.surface}" while byte-comparing the exact CI artifact`,
						pr,
						local.reason,
					);
				}
				if (!sameBytes(remote.value, local.value)) {
					return refuse(
						MALFORMED_DOCUMENT,
						`${VERB}: CI evidence set "${options.evidence}" capture "${capture.surface}" does not byte-match the exact re-downloaded GitHub artifact.`,
					);
				}
			}
			trustedCiProvenance = receipt;
		}
		if (
			requiresCiProvenance &&
			polarity === "PASS" &&
			manifest.captures.some((capture) =>
				capture.pageErrors.rows.some((error) => error.kind === "pageerror"),
			)
		) {
			return refuse(
				RENDER_CRASHED,
				`${VERB}: CI evidence records an uncaught page error — the materialized render is FAIL ground and cannot carry PASS.`,
			);
		}
		const manifestMatches = requiresCiProvenance
			? manifest.head === live && inspected === live
			: prefixMatch(manifest.head, inspected);
		if (!manifestMatches) {
			return refuse(
				STALE_TREE,
				`${VERB}: evidence set "${options.evidence}" was rendered at ${manifest.head.slice(0, 7)}, you are posting at ${inspected.slice(0, 7)} — stale pixels; re-render at the live head.`,
			);
		}

		// Step 3 — re-validate every capture against the manifest that claims it.
		const bytesByEntry: Array<readonly [CaptureEntry, Uint8Array]> = [];
		const path = yield* Path.Path;
		const previewRoot = path.resolve(setDir);
		for (const entry of manifest.captures) {
			const capturePath = requiresCiProvenance ? `${setDir}/${entry.path}` : entry.path;
			const resolvedCapturePath = path.resolve(capturePath);
			if (!requiresCiProvenance && !resolvedCapturePath.startsWith(`${previewRoot}${path.sep}`)) {
				return refuse(
					MALFORMED_DOCUMENT,
					`${VERB}: preview capture "${entry.surface}" resolves outside its review-ui render set.`,
				);
			}
			const bytes = yield* readCaptureBytes(resolvedCapturePath);
			if (bytes._tag === "Unreadable") {
				return unreadable(
					`capture "${entry.surface}" in set "${options.evidence}"`,
					pr,
					bytes.reason,
				);
			}
			const actual = sha256Hex(bytes.value);
			const dimensions = validateCaptureBytes(bytes.value);
			if (
				actual !== entry.sha256 ||
				dimensions._tag === "Invalid" ||
				dimensions.width !== entry.width ||
				dimensions.height !== entry.height
			) {
				return refuse(
					INVALID_CAPTURE,
					`${VERB}: capture "${entry.surface}" in set "${options.evidence}" is invalid or fails its manifest hash/dimensions (recorded ${entry.sha256.slice(0, 12)}, read ${actual.slice(0, 12)}).`,
				);
			}
			bytesByEntry.push([entry, bytes.value]);
		}

		// Step 4 — the tier choice, then verify-upload every capture BEFORE anything posts.
		const tier = yield* readTierChoice(options.harnessPath);
		if (tier._tag === "Malformed") {
			return refuse(
				MALFORMED_DOCUMENT,
				`${VERB}: design-harness.json exists but does not satisfy its schema: ${tier.reason} — the tier choice is unmakeable.`,
			);
		}
		if (tier._tag === "Unreadable") {
			return unreadable("design-harness.json", pr, tier.reason);
		}
		if (tier._tag === "DeclaredStore") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: design-harness.json declares the "${tier.kind}" evidence store, and this delivery layer wires no store leg for it — the upload target's state is UNKNOWN; nothing was uploaded or posted.`,
			);
		}
		const hosted: Array<readonly [CaptureEntry, string]> = [];
		const failures: string[] = [];
		for (const [entry, bytes] of bytesByEntry) {
			const outcome = yield* options.upload({
				repo,
				fileName: `${entry.surface.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "root"}.png`,
				bytes,
			});
			if (outcome._tag === "Hosted") hosted.push([entry, outcome.url]);
			else failures.push(`${entry.surface}: ${outcome.reason}`);
		}
		if (failures.length > 0) {
			return refuse(
				UPLOAD_FAILED,
				`${VERB}: upload failed for ${failures.length} of ${bytesByEntry.length} captures (${failures[0]}) — refusing to post a verdict over a broken evidence channel (#3925).`,
				failures.map((failure) => `${VERB}: upload failed — ${failure}`),
			);
		}

		// The upload can take long enough for a push to race it. Re-read before composing any marker.
		const postingTarget = yield* openPull(VERB, repo, pr, {
			requireOpen: true,
			closedReason: "a verdict on a closed PR gates nothing.",
			requireFiles: false,
			unknownMessage: (reason) =>
				`${VERB}: cannot re-read the PR for #${pr}: ${reason} — nothing was posted.`,
		});
		if (postingTarget._tag === "Refused") return postingTarget.outcome;
		if (postingTarget.pull.headSha !== live) {
			return refuse(
				STALE_TREE,
				`${VERB}: the live head moved from ${live} to ${postingTarget.pull.headSha} before posting — the tree you judged is gone.`,
			);
		}

		// Step 5 — compose through the wire format, or through the ADR 0151 advisory shape.
		const firstLine =
			carrier === "advisory"
				? emitAdvisory(NAMESPACE, clause)
				: emitMarker({
						namespace: NAMESPACE,
						polarity: polarity as Polarity,
						sha: inspected,
						// Head-bound only: this namespace attests deployed PIXELS, and ADR 0276's digest is
						// taken over a diff, which a rendered preview is not a function of (#4808's class).
						content: null,
						clause,
					});
		const below =
			carrier === "advisory" ? `${reviewedHeadLine(inspected)}\n\n${authored.text}` : authored.text;
		const provenance =
			ciDocument && "producer" in manifest && "harness" in manifest && trustedCiProvenance !== null
				? [
						"## Evidence provenance",
						"",
						`- Repository: ${trustedCiProvenance.repository}`,
						`- Workflow: ${manifest.producer.workflow} (${manifest.producer.event})`,
						`- GitHub Actions run: [${trustedCiProvenance.runId}](https://github.com/${repo}/actions/runs/${trustedCiProvenance.runId})`,
						`- Check: ${manifest.producer.check} ([${trustedCiProvenance.checkId}](https://github.com/${repo}/runs/${trustedCiProvenance.checkId}))`,
						`- Artifact: ${manifest.producer.artifact} (id ${trustedCiProvenance.artifactId})`,
						`- Governed harness: ${manifest.harness}`,
						`- Browser error coverage: pageerror and console.error readable for ${manifest.captures.length}/${manifest.captures.length} captures`,
					].join("\n")
				: "";
		const composed = `${firstLine}\n${below.replace(/\n+$/, "")}\n\n${provenance === "" ? "" : `${provenance}\n\n`}${gallery(hosted)}\n`;

		// Step 6 — the scan runs over the ASSEMBLED comment, so nothing this verb appended escapes it.
		const leaked = leakRefusal(SURFACE, composed);
		if (leaked !== null) return leaked;

		// Step 7 — one namespace under one carrier, one comment.
		const me = yield* viewerLogin;
		if (me._tag === "Failure") return unreadable("the authenticated user", pr, me.reason);
		const comments = yield* listComments(repo, pr);
		if (comments._tag === "Failure") return unreadable("the comments", pr, comments.reason);
		if (trustedPreviewProvenance !== null) {
			const preview = resolvePreview(comments.value, trustedPreviewProvenance.app);
			if (
				preview._tag !== "Resolved" ||
				preview.value.url !== trustedPreviewProvenance.previewUrl ||
				!prefixMatch(live, preview.value.deployedSha)
			) {
				return refuse(
					STALE_TREE,
					`${VERB}: preview evidence set "${options.evidence}" no longer matches the live preview announcement.`,
				);
			}
		}
		const diagnostics = [scannedLine(VERB, comments.value.length, "comment")];
		// The NEWEST match by write stamp, stated rather than left to the order the API returned: a
		// body-only repair legitimately leaves two verdicts at one SHA, and editing the older one
		// lands the verdict where nobody reads (#5048, and the recency rule #4881 records).
		const mine = comments.value
			.filter((comment) => comment.author === me.value && carriesNamespace(comment.body, carrier))
			.reduce<(typeof comments.value)[number] | undefined>((newest, comment) => {
				if (newest === undefined) return comment;
				const [a, b] = [
					comment.updatedAt === "" ? comment.createdAt : comment.updatedAt,
					newest.updatedAt === "" ? newest.createdAt : newest.updatedAt,
				];
				if (a !== b) return a > b ? comment : newest;
				return comment.id > newest.id ? comment : newest;
			}, undefined);

		let landed: {readonly id: number; readonly url: string} | null = null;
		let failure: string | null = null;
		if (mine === undefined) {
			const created = yield* createComment(repo, pr, composed);
			if (created._tag === "Failure") failure = created.reason;
			else landed = {id: created.value.id, url: created.value.url};
		} else {
			const edited = yield* patchComment(repo, mine.id, composed);
			if (edited._tag === "Failure") failure = edited.reason;
			else landed = {id: mine.id, url: edited.value};
		}
		if (landed === null) {
			return refuse(
				WRITE_UNKNOWN,
				`${VERB}: create/edit failed: ${failure ?? "unknown"} — UNKNOWN whether the verdict landed; run \`fabrika review verdicts ${pr}\` before retrying.`,
				diagnostics,
			);
		}

		// Step 8 — read it back from live state. The write call's own echo is not evidence (#3173).
		const back = yield* getComment(repo, landed.id);
		const mismatch =
			back._tag === "Failure"
				? back.reason
				: mismatchOf(back.value, {polarity, sha: inspected, clause}, carrier, composed);
		if (mismatch !== null) {
			return refuse(
				READBACK_MISMATCH,
				`${VERB}: posted, but the read-back does not yield this marker (${mismatch}) — inspect comment ${landed.id}.`,
				diagnostics,
			);
		}

		return answer(
			JSON.stringify({
				answer: "posted",
				namespace: NAMESPACE,
				polarity,
				sha: inspected,
				upsert: mine === undefined ? "created" : "edited",
				carrier,
				surfaces: manifest.captures.length,
				commentUrl: landed.url,
			}),
			diagnostics,
		);
	});
