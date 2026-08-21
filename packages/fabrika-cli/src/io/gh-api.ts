/**
 * The GitHub transport every adapter in this package calls: a fetch client over
 * `effect/unstable/http`, not a `gh` subprocess.
 *
 * Two disciplines hold everywhere here and are stated once rather than re-derived per call site:
 *
 * - **Every response's status is read before its bytes are interpreted.** The status arrives as a
 *   number, so `Absent` and `Unknown` are told apart by the platform's own answer instead of by
 *   scraping `(HTTP 404)` out of a `gh` error string, which is what the package did until #6644 read
 *   a ported 403 as no status at all.
 * - **Every list read returns its own completeness proof beside what it received.** A caller that
 *   cannot see the proof cannot refuse a truncated read, and a truncated read that answers anyway
 *   is a verdict over unknown scope. Which proof depends on what the platform declares: an envelope
 *   read proves completeness by `total_count`, a bare-array read declares no count at all and its
 *   proof is exhausted pagination — a terminal page carrying no `rel="next"` link.
 *
 * REST throughout, with two carves recorded in ADR 0315: {@link graphqlRead} for review threads and
 * their mutations, and the auto-merge mutation. Issue queries stay REST — this org's
 * Projects-classic integration errors GraphQL issue queries out.
 *
 * The credential is an argument to every leg *of this module*, never something a leg resolves —
 * {@link resolveToken} is the one producer, and a caller holding no `token` cannot construct a
 * request at all. Adapters outside this file take `(repo, …)` and reach {@link ambientToken} for
 * theirs, and they erase the transport requirement with {@link onTransport} rather than publishing
 * `HttpClient` up through 45 verb annotations (ADR 0315, as amended).
 */
import {Effect, Option} from "effect";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import {execRecord} from "./exec.ts";
import {type Attempt, type Failure, fail, type Ok, ok, type Shell} from "./git.ts";
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
 * The credential, in the order ADR 0315 rules: `GITHUB_TOKEN`, `GH_TOKEN`, then `gh auth token`
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

let memoisedToken: Attempt<string> | null = null;

/**
 * The credential an adapter reaches for, resolved once per process off `process.env`.
 *
 * An adapter's signature is `(repo, …)` and has nowhere to take an `env`, so the resolution happens
 * here rather than being threaded through every verb (ADR 0315, as amended). The memo is not a
 * micro-optimisation: without it the `gh auth token` leg spawns a subprocess per request, which is
 * the cost this whole port exists to remove. A refusal memoises too — the env does not change
 * mid-run, so re-asking a logged-out `gh` fifty times only reprints one answer.
 */
export const ambientToken: Shell<Attempt<string>> = Effect.suspend(() =>
	memoisedToken !== null
		? Effect.succeed(memoisedToken)
		: Effect.map(resolveToken(process.env), (attempt) => {
				memoisedToken = attempt;
				return attempt;
			}),
);

/**
 * Drop the memo, so the next {@link ambientToken} resolves the environment again.
 *
 * A process only ever has one environment, so nothing on a request path calls this. A test does: a
 * suite that proves the no-credential refusal restages `process.env` between cases, and a memo taken
 * under the previous case's environment would answer for the new one — the refusal would pass or
 * fail on test order rather than on the code.
 */
export const forgetAmbientToken = (): void => {
	memoisedToken = null;
};

/**
 * Run an {@link Api} against the caller's `HttpClient` when there is one, and a fetch client
 * otherwise — erasing the requirement so an adapter's effect type stays what its callers annotate.
 *
 * A provided client always wins, which is the whole point: `HttpClient.HttpClient` is a
 * `Context.Service` and not a defaulted `Context.Reference`, so `Effect.serviceOption` answers
 * `None` only when nothing above provided one (`Context.getOption` over the fiber's context —
 * `effect@4.0.0-beta.92`, `src/internal/effect.ts`). A test that provides `fakeHttp`'s layer is
 * therefore still testing the seam production runs on; the fallback is reached only by a caller who
 * provided nothing, and `FetchHttpClient.layer` is exactly what `src/run.ts` provides there.
 */
