# Run agents under a second GitHub account

Use this when you want fabrika's owner-only steps to refuse your agents. It is optional: a repo
with one GitHub account works without it, and there the steps confirm the account only.
[Why an owner-only step confirms an account](how-fabrika-works.md#an-owner-only-step-confirms-an-account-not-a-person)
has the reasoning.

You need a repo that already runs fabrika, with a `.github/CODEOWNERS` that names your own login.

## 1. Create the agent account and give it write access

Create a second GitHub account for your agents. Invite it to the repo as a collaborator with write
access, and accept the invite from that account. It needs write access to push branches and open
pull requests.

## 2. Keep it off the control-plane rows

Open `.github/CODEOWNERS` on your default branch. fabrika counts every login and team the file names
as a control-plane owner, so the agent login must appear on no row. If a row names a team, such as
`@your-org/control-plane`, keep the agent account out of that team.

fabrika reads this file from the default branch, so a change counts once it is merged there.

## 3. Start agent sessions with the agent account's token

Create a token for the agent account with access to the repo. If you use the betting table, give it
the `project` scope too.

Set it in the environment each agent session starts from:

```bash
export GH_TOKEN=<the agent account's token>
unset GITHUB_TOKEN
```

fabrika takes its credential from `GITHUB_TOKEN` first, then `GH_TOKEN`, then `gh auth token`. So a
`GITHUB_TOKEN` left set to your own token would win.

Check which account the session acts as:

```bash
gh api user --jq .login
```

It prints the agent login.

`git push` uses git's own credentials, not this token. None of the owner-only checks read who
pushed, so this does not affect them.

## 4. Say which accounts' pull requests the pipeline owns

Skip this if every fabrika session that touches a pull request runs as the account that opened it.

By default, fabrika repairs and ships only pull requests opened by the account it is running as.
If you sometimes drive from your own account a pull request the agent account opened, or the other
way round, name both in `.fabrika.jsonc`:

```jsonc
"ownAccounts": ["@your-login", "@your-agent-login"]
```

A declared list replaces the default, so list every account whose pull requests fabrika may repair
and ship. Commit the file to your default branch.

## 5. Do the owner-only steps from your own account

Your agents now run as an account the roster does not name. These four steps refuse it, so you do
them yourself, under your own login:

| Step | What the agent account gets | How you do it |
|---|---|---|
| UI hand-check | `review-ui route` does not count its comment. A pinned one refuses at exit `22`; with no other comment at the head, the route refuses at `21`. | Post the screenshot comment from your own account. |
| `fabrika plan approve` | exit `24` | Run it in a terminal that uses your own token. |
| `fabrika decision rule` | exit `20` | Run it in a terminal that uses your own token. |
| Control-plane approval | A pull request the agent account opened has no self-approval path. `ship cp-approval` answers `stop` until an owner account approves. | Approve the pull request at its current head with a GitHub review. |

GitHub does not let a pull request's author approve it, so the agent account cannot give that last
approval to its own pull request.

A pull request you open yourself is unchanged. On a repo where you are the only control-plane
owner, it still takes your `control-plane-self-approval @ <sha>` comment.

## What the second account does not change

Two owner-only steps read write access, not the roster, and the agent account has write access:

- the `pitch-approved:` comment, which also must carry no agent stamp;
- the `bet` row on the betting table.

Both still pass when the agent account does them. Leaving them to you remains a rule your agents
keep, and no check enforces it.
