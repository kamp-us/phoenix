/**
 * The package's library surface: the pure verb cores, so a consumer (or a test) can compute an
 * outcome without spawning the bin. The CLI itself is `bin.ts`.
 *
 * The verbs are exported as namespaces, not flattened: each one owns a set of exit-code constants
 * whose *names* deliberately repeat across verbs (`ZERO_SCOPE`, `NO_SUBJECT`), because the contract
 * assigns each verb its own codes. Flattening would collide them.
 */
export * as BaseRef from "./adr/base-ref.ts";
export * as AdrNew from "./adr/new-verb.ts";
export * as Allocation from "./adr/next.ts";
export * as AdrNext from "./adr/next-verb.ts";
export * as Records from "./adr/records.ts";
export * as AdrRelate from "./adr/relate-verb.ts";
export * as Resolution from "./adr/resolve.ts";
export * as AdrResolve from "./adr/resolve-verb.ts";
export * as StatusLine from "./adr/status-line.ts";
export * as Sweep from "./adr/sweep.ts";
export * as AdrSweep from "./adr/sweep-verb.ts";
export * as Template from "./adr/template.ts";
export * as Exec from "./io/exec.ts";
export * as Fs from "./io/fs.ts";
export * as Git from "./io/git.ts";
export * as GitHub from "./io/github.ts";
export * as Verb from "./verb.ts";
export {VERSION} from "./version.ts";
