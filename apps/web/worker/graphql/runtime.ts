import {Layer, ManagedRuntime} from "effect";
import {CloudflareEnv, RequestContext} from "../services";

/**
 * Service requirements for any GraphQL resolver.
 * Add new services here as features land (Auth, LibraryClient, etc.).
 */
export type GraphQLContext = CloudflareEnv | RequestContext;

export namespace GraphQLRuntime {
	export type Context = GraphQLContext;

	export const layer = (env: Env, request: Request): Layer.Layer<GraphQLContext> =>
		Layer.mergeAll(
			Layer.succeed(CloudflareEnv, env),
			Layer.succeed(RequestContext, {
				headers: request.headers,
				url: request.url,
				method: request.method,
			}),
		);

	export const make = (
		env: Env,
		request: Request,
	): ManagedRuntime.ManagedRuntime<GraphQLContext, never> =>
		ManagedRuntime.make(layer(env, request));
}
