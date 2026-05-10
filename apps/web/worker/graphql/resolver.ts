import {Cause, Effect, Exit, type ManagedRuntime} from "effect";
import {GraphQLError} from "graphql";
import {Unauthorized} from "../services/Auth";

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
 * Failure handling:
 * - `Unauthorized` (tagged failure, raised by `Auth.required`) → re-thrown as
 *   a `GraphQLError` with `extensions.code === 'UNAUTHORIZED'` so Yoga's
 *   maskedErrors lets it through and the SPA's `useSessionExpiredToast` hook
 *   surfaces the session-expired toast (T17).
 * - Defects (uncaught `throw` inside the generator) and other tagged failures
 *   → re-thrown via `Cause.squash` so hand-rolled `GraphQLError` instances
 *   still reach Yoga's serializer.
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
	return async (source, args, context) => {
		const exit = await context.runtime.runPromiseExit(Effect.gen(() => body(source, args)));
		if (Exit.isSuccess(exit)) return exit.value;
		const errResult = Cause.findError(exit.cause);
		if (errResult._tag === "Success") {
			const e = errResult.success as unknown;
			if (e instanceof Unauthorized || (e as {_tag?: string})?._tag === "Unauthorized") {
				throw new GraphQLError("not authorized", {
					extensions: {code: "UNAUTHORIZED"},
				});
			}
			throw e;
		}
		throw Cause.squash(exit.cause);
	};
}
