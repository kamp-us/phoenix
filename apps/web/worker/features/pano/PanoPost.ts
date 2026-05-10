/**
 * Per-post Agent DO. Addressed by `idFromName(postId)` — one instance per post.
 *
 * Lineage: ADR 0005 (per-coordination-atom sharding) + ADR 0006 (Agent base
 * class) + ADR 0007 (outbox + Workflows + D1 view layer).
 *
 * T1 ships this as an empty `DurableObject` stub so the wrangler binding
 * (`PANO_POST`) and the v4 sqlite migration tag both have a concrete class
 * to reference. T3 replaces this with the full `Agent<Env, PostState>`
 * implementation: `post_meta`, `tag`, `comment`, `post_vote`, `comment_vote`,
 * `outbox` tables; `getPost`, `listComments`, `submitPost`, `voteOnPost`,
 * `addComment`, etc.; outbox + `flushOutbox` + reconciliation per ADR 0007.
 */
import {DurableObject} from "cloudflare:workers";

export class PanoPost extends DurableObject<Env> {}
