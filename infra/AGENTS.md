# Standalone stacks

These stacks own account-level resources outside an app's deployment. Reuse the
account state store and CI credentials; adding a deployed app does not require a
second bootstrap. Changes can affect real Cloudflare or GitHub resources.

Read the owning stack's entry point and README where present. Use the shared
[pattern index](../.patterns/index.md) for binding, deployment and credential guidance.
