# Security policy

Tin Can is a hobby-scale project maintained by one person. This page says how to report a security problem and what you can expect. It is short on purpose.

## Supported versions

Only the **latest release** gets security fixes. If you run an older version, the fix is to upgrade; the release notes say when an upgrade needs manual steps. There are no backports.

## How to report a vulnerability

**Please do not open a public issue or discussion for a security problem.**

1. Preferred: use GitHub's private reporting. Open the [Security tab](../../security/advisories/new) of this repository and choose "Report a vulnerability". Only the maintainer can see it.
2. If you cannot use GitHub, write to **karl.mike2002@gmail.com**. If you want to send details encrypted, say so in a first short message and ask for a key.

What helps most:

- the Tin Can version (`/api/v1/capabilities` shows it, or run `tincan version`) and how it is installed;
- what an attacker needs to start with (no account, a normal member, a moderator, network access to the server) and what they get;
- steps or a small proof of concept that reproduces it, against your own test instance;
- your name or handle, if you would like to be credited.

Please do not test against someone else's server, do not read or change other people's data, and do not run denial-of-service tests against a server you do not own.

## What to expect

- An acknowledgement within a few days. This is a spare-time project, so please be patient if it takes a little longer, and ask again after a week of silence.
- A first assessment (confirmed, not a problem, or need more information) usually within two weeks.
- A fix in a new release, with a note in the changelog. For something serious you are told the date before it is published. We prefer to disclose once a fix exists and will agree on a date with you. Credit in the advisory if you want it.
- **There is no bug bounty.** There is thanks, and credit.

## Safe harbour

If you act in good faith, stay within the limits above and report what you find to us, we will not take legal action against you over it. This covers our own project and the instances we run. We cannot speak for other people's servers, so test against your own.

## What is known already

Read these before reporting, so you can tell us what is new:

- [docs/15](docs/15-security-and-threat-model.md): the threat model and the security requirements S-01 to S-16.
- [docs/security/m5-review.md](docs/security/m5-review.md): the review of those requirements against the code, with the **residual risks that are accepted or still open** (for example: the host can read voice and all text; rate limits live in memory; no two-factor login).
- [docs/guides/admin-guide.md](docs/guides/admin-guide.md#8-host-hardening-checklist): the host hardening checklist.

Findings that match an accepted risk in those documents are still welcome if you have a better way to fix them, but they are not vulnerabilities in the sense of this policy.
