// Re-anchor transitive type specifiers away from `.pnpm/<hash>/...` paths
// so tsgo can portably name plugin types under composite project refs.
// Mirrors worker/features/pasaport/auth.ts.
import type {} from "@better-auth/core";
import type {} from "better-auth/client";
import type {} from "better-auth/react";
import {createAuthClient} from "better-auth/react";
import type {} from "better-call";
import type {} from "zod/v4/core";

const TOKEN_KEY = "phoenix.bearer_token";

export const authClient = createAuthClient({
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
