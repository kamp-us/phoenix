/**
 * The GitHub transport every adapter in this package calls: a fetch client over
 * `effect/unstable/http`, not a `gh` subprocess.
 *
 * Two disciplines hold everywhere here and are stated once rather than re-derived per call site:
 *
 * - **Every response's status is read before its bytes are interpreted.** The status arrives as a
 *   number, so `Absent` and `Unknown` are told apart by the platform's own answer instead of by
 *   scraping `(HTTP 404)` out of a `gh` error string (`httpStatusOf` in `./issues.ts`, which stays
 *   for the adapters still on `gh`).
 * - **Every list read returns its own completeness proof beside what it received.** A caller that
 *   cannot see the proof cannot refuse a truncated read, and a truncated read that answers anyway
 *   is a verdict over unknown scope. Which proof depends on what the platform declares: an envelope
 *   read proves completeness by `total_count`, a bare-array read declares no count at all and its
 *   proof is exhausted pagination — a terminal page carrying no `rel="next"` link.
 *
 * REST throughout, with two carves recorded in ADR 0314: {@link graphqlRead} for review threads and
 * their mutations, and the auto-merge mutation. Issue queries stay REST — this org's
 * Projects-classic integration errors GraphQL issue queries out.
 *
 * The credential is an argument to every leg, never something a leg resolves. {@link resolveToken}
 * is the one producer, and a caller that could not resolve one holds no `token` to pass — so an
 * anonymous request has no way to be constructed (ADR 0314).
 */
import {Effect} from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import {execRecord} from "./exec.ts";
import {type Attempt, fail, ok, type Shell} from "./git.ts";
import {absent, type Existence, present, unknown} from "./issues.ts";
import {isRecord, parseJson} from "./json.ts";

/** Anything on the HTTP path: the client is its one requirement, and failures are data. */
export type Api<A> = Effect.Effect<A, never, HttpClient.HttpClient>;

const API_ROOT = "https://api.github.com";
const GRAPHQL_URL = `${API_ROOT}/graphql`;

/** How many pages a bare-array read walks before it gives up and reports non-exhaustion. */
export const PAGE_CAP = 50;

const NEXT_LINK = /<[^>]*>\s*;\s*rel="next"/i;

/**
 * The refusal a caller prints when no credential resolved. It names **both** env vars, because the
 * `gh auth token` leg is a developer-machine convenience and telling someone in CI to log in with
 * `gh` sends them somewhere they cannot go.
 */
export const NO_TOKEN =
	"no GitHub token — set GITHUB_TOKEN or GH_TOKEN (on a developer machine, `gh auth login` also resolves one)";

const definedOnly = (env: Readonly<Record<string, string | undefined>>): Record<string, string> => {
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(env)) if (value !== undefined) out[key] = value;
	return out;
};

/**
 * The credential, in the order ADR 0314 rules: `GITHUB_TOKEN`, `GH_TOKEN`, then `gh auth token`
 * **only when `gh` is present**.
 *
 * The env path is the contract and is what keeps this package binary-free. The `gh` leg resolves a
 * credential once, before any request; it is never a fallback on a request path. `gh` absent from
 * `PATH` fails the spawn rather than exiting non-zero, which is why the read goes through
 * {@link execRecord} — it keeps `Unstartable` apart from a `gh` that ran and declined, and the two
 * mean different things even though both end here on the same refusal.
 */
export const resolveToken = (
	env: Readonly<Record<string, string | undefined>>,
): Shell<Attempt<string>> =>
	Effect.gen(function* () {
		for (const named of [env.GITHUB_TOKEN, env.GH_TOKEN]) {
			const token = (named ?? "").trim();
			if (token !== "") return ok(token);
		}
		const outcome = yield* execRecord({
			file: "gh",
			args: ["auth", "token"],
			cwd: ".",
			env: definedOnly(env),
			timeoutSeconds: 15,
			captureBytes: 64 * 1024,
		});
		if (outcome._tag === "Unstartable") return fail(NO_TOKEN);
		const token = new TextDecoder().decode(outcome.stdout).trim();
		return outcome.exitCode === 0 && token !== "" ? ok(token) : fail(NO_TOKEN);
	});

/** One served response, or the reason the request never produced one. */
export type Rest =
	| {
			readonly _tag: "Response";
			readonly status: number;
			readonly headers: Readonly<Record<string, string>>;
			/** The body parsed as JSON, or `null` when the bytes were not JSON at all. */
			readonly body: unknown;
			readonly text: string;
	  }
	| {readonly _tag: "Unreachable"; readonly reason: string};

const endpoint = (path: string): string =>
	path.startsWith("http") ? path : `${API_ROOT}/${path.replace(/^\//, "")}`;

const headersFor = (token: string): Record<string, string> => ({
	authorization: `token ${token}`,
	accept: "application/vnd.github+json",
	"x-github-api-version": "2022-11-28",
	"user-agent": "fabrika-cli",
});

const send = (request: HttpClientRequest.HttpClientRequest): Api<Rest> =>
	HttpClient.execute(request).pipe(
		Effect.flatMap((response) =>
			response.text.pipe(
				Effect.map(
					(text): Rest => ({
						_tag: "Response",
						status: response.status,
						headers: response.headers,
						body: parseJson(text),
						text,
					}),
				),
			),
		),
		Effect.catch((error: unknown) =>
			Effect.succeed<Rest>({
				_tag: "Unreachable",
				reason: `the GitHub API could not be reached: ${String(error)}`,
			}),
		),
	);

/**
 * One REST call, handing back the parsed body, the numeric status and the response headers.
 *
 * The status and the headers are structural, not decoration: the status is what
 * {@link existenceOf} splits absent from unreadable on, and `Link` is what {@link pagedWithLinkProof}
 * reads its completeness proof off.
 */
