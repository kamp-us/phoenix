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
		/**
		 * GitHub's response body on a non-2xx (bounded/truncated), so a 403's reason
		 * ("Resource not accessible…" vs a rate-limit) is diagnosable in one shot
		 * (issue #292). Null when there's no body to surface — a transport/parse
		 * failure, an empty body, or a guarded `res.text()` read that itself failed.
		 * Only GitHub's own response text; never the bearer token (`github.ts` reads
		 * the body, not the request, so a secret can't ride along).
		 */
		detail: Schema.NullOr(Schema.String),
	},
) {}
