/**
 * The impure HTTP legs: fetching blessed golden bytes, and the two evidence upload tiers.
 *
 * Every one of them **verifies its own effect** rather than trusting a status line: the golden fetch
 * hands the bytes back for the caller to hash against the pointer, the store tier PUTs then GETs the
 * same content-addressed URL and hash-compares, and the attachment tier reads every returned URL
 * back through GitHub's renderer and compares the bytes (`../io/attachment-read-back.ts`). That is
 * the whole difference from the upstream capture-side upload, whose failures are projected away by
 * an error channel typed `never`: here a failed verification is a value the verb refuses on.
 */
import {Effect} from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {PNG_CONTENT_TYPE, parseUploadResponse, uploadEndpoint} from "../capture/upload.ts";
import {readBackThroughRenderer} from "../io/attachment-read-back.ts";
import {existenceOf, resolveToken, restRead} from "../io/gh-api.ts";
import {fail, ok} from "../io/git.ts";
import {isRecord} from "../io/json.ts";
import type {Upload, UploadTarget} from "./evidence-verb.ts";
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

/** What the attachment tier needs before it can post anything: the repo, its id, and a credential. */
interface Credentials {
	readonly repo: string;
	readonly repositoryId: number;
	readonly token: string;
}

/** PURE: whether the upload answered a plain GitHub attachment URL, the only thing worth rendering. */
const isTrustedAttachment = (hostedUrl: string): boolean => {
	const attachment = URL.parse(hostedUrl);
	return (
		attachment !== null &&
		attachment.origin === "https://github.com" &&
		attachment.username === "" &&
		attachment.password === "" &&
		attachment.search === "" &&
		attachment.hash === "" &&
		/^\/user-attachments\/assets\/[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(
			attachment.pathname,
		)
	);
};

const failed = (reason: string): Upload => ({_tag: "Failed", reason});

/** POST the PNG and take the URL the endpoint answers. A failure names the status, never the body. */
const postAttachment = (
	credentials: Credentials,
	target: UploadTarget,
): Effect.Effect<Upload, never, HttpClient.HttpClient> => {
	const request = HttpClientRequest.post(
		uploadEndpoint({
			repositoryId: credentials.repositoryId,
			fileName: target.fileName,
			size: target.bytes.length,
			contentType: PNG_CONTENT_TYPE,
		}),
	).pipe(
		HttpClientRequest.setHeaders({
			authorization: `token ${credentials.token}`,
			accept: "application/vnd.github+json",
		}),
		HttpClientRequest.bodyUint8Array(target.bytes, PNG_CONTENT_TYPE),
	);
	return HttpClient.execute(request).pipe(
		Effect.flatMap((response) =>
			response.text.pipe(
				Effect.map((body): Upload => {
					const hostedUrl = parseUploadResponse({status: response.status, body}).hostedUrl;
					return hostedUrl === null
						? failed(
								`the user-attachments upload returned no trusted URL (HTTP ${response.status})`,
							)
						: {_tag: "Ok", url: hostedUrl};
				}),
				Effect.catch(() =>
					Effect.succeed(failed("the user-attachments upload response could not be read")),
				),
			),
		),
		Effect.catch(() => Effect.succeed(failed("the user-attachments upload failed"))),
	);
};

/**
 * Attachment tier: GitHub's user-attachment endpoint, then the shared read-back — the returned URL
 * rendered through `POST /markdown`, its signed link fetched anonymously, and the served bytes held
 * to the capture. The returned URL itself is never fetched: fresh, it reads `404`.
 *
 * Two facts stated rather than hidden. The endpoint is **undocumented** (so the durability caveat
 * rides along — hosted copies are display-grade, and the set manifest in the lane scratch is the
 * durable record), and it is an upload API rather than an issues read/write, so it sits outside skill
 * conventions §11's REST-porcelain scope while every issue/PR read and write in `ui evidence` stays
 * inside it.
 */
export const attachmentUpload =
	(credentials: Credentials) =>
	(target: UploadTarget): Effect.Effect<Upload, never, HttpClient.HttpClient> =>
		Effect.gen(function* () {
			const upload = yield* postAttachment(credentials, target);
			if (upload._tag === "Failed") return upload;
			if (!isTrustedAttachment(upload.url)) {
				return failed("the upload returned no trusted GitHub attachment URL");
			}
			const failure = yield* readBackThroughRenderer(credentials.token, credentials.repo, {
				url: upload.url,
				bytes: target.bytes,
			});
			return failure === null ? upload : failed(failure);
		});

/** Everything the credential path needs: the fetch client, and the spawner `resolveToken`'s `gh` leg uses. */
type Credentialed<A> = Effect.Effect<
	A,
	never,
	HttpClient.HttpClient | ChildProcessSpawner.ChildProcessSpawner
>;

/**
 * The attachment tier's two credentials, both off `../io/gh-api.ts` — the package's one token
 * resolution and one REST read, never a second auth path and never a `gh` subprocess on
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
		if (read._tag === "Present") return {repo, repositoryId: read.value, token: token.value};
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
			return typeof cached === "string" ? failed(cached) : yield* attachmentUpload(cached)(target);
		});

/** Test-only: the memo is module-level, so a test over laziness needs a way back to a cold start. */
export const forgetCredentials = (): void => credentials.clear();
