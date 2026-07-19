/**
 * The Cloudflare boundary: list the account's Worker scripts + D1 databases + Flagship
 * apps/flags, and (only when the bin asks) delete one. Shells the CF REST API via `curl` over
 * `ChildProcessSpawner` — the SAME transport `.github/workflows/deploy.yml` uses for
 * its `/d1/database?name=` lookup, and the same `runGh`-shaped boundary
 * `@kampus/flake-rate` uses for `gh`. REST only; Schema decodes the untrusted envelope
 * at the trust boundary (`.patterns/effect-schema-validation.md`); every infra fault is
 * a typed error in the `E` channel (`.patterns/effect-errors.md`).
 *
 * Credentials come from the environment at runtime, NEVER from source: `$CLOUDFLARE_API_TOKEN`
 * (the minted, rotatable CI token) and `$CLOUDFLARE_ACCOUNT_ID`. The pure core
 * (`orphan-sweep.ts`) computes the plan; this shell only fetches the inputs and, with
 * `--execute`, performs the deletes the plan named.
 */
import {Config, Context, Effect, Layer, Schedule, Stream} from "effect";
import * as Schema from "effect/Schema";
import {ChildProcess, ChildProcessSpawner} from "effect/unstable/process";
import {type CfResource, FLAGSHIP_APP_NAME_PREFIX} from "./orphan-sweep.ts";

const CF_API = "https://api.cloudflare.com/client/v4";

/** A `curl`/CF call failed at the process level (network, auth header, non-zero exit). */
export class CfCommandError extends Schema.TaggedErrorClass<CfCommandError>()(
	"@kampus/orphan-sweep/CfCommandError",
	{
		args: Schema.Array(Schema.String),
		exitCode: Schema.Number,
		stderr: Schema.String,
	},
) {}

/** `curl` output was not the JSON the loader expected. */
export class CfParseError extends Schema.TaggedErrorClass<CfParseError>()(
	"@kampus/orphan-sweep/CfParseError",
	{
		args: Schema.Array(Schema.String),
		message: Schema.String,
	},
) {}

/** The CF API replied `success: false` (a typed application error inside a 200). */
export class CfApiError extends Schema.TaggedErrorClass<CfApiError>()(
	"@kampus/orphan-sweep/CfApiError",
	{
		endpoint: Schema.String,
		errors: Schema.String,
	},
) {}

/**
 * The CF API returned a non-2xx HTTP status. Carries the status code AND the response
 * body so a genuine failure reports WHAT failed (e.g. a 429 rate-limit, a 403 scope
 * error + its CF error JSON) instead of the opaque empty `CfCommandError` `curl -f`
 * produced (`-s` suppressed the body, `-f` discarded it). `retryable` is set for the
 * transient statuses the fan-out retries (429 + 5xx). No argv is captured here, so there
 * is nothing to redact — `endpoint` is the token-free URL and `body` is the CF response.
 */
export class CfHttpError extends Schema.TaggedErrorClass<CfHttpError>()(
	"@kampus/orphan-sweep/CfHttpError",
	{
		endpoint: Schema.String,
		status: Schema.Number,
		body: Schema.String,
		retryable: Schema.Boolean,
	},
) {}

/** No account id / token could be resolved from the environment. */
export class CfCredentialsError extends Schema.TaggedErrorClass<CfCredentialsError>()(
	"@kampus/orphan-sweep/CfCredentialsError",
	{
		message: Schema.String,
	},
) {}

const CfError = Schema.Union([
	CfCommandError,
	CfParseError,
	CfApiError,
	CfHttpError,
	CfCredentialsError,
]);
// The methods also surface `ConfigError` (resolving env creds) and Schema's `SchemaError`
// (decoding the CF envelope) — both infra faults, kept in the typed `E` channel.
type CfError = (typeof CfError)["Type"] | Config.ConfigError | Schema.SchemaError;

// The CF list envelopes, lenient on every field but the name.
const ScriptListResponse = Schema.Struct({
	success: Schema.Boolean,
	errors: Schema.Array(Schema.Unknown),
	result: Schema.NullOr(Schema.Array(Schema.Struct({id: Schema.String}))),
});

const D1ListResponse = Schema.Struct({
	success: Schema.Boolean,
	errors: Schema.Array(Schema.Unknown),
	result: Schema.NullOr(Schema.Array(Schema.Struct({uuid: Schema.String, name: Schema.String}))),
});

