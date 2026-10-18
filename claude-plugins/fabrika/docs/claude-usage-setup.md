# Enable Claude usage collection

1. Install the Fabrika CLI using [the repository setup guide](../../../packages/fabrika-cli/docs/running-fabrika-in-a-repo.md), and enable the Fabrika plugin in Claude Code.
2. Confirm `fabrika hook claude-spend --help` resolves in the checkout where work runs.
   The plugin's [hooks.json](../hooks.json) installs collection for both interactive sessions
   and native dispatched subagents. Keep native model and permission settings as they are.
   Collection defaults on under the common [primary-checkout policy](../../../packages/fabrika-cli/docs/usage-recording.md#automatic-collection-policy).
3. Start or resume work normally. Hooks save response measurements and child expectations under
   the checkout's `.fabrika/` directory. Read them with `fabrika spend read --ledger .fabrika/spend-ledger.jsonl`.
4. If a notice reports unavailable policy, restore a readable primary `.fabrika.jsonc` with
   `usageCollection` on or absent. For incomplete usage, restore access to the native transcript files and
   resume the session. Every hook revisits the saved inventory, including prior sessions in
   that checkout. You can also pipe the original lifecycle payload to
   `fabrika hook claude-spend`. Repeated reads use the shared recorder's identity checks.
5. Preserve `.fabrika/claude-usage/`, `.fabrika/spend-ledger.jsonl`, and native transcript files
   when retiring a checkout. Each checkout has its own ledger. Missing files remain visible;
   recovery requires their return. Inventory files contain local paths and identities, so keep
   them private alongside the already ignored `.fabrika/` directory.

See [the collector reference](claude-usage.md) for attribution, counter meanings and tested evidence.

## Disable automatic usage collection

1. Run `git worktree list` and locate the primary checkout, its first entry.
2. Set `"usageCollection": "off"` in that checkout's tracked `.fabrika.jsonc` and confirm the
   value with `fabrika status settings --root <primary-checkout>`. An uncommitted edit applies;
   the linked checkout's copy does not control it. Keep the primary checkout readable.
3. Continue native work. The next Claude lifecycle callback returns quietly before usage IO,
   including with old saved inventory. This setting also disables automatic Codex collection.
   New accounting is unavailable; previous facts and manual recording remain usable.
4. To resume collection or replay, set `"on"` or remove the key in the primary checkout, then
   replay the original payload. Enabled collection retains its existing partial coverage.
