/**
 * `review-ui fetch` resolves one governed localhost producer through GitHub and materializes only
 * its independently validated exact-head captures in reviewer-owned scratch. Producer identities
 * and artifact locations are declaration-derived; no filesystem or Actions identity is an input.
 * Exit `13` is a materialized, integrity-validated red render whose stderr names every capture path,
 * not an unresolved evidence state.
 */
import {copyFile, mkdir, readFile, rename, rm, writeFile} from "node:fs/promises";
import {dirname, join} from "node:path";
import {Effect} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {validateCaptureBytes} from "../capture/png.ts";
import {openPull, resolveTargetRepo} from "../review/target.ts";
import {commitShaAtRef, defaultBranch, readFileAtRef} from "../ship/github.ts";
import {answer, FAILED, refuse, type VerbOutcome} from "../verb.ts";
import {fetchCiBundle} from "./ci-github.ts";
import {
	INVALID_CAPTURE,
	MALFORMED_DOCUMENT,
	OFF_VOCABULARY,
	PRECONDITION_UNKNOWN,
	RENDER_CRASHED,
	STALE_TREE,
} from "./codes.ts";
import {
	CI_PROVENANCE_RECEIPT,
	declarationDigest,
	LOCALHOST_DECLARATIONS_PATH,
	parseCiCaptureManifest,
	parseLocalhostDeclarations,
} from "./localhost-evidence.ts";
import {isKebabSetName, manifestPath, setDirectory, sha256Hex} from "./manifest.ts";

const VERB = "review-ui fetch";

export interface CiFetchOptions {
	readonly pr: number;
	readonly harness: string;
	readonly out: string;
	readonly repo: string | null;
	readonly env: Readonly<Record<string, string | undefined>>;
	readonly tmpRoot: string;
	readonly fetchBundle?: typeof fetchCiBundle;
}

const pull = (repo: string, pr: number) =>
	openPull(VERB, repo, pr, {
		requireOpen: true,
		closedReason: "a closed PR has no live evidence head.",
		requireFiles: false,
		unknownMessage: (reason) => `${VERB}: cannot read PR #${pr}: ${reason}.`,
	});

