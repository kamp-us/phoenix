import {Effect, Schema} from "effect";

export class TestFailure extends Schema.TaggedErrorClass<TestFailure>()("tuval-test/TestFailure", {
	cause: Schema.Defect(),
}) {}

export const tryPromise = <A>(try_: () => A | PromiseLike<A>) =>
	Effect.tryPromise({
		try: async () => try_(),
		catch: (cause) => new TestFailure({cause}),
	});
