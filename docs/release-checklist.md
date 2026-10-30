# Release checklist: going public and cutting the first beta

For the owner. Do the steps in order; each one says why it is there. Nothing here has been done for you: this branch only prepared the files. Steps marked **(you)** need your account or your decision; the rest is commands.

Where things are: [public-readiness audit](security/public-readiness.md) (what is in the history), [release notes template](release-notes-template.md), [hosting guide](guides/hosting.md), the pipeline in `.github/workflows/release.yml`.

## 0. Decide first

- [ ] **(you)** The name. See step 1. Everything below uses `Tin Can`, `tincan` and `GoranSalzmann/TinCan`; a rename touches the places listed there.
- [x] **(you, decided 2026-10-30)** The four decisions of the audit ([§4 of public-readiness](security/public-readiness.md#4-findings-that-need-your-decision)): your e-mail address in the history, `mkarl.io` in the documents, the logo's origin, what to do with `spikes/`.
- [ ] **(you)** Two contact addresses (they can be the same): one for security reports, one for code-of-conduct reports. Use an address you are happy to publish. A shared mailbox or an alias of its own is better than your private one.

## 1. Name and trademark check (docs/18 F4)

- [x] **(you, done 2026-10-30)** Search for "Tin Can" and "tincan" in the trademark databases of the places you and your members live (EUIPO's TMview and the national office, USPTO, DPMA, and so on) for software, chat and communication services. I am not a lawyer and nor are you: this is a look for obvious conflicts, not a legal opinion. One known collision to look at: **"Tin Can API"** is the former name of the e-learning standard now called xAPI, and "Tin Can" is common as a product name.
- [ ] Check that the names are free where you will publish: the GitHub repository (taken by you), the npm scope `@tincan` (only matters if you ever publish packages; the packages are private), the container names `ghcr.io/goransalzmann/tincan-server` and `…/tincan-web` (they live under your account, so no clash), and a domain or website if you want one.
- [ ] If you rename: change `DEFAULT_SOURCE_URL` in `apps/server/src/version.ts`, the URLs in `README.md`, `SECURITY.md`, `CONTRIBUTING.md`, `.github/ISSUE_TEMPLATE/*`, `CHANGELOG.md`, the image names in `docs/guides/hosting.md`, `docs/release-notes-template.md` and `README.md`, and `tincan init --image`'s examples. The release workflow derives image names from the repository owner, not from a fixed string. Searching for `goransalzmann` and `TinCan` finds all of it.

## 2. Fill the placeholders

```bash
grep -rn "OWNER TODO" --include=*.md . --exclude-dir=node_modules
```

- [x] `SECURITY.md`: the security contact address.
- [x] `CODE_OF_CONDUCT.md`: the conduct contact address.
- [ ] `README.md`: the `VERSION=` example in the quickstart (step 5 below sets the real one).
- [ ] The `.github/CODEOWNERS` entries name `@GoranSalzmann`; change them if the account name differs.

## 3. Merge the preparation branch

- [ ] **(you)** Review the pull request for this branch (`claude/determined-lewin-8499fb`): README, SECURITY, CONTRIBUTING, code of conduct, issue forms, Dependabot, release and clean-install workflows, `tincan init --image`, the doctor and setup message fixes, the hosting guide, the audit.
- [ ] CI is green on the pull request. Note that `pnpm audit` may fail again if a new advisory appears between now and then; the fix is usually a version bump.

## 4. Clean the history, if you decided to (before the repository is public)

- [ ] **(you)** Follow [§5 of the audit](security/public-readiness.md#5-exact-commands-if-you-want-to-clean-the-history) on a fresh clone. It force-pushes to the **private** repository, which is why it is a decision and not something the sessions did.
- [ ] Run the scans again on the final commit ([§6 of the audit](security/public-readiness.md#6-how-to-repeat-the-scans)). Both must find nothing but the three allow-listed development credentials.

## 5. Choose the version and write the changelog

The first beta is `0.2.0-beta.1`: the packages say `0.1.0` today, and a tag must equal the package version (the workflow checks).

- [ ] Set `"version": "0.2.0-beta.1"` in the root `package.json` and in `apps/server/package.json`. (`apps/web` and the packages have their own numbers and are not published.)
- [ ] In `CHANGELOG.md`, rename `## [Unreleased]` to `## [0.2.0-beta.1] - 2026-MM-DD`, add a fresh empty `## [Unreleased]` above it, and read the section as a host would. Use the [template](release-notes-template.md) for "Before you upgrade".
- [ ] In `README.md`, set `VERSION=` in the quickstart to `0.2.0-beta.1`.
- [ ] Commit with `git commit -s` on a branch, merge it. `pnpm check` must be green.

## 6. GitHub settings **(you)**

In the repository's Settings. Do these before or together with making it public; the ones marked "public" only exist for public repositories on a free account.

- [ ] **General › Features:** turn **Discussions** on and create the category **Q&A** (the issue chooser links to `…/discussions/categories/q-a`). Keep Issues on. Add a description and topics.
- [ ] **Code security:** turn on **Private vulnerability reporting** (public), **Dependabot alerts**, **Dependabot security updates**, **Secret scanning** and **Push protection** (public). `.github/dependabot.yml` then handles the weekly version updates. CodeQL already runs from `.github/workflows/codeql.yml`.
- [ ] **Actions › General:** *Workflow permissions* = read repository contents only (the workflows ask for more where they need it). *Fork pull request workflows* = require approval for all outside contributors. If your plan has the option, require actions to be pinned to a full commit SHA (they are).
- [ ] **Branches (or Rules › Rulesets):** protect `main`: require a pull request, require the status checks `PR checks / checks`, `PR checks / dco`, `PR checks / images` and the CodeQL analysis, block force pushes and deletion. For a one-person project do not require approving reviews (you would block yourself), but allow admins to bypass in an emergency.
- [ ] **Rules › Rulesets for tags:** restrict creating tags that match `v*` to yourself, so nobody else can trigger a release.
- [ ] **General › Danger zone › Change visibility → Public.** The last step before the release: until then the pipeline can be tried in private.

## 7. Rehearse the release (dry run)

The workflow file must be on the default branch to appear in the Actions tab.

- [ ] **Actions › Release › Run workflow**, version `0.2.0-beta.1`. It runs the full check set, builds `tincan-server` and `tincan-web` for amd64 **and arm64** (the arm64 build runs under emulation and is slow, up to about 45 minutes the first time), and pushes nothing. If a step fails, that is the thing to fix before tagging.
- [ ] **Actions › Clean install › Run workflow.** It must end with `PASS`.
- [ ] **Actions › Media tests › Run workflow** (nightly anyway). Must be green.
- [ ] Try the arm64 image on a real arm64 machine if you have one (a Raspberry Pi or an ARM VPS): the pipeline builds it but cannot run it. During preparation the **server** image was built for arm64 under emulation on a Windows machine and `tincan setup` ran in it (the argon2 and SQLite native modules load); the web image (Caddy plus static files) was not built for arm64, and nothing ran on real ARM hardware.

## 8. Cut the tag

```bash
git switch main && git pull
git tag -s v0.2.0-beta.1 -m "Tin Can 0.2.0-beta.1"       # -a instead of -s if you do not sign tags
git push origin v0.2.0-beta.1
```

- [ ] Watch **Actions › Release**. It creates the images on GHCR, the attestations, the SBOMs, `SHA256SUMS` and a GitHub Release marked **pre-release**, with the changelog section as its text. A beta never moves `latest`.
- [ ] **(you)** **Packages:** the first push creates two **private** packages (`tincan-server`, `tincan-web`) under your account. Open each ▸ *Package settings* ▸ *Change visibility* ▸ **Public**, and check that they are connected to the repository (the image label `org.opencontainers.image.source` does that). Anonymous `docker pull` fails until you do.
- [ ] Verify like a host would, from a machine that is not logged in:

```bash
docker pull ghcr.io/goransalzmann/tincan-server:0.2.0-beta.1
docker pull ghcr.io/goransalzmann/tincan-web:0.2.0-beta.1
docker buildx imagetools inspect ghcr.io/goransalzmann/tincan-server:0.2.0-beta.1     # shows linux/amd64 and linux/arm64
gh attestation verify oci://ghcr.io/goransalzmann/tincan-server:0.2.0-beta.1 --repo GoranSalzmann/TinCan
curl -fsSLO https://github.com/GoranSalzmann/TinCan/releases/download/v0.2.0-beta.1/SHA256SUMS
sha256sum -c SHA256SUMS --ignore-missing
```

- [ ] Follow the README quickstart once on a scratch VPS with the real images. This is the test the clean-install job cannot do (it uses locally built images). Then upgrade `mkarl.io` to the released tag the way the hosting guide says.
- [ ] Open a **Discussions** announcement post, and tell the friends and the first outside hosts. Ask them to run `tincan doctor` and report with the bug form.

## 9. If the tag was wrong

```bash
gh release delete v0.2.0-beta.1 --yes --cleanup-tag
# then delete the two package versions under Packages, fix, and tag again with a new number (0.2.0-beta.2)
```

Do not reuse a version number that anyone may have pulled.

## 10. The M7 exit

Beta is over when three independent hosts run Tin Can successfully and no P0 or P1 issue is open ([docs/17 M7](17-roadmap-and-milestones.md)). Keep a list of hosts (who, which version, since when, what went wrong) in Discussions or in docs/18, label issues P0 to P3, then tag `v1.0.0` (no `-beta`): that moves `latest` and the `1.0` line.

## Accounts and access you need

Only GitHub (the repository, Packages, Discussions, Actions). No Docker Hub account, no signing certificate, no registry credentials: the workflow publishes with the repository's own `GITHUB_TOKEN`. An e-mail address for the two contact placeholders. Optionally a signing key for tags.

## Not run during preparation

- The release workflow itself (it was written, not run: no tag, no dry run, nothing pushed).
- The arm64 web image, and any arm64 image on real hardware (the server image was built and smoke-tested under emulation only).
- The clean-install workflow on GitHub's runners (the script passes locally on Docker Desktop for Windows).
- Private vulnerability reporting, Discussions, branch rules and package visibility (settings that exist only on GitHub).
