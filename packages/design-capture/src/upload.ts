/**
 * The GitHub user-attachments upload leg. Two parts:
 *
 *   - `parseUploadResponse` — the PURE core: given a raw HTTP status + body,
 *     decide whether the endpoint handed back a hosted asset URL or failed, as an
 *     `UploadOutcome` (`hostedUrl` xor `uploadError`). This encodes the FALLBACK
 *     contract (AC: an upload failure is tolerated with a clear diagnostic, never
 *     a silent drop).
 *   - `uploadAsset` — the thin impure Effect: POST the PNG bytes and run the
 *     parser over the response. Its error channel is `never` — every transport /
 *     status / parse failure is CAUGHT and degraded to `{hostedUrl: null,
 *     uploadError}`.
 *
 * The upload is DISPLAY-ONLY and out of the decision path (ADR 0165): the gate
 * judges the LOCAL captured bytes (`localPath`) regardless of whether hosting
 * succeeds. A failed upload loses the hosted evidence embed, never the judged
 * image and never the verdict.
 *
 * LOAD-BEARING NOTE — `uploads.github.com/user-attachments/assets` is an
 * UNDOCUMENTED GitHub endpoint (its web-composer internal API), recorded as a
 * known durability risk in ADR 0165 ("Evidence hosting"). It works with a user
 * token today but can change or break without notice. The `uploadError` fallback
 * below is an acceptance criterion, unit-tested, NOT a TODO.
 */
import {Effect} from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";

/**
 * The outcome of one upload: a GitHub-hosted attachment URL on success, or a
 * diagnostic on failure. Exactly one of the two is non-null. This is folded into
 * a per-surface `CaptureRecord` alongside the always-present `localPath`, so the
 * judged image is never conditional on the upload.
 */
export interface UploadOutcome {
	readonly hostedUrl: string | null;
	readonly uploadError: string | null;
}

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
 * undocumented, so read tolerantly: accept `href` or `url`, require a GitHub
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
 * PURE: classify an upload response into an {@link UploadOutcome}. A non-2xx
 * status, an unparseable body, or a body with no recognizable hosted URL all
 * yield `{hostedUrl: null, uploadError}`; only a 2xx carrying a valid GitHub
 * user-attachments URL yields `{hostedUrl, uploadError: null}`.
 */
export const parseUploadResponse = (res: RawUploadResponse): UploadOutcome => {
	if (res.status < 200 || res.status >= 300) {
		return {
			hostedUrl: null,
			uploadError: `uploads.github.com/user-attachments/assets returned HTTP ${res.status}: ${snippet(res.body)}`,
		};
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(res.body);
	} catch {
		return {
			hostedUrl: null,
			uploadError: `uploads.github.com/user-attachments/assets returned unparseable JSON (HTTP ${res.status}): ${snippet(res.body)}`,
		};
	}
	const hostedUrl = extractHostedUrl(parsed);
	if (hostedUrl === null) {
		return {
			hostedUrl: null,
			uploadError: `uploads.github.com/user-attachments/assets response carried no hosted URL (href/url field) — the undocumented endpoint may have changed: ${snippet(res.body)}`,
		};
	}
	return {hostedUrl, uploadError: null};
};

/** PURE: the upload endpoint URL for a target repo's numeric id. */
export const uploadEndpoint = (repositoryId: number): string =>
	`https://uploads.github.com/user-attachments/assets?repository_id=${repositoryId}`;

export interface UploadAssetOptions {
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
 * (network, non-2xx, body-read) is caught and degraded to `{hostedUrl: null,
 * uploadError}`, matching the display-only, out-of-decision-path contract of ADR
 * 0165.
 */
export const uploadAsset = (
	opts: UploadAssetOptions,
): Effect.Effect<UploadOutcome, never, HttpClient.HttpClient> => {
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
				Effect.map((body) => parseUploadResponse({status: response.status, body})),
			),
		),
		Effect.catch((error: unknown) =>
			Effect.succeed<UploadOutcome>({
				hostedUrl: null,
				uploadError: `uploads.github.com/user-attachments/assets request failed (undocumented endpoint): ${String(error)}`,
			}),
		),
	);
};
