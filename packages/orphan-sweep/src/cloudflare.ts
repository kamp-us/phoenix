/**
 * The Cloudflare boundary: list the account's Worker scripts + D1 databases, and
 * (only when the bin asks) delete one. Shells the CF REST API via `curl` over
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
import {Config, Context, Effect, Layer, Stream} from "effect";
import * as Schema from "effect/Schema";
import {ChildProcess, ChildProcessSpawner} from "effect/unstable/process";
import type {CfResource} from "./orphan-sweep.ts";

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

/** No account id / token could be resolved from the environment. */
export class CfCredentialsError extends Schema.TaggedErrorClass<CfCredentialsError>()(
	"@kampus/orphan-sweep/CfCredentialsError",
	{
		message: Schema.String,
	},
) {}

const CfError = Schema.Union([CfCommandError, CfParseError, CfApiError, CfCredentialsError]);
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

const decodeScripts = Schema.decodeUnknownEffect(ScriptListResponse);
const decodeD1 = Schema.decodeUnknownEffect(D1ListResponse);

const collect = (stream: Stream.Stream<Uint8Array, unknown>): Effect.Effect<string> =>
	Stream.decodeText(stream).pipe(
		Stream.mkString,
		Effect.orElseSucceed(() => ""),
	);

/**
 * Run `curl <args>` and return stdout, lowering a non-zero exit (or a spawn
 * `PlatformError`) into `CfCommandError`. Mirrors `@kampus/flake-rate`'s `runGh`.
 */
const runCurl = Effect.fn("Cloudflare.runCurl")(
	function* (args: ReadonlyArray<string>) {
		const handle = yield* ChildProcess.make("curl", args);
		const [stdout, stderr, exitCode] = yield* Effect.all(
			[collect(handle.stdout), collect(handle.stderr), handle.exitCode],
			{concurrency: "unbounded"},
		);
		if (exitCode !== 0) {
			return yield* new CfCommandError({args, exitCode, stderr});
		}
		return stdout;
	},
	Effect.scoped,
	(effect, args) =>
		Effect.catchTag(
			effect,
			"PlatformError",
			(cause) => new CfCommandError({args, exitCode: -1, stderr: cause.message}),
		),
);

const parseJson = (
	args: ReadonlyArray<string>,
	raw: string,
): Effect.Effect<unknown, CfParseError> =>
	Effect.try({
		try: () => JSON.parse(raw) as unknown,
		catch: (cause) =>
			new CfParseError({args, message: cause instanceof Error ? cause.message : String(cause)}),
	});

// The auth + silent-fail flags every call shares. `-f` makes curl exit non-zero on an
// HTTP error so `runCurl` surfaces it; `-s` keeps the progress meter off stdout.
const curlArgs = (token: string, method: string, url: string): ReadonlyArray<string> => [
	"-sf",
	"-X",
	method,
	url,
	"-H",
	`Authorization: Bearer ${token}`,
];

/**
 * `Cloudflare` — the IO shell. `listResources` returns every Worker script + D1 db on
 * the account as `CfResource[]` (the pure core's input); `deleteResource` removes one
 * (called only on `--execute`, for resources the plan already vetted). Built by
 * `CloudflareLive`, whose `R` is `ChildProcessSpawner`.
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
	const decoded = yield* decodeScripts(yield* parseJson(args, yield* runCurl(args)));
	yield* checkSuccess(url, decoded.success, decoded.errors);
	return (decoded.result ?? []).map((s): CfResource => ({kind: "worker", name: s.id}));
});

const listD1 = Effect.fn("Cloudflare.listD1")(function* (creds: Creds) {
	// `?per_page=1000` lifts the default page so a busy account's it-* dbs aren't paged
	// out of the first page (the leak this sweep bounds is exactly an accumulation).
	const url = `${CF_API}/accounts/${creds.accountId}/d1/database?per_page=1000`;
	const args = curlArgs(creds.token, "GET", url);
	const decoded = yield* decodeD1(yield* parseJson(args, yield* runCurl(args)));
	yield* checkSuccess(url, decoded.success, decoded.errors);
	return (decoded.result ?? []).map((d): CfResource => ({kind: "d1", name: d.name}));
});

/**
 * Delete one resource. A worker is keyed by its script name (= its physical name); a D1
 * must be deleted by UUID, so we re-resolve the uuid by name first (the list result
 * carries it, but the plan only carries names to keep the core pure). Deletes are
 * idempotent-ish: a 404 (already gone) folds to success so a re-run after a partial
 * sweep is safe.
 */
const deleteWorker = Effect.fn("Cloudflare.deleteWorker")(function* (creds: Creds, name: string) {
	const url = `${CF_API}/accounts/${creds.accountId}/workers/scripts/${name}`;
	const args = curlArgs(creds.token, "DELETE", url);
	yield* runCurl(args);
});

const deleteD1 = Effect.fn("Cloudflare.deleteD1")(function* (creds: Creds, name: string) {
	const listArgs = curlArgs(
		creds.token,
		"GET",
		`${CF_API}/accounts/${creds.accountId}/d1/database?name=${encodeURIComponent(name)}`,
	);
	const decoded = yield* decodeD1(yield* parseJson(listArgs, yield* runCurl(listArgs)));
	const match = (decoded.result ?? []).find((d) => d.name === name);
	if (match === undefined) {
		return; // already gone — idempotent
	}
	const url = `${CF_API}/accounts/${creds.accountId}/d1/database/${match.uuid}`;
	yield* runCurl(curlArgs(creds.token, "DELETE", url));
});

const resolveCreds = Effect.gen(function* () {
	const accountId = yield* Config.string("CLOUDFLARE_ACCOUNT_ID").pipe(Config.option);
	// Read as a string (not Redacted) — the token is only ever spliced into a curl arg,
	// never logged or rendered, so it needs no redaction ceremony here.
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
						Effect.all([withSpawner(listWorkers(creds)), withSpawner(listD1(creds))]),
					),
					Effect.map(([workers, d1s]) => [...workers, ...d1s]),
				),
			deleteResource: (resource: CfResource) =>
				credsRef.pipe(
					Effect.flatMap((creds) =>
						resource.kind === "worker"
							? withSpawner(deleteWorker(creds, resource.name))
							: withSpawner(deleteD1(creds, resource.name)),
					),
				),
		};
	}),
);
