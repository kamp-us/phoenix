/**
 * The real {@link StageLifecyclePort} — the thin wiring from the pure core
 * (`lifecycle.ts`) to alchemy, better-auth, and the seed packages. The core owns the
 * sequence + the teardown guarantee; this owns the side effects, and is exercised only
 * against a real Cloudflare account (the integration concern), never in the unit tests.
 *
 * Transport idioms are the repo's existing ones:
 *   - alchemy deploy/destroy + the Cloudflare REST D1 lookup run over `curl`/`pnpm`
 *     through `effect/unstable/process` (the `@kampus/orphan-sweep` / deploy.yml idiom);
 *   - the seeds (`@kampus/preview-seed`, `@kampus/founder-seed`) write the stage D1 over
 *     the canonical `@kampus/d1-rest` REST transport — the same path their own bins ship.
 *
 * The test-mod's id is resolved by querying the stage `user` table by email AFTER sign-up
 * (not by parsing better-auth's response body), so the promotion feeds `@kampus/founder-seed`
 * the minted id as DATA — the cohort-as-data seam — without depending on the auth response
 * shape. Sign-up uses the no-verify auto-sign-in path (`POST /api/auth/sign-up/email`), the
 * same çaylak self-registration the e2e `signUpViaApi` helper drives.
 */
import {randomUUID} from "node:crypto";
import {makeD1RestFromEnv} from "@kampus/d1-rest";
import {makeSeedDb, seedFounders} from "@kampus/founder-seed";
import {seed as previewSeedD1} from "@kampus/preview-seed";
import {Console, Effect, Stream} from "effect";
import {ChildProcess, ChildProcessSpawner} from "effect/unstable/process";
import {
	type D1Target,
	type DeployResult,
	type MintTestModInput,
	type PreviewSeedInput,
	StageLifecycleError,
	type StageLifecyclePort,
	type StagePhase,
	type TestMod,
} from "./lifecycle.ts";

/**
 * The deploy ENVIRONMENT class for the audit stage. `apps/web/worker/environment.ts`
 * (#1511) is the canonical owner of the `audit` class + `AUDIT_STAGE`; this CLI deploys
 * exactly that class so #1511's force-on rule serves `phoenix-authorship-loop` ON. Kept as
 * a local literal (not a `@kampus/web` import) because the value is two characters and the
 * worker module is not an exported subpath — a drift would fail loud (the flag would not be
 * on, the audit meaningless), not silently.
 */
const AUDIT_ENVIRONMENT = "audit";

/** The default audit stage name — matches `AUDIT_STAGE` in `apps/web/worker/environment.ts`. */
export const DEFAULT_AUDIT_STAGE = "audit";

export interface AdapterConfig {
	/** The app whose alchemy stack deploys (`@kampus/web`). */
	readonly appPackage: string;
	/** Cloudflare account id ($CLOUDFLARE_ACCOUNT_ID) — needed for the D1 management-API lookup + the seed transport. */
	readonly accountId: string;
	/** Cloudflare API token ($CLOUDFLARE_API_TOKEN) — the bearer for the D1 lookup curl. */
	readonly apiToken: string;
}

const decode = (stream: Stream.Stream<Uint8Array, unknown>): Effect.Effect<string> =>
	Stream.decodeText(stream).pipe(
		Stream.mkString,
		Effect.orElseSucceed(() => ""),
	);

// Mask secrets before they land in a StageLifecycleError message: the curl bearer header
// and the sign-up JSON body (carries the password). The live argv still reaches curl; only
// the loggable copy is redacted.
const AUTH_PREFIX = "Authorization: Bearer ";
const redactArg = (arg: string): string => {
	if (arg.startsWith(AUTH_PREFIX)) return `${AUTH_PREFIX}[REDACTED]`;
	if (arg.startsWith("{") && arg.includes("password")) return "[REDACTED-BODY]";
	return arg;
};

interface ProcOptions {
	readonly env?: Record<string, string | undefined>;
}

/** Spawn `command args`, returning stdout; a non-zero exit or a spawn fault is a `StageLifecycleError` tagged with `phase`. */
const runProc = (
	phase: StagePhase,
	command: string,
	args: ReadonlyArray<string>,
	options?: ProcOptions,
): Effect.Effect<string, StageLifecycleError, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.scoped(
		Effect.gen(function* () {
			const handle = yield* ChildProcess.make(command, args, {
				extendEnv: true,
				...(options?.env ? {env: options.env} : {}),
			});
			const [stdout, stderr, exitCode] = yield* Effect.all(
				[decode(handle.stdout), decode(handle.stderr), handle.exitCode],
				{concurrency: "unbounded"},
			);
			if (exitCode !== 0) {
				const shown = [command, ...args.map(redactArg)].join(" ");
				return yield* new StageLifecycleError({
					phase,
					message: `\`${shown}\` exited ${exitCode}: ${stderr.trim().slice(0, 600)}`,
				});
			}
			return stdout;
		}),
	).pipe(
		Effect.catchTag(
			"PlatformError",
			(cause) =>
				new StageLifecycleError({phase, message: `could not run \`${command}\`: ${cause.message}`}),
		),
	);

