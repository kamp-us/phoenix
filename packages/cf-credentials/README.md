# @kampus/cf-credentials

The shared macOS-Keychain Cloudflare-credential seam for kamp.us operator CLIs.

## What it is

A single Effect package that owns how a human operator's Cloudflare credentials are
acquired, validated, stored, and resolved:

- **`keychain.ts`** — the `security`-CLI Keychain boundary: a typed Effect service
  (`Keychain`, `KeychainLive`) shelling `security` over `ChildProcessSpawner`, so no
  plaintext credential ever touches a dotfile. `get` treats every read failure (item not
  found, missing `security` binary on Linux/CI, a locked keychain) as a miss; `set`/`remove`
  fail loudly with `KeychainCommandError`.
- **`credentials.ts`** — the keychain-first resolvers with an env-var fallback:
  `CredentialsKeychainFirst` (the `Credentials` layer the Flagship/D1 transports depend on)
  resolves the API token from the Keychain first, falling back to `$CLOUDFLARE_API_TOKEN`;
  `AccountIdKeychainConfig` is the account-id twin over a `ConfigProvider` answering
  `CLOUDFLARE_ACCOUNT_ID` keychain-first. `credentialSources` reports where each credential
  currently resolves from; `validateCredentials` / `validateAmbient` run a cheap
  authenticated `listApps` read before persisting (login) or when reporting `auth status`.
- **`auth.ts`** — the `auth login`/`status`/`logout` CLI command surface: paste an API
  token, validate it with an authenticated read **before** persisting, and store it through
  the Keychain. Secrets ride prompts (`Prompt.password`) and the keychain — never argv,
  shell history, or a dotfile.

## Why it exists

The seam previously lived inside `@kampus/cf-utils`. It has more than one consumer today
(`cf-utils` itself and `@kampus/orphan-sweep`, which needs to resolve the founder token
locally) and a future one (`anka-ops`, #2089). Collapsing every CF operator tool into
`cf-utils` to borrow its auth is the megapackage trap: a shared capability with multiple
consumers is extracted into a package they all depend on, not merged. Two concrete consumers
is the repo's "promote at the 2nd usage" trigger (cf. [ADR 0068](../../.decisions/0068-adopt-lefthook-at-second-git-hook.md)).
The credential model itself is [ADR 0045](../../.decisions/0045-kampus-client-cli.md) (the
one-authenticated-surface auth) and #1730 (the paste-token login).

## How to use it

Depend on it via `workspace:*` and import the seam from the package root:

```ts
import {
	auth, // the login/status/logout Command for a CLI's subcommand tree
	CredentialsKeychainFirst, // Layer<Credentials, never, Keychain>
	AccountIdKeychainConfig, // Layer<never, never, Keychain> — the account-id ConfigProvider
	Keychain,
	KeychainLive, // Layer<Keychain, never, ChildProcessSpawner>
} from "@kampus/cf-credentials";
```

Wire the layers the way `cf-utils` does — `KeychainLive` under the credential layers, with a
Node `ChildProcessSpawner` and an HTTP client below:

```ts
const CredentialLayer = Layer.mergeAll(CredentialsKeychainFirst, AccountIdKeychainConfig).pipe(
	Layer.provideMerge(KeychainLive),
	Layer.provideMerge(NodeServices.layer),
);
```

Credentials resolve **keychain-first** (after `cf-utils auth login`), falling back to
`$CLOUDFLARE_API_TOKEN` / `$CLOUDFLARE_ACCOUNT_ID` — the env-var path CI keeps using
unchanged.

## Testing

```bash
pnpm --filter @kampus/cf-credentials test    # the unit tier over a FAKE Keychain (no real security CLI, no real CF)
```
