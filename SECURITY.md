# Security Policy

kamp.us — geliştiricilerin yavaş köşesi — runs on **phoenix**: a single Cloudflare
Worker (`apps/web`) that serves the SPA, the `/fate` data plane, and every backend
route. This policy defines how to report a security vulnerability in it.

If you believe you have found a vulnerability, **thank you** — please report it
privately through the channel below rather than opening a public issue.

## Reporting a vulnerability

Report privately through **GitHub's private vulnerability reporting**:

> **[Report a vulnerability](https://github.com/kamp-us/phoenix/security/advisories/new)**
> (Security → Advisories → "Report a vulnerability")

This keeps your report private by construction — it is visible only to the
maintainers until a fix ships, so a flaw is never disclosed before it can be fixed.
It is the **only** sanctioned reporting channel: no contact email is published here
on purpose, so no maintainer's personal address is baked into the repository.

**Please do not open a public GitHub issue for a suspected vulnerability** — a public
issue discloses the flaw to everyone before there is a fix. If private vulnerability
reporting is ever unavailable to you, hold the details and note in a public issue only
that you have a private security report to send, without describing the flaw.

## Scope

In scope — the deployed `apps/web` worker and its surfaces:

- the React SPA served from the worker's `assets` binding,
- the `/fate` data views and the `/fate/live` SSE stream,
- the `/api/*` backend routes and authentication/session handling.

Out of scope: third-party dependencies and the Cloudflare platform itself (report
those upstream to their maintainers), and findings that require a compromised
maintainer account or physical access.

When testing, please **do not**:

- run automated scanning, fuzzing, or load testing that degrades service for others,
- access, modify, or exfiltrate data belonging to accounts that are not your own,
- perform social engineering, phishing, or any denial-of-service.

## Supported versions

kamp.us ships continuously from `main`; there are no tagged releases or maintained
older versions. Only the **currently deployed `main`** (the live site) is supported,
and that is the version to test and report against.

| Version         | Supported |
| --------------- | --------- |
| current `main`  | ✅        |
| older revisions | ❌        |

## What to expect

- **Acknowledgement:** we aim to acknowledge a report within a few business days.
  This is a best-effort target from a small team, not a contractual SLA.
- **Updates:** we will keep you informed as we investigate and work toward a fix, and
  we practice coordinated disclosure — we will agree a disclosure timing with you
  rather than going public unilaterally.
- **Credit:** if you would like it, we are glad to credit you once a fix has shipped.
