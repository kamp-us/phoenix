/**
 * The feature flags as everything downstream reads them, and the record a config that states none
 * means. Its own module, node-free on purpose: the flags are merged on the node side (`./config.ts`)
 * and read on the browser side, so both ends need this type and only one end may reach `node:*`.
 * `page/assets.d.ts` types the generated `virtual:tuval/features` module from here, and
 * `tsconfig.browser.json` — which compiles with `types: []` — is what would red if this file grew a
 * Node import (#8439).
 *
 * A flag added here crosses to the page with no other edit: the generated module is written by
 * walking this record (`page/dev-server.ts`).
 */

export interface TuvalFeatures {
	/**
	 * The running-subagent list at the top of the agent window, and — the same flag, because they are
	 * one change — a subagent's rows leaving the agent window's transcript (#8405).
	 */
	readonly subagentList: boolean;
}

/**
 * Every flag off. A user-facing change ships dark behind a default-off flag
 * (`product-development-cycle.md`), so this is what a config that declares no `features` means.
 */
export const featuresOff: TuvalFeatures = {subagentList: false};
