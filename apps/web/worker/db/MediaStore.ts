/**
 * `MediaStore` service — the single seam holding the init-resolved
 * Effect-native `R2BucketClient` for the imge object store (ADR 0044 Decision 1).
 *
 * Mirrors `db/Database.ts`: the binding is resolved once per isolate via
 * `Cloudflare.R2Bucket.bind(ImgeBucket)` (like `Cloudflare.D1Connection.bind(PhoenixDb)`)
 * and wrapped behind a Tag so the runtime never re-binds per request. This child
 * wires the binding only; the upload/serve paths that consume the client land in
 * later imge children (#109/#111).
 */
import * as Cloudflare from "alchemy/Cloudflare";
import {Context, Effect, Layer} from "effect";
import {ImgeBucket} from "./resources.ts";

export class MediaStore extends Context.Service<MediaStore, Cloudflare.R2BucketClient>()(
	"@kampus/MediaStore",
) {}

/**
 * Resolved once and provided as a worker-level layer (the binding is stable for
 * the isolate's life). No finalizer: a Cloudflare binding is not a resource the
 * worker owns or closes.
 */
export const MediaStoreLive = Layer.effect(
	MediaStore,
	Effect.gen(function* () {
		return yield* Cloudflare.R2Bucket.bind(ImgeBucket);
	}),
);