export const restRead = (token: string, method: "GET" | "POST", path: string): Api<Rest> =>
	send(
		(method === "GET" ? HttpClientRequest.get : HttpClientRequest.post)(endpoint(path)).pipe(
			HttpClientRequest.setHeaders(headersFor(token)),
		),
	);

/**
 * The three-arm {@link Existence} construction, off the status the response carried.
 *
 * 404 is `Absent`, any other non-2xx is `Unknown` carrying the reason, 2xx is `Present` — the same
 * three arms with the same meanings the `gh`-era adapters build, never fused into two.
 */
export const existenceOf = <A>(
	outcome: Rest,
	read: (body: unknown) => Attempt<A>,
): Existence<A> => {
	if (outcome._tag === "Unreachable") return unknown<A>(outcome.reason);
	if (outcome.status === 404) return absent<A>();
	if (outcome.status < 200 || outcome.status >= 300) {
		return unknown<A>(`GitHub answered HTTP ${outcome.status}`);
	}
	const value = read(outcome.body);
	return value._tag === "Failure" ? unknown<A>(value.reason) : present<A>(value.value);
};

/** What a bare-array read holds, beside the one fact that says whether it holds all of it. */
export interface PagedProof {
	readonly entries: ReadonlyArray<unknown>;
	/** True only when a terminal page arrived carrying no `rel="next"` link. */
	readonly exhausted: boolean;
}

/** What an envelope read holds: the platform's declared count, and what actually arrived. */
export interface EnvelopeRead {
	readonly declared: number;
	readonly entries: ReadonlyArray<unknown>;
}

const declaresNextPage = (headers: Readonly<Record<string, string>>): boolean =>
	NEXT_LINK.test(headers.link ?? "");

const paged = (path: string, page: number): string =>
	`${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`;

const refusalFor = (outcome: Rest & {_tag: "Response"}): string =>
	`GitHub answered HTTP ${outcome.status}`;

/**
 * A list read whose completeness proof is **exhausted pagination**, not a declared count.
 *
 * Reviews and timeline events arrive as bare arrays and the platform declares no `total_count` for
 * either, so a `received <k> of <m>` refusal over them has no derivable `<m>` — any number printed
 * there was invented. What the platform *does* declare is the `Link` header: a terminal page carries
 * no `rel="next"`, and seeing one is positive proof the caller holds every page. Reaching
 * {@link PAGE_CAP} with a `next` still outstanding returns `exhausted: false` and is the caller's
 * refusal to make.
 *
 * The header is read off the response natively — the `gh api -i` era parsed it back out of the
 * printed status line, which is the one thing this port makes simpler. The proof itself stays a
 * value the caller can refuse on; it does not become implicit because the header got easier to
 * reach.
 */
export const pagedWithLinkProof = (token: string, path: string): Api<Attempt<PagedProof>> =>
	Effect.gen(function* () {
		const entries: unknown[] = [];
		for (let page = 1; page <= PAGE_CAP; page++) {
			const outcome = yield* restRead(token, "GET", paged(path, page));
			if (outcome._tag === "Unreachable") return fail(outcome.reason);
			if (outcome.status < 200 || outcome.status >= 300) return fail(refusalFor(outcome));
			if (!Array.isArray(outcome.body))
				return fail("GitHub answered 200 but its body is not a list");
			entries.push(...outcome.body);
			if (!declaresNextPage(outcome.headers)) return ok({entries, exhausted: true});
		}
		return ok({entries, exhausted: false});
	});

/**
 * A `{total_count, <key>: []}` envelope, paged: entries accumulate, `declared` is page one's count.
 *
 * It hands the declared count back for the caller to reconcile against what arrived. It does not
 * reconcile on the caller's behalf — which of `declared` and `entries.length` is authoritative is a
 * question about the endpoint, not about the transport.
 */
export const pagedEnvelope = (
	token: string,
	path: string,
	key: string,
): Api<Attempt<EnvelopeRead>> =>
	Effect.gen(function* () {
		const entries: unknown[] = [];
		let declared: number | null = null;
		for (let page = 1; page <= PAGE_CAP; page++) {
			const outcome = yield* restRead(token, "GET", paged(path, page));
			if (outcome._tag === "Unreachable") return fail(outcome.reason);
			if (outcome.status < 200 || outcome.status >= 300) return fail(refusalFor(outcome));
			const body = outcome.body;
			if (!isRecord(body) || !Array.isArray(body[key])) {
				return fail(`GitHub answered 200 but its body carries no ${key} list`);
			}
			if (declared === null) {
				if (typeof body.total_count !== "number") {
					return fail("GitHub answered 200 but the envelope declares no total_count");
				}
				declared = body.total_count;
			}
			entries.push(...body[key]);
			if (!declaresNextPage(outcome.headers)) return ok({declared, entries});
		}
		return declared === null
			? fail("GitHub answered 200 and printed no envelope at all")
			: ok({declared, entries});
	});

/**
 * The one non-REST leg, and it is a carve rather than a default (ADR 0314).
 *
 * Three things need it and nothing else may: review-thread resolution state, the reply and resolve
 * mutations, and `enablePullRequestAutoMerge`. Issue queries stay REST — this org's Projects-classic
 * integration errors GraphQL issue queries out.
 */
export const graphqlRead = (
	token: string,
	query: string,
	variables: Readonly<Record<string, unknown>>,
): Api<Rest> =>
	send(
		HttpClientRequest.post(GRAPHQL_URL).pipe(
			HttpClientRequest.setHeaders(headersFor(token)),
			HttpClientRequest.bodyJsonUnsafe({query, variables}),
		),
	);
