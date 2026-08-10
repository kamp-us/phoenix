/**
 * The impure HTTP legs: fetching blessed golden bytes, and the two evidence upload tiers.
 *
 * Every one of them **verifies its own effect** rather than trusting a status line: the golden fetch
 * hands the bytes back for the caller to hash against the pointer, the store tier PUTs then GETs the
 * same content-addressed URL and hash-compares, and the attachment tier probes every returned URL
 * with a HEAD. That is the whole difference from the upstream capture-side upload, whose failures are
 * projected away by an error channel typed `never` (#3925): here a failed verification is a value the
 * verb refuses on.
 */
import {execFileSync} from "node:child_process";
import {Effect} from "effect";
import {
	PNG_CONTENT_TYPE,
	parseUploadResponse,
	type UploadOutcome,
	uploadEndpoint,
} from "../capture/upload.ts";
import type {Upload, UploadLeg, UploadTarget} from "./evidence-verb.ts";
import type {FetchLeg} from "./golden-verb.ts";
import {legFailed} from "./leg-failed.ts";
import {sha256Of} from "./png.ts";
import {goldenUrl} from "./pointer.ts";

/** Settle a promise into its value or its failure, so no path here needs a `try`. */
const attempt = <A>(promise: Promise<A>): Promise<A | Error> =>
	promise.then(
		(value) => value,
		(cause: unknown) => (cause instanceof Error ? cause : new Error(String(cause))),
	);

/** Fetch blessed bytes. The caller hashes them — this leg never decides they are the right bytes. */
export const fetchGolden: FetchLeg = (url) =>
	Effect.tryPromise({
		try: async () => {
			const response = await attempt(fetch(url));
			if (response instanceof Error) {
				return {_tag: "Failed" as const, reason: `GET ${url} failed: ${response.message}`};
			}
			if (!response.ok) {
				return {_tag: "Failed" as const, reason: `GET ${url} returned HTTP ${response.status}`};
			}
			const body = await attempt(response.arrayBuffer());
			return body instanceof Error
				? {_tag: "Failed" as const, reason: `GET ${url} failed while reading: ${body.message}`}
				: {_tag: "Ok" as const, bytes: new Uint8Array(body)};
		},
		catch: legFailed,
	}).pipe(Effect.catch((cause) => Effect.succeed({_tag: "Failed" as const, reason: cause.reason})));

/** Store tier: content-addressed PUT, then a GET back that must hash to the same address. */
export const storeUpload = (store: string, target: UploadTarget): Effect.Effect<Upload> =>
	Effect.tryPromise({
		try: async (): Promise<Upload> => {
			const url = goldenUrl(store.replace(/\/+$/, ""), target.sha256);
			const put = await attempt(
				fetch(url, {
					method: "PUT",
					body: target.bytes,
					headers: {"content-type": PNG_CONTENT_TYPE},
				}),
			);
			if (put instanceof Error)
				return {_tag: "Failed", reason: `PUT ${url} failed: ${put.message}`};
			if (!put.ok) return {_tag: "Failed", reason: `PUT ${url} returned HTTP ${put.status}`};
			const get = await attempt(fetch(url));
			if (get instanceof Error)
				return {_tag: "Failed", reason: `GET ${url} failed: ${get.message}`};
			if (!get.ok) return {_tag: "Failed", reason: `GET ${url} returned HTTP ${get.status}`};
			const body = await attempt(get.arrayBuffer());
			if (body instanceof Error) {
				return {_tag: "Failed", reason: `GET ${url} failed while reading: ${body.message}`};
			}
			const seen = sha256Of(new Uint8Array(body));
			return seen === target.sha256
				? {_tag: "Ok", url}
				: {_tag: "Failed", reason: `${url} reads back as ${seen}, not ${target.sha256}`};
		},
		catch: legFailed,
	}).pipe(Effect.catch((cause) => Effect.succeed<Upload>({_tag: "Failed", reason: cause.reason})));

