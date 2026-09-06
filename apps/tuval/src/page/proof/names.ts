/**
 * The names the reconnect proof's harness, its Playwright config and its spec share.
 *
 * They live apart from `./serve.ts` because importing that module runs it: it is a `Command.run`
 * entry, so a config file reaching into it for a port number would boot a kernel and a Pi session
 * the moment Playwright read its own config.
 */

/**
 * One harness per test, keyed by the arm it serves. A boot holds two turns
 * (`../../pi/proof/vertical.ts`) and each test spends both — the one it finds already chatted, and
 * the one it asks for after the drop. Both harnesses serve both pages; which page a test opens is
 * what makes it the arm it is.
 */
export const CONTROL_PORTS = {recovering: 4319, refusing: 4320} as const;

/** The negative control's document, served by the same Vite dev server as the real page. */
export const NO_RECOVERY_PATH = "/src/page/proof/no-recovery.html";
