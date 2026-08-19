/**
 * The Cloudflare boundary: list the account's Worker scripts + D1 databases + Flagship
 * apps/flags, and (only when the bin asks) delete one. Shells the CF REST API via `curl` over
 * `ChildProcessSpawner`, the same boundary shape `src/github.ts` uses for `gh`. Credentials
 * come from the environment at runtime, never from source.
 */
import {Config, Context, Effect, Layer, Schedule, Stream} from "effect";
import * as Schema from "effect/Schema";
import {ChildProcess, ChildProcessSpawner} from "effect/unstable/process";
import {type CfResource, FLAGSHIP_APP_NAME_PREFIX} from "./orphan-sweep.ts";

const CF_API = "https://api.cloudflare.com/client/v4";

export class CfCommandError extends Schema.TaggedErrorClass<CfCommandError>()(
	"@kampus/orphan-sweep/CfCommandError",
	{
		args: Schema.Array(Schema.String),
		exitCode: Schema.Number,
		stderr: Schema.String,
	},
) {}

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
 * A non-2xx HTTP status, carrying the body so a failure reports WHAT failed instead of the
 * opaque empty `CfCommandError` `curl -f` produced (#1506). No argv is captured, so there is
 * nothing to redact.
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
type CfError = (typeof CfError)["Type"] | Config.ConfigError | Schema.SchemaError;

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

// Grounded in `@distilled.cloud/cloudflare/flagship` (the SDK alchemy's FlagshipApp/Flag
// resource uses): `id` is the appId delete-key, `name` the physical name carrying the stage.
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

// Strip the bearer token before the argv is STORED on an error: the live argv still goes to
// curl, but runMain's logError inspects error fields, so a stored raw token would leak.
const redactArgs = (args: ReadonlyArray<string>): ReadonlyArray<string> =>
	args.map((arg) => (arg.startsWith(AUTH_HEADER_PREFIX) ? `${AUTH_HEADER_PREFIX}[REDACTED]` : arg));

// `curl -w` appends this marker + the HTTP status to stdout AFTER the body, so one stream
// carries both. Split on the LAST occurrence; the sentinel never appears in a JSON envelope.
const HTTP_STATUS_MARKER = "\nHTTP_STATUS:";

const splitStatus = (raw: string): {body: string; status: number} => {
	const idx = raw.lastIndexOf(HTTP_STATUS_MARKER);
	if (idx === -1) {
		return {body: raw, status: 0};
	}
	const status = Number.parseInt(raw.slice(idx + HTTP_STATUS_MARKER.length), 10);
	return {body: raw.slice(0, idx), status: Number.isNaN(status) ? 0 : status};
};

// Because `curlArgs` drops `-f`, a non-zero exit here means a PROCESS-level fault (DNS,
// connection refused, timeout); an HTTP error keeps curl at exit 0 and travels in-band as
// `status`.
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

// `-f` is DELIBERATELY ABSENT (it was the #1506 defect): under `-f`, curl exits non-zero AND
// discards the body on any HTTP error, so a transient 429 mid-fan-out aborted the whole list
// as an opaque empty `CfCommandError`. The status comes back in-band via `-w` instead.
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

// 429 was the #1506 trigger across the ~210-app fan-out.
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

const isRetryableCfHttp = (error: unknown): boolean =>
	error instanceof CfHttpError && error.retryable;

// `jittered` spreads the per-app retries so the fan-out doesn't synchronize into a second
// rate-limit spike. `Schedule.both(exponential, recurs(N))` as capped backoff is grounded in
// effect-smol `LLMS.md` §"Working with Schedules" (`ai-docs/src/06_schedule/10_schedules.ts`).
const cfRetrySchedule = Schedule.jittered(
	Schedule.both(Schedule.exponential("500 millis"), Schedule.recurs(5)),
);

// `allow`ed statuses (e.g. a 404 on an idempotent delete) fold to success.
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

// `deleteResource` is called only on `--execute`, for resources the plan already vetted.
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
	// `?per_page=1000` lifts the default page so a busy account's it-* dbs aren't paged out
	// of the first page — the leak this sweep bounds is exactly an accumulation.
	const url = `${CF_API}/accounts/${creds.accountId}/d1/database?per_page=1000`;
	const args = curlArgs(creds.token, "GET", url);
	const decoded = yield* decodeD1(yield* parseJson(args, yield* runCurlOk(url, args)));
	yield* checkSuccess(url, decoded.success, decoded.errors);
	return (decoded.result ?? []).map((d): CfResource => ({kind: "d1", name: d.name}));
});

/**
 * Flags have no account-wide endpoint, so this fans out one flag-list per app — but only for
 * apps carrying our name prefix, so a foreign app never costs an extra call.
 *
 * Each app's flags are emitted BEFORE the app itself, so the bin's in-order delete loop
 * removes a stage's flags before its parent app: a flag delete needs the app to still exist.
 */
const listFlagship = Effect.fn("Cloudflare.listFlagship")(function* (creds: Creds) {
	// `?per_page=1000` lifts the default page — see `listD1`.
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
			// `allow: [404]` keeps a flags 404 (app mid-deletion, or no flags) from aborting the
			// whole ~210-app fan-out (#1506): its `result:null` envelope folds to zero flags, and
			// the app is still emitted below.
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

// A D1 deletes by UUID, so `deleteD1` re-resolves the uuid by name: the plan carries only
// names, to keep the core pure. Every delete folds a 404 to success, so a re-run after a
// partial sweep is safe.
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
		return;
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
	// Read as a string (not Redacted) because the token is spliced into the live curl argv;
	// every error that captures that argv stores a `redactArgs`-masked copy instead.
	const token = yield* Config.string("CLOUDFLARE_API_TOKEN").pipe(Config.option);
	if (accountId._tag === "None" || token._tag === "None") {
		return yield* new CfCredentialsError({
			message:
				"orphan-sweep needs $CLOUDFLARE_ACCOUNT_ID and $CLOUDFLARE_API_TOKEN in the environment",
		});
	}
	return {accountId: accountId.value, token: token.value};
});

// Credentials resolve once and lazily, so the layer build stays side-effect-free and
// `--help` never reads the env.
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
