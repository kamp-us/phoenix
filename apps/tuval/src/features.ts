/**
 * The feature flags as everything downstream reads them, and the record a config that states none
 * means. Its own module, node-free on purpose: the flags are merged on the node side (`./config.ts`)
 * and read on the browser side, so both ends need this type and only one end may reach `node:*`.
 * `page/assets.d.ts` types the generated `virtual:tuval/features` module from here, and
 * `tsconfig.browser.json` — which compiles with `types: []` — is what would red if this file grew a
 * Node import (#8439).
 *
 * A flag added here crosses to the page with no other edit: the generated module is written by
 * walking this record (`page/dev-server.ts`). Reaching the node side takes two: the key has to be
 * declared in `config.ts`'s `DeclaredFeatures`, or the decode drops it, and the reader takes the
 * merged record off the `Features` kernel service rather than off `featuresDefault` (#8595).
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
	 * Register the three kernel tools — `spawn`, `send`, `read` — on a Pi session, so a Pi row can
	 * start, write to and read another Tuval process the way Claude and Codex already can (#8720).
	 * Off: the session carries no custom tools, which is the session Pi opened before this flag.
	 */
	readonly piKernelTools: boolean;
	/**
	 * Show a process the agent spawned through the kernel as a marked row in its parent's sub-agent
	 * list, openable as its own window (#8719). Off: the list is exactly the list of the backend's
	 * own workers, as it is today.
	 */
	readonly kernelChildren: boolean;
	/**
	 * Title a window by the line its process published on `title@1`, and show the process id under
	 * the desk inspector's heading instead (#8721). Off: every window is `process <uuid>`, as it was,
	 * and the inspector carries no id line.
	 */
	readonly windowTitles: boolean;
	/**
	 * The process board over the desk: one tile per process from the kernel row and the two generic
	 * ports, children nested in their parent's tile (#8723). Off: the page is the desk alone, as it
	 * is today.
	 */
	readonly processBoard: boolean;
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
	piKernelTools: false,
	kernelChildren: false,
	windowTitles: false,
	processBoard: false,
};