// Flagship list envelopes (the standard CF `{success, errors, result}` wrapper). Grounded
// in `@distilled.cloud/cloudflare/flagship` (the SDK alchemy's FlagshipApp/Flag resource
// uses): apps carry `{id, name}` (id = the appId delete-key, name = the physical name that
// carries the stage), flags carry `{key}`. Lenient on every field but the ones we key on.
const FlagshipAppListResponse = Schema.Struct({
	success: Schema.Boolean,
	errors: Schema.Array(Schema.Unknown),
	result: Schema.NullOr(Schema.Array(Schema.Struct({id: Schema.String, name: Schema.String}))),
});

const FlagshipFlagListResponse = Schema.Struct({
	success: Schema.Boolean,
	errors: Schema.Array(Schema.Unknown),
	result: Schema.NullOr(Schema.Array(Schema.Struct({key: Schema.String}))),
});

const decodeScripts = Schema.decodeUnknownEffect(ScriptListResponse);
const decodeD1 = Schema.decodeUnknownEffect(D1ListResponse);
const decodeFlagshipApps = Schema.decodeUnknownEffect(FlagshipAppListResponse);
const decodeFlagshipFlags = Schema.decodeUnknownEffect(FlagshipFlagListResponse);

const collect = (stream: Stream.Stream<Uint8Array, unknown>): Effect.Effect<string> =>
	Stream.decodeText(stream).pipe(
		Stream.mkString,
		Effect.orElseSucceed(() => ""),
	);

const AUTH_HEADER_PREFIX = "Authorization: Bearer ";

// Strip the bearer token before the argv is STORED on an error. The real argv (with the
// live token) still goes to curl; only the loggable copy captured on CfCommandError /
// CfParseError is redacted, so a routine curl/parse fault rendered by runMain's logError
// (util.inspect of the error fields) can never leak the token. The header pair is kept —
// just its value masked — so diagnostics still show an auth header was present.
const redactArgs = (args: ReadonlyArray<string>): ReadonlyArray<string> =>
	args.map((arg) => (arg.startsWith(AUTH_HEADER_PREFIX) ? `${AUTH_HEADER_PREFIX}[REDACTED]` : arg));

// `curl -w` appends this marker + the HTTP status to stdout AFTER the body, so a single
// stdout stream carries both. We split on the LAST occurrence: everything after it is the
// status code, everything before is the response body. The marker leads with a newline and
// a fixed sentinel a JSON envelope never contains, so the split is unambiguous.
const HTTP_STATUS_MARKER = "\nHTTP_STATUS:";

const splitStatus = (raw: string): {body: string; status: number} => {
	const idx = raw.lastIndexOf(HTTP_STATUS_MARKER);
	if (idx === -1) {
		return {body: raw, status: 0};
	}
	const status = Number.parseInt(raw.slice(idx + HTTP_STATUS_MARKER.length), 10);
	return {body: raw.slice(0, idx), status: Number.isNaN(status) ? 0 : status};
};

/**
 * Run `curl <args>` and return the response body + HTTP status, lowering a non-zero exit
 * (or a spawn `PlatformError`) into `CfCommandError`. Mirrors `@kampus/flake-rate`'s `runGh`.
 *
 * Because `curlArgs` drops `-f`, a non-zero exit here now means a genuine PROCESS-level
 * fault (DNS, connection refused, timeout) — an HTTP error (4xx/5xx) keeps `curl` at exit 0
 * and travels in-band as `status`, so the caller (`runCurlOk`) can surface it WITH its body
 * instead of the opaque empty error `-f` produced.
 */
const runCurl = Effect.fn("Cloudflare.runCurl")(
	function* (args: ReadonlyArray<string>) {
		const handle = yield* ChildProcess.make("curl", args);
		const [stdout, stderr, exitCode] = yield* Effect.all(
			[collect(handle.stdout), collect(handle.stderr), handle.exitCode],
			{concurrency: "unbounded"},
		);
		if (exitCode !== 0) {
			return yield* new CfCommandError({args: redactArgs(args), exitCode, stderr});
		}
		return splitStatus(stdout);
	},
	Effect.scoped,
	(effect, args) =>
		Effect.catchTag(
			effect,
			"PlatformError",
			(cause) => new CfCommandError({args: redactArgs(args), exitCode: -1, stderr: cause.message}),
		),
);

const parseJson = (
	args: ReadonlyArray<string>,
	raw: string,
): Effect.Effect<unknown, CfParseError> =>
	Effect.try({
		try: () => JSON.parse(raw) as unknown,
		catch: (cause) =>
			new CfParseError({
				args: redactArgs(args),
				message: cause instanceof Error ? cause.message : String(cause),
			}),
	});

