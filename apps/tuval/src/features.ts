/**
 * The feature flags as everything downstream reads them, and the record a config that states none
 * means. Its own module, node-free on purpose: the flags are merged on the node side (`./config.ts`)
 * and read on the browser side, so both ends need this type and only one end may reach `node:*`.
 * `page/assets.d.ts` types the generated `virtual:tuval/features` module from here, and
 * `tsconfig.browser.json` — which compiles with `types: []` — is what would red if this file grew a
 * Node import (#8439).
 *
 * A flag added here is one edit: the generated browser module is written by walking this record
 * (`page/dev-server.ts`), and `config.ts`'s `DeclaredFeatures` — the schema a layer's `features`
 * block decodes against — is derived from this record's own keys, so a key added here cannot be
 * absent from the config schema (#8783). What a node-side reader still owes is taking the merged
 * record off the `Features` kernel service rather than off `featuresDefault` (#8595).
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
	/**
	 * Register the worked `pr-review` example as a program row, so the authoring layer's own
	 * thirty-line program is in the box a booted desk reads (#8734). Off: the desk is the eight rows
	 * it carried before this flag — no row, no graph node, no `:pr-review` spells.
	 *
	 * The first flag over a program *row*, and a row is stated one layer lower than every other flag
	 * here: `.tuval/tuval.config.ts` reads its own `features` block to decide whether to build the
	 * row, because the merged record does not exist while a config module is being evaluated (#8595).
	 * So a global `~/.tuval/tuval.config.ts` stating this flag reaches the `Features` service and not
	 * the row. ADR 0375.
	 */
	readonly prReviewExample: boolean;
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
	prReviewExample: false,
};
