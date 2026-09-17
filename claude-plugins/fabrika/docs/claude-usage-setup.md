# Enable Claude usage collection

1. Install the Fabrika CLI using [the repository setup guide](../../../packages/fabrika-cli/docs/running-fabrika-in-a-repo.md), and enable the Fabrika plugin in Claude Code.
2. Confirm `fabrika hook claude-spend --help` resolves in the checkout where work runs.
   The plugin's [hooks.json](../hooks.json) installs collection for both interactive sessions
   and native dispatched subagents. Keep native model and permission settings as they are.
3. Start or resume work normally. Hooks save response measurements and child expectations under
   the checkout's `.fabrika/` directory. Read them with `fabrika spend read --ledger .fabrika/spend-ledger.jsonl`.
4. If a notice reports incomplete usage, restore access to the native transcript files and
   resume the session. Every hook revisits the saved inventory, including prior sessions in
   that checkout. You can also pipe the original lifecycle payload to
   `fabrika hook claude-spend`. Repeated reads use the shared recorder's identity checks.
5. Preserve `.fabrika/claude-usage/`, `.fabrika/spend-ledger.jsonl`, and native transcript files
   when retiring a checkout. Each checkout has its own ledger. Missing files remain visible;
   recovery requires their return. Inventory files contain local paths and identities, so keep
   them private alongside the already ignored `.fabrika/` directory.

See [the collector reference](claude-usage.md) for attribution, counter meanings and tested evidence.
