/**
 * Tagged errors the pipeline feature raises. The dashboard worker has no fate
 * transport, so these carry no `ErrorCode` annotation (`.patterns/effect-errors.md`
 * — an error with no wire round-trip needs none); the route edge maps a
 * `GithubFetchError` to a 502.
 */
import * as Schema from "effect/Schema";

/** A GitHub REST call failed — non-2xx status or a transport/JSON error. */
export class GithubFetchError extends Schema.TaggedErrorClass<GithubFetchError>()(
	"@phoenix/dashboard/pipeline/GithubFetchError",
	{
		/** The REST path that failed (e.g. `/repos/kamp-us/phoenix/issues`). */
		path: Schema.String,
		/** HTTP status when the call completed non-2xx; null for a transport/parse failure. */
		status: Schema.NullOr(Schema.Number),
		message: Schema.String,
	},
) {}
