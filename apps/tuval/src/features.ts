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
	/**
	 * Load the `pi-subagents` extension into a Pi session, so a Pi row can spawn a subagent (#8555).
	 * On by default since the founder desk check on 2026-09-08. Off: the row opens the session it opened before the flag existed.
	 */
	readonly piSubagents: boolean;
	/**
	 * The chat window's new turn shape (#8210): no per-row author label — a `user` row is a bubble,
	 * an agent reply is plain prose, and authorship rides a `data-message-role` attribute plus a
	 * visually-hidden author name. Off: every row keeps the uppercase label above it. Every child of
	 * #8210 gates on this one flag, and flipping it is that epic's last child.
	 */
	readonly chatTurnShape: boolean;
}

/**
 * What a config that declares no `features` block means. A user-facing change ships dark behind a
 * default-off flag (`product-development-cycle.md`) and is flipped on here once it has had its
 * runbook pass, so a flag's entry moves from `false` to `true` in this record and nowhere else. A
 * layer that states a flag still wins over it, in either direction (`./config.ts`'s merge).
 */
export const featuresDefault: TuvalFeatures = {
	subagentList: true,
	piSubagents: true,
	chatTurnShape: false,
};
