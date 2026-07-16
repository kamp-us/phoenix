/**
 * Attach before/after local captures to a UI PR as SHA-bound evidence (#2964).
 *
 * The render→look→fix inner loop (#2965) runs two capture passes over the local
 * `alchemy dev` build — a pre-edit baseline and the post-edit result (renderLocal,
 * #2963). This entry pairs those passes by surface, uploads each PNG through the
 * design-capture upload leg, and renders the PR-attachment markdown bound to the PR
 * head SHA — the same SHA-bound, hosted-evidence convention review-design emits
 * (ADR 0058 SHA-binding, ADR 0165 evidence-hosting).
 *
 * Pure core + injected impure leg (the orchestrate.ts idiom): the before/after
 * pairing and the markdown render are pure and unit-tested; the only impure leg —
 * the GitHub user-attachments upload — is injected, so the orchestration is proven
 * with a fake leg and no live network. The upload is display-only and out of the
 * decision path: a failed upload degrades one embed to its `uploadError` diagnostic,
 * it never loses the paired evidence and never fails the effect.
 */
import type {CapturedSurface, UploadAssetOptions, UploadOutcome} from "@kampus/design-capture";
import {Effect} from "effect";
import * as Schema from "effect/Schema";

/**
 * The injected upload leg — `uploadAsset`'s shape. Its error/requirement channels
 * are the caller's: the bin wires the real `@kampus/design-capture` `uploadAsset`
 * (`E = never`, `R = HttpClient`), the unit test injects a fake with neither, so
 * this module stays parametric over both and needs no service at its edge (the same
 * `StoreLeg` seam candidate-render uses).
 */
export type UploadLeg<E = never, R = never> = (
	opts: UploadAssetOptions,
) => Effect.Effect<UploadOutcome, E, R>;

/** Fail-closed when a head SHA is malformed — evidence must never be bound to a non-SHA. */
export class AttachEvidenceError extends Schema.TaggedErrorClass<AttachEvidenceError>()(
	"AttachEvidenceError",
	{
		message: Schema.String,
		cause: Schema.optional(Schema.Unknown),
	},
) {}

/** One surface's paired evidence: the before/after upload outcome, either side possibly absent. */
export interface SurfaceEvidence {
	readonly surface: string;
	readonly route: string | null;
	readonly state: string | null;
	/** The before pass's upload outcome, or `null` when the surface is new (after only). */
	readonly before: UploadOutcome | null;
	/** The after pass's upload outcome, or `null` when the surface was removed (before only). */
	readonly after: UploadOutcome | null;
}

export interface AttachEvidenceRequest {
	/** The pre-edit baseline captures (a renderLocal pass over the surfaces before the change). */
	readonly before: readonly CapturedSurface[];
	/** The post-edit result captures (a renderLocal pass over the surfaces after the change). */
	readonly after: readonly CapturedSurface[];
	/** The PR head commit the evidence binds to — a full 40-hex git SHA (ADR 0058). */
	readonly headSha: string;
	/** The target repo's numeric id (`gh api repos/OWNER/REPO --jq .id`). */
	readonly repositoryId: number;
	/** A GitHub token with write access to the target repo. */
	readonly token: string;
}

export interface AttachEvidenceResult {
	/** One paired record per surface, in before-then-new-surface order. */
	readonly records: readonly SurfaceEvidence[];
	/** The PR-attachment markdown, bound to `headSha`, ready to embed in the PR body/comment. */
	readonly markdown: string;
}

/** A full-length lowercase git SHA — the head an evidence block may bind to. */
export const isHeadSha = (value: string): boolean => /^[0-9a-f]{40}$/.test(value);

/** A paired surface across the two passes — either slot possibly absent (new/removed surface). */
interface PairedSurface {
	readonly surface: string;
	readonly route: string | null;
	readonly state: string | null;
	readonly before: CapturedSurface | null;
	readonly after: CapturedSurface | null;
}

/**
 * PURE: pair two capture passes by surface token into before/after slots. A surface
 * present in both is a changed surface (both slots); one present in only the after
 * pass is new (before `null`); only in the before pass is removed (after `null`).
 * Order is before-pass order, then any after-only surfaces appended in their order.
 */