export const runCiFetch = (
	options: CiFetchOptions,
): Effect.Effect<VerbOutcome, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		if (!Number.isInteger(options.pr) || options.pr <= 0) {
			return refuse(FAILED, `${VERB}: ${options.pr} is not a pull-request number.`);
		}
		if (!isKebabSetName(options.out)) {
			return refuse(
				OFF_VOCABULARY,
				`${VERB}: --out "${options.out}" is not a kebab-case set name.`,
			);
		}
		const resolved = yield* resolveTargetRepo(VERB, options.repo, options.env);
		if (resolved._tag === "Refused") return resolved.outcome;
		const repo = resolved.repo;
		const target = yield* pull(repo, options.pr);
		if (target._tag === "Refused") return target.outcome;
		const head = target.pull.headSha;

		const base = yield* defaultBranch(repo);
		if (base._tag === "Failure") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot resolve the repository default branch (${base.reason}).`,
			);
		}
		const authorityRevision = yield* commitShaAtRef(repo, base.value);
		if (authorityRevision._tag === "Failure") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot resolve the exact default-branch authority revision (${authorityRevision.reason}).`,
			);
		}
		const authority = yield* readFileAtRef(
			repo,
			LOCALHOST_DECLARATIONS_PATH,
			authorityRevision.value,
		);
		if (authority._tag === "Unknown") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot read the governed localhost declaration (${authority.reason}).`,
			);
		}
		if (authority._tag === "Absent") {
			return refuse(
				MALFORMED_DOCUMENT,
				`${VERB}: ${LOCALHOST_DECLARATIONS_PATH} is absent at authority revision ${authorityRevision.value}.`,
			);
		}
		const declarations = parseLocalhostDeclarations(authority.value);
		if (declarations._tag === "Malformed") {
			return refuse(
				MALFORMED_DOCUMENT,
				`${VERB}: the governed localhost declaration is malformed (${declarations.reason}).`,
			);
		}
		const harness = declarations.value.harnesses.find((entry) => entry.id === options.harness);
		if (harness === undefined) {
			return refuse(
				OFF_VOCABULARY,
				`${VERB}: "${options.harness}" is not a governed localhost-only harness.`,
			);
		}

		const bundle = yield* (options.fetchBundle ?? fetchCiBundle)(
			repo,
			options.pr,
			head,
			authorityRevision.value,
			harness,
			options.tmpRoot,
		);
		if (bundle._tag === "Failure") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: trusted CI evidence is unresolved (${bundle.reason}).`,
			);
		}
		const parsed = parseCiCaptureManifest(bundle.value.manifestText);
		if (parsed._tag === "Malformed") {
			return refuse(
				MALFORMED_DOCUMENT,
				`${VERB}: the CI capture manifest is malformed (${parsed.reason}).`,
			);
		}
		const manifest = parsed.value;
		const digest = declarationDigest(authority.value);
		if (
			manifest.repository !== repo ||
			manifest.pr !== options.pr ||
			manifest.head !== head ||
			manifest.harness !== harness.id ||
			manifest.declarationSha256 !== digest ||
			manifest.producer.workflow !== harness.workflow ||
			manifest.producer.check !== harness.check ||
			manifest.producer.event !== harness.event ||
			manifest.producer.runId !== bundle.value.runId ||
			manifest.producer.artifact !== harness.artifact ||
			manifest.producer.authorityHead !== authorityRevision.value ||
			bundle.value.authorityHead !== authorityRevision.value ||
			bundle.value.artifactName !== harness.artifact
		) {
			return refuse(
				MALFORMED_DOCUMENT,
				`${VERB}: the artifact manifest does not bind the governed producer, exact authority revision, declaration, repository, PR, and exact live head.`,
			);
		}
		const captureSurfaces = manifest.captures.map((capture) => capture.surface);
		if (new Set(captureSurfaces).size !== captureSurfaces.length) {
			return refuse(MALFORMED_DOCUMENT, `${VERB}: the artifact contains a surface more than once.`);
		}
		const expected = new Set(harness.surfaces.map((surface) => surface.id));
		const actual = new Set(captureSurfaces);
		if (expected.size !== actual.size || [...expected].some((surface) => !actual.has(surface))) {
			return refuse(
				MALFORMED_DOCUMENT,
				`${VERB}: the artifact does not contain every declared ${harness.id} surface/state exactly once.`,
			);
		}
		const red = manifest.captures.flatMap((capture) =>
			capture.pageErrors.rows.filter((error) => error.kind === "pageerror"),
		);
		for (const capture of manifest.captures) {
			const bytesRead = yield* Effect.tryPromise({
				try: () => readFile(join(bundle.value.directory, capture.path)),
				catch: (cause) => String(cause),
			}).pipe(Effect.result);
			if (bytesRead._tag === "Failure") {
				return refuse(
					PRECONDITION_UNKNOWN,
					`${VERB}: capture ${capture.surface} is unreadable (${bytesRead.failure}).`,
				);
			}
			const bytes = bytesRead.success;
			const valid = validateCaptureBytes(bytes);
			if (
				valid._tag === "Invalid" ||
				valid.width !== capture.width ||
				valid.height !== capture.height ||
				sha256Hex(bytes) !== capture.sha256
			) {
				return refuse(
					INVALID_CAPTURE,
					`${VERB}: capture ${capture.surface} fails its hash or dimensions.`,
				);
			}
		}
		const still = yield* pull(repo, options.pr);
		if (still._tag === "Refused") return still.outcome;
		if (still.pull.headSha !== head) {
			return refuse(
				STALE_TREE,
				`${VERB}: PR #${options.pr} moved from ${head} to ${still.pull.headSha} before the evidence set was accepted.`,
			);
		}

		const destination = setDirectory(options.tmpRoot, options.pr, head, options.out);
		const staging = `${destination}.staging-${bundle.value.runId}`;
		const materialized = yield* Effect.tryPromise({
			try: async () => {
				await rm(staging, {recursive: true, force: true});
				await mkdir(join(staging, "captures"), {recursive: true});
				for (const capture of manifest.captures) {
					const to = join(staging, capture.path);
					await mkdir(dirname(to), {recursive: true});
					await copyFile(join(bundle.value.directory, capture.path), to);
				}
				const manifestDocument = bundle.value.manifestText;
				await writeFile(manifestPath(staging), manifestDocument);
				await writeFile(
					join(staging, CI_PROVENANCE_RECEIPT),
					JSON.stringify({
						schemaVersion: 1,
						repository: repo,
						pr: options.pr,
						head,
						harness: harness.id,
						runId: bundle.value.runId,
						checkId: bundle.value.checkId,
						artifactId: bundle.value.artifactId,
						manifestSha256: sha256Hex(new TextEncoder().encode(manifestDocument)),
					}),
				);
				await rm(destination, {recursive: true, force: true});
				await mkdir(dirname(destination), {recursive: true});
				await rename(staging, destination);
			},
			catch: (cause) => String(cause),
		}).pipe(Effect.result);
		if (materialized._tag === "Failure") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot materialize reviewer-owned evidence scratch (${materialized.failure}).`,
			);
		}
		if (red.length > 0) {
			const paths = manifest.captures
				.map(
					(capture) =>
						`${VERB}: materialized capture ${capture.surface}: ${join(destination, capture.path)}`,
				)
				.join("\n");
			return refuse(
				RENDER_CRASHED,
				`${VERB}: the accepted artifact records ${red.length} uncaught page error(s); the materialized render is red and must be posted as FAIL.\n${paths}`,
			);
		}
		return answer(
			JSON.stringify({
				answer: "fetched",
				set: options.out,
				pr: options.pr,
				head,
				harness: harness.id,
				run: bundle.value.runId,
				artifact: bundle.value.artifactId,
				check: bundle.value.checkId,
				surfaces: manifest.captures.length,
				captures: manifest.captures.map((capture) => ({
					surface: capture.surface,
					path: join(destination, capture.path),
					width: capture.width,
					height: capture.height,
					sha256: capture.sha256,
					pageErrors: capture.pageErrors,
				})),
			}),
		);
	});
