/**
 * @kampus/pipeline-crew-mcp — the crew's channels-backed messaging substrate (epic #3045).
 *
 * This scaffold (issue #3052) lands the package shape and the module skeleton only; no
 * seam behavior yet — each module below is filled by its own child.
 *
 * The one structural invariant the skeleton exists to hold: the generic core is
 * crew-agnostic. `protocol/`, `tracker/`, `peer/`, and `edge/` are the reusable
 * channels substrate and MUST NOT import `crew/`; `crew/` is the sole crew-coupled
 * module (Role catalog + wiring) and depends inward on the generic core, never the
 * reverse. That one-way boundary is what keeps the substrate reusable — enforcing it
 * is the point of splitting these into directories.
 */
export * as Protocol from "./protocol/index.ts";
export {VERSION} from "./version.ts";