// The flags every call shares. `-s` keeps the progress meter off stdout. `-f` is
// DELIBERATELY ABSENT (it was the #1506 defect): under `-f`, curl exits non-zero AND
// discards the body on any HTTP error, so a transient 429 mid-fan-out aborted the whole
// list as an opaque empty `CfCommandError`. Instead we let curl exit 0 on an HTTP error and
// capture the status in-band via `-w` (appended after the body), so `runCurlOk` can decide
// retry-vs-surface on the real status + body.
const curlArgs = (token: string, method: string, url: string): ReadonlyArray<string> => [
	"-s",
	"-w",
	`${HTTP_STATUS_MARKER}%{http_code}`,
	"-X",
	method,
	url,
	"-H",
	`Authorization: Bearer ${token}`,
];

// Transient HTTP statuses worth retrying: 429 (rate limit — the #1506 trigger across the
// ~210-app fan-out) and the 5xx gateway/overload family.
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

const isRetryableCfHttp = (error: unknown): boolean =>
	error instanceof CfHttpError && error.retryable;

/**
 * Capped, jittered exponential backoff: ~0.5s, 1, 2, 4, 8s across up to 5 retries (6
 * attempts total), `jittered` to spread the per-app retries so the fan-out doesn't
 * synchronize into a second rate-limit spike. Grounded in effect-smol `LLMS.md`
 * §"Working with Schedules" (`ai-docs/src/06_schedule/10_schedules.ts`):
 * `Schedule.both(exponential, recurs(N))` is capped backoff, mirroring
 * `apps/web/worker/features/fate-live/cold-start-retry.ts`.
 */
const cfRetrySchedule = Schedule.jittered(
	Schedule.both(Schedule.exponential("500 millis"), Schedule.recurs(5)),
);

/**
 * Run a CF call and enforce a 2xx: a retryable HTTP status (429/5xx) becomes a retryable
 * `CfHttpError`, any other non-2xx surfaces its status + body, and `allow`ed statuses (e.g.
 * a 404 on an idempotent delete) fold to success. The whole thing is wrapped in the bounded
 * backoff `Effect.retry({schedule, while})` — the documented effect-smol retry idiom — so a
 * transient 429 is re-driven instead of aborting the list (#1506).
 */
const runCurlOk = (
	endpoint: string,
	args: ReadonlyArray<string>,
	options?: {readonly allow?: ReadonlyArray<number>},
): Effect.Effect<string, CfCommandError | CfHttpError, ChildProcessSpawner.ChildProcessSpawner> =>
	runCurl(args).pipe(
		Effect.flatMap(({body, status}) => {
			if ((status >= 200 && status < 300) || (options?.allow?.includes(status) ?? false)) {
				return Effect.succeed(body);
			}
			return Effect.fail(
				new CfHttpError({endpoint, status, body, retryable: RETRYABLE_STATUSES.has(status)}),
			);
		}),
		Effect.retry({schedule: cfRetrySchedule, while: isRetryableCfHttp}),
	);

/**
 * `Cloudflare` — the IO shell. `listResources` returns every Worker script + D1 db +
 * Flagship app/flag on the account as `CfResource[]` (the pure core's input);
 * `deleteResource` removes one (called only on `--execute`, for resources the plan already
 * vetted). Built by `CloudflareLive`, whose `R` is `ChildProcessSpawner`.
 */
export class Cloudflare extends Context.Service<
	Cloudflare,
	{
		readonly listResources: () => Effect.Effect<ReadonlyArray<CfResource>, CfError>;
		readonly deleteResource: (resource: CfResource) => Effect.Effect<void, CfError>;
	}
>()("@kampus/orphan-sweep/Cloudflare") {}

interface Creds {
	readonly accountId: string;
	readonly token: string;
}

const checkSuccess = (
	endpoint: string,
	success: boolean,
	errors: ReadonlyArray<unknown>,
): Effect.Effect<void, CfApiError> =>
	success ? Effect.void : Effect.fail(new CfApiError({endpoint, errors: JSON.stringify(errors)}));

const listWorkers = Effect.fn("Cloudflare.listWorkers")(function* (creds: Creds) {
	const url = `${CF_API}/accounts/${creds.accountId}/workers/scripts`;
	const args = curlArgs(creds.token, "GET", url);
	const decoded = yield* decodeScripts(yield* parseJson(args, yield* runCurlOk(url, args)));
	yield* checkSuccess(url, decoded.success, decoded.errors);
	return (decoded.result ?? []).map((s): CfResource => ({kind: "worker", name: s.id}));
});

