import {Layer, ManagedRuntime} from "effect";
import type {Session} from "../features/pasaport/auth";
import {Auth, CloudflareEnv, RequestContext} from "../services";

/**
 * Service requirements for any GraphQL resolver.
 * Add new services here as features land (LibraryClient, Pasaport, etc.).
 */
export type GraphQLContext = CloudflareEnv | RequestContext | Auth;

export type SessionData = {
	user?: Session["user"];
	session?: Session["session"];
} | null;

export namespace GraphQLRuntime {
	export type Context = GraphQLContext;

	export const layer = (
		env: Env,
		request: Request,
		sessionData: SessionData,
	): Layer.Layer<GraphQLContext> =>
		Layer.mergeAll(
			Layer.succeed(CloudflareEnv, env),
			Layer.succeed(RequestContext, {
				headers: request.headers,
				url: request.url,
				method: request.method,
			}),
			Layer.succeed(Auth, {
				user: sessionData?.user,
				session: sessionData?.session,
			}),
		);

	export const make = (
		env: Env,
		request: Request,
		sessionData: SessionData,
	): ManagedRuntime.ManagedRuntime<GraphQLContext, never> =>
		ManagedRuntime.make(layer(env, request, sessionData));
}
