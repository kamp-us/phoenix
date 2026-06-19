/**
 * The phoenix CI-credential stack — a one-shot you deploy from your laptop under
 * a dedicated `admin` profile to provision everything GitHub Actions needs to
 * run `alchemy deploy` (Part 5 of the alchemy tutorial, adapted to phoenix:
 * pnpm + node, not bun; `kamp-us/phoenix`).
 *
 * Authored by Can Sirin (@cansirin) in #19; brought into #12 to land the
 * self-provisioning CI credential flow with the framework foundation.
 *
 * Why a separate stack from `alchemy.run.ts`: the app stack only needs enough
 * Cloudflare permission to deploy the worker. THIS stack *mints a brand-new,
 * scoped Cloudflare API token* (which requires the elevated `API Tokens > Write`
 * permission) and stores it as a GitHub Actions secret — so your personal
 * Cloudflare key never touches the repo, and CI runs on a token scoped to
 * exactly what the deploy touches.
 *
 * Run it once, under the elevated profile (see `.patterns/alchemy-ci-cd.md`):
 *
 *   alchemy login --profile admin     # Cloudflare Global API Key + a GitHub creds
 *   CLOUDFLARE_ACCOUNT_ID=<id> ALCHEMY_PASSWORD=<pw> \
 *     pnpm --filter @kampus/infra exec alchemy deploy github.ts \
 *       --profile admin --yes
 *
 * Re-run only to rotate the token or change its scope. Reusing the remote
 * `Cloudflare.state()` means the token's ID is tracked, so a rescope is a clean
 * diff rather than an orphaned token.
 *
 * Provisions the full set of repo secrets the deploy workflow consumes:
 *   - CLOUDFLARE_API_TOKEN   — the minted scoped token (never echoed to your shell)
 *   - CLOUDFLARE_ACCOUNT_ID  — which account to deploy into
 *   - ALCHEMY_PASSWORD       — encrypts/decrypts secrets in the Cloudflare-hosted
 *                              alchemy state store
 *   - BETTER_AUTH_SECRET     — the session-signing secret. The worker reads it at
 *                              runtime as a `secret_text` binding (`config.ts`:
 *                              `Config.redacted("BETTER_AUTH_SECRET")`), so the
 *                              deploy needs the value. Minted here as a stable
 *                              `Random` (persisted in this stack's state) and
 *                              pushed so CI can bind it on every deploy.
 */
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as GitHub from "alchemy/GitHub";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

const OWNER = "kamp-us";
const REPOSITORY = "phoenix";

export default Alchemy.Stack(
	"github",
	{
		// `provideMerge`, not `mergeAll`: both provider sets bring their own
		// `Profile`/`CredentialsStore`, so a parallel `mergeAll` builds the shared
		// auth layer twice. Sequencing them shares one (effect TS377035).
		providers: Cloudflare.providers().pipe(Layer.provideMerge(GitHub.providers())),
		state: Cloudflare.state(),
	},
	Effect.gen(function* () {
		// A missing env on this one-shot is unrecoverable — surface it as a defect
		// (the stack body's error channel must be `never`) rather than threading
		// `ConfigError` out.
		const accountId = yield* Effect.orDie(Config.string("CLOUDFLARE_ACCOUNT_ID"));
		const alchemyPassword = yield* Effect.orDie(Config.redacted("ALCHEMY_PASSWORD"));

		// Scoped to exactly what `alchemy deploy` touches: the worker (its DOs and
		// uploaded `dist/client` assets ride on the script), the alchemy
		// state-store worker, the D1 database, KV (state-store metadata), tail
		// logs, and read access to account settings. No R2/Queues — phoenix uses
		// neither; drop or add groups here if that changes.
		//
		// Secrets Store Read+Write is NOT optional: `Cloudflare.state()` (the
		// hosted state store) keeps its worker's bearer token + AES encryption key
		// in the account-wide Cloudflare Secrets Store, and adopts/refreshes them
		// on *every* deploy. Without these the very first deploy call (the
		// state-store bootstrap) fails with Cloudflare error 10000 "Authentication
		// error" — even though the token authenticates fine for D1/Workers.
		const apiToken = yield* Cloudflare.AccountApiToken("phoenix-ci-token", {
			name: "phoenix-ci",
			accountId,
			policies: [
				{
					effect: "allow",
					permissionGroups: [
						"Workers Scripts Write",
						"Workers KV Storage Write",
						"D1 Write",
						"Workers Tail Read",
						"Account Settings Read",
						"Secrets Store Read",
						"Secrets Store Write",
					],
					resources: {[`com.cloudflare.api.account.${accountId}`]: "*"},
				},
			],
		});

		// Pipe the minted value straight into a GitHub secret — the raw token
		// never round-trips through the shell.
		yield* GitHub.Secret("cf-api-token", {
			owner: OWNER,
			repository: REPOSITORY,
			name: "CLOUDFLARE_API_TOKEN",
			value: apiToken.value,
		});

		// Not a cryptographic secret, but storing it here keeps all CI config in
		// one place. `Redacted.make` gives it the same masking as the token.
		yield* GitHub.Secret("cf-account-id", {
			owner: OWNER,
			repository: REPOSITORY,
			name: "CLOUDFLARE_ACCOUNT_ID",
			value: Redacted.make(accountId),
		});

		// The same password used to encrypt this stack's state — propagated so CI
		// can read encrypted secrets back out of the shared alchemy state store.
		yield* GitHub.Secret("alchemy-password", {
			owner: OWNER,
			repository: REPOSITORY,
			name: "ALCHEMY_PASSWORD",
			value: alchemyPassword,
		});

		// The better-auth session-signing secret. The worker reads it at runtime as
		// a `secret_text` binding (`config.ts` `Config.redacted("BETTER_AUTH_SECRET")`),
		// so `alchemy deploy` needs the value in its env. Mint a stable random one
		// here — persisted in this stack's state, so re-runs keep the same value and
		// existing sessions survive — and push it as the repo secret the deploy reads.
		const betterAuthSecret = yield* Alchemy.Random("BETTER_AUTH_SECRET");
		yield* GitHub.Secret("better-auth-secret", {
			owner: OWNER,
			repository: REPOSITORY,
			name: "BETTER_AUTH_SECRET",
			value: betterAuthSecret.text,
		});
	}),
);
