/**
 * The GitHub user-attachments upload leg. Two parts:
 *
 *   - `parseUploadResponse` — the PURE core: given a raw HTTP status + body,
 *     decide whether the endpoint handed back a hosted asset URL (→ `hosted`) or
 *     failed in any way (→ `unhosted`, carrying a diagnostic). This is what the
 *     unit tier exercises exhaustively, because it encodes the FALLBACK contract
 *     (AC: upload failure is tolerated with a clear diagnostic, never a silent
 *     drop).
 *   - `uploadAsset` — the thin impure Effect: POST the PNG bytes and run the
 *     parser over the response. Its error channel is `never` — every transport /
 *     status / parse failure is CAUGHT and degraded to an `unhosted` evidence
 *     entry, so a broken endpoint never breaks the gate (ADR 0165: the upload is
 *     display-only and out of the decision path; the verdict judges the local
 *     bytes regardless).
 *
 * LOAD-BEARING NOTE — `uploads.github.com/user-attachments/assets` is an
 * UNDOCUMENTED GitHub endpoint (its web-composer internal API), recorded as a
 * known durability risk in ADR 0165 ("Evidence hosting"). It works with a user
 * token today but can change or break without notice. This module treats it as
 * load-bearing-but-fragile: the `unhosted` fallback below is an acceptance
 * criterion, unit-tested, NOT a TODO — a break degrades the human-visible
 * evidence embed, never the verdict.
 */
import {Effect} from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";

/**
 * The evidence for one shot: either a GitHub-hosted attachment URL, or a marked
 * fallback carrying the diagnostic of why hosting failed. Consumers (the
 * review-design skill, #2246) embed `hosted` URLs and surface `unhosted`
 * diagnostics as a clearly-marked no-hosted-evidence note — never silently drop.
 */
export type ShotEvidence =
	| {readonly _tag: "hosted"; readonly label: string; readonly hostedUrl: string}
	| {readonly _tag: "unhosted"; readonly label: string; readonly diagnostic: string};

/** A raw upload response, decoupled from the HTTP client so the parser is pure. */
export interface RawUploadResponse {
	readonly status: number;
	readonly body: string;
}

/** Cap a response body so a diagnostic stays log-friendly. */
const snippet = (body: string, max = 300): string =>
	body.length <= max ? body : `${body.slice(0, max)}…`;

/**
 * Pull the hosted asset URL out of a parsed response object. The endpoint is
 * undocumented, so read tolerantly: accept `href` or `url` (the fields the
 * web-composer response is observed to carry), require it to be a GitHub
 * user-attachments URL, and reject anything else so a shape change degrades to
 * the fallback rather than embedding a bogus link.
 */
const extractHostedUrl = (parsed: unknown): string | null => {
	if (typeof parsed !== "object" || parsed === null) return null;
	const rec = parsed as Record<string, unknown>;
	const candidate = rec.href ?? rec.url;
	if (typeof candidate !== "string") return null;
	return /^https:\/\/github\.com\/user-attachments\/assets\//.test(candidate) ? candidate : null;
};

/**
 * PURE: classify an upload response into evidence. A non-2xx status, an
 * unparseable body, or a body with no recognizable hosted URL all yield an
 * `unhosted` fallback with a diagnostic; only a 2xx carrying a valid GitHub
 * user-attachments URL yields `hosted`.
 */
export const parseUploadResponse = (label: string, res: RawUploadResponse): ShotEvidence => {
	if (res.status < 200 || res.status >= 300) {
		return {
			_tag: "unhosted",
			label,
			diagnostic: `uploads.github.com/user-attachments/assets returned HTTP ${res.status}: ${snippet(res.body)}`,
		};
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(res.body);
	} catch {
		return {
			_tag: "unhosted",
			label,
			diagnostic: `uploads.github.com/user-attachments/assets returned unparseable JSON (HTTP ${res.status}): ${snippet(res.body)}`,
		};
	}
	const hostedUrl = extractHostedUrl(parsed);
	if (hostedUrl === null) {
		return {
			_tag: "unhosted",
			label,
			diagnostic: `uploads.github.com/user-attachments/assets response carried no hosted URL (href/url field) — the undocumented endpoint may have changed: ${snippet(res.body)}`,
		};
	}
	return {_tag: "hosted", label, hostedUrl};
};

/** PURE: the upload endpoint URL for a target repo's numeric id. */
export const uploadEndpoint = (repositoryId: number): string =>
	`https://uploads.github.com/user-attachments/assets?repository_id=${repositoryId}`;

export interface UploadAssetOptions {
	readonly label: string;
	readonly pngBytes: Uint8Array;
	readonly repositoryId: number;
	/** A GitHub token (user or GITHUB_TOKEN) with write access to the target repo. */
	readonly token: string;
	/** Attachment file name, e.g. `sozluk-home@desktop.png`. */
	readonly fileName: string;
}

/**
 * Impure: POST the PNG bytes to the undocumented user-attachments endpoint and
 * classify the response. Error channel is `never` — any HttpClient failure
 * (network, non-2xx surfaced as an error, body-read failure) is caught and
 * degraded to an `unhosted` evidence entry, matching the display-only,
 * out-of-decision-path contract of ADR 0165.
 */
export const uploadAsset = (
	opts: UploadAssetOptions,
): Effect.Effect<ShotEvidence, never, HttpClient.HttpClient> => {
	const request = HttpClientRequest.post(uploadEndpoint(opts.repositoryId)).pipe(
		HttpClientRequest.setHeaders({
			authorization: `token ${opts.token}`,
			accept: "application/vnd.github+json",
			"content-type": "application/octet-stream",
			// The web-composer sends the file name so GitHub derives the asset name.
			"content-disposition": `attachment; filename="${opts.fileName}"`,
		}),
		HttpClientRequest.bodyUint8Array(opts.pngBytes, "application/octet-stream"),
	);
	return HttpClient.execute(request).pipe(
		Effect.flatMap((response) =>
			response.text.pipe(
				Effect.map((body) => parseUploadResponse(opts.label, {status: response.status, body})),
			),
		),
		Effect.catch((error: unknown) =>
			Effect.succeed<ShotEvidence>({
				_tag: "unhosted",
				label: opts.label,
				diagnostic: `uploads.github.com/user-attachments/assets request failed (undocumented endpoint): ${String(error)}`,
			}),
		),
	);
};
