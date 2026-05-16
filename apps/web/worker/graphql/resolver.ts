import {Cause, Effect, Exit, type ManagedRuntime} from "effect";
import {GraphQLError} from "graphql";
import {encodeMutationError} from "./errors";

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
 * Failure handling (task_2, d1-direct): every tagged failure and every plain
 * `Error` raised inside the generator passes through {@link encodeMutationError},
 * which maps known domain error classes onto stable wire-format
 * `extensions.code` strings. Mutation resolvers therefore no longer need
 * inline `try/catch + map*MutationError` boilerplate — they can just throw the
 * raw agent error (or let `Auth.required` fail with `Unauthorized`) and the
 * wrapper takes care of the rest.
 *
 * Pre-built `GraphQLError`s pass through unchanged so resolver-side
 * validation can still raise typed codes directly.
 *
 * @example
 *   resolve: resolver(function* (_source, args: {value: string}) {
 *     const {user} = yield* Auth.required;     // Unauthorized → UNAUTHORIZED
 *     const result = yield* Effect.promise(() => stub.setUsername(...));
 *     return result;                            // UsernameValidationError → TAKEN, etc.
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
			const e = errResult.success;
			// `GraphQLError` is the resolver-side "I already know the wire shape"
			// escape hatch — pass it through verbatim so codes like
			// `BODY_REQUIRED` raised by inline validation aren't double-encoded.
			if (e instanceof GraphQLError) throw e;
			throw encodeMutationError(e);
		}
		// Defects (uncaught `throw` that didn't surface as an Effect error)
		// still need to reach Yoga's serializer; squash → encode applies the
		// same wire contract to those too.
		throw encodeMutationError(Cause.squash(exit.cause));
	};
}