// alchemy prints the deployed worker origin as `url: 'https://…workers.dev'`; scrape the
// last such URL (the deploy.yml idiom). Returns null if none was printed.
const WORKER_URL_RE = /https:\/\/[A-Za-z0-9.-]+\.workers\.dev/g;
const scrapeWorkerUrl = (stdout: string): string | null => {
	const matches = stdout.match(WORKER_URL_RE);
	return matches?.[matches.length - 1] ?? null;
};

// alchemy's per-stage D1 physical name is `phoenix-phoenix-db-<stage>-<suffix>` (the scheme
// the deploy.yml "Resolve web preview D1 id" step documents: stack "phoenix" + id
// "phoenix_db" sanitized to "phoenix-db"). The random suffix is not reconstructable, so the
// uuid is looked up by this prefix against the CF management API.
const d1NamePrefix = (stage: string): string => `phoenix-phoenix-db-${stage}-`;

const resolveD1DatabaseId = (
	config: AdapterConfig,
	stage: string,
): Effect.Effect<string, StageLifecycleError, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const prefix = d1NamePrefix(stage);
		const out = yield* runProc("deploy", "curl", [
			"-sf",
			"-G",
			`https://api.cloudflare.com/client/v4/accounts/${config.accountId}/d1/database`,
			"-H",
			`${AUTH_PREFIX}${config.apiToken}`,
			"--data-urlencode",
			`name=${prefix}`,
		]);
		const parsed = yield* parseJson("deploy", out);
		const uuid = pickD1Uuid(parsed, prefix);
		if (!uuid) {
			return yield* new StageLifecycleError({
				phase: "deploy",
				message: `could not resolve D1 uuid for prefix '${prefix}' from the CF management API`,
			});
		}
		return uuid;
	});

const parseJson = (phase: StagePhase, raw: string): Effect.Effect<unknown, StageLifecycleError> =>
	Effect.suspend(() => {
		try {
			return Effect.succeed(JSON.parse(raw) as unknown);
		} catch (cause) {
			return Effect.fail(
				new StageLifecycleError({phase, message: `expected JSON but got: ${String(cause)}`}),
			);
		}
	});

// Pick the uuid of the first D1 whose name carries the stage prefix, tolerating the CF
// envelope `{result: [{uuid, name}]}` without asserting on any other field.
const pickD1Uuid = (parsed: unknown, prefix: string): string | undefined => {
	if (typeof parsed !== "object" || parsed === null) return undefined;
	const result = (parsed as {result?: unknown}).result;
	if (!Array.isArray(result)) return undefined;
	for (const row of result) {
		if (typeof row !== "object" || row === null) continue;
		const {uuid, name} = row as {uuid?: unknown; name?: unknown};
		if (typeof uuid === "string" && typeof name === "string" && name.startsWith(prefix)) {
			return uuid;
		}
	}
	return undefined;
};

const deployImpl = (
	config: AdapterConfig,
	stage: string,
): Effect.Effect<DeployResult, StageLifecycleError, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		// alchemy applies the worker `migrationsDir` during deploy, so this single step
		// provisions AND migrates the stage D1 (the "migrate" phase of the spec).
		const stdout = yield* runProc(
			"deploy",
			"pnpm",
			["--filter", config.appPackage, "exec", "alchemy", "deploy", "--stage", stage, "--yes"],
			{env: {ENVIRONMENT: AUDIT_ENVIRONMENT, CI: "true"}},
		);
		const baseUrl = scrapeWorkerUrl(stdout);
		if (!baseUrl) {
			return yield* new StageLifecycleError({
				phase: "deploy",
				message: "alchemy deploy printed no workers.dev URL to scrape",
			});
		}
		const databaseId = yield* resolveD1DatabaseId(config, stage);
		// Print the base URL while the stage is live (teardown runs at the end), satisfying
		// the "single command … prints the stage's base URL" acceptance.
		yield* Console.log(`audit-stage: deployed '${stage}' → ${baseUrl} (D1 ${databaseId})`);
		return {baseUrl, target: {accountId: config.accountId, databaseId}} satisfies DeployResult;
	});

