/**
 * The fence between the committed preview session-signing key and every stage that is not a
 * preview — see `infra/preview-auth-key/README.md` for the key itself and ADR 0405 for the ruling.
 *
 * The key is public by design, so "production must not verify against it" cannot rest on nobody
 * having a copy; it has to rest on production refusing the value. The refusal keys on a PREFIX
 * rather than on the literal committed bytes, and that is the whole point: a rotation of
 * `infra/preview-auth-key/key.txt` cannot outrun this check, and any future preview-only key wears
 * the same prefix and is refused off-preview for free. `preview-auth-key.unit.test.ts` reads the
 * committed file and asserts it carries the prefix, so the two cannot drift apart silently.
 *
 * Deliberately pure and `effect`-free, like `environment.ts` beside it: the deploy-time selection
 * in `.github/workflows/deploy.yml` and the runtime refusal in `better-auth-live.ts` are two
 * different moments reading one taxonomy.
 */
import type {Environment} from "./environment.ts";

/**
 * The prefix the committed preview key wears. It is the key's own self-declaration — the same shape
 * `.env.example`'s `insecure_` dev secret uses, for the same reason: a value that says what it is
 * cannot be mistaken for one that does not.
 */
export const PREVIEW_AUTH_KEY_PREFIX = "preview_";

/** The repo-relative home of the committed key, named once so a message can point at it. */
export const PREVIEW_AUTH_KEY_PATH = "infra/preview-auth-key/key.txt";

export const isPreviewAuthKey = (secret: string): boolean =>
	secret.trim().startsWith(PREVIEW_AUTH_KEY_PREFIX);

/**
 * Whether this stage may sign and verify sessions with the secret it was handed.
 *
 * Two arms, not a boolean: the refusal carries the environment that refused, because the operator
 * question on a dead worker is always "which stage did this key reach", and a bare `false` answers
 * it with nothing.
 */
export type AuthSecretVerdict =
	| {readonly _tag: "Accepted"}
	| {readonly _tag: "PreviewKeyOffPreview"; readonly environment: Environment};

/**
 * `preview` is the only environment the committed key is admissible in. `production` is the obvious
 * refusal; `audit` and `development` refuse too, and on purpose — `audit` is a deployed stage on a
 * real origin (#1511) and `development` is a laptop that should be signing with `.env`'s own
 * throwaway, so neither has any business verifying against a key the whole internet holds.
 */
export const judgeAuthSecret = (environment: Environment, secret: string): AuthSecretVerdict =>
	isPreviewAuthKey(secret) && environment !== "preview"
		? {_tag: "PreviewKeyOffPreview", environment}
		: {_tag: "Accepted"};

export class PreviewAuthKeyOffPreviewError extends Error {
	readonly environment: Environment;
	constructor(environment: Environment) {
		super(
			`Refusing to boot: ENVIRONMENT "${environment}" was handed a session-signing secret carrying the ` +
				`"${PREVIEW_AUTH_KEY_PREFIX}" prefix — that is the public preview key committed at ` +
				`${PREVIEW_AUTH_KEY_PATH}, which anyone who can read the repo can forge a login with. ` +
				`Only a pr-<n> preview stage may deploy with it (ADR 0405); this stage must deploy with ` +
				`the founder-held BETTER_AUTH_SECRET.`,
		);
		this.name = "PreviewAuthKeyOffPreviewError";
		this.environment = environment;
	}
}

/**
 * The runtime half of the fence: throws rather than returning, because the caller is a layer
 * construction whose only honest response is to die. A worker that cannot be trusted to verify a
 * session must serve nothing, not serve it anyway.
 */
export const assertAuthSecretForEnvironment = (environment: Environment, secret: string): void => {
	const verdict = judgeAuthSecret(environment, secret);
	if (verdict._tag === "PreviewKeyOffPreview") {
		throw new PreviewAuthKeyOffPreviewError(verdict.environment);
	}
};
