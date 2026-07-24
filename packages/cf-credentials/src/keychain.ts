/**
 * The macOS Keychain boundary: a typed Effect service shelling the `security` CLI over
 * `ChildProcessSpawner` (the same subprocess idiom as `orphan-sweep/src/github.ts`), so no
 * plaintext credential ever touches a dotfile. `get` treats every failure to read — item
 * not found (`security` exit 44), a missing `security` binary (Linux/CI), a locked
 * keychain — as a miss (`undefined`): a keychain miss is the normal CI path, and the
 * env-var fallback in `credentials.ts` is its containment. Writes (`set`/`remove`) fail
 * loudly with `KeychainCommandError`; they only run from the interactive `auth` commands.
 */
import {Context, Effect, Layer, Stream} from "effect";
import * as Schema from "effect/Schema";
import {ChildProcess, type ChildProcessSpawner} from "effect/unstable/process";

// The generic-password `-s` service every operator credential is stored under. The id retains
// the historical `kampus-cf-utils` name for continuity with already-stored credentials — renaming
// it would strand every credential a human already saved via `auth login`, so it is load-bearing.
export const KEYCHAIN_SERVICE = "kampus-cf-utils";
/** The generic-password `-a` accounts: one per stored credential. */
export const API_TOKEN_ACCOUNT = "cloudflare-api-token";
export const ACCOUNT_ID_ACCOUNT = "cloudflare-account-id";

/** A `security` write exited non-zero (or could not spawn). Secrets never appear in `args`. */
export class KeychainCommandError extends Schema.TaggedErrorClass<KeychainCommandError>()(
	"@kampus/cf-credentials/KeychainCommandError",
	{
		args: Schema.Array(Schema.String),
		exitCode: Schema.Number,
		stderr: Schema.String,
	},
) {}

const collect = (stream: Stream.Stream<Uint8Array, unknown>): Effect.Effect<string> =>
	Stream.decodeText(stream).pipe(
		Stream.mkString,
		Effect.orElseSucceed(() => ""),
	);

interface SecurityResult {
	readonly exitCode: number;
	readonly stdout: string;
	readonly stderr: string;
}

const runSecurity = Effect.fn("Keychain.runSecurity")(
	function* (args: ReadonlyArray<string>) {
		const handle = yield* ChildProcess.make("security", args);
		const [stdout, stderr, exitCode] = yield* Effect.all(
			[collect(handle.stdout), collect(handle.stderr), handle.exitCode],
			{concurrency: "unbounded"},
		);
		return {exitCode, stdout, stderr} satisfies SecurityResult;
	},
	Effect.scoped,
	// A spawn failure (no `security` binary — any non-macOS host) reads as exit -1, so `get`
	// can classify it as a miss and `set`/`remove` as a loud KeychainCommandError.
	(effect) =>
		Effect.catchTag(effect, "PlatformError", (cause) =>
			Effect.succeed({exitCode: -1, stdout: "", stderr: cause.message} satisfies SecurityResult),
		),
);

/**
 * `Keychain` — the injectable credential-store seam. `get` never fails (miss ⇒
 * `undefined`); `set` upserts (`add-generic-password -U`); `remove` reports whether an
 * item was actually deleted. Built by `KeychainLive`; unit tests substitute a fake layer.
 */
export class Keychain extends Context.Service<
	Keychain,
	{
		readonly get: (account: string) => Effect.Effect<string | undefined>;
		readonly set: (account: string, secret: string) => Effect.Effect<void, KeychainCommandError>;
		readonly remove: (account: string) => Effect.Effect<boolean, KeychainCommandError>;
	}
>()("@kampus/cf-credentials/Keychain") {}

export const KeychainLive: Layer.Layer<Keychain, never, ChildProcessSpawner.ChildProcessSpawner> =
	Layer.effect(Keychain)(
		Effect.gen(function* () {
			const context = yield* Effect.context<ChildProcessSpawner.ChildProcessSpawner>();
			const run = (args: ReadonlyArray<string>) => Effect.provide(runSecurity(args), context);

			const get = (account: string) =>
				run(["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account, "-w"]).pipe(
					Effect.map(({exitCode, stdout}) =>
						exitCode === 0 ? stdout.replace(/\n$/, "") : undefined,
					),
				);

			const set = (account: string, secret: string) => {
				const args = ["add-generic-password", "-U", "-s", KEYCHAIN_SERVICE, "-a", account];
				return run([...args, "-w", secret]).pipe(
					Effect.flatMap(({exitCode, stderr}) =>
						exitCode === 0
							? Effect.void
							: // `args` deliberately omits the `-w <secret>` tail so the secret never rides an error.
								new KeychainCommandError({args, exitCode, stderr}),
					),
				);
			};

			const remove = (account: string) => {
				const args = ["delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account];
				return run(args).pipe(
					Effect.flatMap(({exitCode, stderr}) => {
						if (exitCode === 0) {
							return Effect.succeed(true);
						}
						// errSecItemNotFound — nothing stored, a clean "nothing to remove".
						if (exitCode === 44) {
							return Effect.succeed(false);
						}
						return new KeychainCommandError({args, exitCode, stderr});
					}),
				);
			};

			return {get, set, remove};
		}),
	);