export const pairSurfaces = (
	before: readonly CapturedSurface[],
	after: readonly CapturedSurface[],
): readonly PairedSurface[] => {
	const afterBySurface = new Map(after.map((s) => [s.surface, s]));
	const seen = new Set<string>();
	const paired = before.map((b): PairedSurface => {
		seen.add(b.surface);
		return {
			surface: b.surface,
			route: b.route,
			state: b.state,
			before: b,
			after: afterBySurface.get(b.surface) ?? null,
		};
	});
	const afterOnly = after
		.filter((a) => !seen.has(a.surface))
		.map(
			(a): PairedSurface => ({
				surface: a.surface,
				route: a.route,
				state: a.state,
				before: null,
				after: a,
			}),
		);
	return [...paired, ...afterOnly];
};

/** One side of the before/after embed: the image, its fallback diagnostic, or "not captured". */
const embed = (label: string, outcome: UploadOutcome | null): string => {
	if (outcome === null) return `${label} — _not captured this pass_`;
	if (outcome.hostedUrl !== null) return `${label} — ![${label}](${outcome.hostedUrl})`;
	return `${label} — _upload failed: ${outcome.uploadError ?? "unknown error"}_`;
};

/**
 * PURE: render the SHA-bound before/after evidence markdown. The `Captured-head:`
 * anchor binds every embed to the exact PR head the captures were shot at — a
 * distinct anchor from review-design's `Reviewed-head:`, since this is generation
 * evidence, not a merge-authorizing verdict (it stays out of ship-it's namespace).
 * Throws on a malformed head SHA — the orchestration lifts that into the E channel;
 * emitting evidence bound to a non-SHA would break the binding contract (ADR 0058).
 */
export const renderEvidenceMarkdown = (
	records: readonly SurfaceEvidence[],
	headSha: string,
): string => {
	if (!isHeadSha(headSha)) {
		throw new Error(
			`refusing to render evidence bound to a malformed head SHA (expected 40-hex): ${JSON.stringify(headSha)}`,
		);
	}
	const lines = [
		"**Composed-surface evidence** (before/after)",
		"",
		"Local captures of the changed UI surfaces over the `alchemy dev` build, bound to the PR head.",
		"",
		`Captured-head: @ ${headSha}`,
		"",
	];
	if (records.length === 0) {
		lines.push("_No composed surfaces captured for this change._");
		return lines.join("\n");
	}
	for (const r of records) {
		const title = r.state === null ? r.surface : `${r.surface}:${r.state}`;
		lines.push(`- ${title}`, `  - ${embed("before", r.before)}`, `  - ${embed("after", r.after)}`);
	}
	return lines.join("\n");
};

/**
 * Upload the before/after captures and render the SHA-bound PR-attachment markdown.
 * Pairs the two passes (pure), uploads each side through the injected leg
 * (concurrency 1 — the undocumented endpoint is gentle-only), folds the outcomes
 * into per-surface records, and renders the markdown. A malformed head SHA
 * fail-closes into `AttachEvidenceError`; the upload leg's own error channel is
 * whatever the caller wires (`never` for the real `uploadAsset`).
 */
export const attachLocalEvidence = <E = never, R = never>(
	request: AttachEvidenceRequest,
	upload: UploadLeg<E, R>,
): Effect.Effect<AttachEvidenceResult, AttachEvidenceError | E, R> => {
	if (!isHeadSha(request.headSha)) {
		return Effect.fail(
			new AttachEvidenceError({
				message: `refusing to attach evidence bound to a malformed head SHA (expected 40-hex): ${JSON.stringify(request.headSha)}`,
			}),
		);
	}
	const paired = pairSurfaces(request.before, request.after);
	const uploadSide = (
		captured: CapturedSurface | null,
		suffix: string,
	): Effect.Effect<UploadOutcome | null, E, R> =>
		captured === null
			? Effect.succeed(null)
			: upload({
					pngBytes: captured.pngBytes,
					repositoryId: request.repositoryId,
					token: request.token,
					fileName: `${suffix}-${captured.fileName}`,
				});
	return Effect.forEach(
		paired,
		(p): Effect.Effect<SurfaceEvidence, E, R> =>
			Effect.all([uploadSide(p.before, "before"), uploadSide(p.after, "after")]).pipe(
				Effect.map(([before, after]) => ({
					surface: p.surface,
					route: p.route,
					state: p.state,
					before,
					after,
				})),
			),
		{concurrency: 1},
	).pipe(
		Effect.map((records) => ({
			records,
			markdown: renderEvidenceMarkdown(records, request.headSha),
		})),
	);
};