/**
 * Attachment tier: GitHub's user-attachment endpoint, then a HEAD probe of the returned URL.
 *
 * Two facts stated rather than hidden. The endpoint is **undocumented** (ADR 0165's durability
 * caveat rides along — hosted copies are display-grade, the set manifest in the lane scratch is the
 * durable record), and it is an upload API rather than an issues read/write, so it sits outside skill
 * conventions §11's REST-porcelain scope while every issue/PR read and write in `ui evidence` stays
 * inside it.
 */
export const attachmentUpload =
	(params: {readonly repositoryId: number; readonly token: string}): UploadLeg =>
	(target: UploadTarget) =>
		Effect.tryPromise({
			try: async (): Promise<Upload> => {
				const endpoint = uploadEndpoint({
					repositoryId: params.repositoryId,
					fileName: target.fileName,
					size: target.bytes.length,
					contentType: PNG_CONTENT_TYPE,
				});
				const response = await attempt(
					fetch(endpoint, {
						method: "POST",
						headers: {
							authorization: `token ${params.token}`,
							accept: "application/vnd.github+json",
							"content-type": PNG_CONTENT_TYPE,
						},
						body: target.bytes,
					}),
				);
				if (response instanceof Error) {
					return {
						_tag: "Failed",
						reason: `the user-attachments upload failed: ${response.message}`,
					};
				}
				const body = await attempt(response.text());
				const outcome: UploadOutcome = parseUploadResponse({
					status: response.status,
					body: body instanceof Error ? body.message : body,
				});
				const hostedUrl = outcome.hostedUrl;
				if (hostedUrl === null) {
					return {_tag: "Failed", reason: outcome.uploadError ?? "the upload returned no URL"};
				}
				const probe = await attempt(fetch(hostedUrl, {method: "HEAD"}));
				if (probe instanceof Error) {
					return {_tag: "Failed", reason: `${hostedUrl}: HEAD failed: ${probe.message}`};
				}
				return probe.status === 200
					? {_tag: "Ok", url: hostedUrl}
					: {_tag: "Failed", reason: `${hostedUrl}: HEAD returned HTTP ${probe.status}`};
			},
			catch: legFailed,
		}).pipe(
			Effect.catch((cause) => Effect.succeed<Upload>({_tag: "Failed", reason: cause.reason})),
		);

/**
 * The attachment tier's two credentials, resolved through the `gh` CLI the rest of the group already
 * speaks through — never a second auth path. Resolved lazily, at the first upload, so a run that
 * never reaches the attachment tier never asks for a token, and memoised per repo so a five-surface
 * evidence post does not shell out ten times.
 */
const credentials = new Map<
	string,
	{readonly repositoryId: number; readonly token: string} | string
>();

const resolveCredentials = (
	repo: string,
): Effect.Effect<{readonly repositoryId: number; readonly token: string} | string> =>
	Effect.try({
		try: () => {
			const id = Number.parseInt(
				execFileSync("gh", ["api", `repos/${repo}`, "--jq", ".id"], {encoding: "utf8"}).trim(),
				10,
			);
			const token = execFileSync("gh", ["auth", "token"], {encoding: "utf8"}).trim();
			return Number.isInteger(id) && token !== ""
				? {repositoryId: id, token}
				: "`gh` named no repository id or token";
		},
		catch: legFailed,
	}).pipe(
		Effect.catch((cause) =>
			Effect.succeed(`cannot resolve the upload credentials through gh: ${cause.reason}`),
		),
	);

export const ghAttachmentUpload = (repo: string, target: UploadTarget): Effect.Effect<Upload> =>
	Effect.gen(function* () {
		const cached = credentials.get(repo) ?? (yield* resolveCredentials(repo));
		credentials.set(repo, cached);
		return typeof cached === "string"
			? {_tag: "Failed" as const, reason: cached}
			: yield* attachmentUpload(cached)(target);
	});
