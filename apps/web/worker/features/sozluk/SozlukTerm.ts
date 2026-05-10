/**
 * Per-term Agent DO. Addressed by `idFromName(slug)` — one instance per term.
 *
 * Lineage: ADR 0005 (per-coordination-atom sharding) + ADR 0006 (Agent base
 * class) + ADR 0007 (outbox + Workflows + D1 view layer).
 *
 * T1 ships this as an empty `DurableObject` stub so the wrangler binding
 * (`SOZLUK_TERM`) and the v4 sqlite migration tag both have a concrete class
 * to reference. T2 replaces this with the full `Agent<Env, TermState>`
 * implementation: `term_meta`, `definition`, `definition_vote`, `outbox`
 * tables; `getTerm`, `addDefinition`, `voteDefinition`, `editDefinition`,
 * `deleteDefinition` methods; outbox + `flushOutbox` + reconciliation per
 * ADR 0007.
 */
import {DurableObject} from "cloudflare:workers";

export class SozlukTerm extends DurableObject<Env> {}