const previewSeedImpl = ({target}: PreviewSeedInput): Effect.Effect<void, StageLifecycleError> =>
	Effect.tryPromise({
		try: () => previewSeedD1(makeD1RestFromEnv(target)),
		catch: (cause) =>
			new StageLifecycleError({
				phase: "preview-seed",
				message: `preview-seed failed: ${String(cause)}`,
			}),
	}).pipe(Effect.asVoid);

const freshCreds = (): {name: string; email: string; password: string} => {
	const suffix = `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
	return {
		name: `audit mod ${suffix}`,
		email: `audit-mod-${suffix}@kamp.us`,
		password: `Audit-mod-${suffix}!`,
	};
};

// Resolve the minted user's id by querying the stage `user` table by email — the robust
// path that feeds founder-seed the id as data, independent of better-auth's response shape.
const resolveUserIdByEmail = (
	target: D1Target,
	email: string,
): Effect.Effect<string | null, StageLifecycleError> =>
	Effect.tryPromise({
		try: async () => {
			const d1 = makeD1RestFromEnv(target);
			const row = await d1
				.prepare("SELECT id FROM user WHERE email = ?")
				.bind(email)
				.first<{id: string}>();
			return row?.id ?? null;
		},
		catch: (cause) =>
			new StageLifecycleError({
				phase: "mint-test-mod",
				message: `could not resolve test-mod user.id by email: ${String(cause)}`,
			}),
	});

const mintTestModImpl = ({
	baseUrl,
	target,
}: MintTestModInput): Effect.Effect<
	TestMod,
	StageLifecycleError,
	ChildProcessSpawner.ChildProcessSpawner
> =>
	Effect.gen(function* () {
		const creds = freshCreds();
		// çaylak self-registration: better-auth's no-verify auto-sign-in path. A 2xx (curl
		// -sf success) means the account was created and a session was issued.
		yield* runProc("mint-test-mod", "curl", [
			"-sf",
			"-X",
			"POST",
			"-H",
			"Content-Type: application/json",
			"-d",
			JSON.stringify({name: creds.name, email: creds.email, password: creds.password}),
			`${baseUrl}/api/auth/sign-up/email`,
		]);
		const userId = yield* resolveUserIdByEmail(target, creds.email);
		if (!userId) {
			return yield* new StageLifecycleError({
				phase: "mint-test-mod",
				message: `sign-up succeeded but no \`user\` row was found for ${creds.email}`,
			});
		}
		// Promote the minted id to moderator + yazar + the (id,"moderates","platform:platform")
		// tuple via founder-seed — the id supplied as the cohort DATA, never hardcoded.
		yield* Effect.tryPromise({
			try: () => seedFounders(makeSeedDb(makeD1RestFromEnv(target)), [userId]),
			catch: (cause) =>
				new StageLifecycleError({
					phase: "mint-test-mod",
					message: `founder-seed promotion failed: ${String(cause)}`,
				}),
		});
		yield* Console.log(
			`audit-stage: minted test-mod ${creds.email} (id ${userId}) — moderator+yazar+moderates tuple`,
		);
		return {userId, email: creds.email, password: creds.password} satisfies TestMod;
	});

const destroyImpl = (
	config: AdapterConfig,
	stage: string,
): Effect.Effect<void, StageLifecycleError, ChildProcessSpawner.ChildProcessSpawner> =>
	runProc(
		"destroy",
		"pnpm",
		["--filter", config.appPackage, "exec", "alchemy", "destroy", "--stage", stage, "--yes"],
		{env: {ENVIRONMENT: AUDIT_ENVIRONMENT, CI: "true"}},
	).pipe(
		Effect.tap(() => Console.log(`audit-stage: tore down stage '${stage}'`)),
		Effect.asVoid,
	);

/**
 * Build the real port, capturing the `ChildProcessSpawner` once and providing it into each
 * method (the `@kampus/crabbox-manifest` `GitLive` idiom) so the port's methods carry
 * `R = never` and match {@link StageLifecyclePort}. Provide `NodeServices.layer` to satisfy
 * the spawner requirement when running the returned port.
 */
export const makeStageLifecyclePort = (
	config: AdapterConfig,
): Effect.Effect<StageLifecyclePort, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
		const withSpawner = <A, E>(
			effect: Effect.Effect<A, E, ChildProcessSpawner.ChildProcessSpawner>,
		): Effect.Effect<A, E> =>
			effect.pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
		return {
			deploy: (stage) => withSpawner(deployImpl(config, stage)),
			previewSeed: (input) => previewSeedImpl(input),
			mintTestMod: (input) => withSpawner(mintTestModImpl(input)),
			// The audit-run seam: a no-op in #1512, filled by the explorer in #1513.
			runHook: () => Console.log("audit-stage: run hook is a no-op (filled by #1513)"),
			destroy: (stage) => withSpawner(destroyImpl(config, stage)),
		};
	});