const listD1 = Effect.fn("Cloudflare.listD1")(function* (creds: Creds) {
	// `?per_page=1000` lifts the default page so a busy account's it-* dbs aren't paged
	// out of the first page (the leak this sweep bounds is exactly an accumulation).
	const url = `${CF_API}/accounts/${creds.accountId}/d1/database?per_page=1000`;
	const args = curlArgs(creds.token, "GET", url);
	const decoded = yield* decodeD1(yield* parseJson(args, yield* runCurlOk(url, args)));
	yield* checkSuccess(url, decoded.success, decoded.errors);
	return (decoded.result ?? []).map((d): CfResource => ({kind: "d1", name: d.name}));
});

/**
 * List Flagship apps + their flags as `CfResource[]`. Apps enumerate via
 * `GET /accounts/{acct}/flagship/apps`; flags are a per-app sub-resource
 * (`GET /accounts/{acct}/flagship/apps/{appId}/flags`) with no account-wide endpoint, so
 * we fan out one flag-list per app — but ONLY for apps whose physical name carries our
 * `phoenix-phoenix-flags-` prefix, so a foreign account app never costs an extra call.
 * Every app is still emitted as a `flagship-app` resource (a foreign one is kept
 * `unrecognized` by the pure core, exactly like a foreign worker).
 *
 * Each app's flags are emitted BEFORE the app itself, so the bin's in-order delete loop
 * removes a stage's flags before its parent app — a flag delete needs the app to still
 * exist (its path is `apps/{appId}/flags/{key}`), and deleting the app may cascade its
 * flags.
 */
const listFlagship = Effect.fn("Cloudflare.listFlagship")(function* (creds: Creds) {
	// `?per_page=1000` lifts the default page so an account accumulating leaked preview apps
	// isn't paged out of the first page (the leak this sweep bounds is exactly accumulation).
	const appsUrl = `${CF_API}/accounts/${creds.accountId}/flagship/apps?per_page=1000`;
	const appsArgs = curlArgs(creds.token, "GET", appsUrl);
	const apps = yield* decodeFlagshipApps(
		yield* parseJson(appsArgs, yield* runCurlOk(appsUrl, appsArgs)),
	);
	yield* checkSuccess(appsUrl, apps.success, apps.errors);

	const resources: Array<CfResource> = [];
	for (const app of apps.result ?? []) {
		if (app.name.startsWith(FLAGSHIP_APP_NAME_PREFIX)) {
			const flagsUrl = `${CF_API}/accounts/${creds.accountId}/flagship/apps/${app.id}/flags?per_page=1000`;
			const flagsArgs = curlArgs(creds.token, "GET", flagsUrl);
			// `allow: [404]` keeps a flags-sub-resource 404 (an app present in the apps list but
			// mid-deletion / in a no-flags state) from aborting the whole ~210-app fan-out (#1506):
			// the 404 envelope (`success:false`, `result:null`) folds to ZERO flags. Only a 2xx
			// (CF returns `success:true`) or that tolerated 404 reaches the decode — any other
			// non-2xx already surfaced as a `CfHttpError` in `runCurlOk` — so `result ?? []` is the
			// empty flag set, and the app itself is still emitted as a `flagship-app` below.
			const flags = yield* decodeFlagshipFlags(
				yield* parseJson(flagsArgs, yield* runCurlOk(flagsUrl, flagsArgs, {allow: [404]})),
			);
			for (const flag of flags.result ?? []) {
				resources.push({
					kind: "flagship-flag",
					name: flag.key,
					appId: app.id,
					appName: app.name,
				});
			}
		}
		resources.push({kind: "flagship-app", name: app.name, appId: app.id});
	}
	return resources;
});

/**
 * Delete one resource. A worker is keyed by its script name (= its physical name); a D1
 * must be deleted by UUID, so we re-resolve the uuid by name first (the list result
 * carries it, but the plan only carries names to keep the core pure). A Flagship app
 * deletes by its server `appId`, a flag by `(appId, key)` — both already on the resource.
 * Deletes are idempotent-ish: a 404 (already gone) folds to success so a re-run after a
 * partial sweep is safe.
 */
