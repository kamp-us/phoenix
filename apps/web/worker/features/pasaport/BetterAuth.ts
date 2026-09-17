import type {RuntimeContext} from "alchemy";
import type {HttpEffect} from "alchemy/Http";
import type {Auth} from "better-auth";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

// Phoenix supplies its own shared-D1 implementation; Alchemy no longer exports this service tag.
export class BetterAuth extends Context.Service<
	BetterAuth,
	{
		readonly auth: Effect.Effect<Auth<any>, never, RuntimeContext>;
		readonly fetch: HttpEffect<RuntimeContext>;
	}
>()("phoenix/BetterAuth") {}
