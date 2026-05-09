import {Effect, type ManagedRuntime} from "effect";

/**
 * GraphQL context that carries a per-request Effect runtime.
 * Resolvers receive this as the third argument from graphql-yoga.
 */
export interface EffectContext<R> {
	readonly runtime: ManagedRuntime.ManagedRuntime<R, never>;
}

/**
 * Wraps an Effect generator function as a graphql-js–compatible async resolver.
 * The generator runs through the request's ManagedRuntime, which provides
 * services like CloudflareEnv and RequestContext.
 *
 * @example
 *   resolve: resolver(function* (_source, args: {url: string}) {
 *     const env = yield* CloudflareEnv;
 *     return env.ENVIRONMENT;
 *   })
 */
export function resolver<TSource, TArgs, A>(
	body: (source: TSource, args: TArgs) => Generator<any, A, any>,
): (source: TSource, args: TArgs, context: EffectContext<any>) => Promise<A> {
	return (source, args, context) =>
		context.runtime.runPromise(Effect.gen(() => body(source, args)));
}