const deleteWorker = Effect.fn("Cloudflare.deleteWorker")(function* (creds: Creds, name: string) {
	const url = `${CF_API}/accounts/${creds.accountId}/workers/scripts/${name}`;
	yield* runCurlOk(url, curlArgs(creds.token, "DELETE", url), {allow: [404]});
});

const deleteD1 = Effect.fn("Cloudflare.deleteD1")(function* (creds: Creds, name: string) {
	const listUrl = `${CF_API}/accounts/${creds.accountId}/d1/database?name=${encodeURIComponent(name)}`;
	const listArgs = curlArgs(creds.token, "GET", listUrl);
	const decoded = yield* decodeD1(yield* parseJson(listArgs, yield* runCurlOk(listUrl, listArgs)));
	const match = (decoded.result ?? []).find((d) => d.name === name);
	if (match === undefined) {
		return; // already gone — idempotent
	}
	const url = `${CF_API}/accounts/${creds.accountId}/d1/database/${match.uuid}`;
	yield* runCurlOk(url, curlArgs(creds.token, "DELETE", url), {allow: [404]});
});

const deleteFlagshipApp = Effect.fn("Cloudflare.deleteFlagshipApp")(function* (
	creds: Creds,
	appId: string,
) {
	const url = `${CF_API}/accounts/${creds.accountId}/flagship/apps/${appId}`;
	yield* runCurlOk(url, curlArgs(creds.token, "DELETE", url), {allow: [404]});
});

const deleteFlagshipFlag = Effect.fn("Cloudflare.deleteFlagshipFlag")(function* (
	creds: Creds,
	appId: string,
	flagKey: string,
) {
	const url = `${CF_API}/accounts/${creds.accountId}/flagship/apps/${appId}/flags/${encodeURIComponent(flagKey)}`;
	yield* runCurlOk(url, curlArgs(creds.token, "DELETE", url), {allow: [404]});
});

const resolveCreds = Effect.gen(function* () {
	const accountId = yield* Config.string("CLOUDFLARE_ACCOUNT_ID").pipe(Config.option);
	// Read as a string (not Redacted): the token is spliced into the live curl argv, but
	// every error that CAPTURES that argv stores a `redactArgs`-masked copy (the auth header
	// value → `[REDACTED]`), so the raw token never reaches a logged/rendered error field —
	// even when runMain's logError inspects the failing error.
	const token = yield* Config.string("CLOUDFLARE_API_TOKEN").pipe(Config.option);
	if (accountId._tag === "None" || token._tag === "None") {
		return yield* new CfCredentialsError({
			message:
				"orphan-sweep needs $CLOUDFLARE_ACCOUNT_ID and $CLOUDFLARE_API_TOKEN in the environment",
		});
	}
	return {accountId: accountId.value, token: token.value};
});

/**
 * The live `Cloudflare` layer. Mirrors `@kampus/flake-rate`'s `GithubLive`: the
 * `ChildProcessSpawner` is captured at construction and provided into each method (so
 * public methods carry `R = never`); credentials are resolved once, lazily (the layer
 * build is side-effect-free, so `--help` never reads the env). Provide `NodeServices.layer`
 * to satisfy the spawner.
 */
export const CloudflareLive: Layer.Layer<
	Cloudflare,
	never,
	ChildProcessSpawner.ChildProcessSpawner
> = Layer.effect(Cloudflare)(
	Effect.gen(function* () {
		const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
		const withSpawner = <A, E>(
			effect: Effect.Effect<A, E, ChildProcessSpawner.ChildProcessSpawner>,
		) => effect.pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
		const credsRef = yield* Effect.cached(resolveCreds);
		return {
			listResources: () =>
				credsRef.pipe(
					Effect.flatMap((creds) =>
						Effect.all(
							[
								withSpawner(listWorkers(creds)),
								withSpawner(listD1(creds)),
								withSpawner(listFlagship(creds)),
							],
							{concurrency: 1},
						),
					),
					Effect.map(([workers, d1s, flagship]) => [...workers, ...d1s, ...flagship]),
				),
			deleteResource: (resource: CfResource) =>
				credsRef.pipe(
					Effect.flatMap((creds) =>
						resource.kind === "worker"
							? withSpawner(deleteWorker(creds, resource.name))
							: resource.kind === "d1"
								? withSpawner(deleteD1(creds, resource.name))
								: resource.kind === "flagship-app"
									? withSpawner(deleteFlagshipApp(creds, resource.appId))
									: withSpawner(deleteFlagshipFlag(creds, resource.appId, resource.name)),
					),
				),
		};
	}),
);
