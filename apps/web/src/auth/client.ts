// Re-anchor transitive type specifiers away from `.pnpm/<hash>/...` paths
// so tsgo can portably name plugin types under composite project refs.
// Mirrors worker/features/pasaport/better-auth-live.ts.
import {apiKeyClient} from "@better-auth/api-key/client";
import type {} from "@better-auth/core";
import type {} from "better-auth/client";
import {inferAdditionalFields} from "better-auth/client/plugins";
import type {} from "better-auth/react";
import {createAuthClient} from "better-auth/react";
import type {} from "better-call";
import type {} from "zod/v4/core";

const TOKEN_KEY = "phoenix.bearer_token";

export const authClient = createAuthClient({
	// Type the server-managed `username` additional field (worker
	// `better-auth-live.ts` `additionalUserFields`, `input:false`, returned on the
	// session user) onto the client session `user`, so a read of the settled owner
	// identity can use `session.data.user.username` directly instead of paying a
	// second canonical-`me` round-trip to learn it (#2188). The plugin is type-only
	// (its factory returns no endpoints/hooks — no runtime behavior); the schema form
	// keeps the worker auth instance out of the SPA bundle. `username` is immutable
	// once set, so this session value equals `me.username` — see `useMe` for the one
	// transient (right after a `setUsername` write) where the canonical row still wins.
	// `apiKeyClient` surfaces the minimal documented mint path for a logged-in human to
	// obtain a durable agent credential (ADR 0044 Decision 3, #108): a session can mint +
	// copy a key with `await authClient.apiKey.create({name})`, reading the one-time
	// plaintext off `res.data.key` to hand to an agent (which then sends it as the
	// `x-api-key` header). The full `kampus auth` PAT UX is the separate CLI epic (#113).
	plugins: [
		inferAdditionalFields({user: {username: {type: "string", required: false}}}),
		apiKeyClient(),
	],
	fetchOptions: {
		auth: {
			type: "Bearer",
			token: () => localStorage.getItem(TOKEN_KEY) ?? "",
		},
		onSuccess: (ctx) => {
			const token = ctx.response.headers.get("set-auth-token");
			if (token) localStorage.setItem(TOKEN_KEY, token);
		},
	},
});

export const getBearerToken = (): string | null => localStorage.getItem(TOKEN_KEY);
export const clearBearerToken = (): void => localStorage.removeItem(TOKEN_KEY);

export const {signIn, signUp, signOut, useSession} = authClient;

export type Session = typeof authClient.$Infer.Session;
