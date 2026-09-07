/**
 * The impure HTTP legs: fetching blessed golden bytes, and the two evidence upload tiers.
 *
 * Every one of them **verifies its own effect** rather than trusting a status line: the golden fetch
 * hands the bytes back for the caller to hash against the pointer, the store tier PUTs then GETs the
 * same content-addressed URL and hash-compares, and the attachment tier probes every returned URL
 * with a GET and compares the PNG bytes. That is the whole difference from the upstream capture-side upload, whose failures are
 * projected away by an error channel typed `never` (#3925): here a failed verification is a value the
 * verb refuses on.
 */
import {Effect} from "effect";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {
	PNG_CONTENT_TYPE,
	parseUploadResponse,
	type UploadOutcome,
	uploadEndpoint,
} from "../capture/upload.ts";
import {existenceOf, resolveToken, restRead} from "../io/gh-api.ts";
import {fail, ok} from "../io/git.ts";
import {isRecord} from "../io/json.ts";
import type {Upload, UploadLeg, UploadTarget} from "./evidence-verb.ts";
import type {FetchLeg} from "./golden-verb.ts";
import {legFailed} from "./leg-failed.ts";
import {decodePng, sha256Of} from "./png.ts";
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

const verifyAttachment = async (
	hostedUrl: string,
	token: string,
	target: UploadTarget,
): Promise<Upload> => {
	const attachment = URL.parse(hostedUrl);
	if (
		attachment === null ||
		attachment.origin !== "https://github.com" ||
		attachment.username !== "" ||
		attachment.password !== "" ||
		attachment.search !== "" ||
		attachment.hash !== "" ||
		!/^\/user-attachments\/assets\/[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(
			attachment.pathname,
		)
	) {
		return {_tag: "Failed", reason: "the upload returned no trusted GitHub attachment URL"};
	}
	let url: URL = attachment;
	let authenticated = true;
	for (let redirects = 0; redirects <= 20; redirects++) {
		// Signed asset requests can be GET-only; never forward the GitHub token across origins.
		const probe: Response | Error = await attempt(
			fetch(url.href, {
				method: "GET",
				redirect: "manual",
				headers: authenticated ? {authorization: `token ${token}`} : {},
			}),
		);
		if (probe instanceof Error) {
			return {_tag: "Failed", reason: "the hosted attachment GET failed"};
		}
		if ([301, 302, 303, 307, 308].includes(probe.status)) {
			const location: string | null = probe.headers.get("location");
			await attempt(probe.body?.cancel() ?? Promise.resolve());
			const next: URL | null = location === null ? null : URL.parse(location, url);
			if (
				next === null ||
				next.protocol !== "https:" ||
				next.username !== "" ||
				next.password !== "" ||
				redirects === 20
			) {
				return {_tag: "Failed", reason: "the hosted attachment GET returned an invalid redirect"};
			}
			authenticated = authenticated && next.origin === attachment.origin;
			url = next;
			continue;
		}
		if (probe.status !== 200) {
			await attempt(probe.body?.cancel() ?? Promise.resolve());
			return {_tag: "Failed", reason: `the hosted attachment GET returned HTTP ${probe.status}`};
		}
		if (
			probe.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== PNG_CONTENT_TYPE
		) {
			await attempt(probe.body?.cancel() ?? Promise.resolve());
			return {_tag: "Failed", reason: "the hosted attachment GET did not serve image/png"};
		}
		const body = await attempt(probe.arrayBuffer());
		if (body instanceof Error) {
			return {_tag: "Failed", reason: "the hosted attachment GET body could not be read"};
		}
		const bytes = new Uint8Array(body);
		if (sha256Of(bytes) !== target.sha256 || decodePng(bytes)._tag !== "Image") {
			return {_tag: "Failed", reason: "the hosted attachment GET did not match the captured PNG"};
		}
		return {_tag: "Ok", url: hostedUrl};
	}
	return {_tag: "Failed", reason: "the hosted attachment GET exceeded the redirect limit"};
};

/**
 * Attachment tier: GitHub's user-attachment endpoint, then a verified GET of the returned URL.
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
						reason: "the user-attachments upload failed",
					};
				}
				const body = await attempt(response.text());
				if (body instanceof Error) {
					return {_tag: "Failed", reason: "the user-attachments upload response could not be read"};
				}
				const outcome: UploadOutcome = parseUploadResponse({status: response.status, body});
				const hostedUrl = outcome.hostedUrl;
				if (hostedUrl === null) {
					return {
						_tag: "Failed",
						reason: `the user-attachments upload returned no trusted URL (HTTP ${response.status})`,
					};
				}
				return verifyAttachment(hostedUrl, params.token, target);
			},
			catch: () => legFailed("the attachment upload or verification failed"),
		}).pipe(
			Effect.catch((cause) => Effect.succeed<Upload>({_tag: "Failed", reason: cause.reason})),
		);

/** What the attachment tier needs before it can post anything: the repo's id, and a credential. */
interface Credentials {
	readonly repositoryId: number;
	readonly token: string;
}

/** Everything the credential path needs: the fetch client, and the spawner `resolveToken`'s `gh` leg uses. */
type Credentialed<A> = Effect.Effect<
	A,
	never,
	HttpClient.HttpClient | ChildProcessSpawner.ChildProcessSpawner
>;

/**
 * The attachment tier's two credentials, both off `../io/gh-api.ts` — the package's one token
 * resolution (ADR 0315) and one REST read, never a second auth path and never a `gh` subprocess on
 * the request path.
 *
 * Resolved lazily, at the first upload, so a run that never reaches the attachment tier never asks
 * for a token, and memoised per repo so a five-surface evidence post does not resolve them ten
 * times. A failure memoises too: the reason is what the caller refuses on, and re-asking would only
 * fail the same way five more times.
 */
const credentials = new Map<string, Credentials | string>();

const resolveCredentials = (
	env: Readonly<Record<string, string | undefined>>,
	repo: string,
): Credentialed<Credentials | string> =>
	Effect.gen(function* () {
		const token = yield* resolveToken(env);
		if (token._tag === "Failure") return token.reason;
		const read = existenceOf(yield* restRead(token.value, "GET", `repos/${repo}`), (body) =>
			isRecord(body) && typeof body.id === "number" && Number.isInteger(body.id)
				? ok(body.id)
				: fail("GitHub answered 200 but named no repository id"),
		);
		if (read._tag === "Present") return {repositoryId: read.value, token: token.value};
		return read._tag === "Absent"
			? `${repo} does not exist, so it names no repository id`
			: `cannot resolve ${repo}'s numeric id: ${read.reason}`;
	});

export const ghAttachmentUpload =
	(env: Readonly<Record<string, string | undefined>>) =>
	(repo: string, target: UploadTarget): Credentialed<Upload> =>
		Effect.gen(function* () {
			const cached = credentials.get(repo) ?? (yield* resolveCredentials(env, repo));
			credentials.set(repo, cached);
			return typeof cached === "string"
				? {_tag: "Failed" as const, reason: cached}
				: yield* attachmentUpload(cached)(target);
		});

/** Test-only: the memo is module-level, so a test over laziness needs a way back to a cold start. */
export const forgetCredentials = (): void => credentials.clear();