export const onTransport = <A>(api: Api<A>): Effect.Effect<A> =>
	Effect.gen(function* () {
		const provided = yield* Effect.serviceOption(HttpClient.HttpClient);
		return yield* Option.isSome(provided)
			? Effect.provideService(api, HttpClient.HttpClient, provided.value)
			: Effect.provide(api, FetchHttpClient.layer);
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

const JSON_ACCEPT = "application/vnd.github+json";

const headersFor = (token: string, accept: string = JSON_ACCEPT): Record<string, string> => ({
	authorization: `token ${token}`,
	accept,
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

/** What a call is, beyond its path: the method, an optional JSON body, an optional `Accept`. */
export interface RestCall {
	readonly method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
	readonly path: string;
	/**
	 * Serialised as the JSON request body. Omitted entirely when absent — GitHub reads an empty
	 * `DELETE` and a `DELETE` carrying `null` differently, so "no body" must not become `null`.
	 */
	readonly body?: unknown;
	/** Overrides `application/vnd.github+json`; `…diff` and `…patch` are the ones in use. */
	readonly accept?: string;
}

/**
 * One REST call, handing back the parsed body, the numeric status and the response headers.
 *
 * The status and the headers are structural, not decoration: the status is what
 * {@link existenceOf} splits absent from unreadable on, and `Link` is what {@link pagedWithLinkProof}
 * reads its completeness proof off. A non-JSON `Accept` still parses to `null` in `body` and keeps
 * its bytes in `text`, which is how the diff read gets at them.
 */
export const restCall = (token: string, call: RestCall): Api<Rest> => {
	const request = HttpClientRequest.make(call.method)(endpoint(call.path)).pipe(
		HttpClientRequest.setHeaders(headersFor(token, call.accept)),
	);
	return send(
		call.body === undefined ? request : HttpClientRequest.bodyJsonUnsafe(request, call.body),
	);
};

/** {@link restCall}'s read arm, kept as its own name because most call sites are reads. */
export const restRead = (token: string, method: "GET" | "POST", path: string): Api<Rest> =>
	restCall(token, {method, path});

/**
 * Run `use` under the ambient credential and the ambient transport, or hand back the refusal that
 * says there is no credential.
 *
 * Every adapter leg needs the same two lines in front of it, and writing them out per call site is
 * how one of them eventually resolves a token it does not check.
 */
export const authed = <A>(use: (token: string) => Api<Attempt<A>>): Shell<Attempt<A>> =>
	Effect.gen(function* () {
		const token = yield* ambientToken;
		return token._tag === "Failure" ? token : yield* onTransport(use(token.value));
	});

/** {@link authed} for a read whose answer is an {@link Existence}: no credential is `Unknown`. */
export const authedExistence = <A>(
	use: (token: string) => Api<Existence<A>>,
): Shell<Existence<A>> =>
	Effect.gen(function* () {
		const token = yield* ambientToken;
		return token._tag === "Failure"
			? unknown<A>(token.reason)
			: yield* onTransport(use(token.value));
	});

/**
 * One REST call carrying a JSON body — the write half of {@link restRead}.
 *
 * The body travels as JSON on the wire, which is what retires the `gh`-era `-f key=value` argv
 * shape and the `-f body=@file` scar with it: `@` made `gh` read the value as a *path*, so a
 * four-character body posted the four characters of the path and read back as success (#4683). A
 * JSON body has no such form, so the hazard is gone rather than guarded.
 */
export const restWrite = (
	token: string,
	method: "POST" | "PATCH" | "PUT" | "DELETE",
	path: string,
	body: Readonly<Record<string, unknown>>,
): Api<Rest> => restCall(token, {method, path, body});

const refusalText = (outcome: Rest & {_tag: "Response"}): string =>
	`GitHub answered HTTP ${outcome.status}`;

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

/**
 * The two-arm read, for a caller that has no absent arm to tell apart — {@link existenceOf}'s
 * sibling, and the split between them is exactly whether 404 means something to the caller.
 *
 * A repository's default branch, a created pull request, a closed issue: for each of these a 404 is
 * as unreadable as a 500, so fusing them costs nothing and inventing an `Absent` arm to discard
 * would cost a reader. Any non-2xx is a failure carrying the status; 2xx hands the parsed body to
 * `read`, whose own refusal passes straight through.
 */
export const attemptOf = <A>(outcome: Rest, read: (body: unknown) => Attempt<A>): Attempt<A> => {
	if (outcome._tag === "Unreachable") return fail(outcome.reason);
	if (outcome.status < 200 || outcome.status >= 300) return fail(refusalText(outcome));
	return read(outcome.body);
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

/**
 * A paged read's answer: an {@link Attempt} whose failure also names the status GitHub served.
 *
 * A caller telling a permission denial apart from any other unreadable answer needs the number. A
 * single read gets it from {@link existenceOf}; a paged read walks many responses, so the one it
 * stopped on carries its status here rather than leaving the caller to scrape it back out of the
 * reason — the scraping habit this client exists to end.
 */
export type PagedAttempt<A> = Ok<A> | (Failure & {readonly status: number | null});

/** A read that produced no status at all — GitHub was never reached, or answered a shape nobody asked for. */
const statusless = (reason: string): Failure & {readonly status: null} => ({
	...fail(reason),
	status: null,
});

const refusalFor = (outcome: Rest & {_tag: "Response"}): Failure & {readonly status: number} => ({
	...fail(`GitHub answered HTTP ${outcome.status}`),
	status: outcome.status,
});

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
export const pagedWithLinkProof = (token: string, path: string): Api<PagedAttempt<PagedProof>> =>
	Effect.gen(function* () {
		const entries: unknown[] = [];
		for (let page = 1; page <= PAGE_CAP; page++) {
			const outcome = yield* restRead(token, "GET", paged(path, page));
			if (outcome._tag === "Unreachable") return statusless(outcome.reason);
			if (outcome.status < 200 || outcome.status >= 300) return refusalFor(outcome);
			if (!Array.isArray(outcome.body))
				return statusless("GitHub answered 200 but its body is not a list");
			entries.push(...outcome.body);
			if (!declaresNextPage(outcome.headers)) return ok({entries, exhausted: true});
		}
		return ok({entries, exhausted: false});
	});

/**
 * {@link pagedWithLinkProof}, but a 404 is a verdict rather than an error.
 *
 * The dependency and sub-issue endpoints answer `200 []` for a real issue with no edges and `404`
 * for an issue that does not exist. Collapsing those two would print "no blocking edges" over an
 * issue nobody proved exists — a proven negative over zero scope — which is the `404-IS-A-VERDICT`
 * discipline anchored at the top of `./edges.ts`, and why this leg answers {@link Existence} rather
 * than {@link Attempt}. Everything else, including the exhaustion proof, is that leg's unchanged.
 */
export const pagedExistence = (token: string, path: string): Api<Existence<PagedProof>> =>
	Effect.gen(function* () {
		const entries: unknown[] = [];
		for (let page = 1; page <= PAGE_CAP; page++) {
			const outcome = yield* restRead(token, "GET", paged(path, page));
			if (outcome._tag === "Unreachable") return unknown<PagedProof>(outcome.reason);
			if (outcome.status === 404) return absent<PagedProof>();
			if (outcome.status < 200 || outcome.status >= 300) {
				return unknown<PagedProof>(refusalText(outcome));
			}
			if (!Array.isArray(outcome.body)) {
				return unknown<PagedProof>("GitHub answered 200 but its body is not a list");
			}
			entries.push(...outcome.body);
			if (!declaresNextPage(outcome.headers)) {
				return present<PagedProof>({entries, exhausted: true});
			}
		}
		return present<PagedProof>({entries, exhausted: false});
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
): Api<PagedAttempt<EnvelopeRead>> =>
	Effect.gen(function* () {
		const entries: unknown[] = [];
		let declared: number | null = null;
		for (let page = 1; page <= PAGE_CAP; page++) {
			const outcome = yield* restRead(token, "GET", paged(path, page));
			if (outcome._tag === "Unreachable") return statusless(outcome.reason);
			if (outcome.status < 200 || outcome.status >= 300) return refusalFor(outcome);
			const body = outcome.body;
			if (!isRecord(body) || !Array.isArray(body[key])) {
				return statusless(`GitHub answered 200 but its body carries no ${key} list`);
			}
			if (declared === null) {
				if (typeof body.total_count !== "number") {
					return statusless("GitHub answered 200 but the envelope declares no total_count");
				}
				declared = body.total_count;
			}
			entries.push(...body[key]);
			if (!declaresNextPage(outcome.headers)) return ok({declared, entries});
		}
		return declared === null
			? statusless("GitHub answered 200 and printed no envelope at all")
			: ok({declared, entries});
	});

/**
 * The one non-REST leg, and it is a carve rather than a default (ADR 0315).
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
