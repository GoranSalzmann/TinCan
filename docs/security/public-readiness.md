# Public-readiness audit

Done 2026-10-30 on the repository as it stood at `4238ff0` (83 commits, one author, one branch of consequence: `main`) plus the work of this branch. Purpose: find out what would be exposed, or embarrassing, when the repository goes from private to public, and what has to be decided first. Nothing was rewritten or published. The steps to act on it are in [../release-checklist.md](../release-checklist.md).

**Result in one paragraph.** No secret, token, private key, `.env`, database or backup was ever committed. Two scanners find nothing real. What is in the history is personal rather than secret: your e-mail address in every commit, the name of your server (`mkarl.io`) in the documents, and 11 early commits without a DCO sign-off. None of that is a security problem; each is a decision (§4). One real finding outside the history: `pnpm audit` reported a high advisory against `ws 8.18.0`, which only the root dev tooling used. It is fixed on this branch (`ws 8.22.0`).

## 1. Secrets in the history

| Check | How | Result |
|---|---|---|
| gitleaks 8 (container `zricethezav/gitleaks`), all commits of a fresh mirror clone, redacted | `git clone --mirror D:/TinCan mirror`, then `docker run --rm -v <mirror>:/repo:ro zricethezav/gitleaks:latest detect --source /repo --log-opts="--all" --redact` | 3 findings, all the **public LiveKit development credentials** `devkey` / `devsecret0123456789…` in the M3 spike files (`spikes/m3-voice/d6/livekit.yaml`, `spikes/m3-voice/livekit/livekit.yaml`, `spikes/m3-voice/probe/d1-api.mjs`, commit `75febee`). They protect nothing: they only ever ran on a throw-away container. Allow-listed in `.gitleaksignore` so later scans are quiet |
| trufflehog 3 (container `trufflesecurity/trufflehog`), same history, without contacting any service (`--no-verification`) | `docker run --rm -v <clone>:/repo:ro trufflesecurity/trufflehog:latest git file:///repo --no-verification --no-update` | 0 findings |
| File names ever committed | `git log --all --name-only --format= \| sort -u \| grep -Ei '\.env\|\.pem\|\.key\|\.db$\|setup-token\|\.tar\.gz\|\.enc\$\|passphrase'` | only `apps/server/src/modules/accounts/setup-token.ts` (source code). `.env` and `data/` are in `.gitignore` |
| Token patterns in added lines (`_authToken`, `npm_…`, `ghp_`, `xox[bp]-`, private-key headers) | `git log --all -p \| grep …` | none |
| The repository's own scan (`pnpm check:secrets`) on the working tree | CI step | passes |
| Largest objects | `git rev-list --objects --all \| git cat-file --batch-check` | only `pnpm-lock.yaml` revisions (about 170 KB); the pack is 1 MiB |

The secrets that do exist (the instance secret, LiveKit key and secret, the metrics token, the backup passphrase) live in `.env`, `livekit.yaml` and `monitoring/metrics-token` **on the server**, mode 0600, and were generated there. Nothing about them was ever in a commit, a document or a test fixture. The development values that appear in tests and in `CONTRIBUTING.md` (`mediakey`, `dev-only-secret-…`) are labelled as such.

## 2. Personal data and private paths

| What | Where | Assessment |
|---|---|---|
| Your e-mail address `karl.mike2002@gmail.com` as author and committer of all 83 commits (82 also as committer; one committed by GitHub's web interface) | commit metadata | **Public the moment the repository is.** Anyone can read it, scrapers will collect it, and it cannot be hidden without rewriting history. Decision 1 below |
| The author name `Mike Karl`, while the GitHub account is `GoranSalzmann` | commit metadata | Not a problem, but contributors will see two different names. Decide which one you want shown (a `.mailmap` file maps names without rewriting anything) |
| The host name `mkarl.io` (your production server) | 9 files: docs/qa, docs/17, docs/18, docs/14, the admin guide, `deploy/backup/*` | Reveals which server is yours, and that it runs Tin Can. The qa documents also contain `nmap -p … mkarl.io` as a check you run **against it**. Nothing secret, but it invites people to look at it. Decision 2 below. The ssh alias and user are not in the repository |
| Local paths (`C:\Users\…`, `D:\TinCan`, `/home/<user>`) | none in any commit | clean |
| Public IP addresses | none; only private ranges and documentation examples (`172.30.0.x` in the D6 spike notes, `172.17.0.1`, `203.0.113.x`) | clean |
| E-mail addresses in file contents | only `example.com` placeholders (`a@example.com`, `ops@example.com`, `you@example.com`) | clean |
| Member data, message content, uploaded files | none; tests use generated data | clean |

## 3. Licence, headers and third-party code

| Check | Result |
|---|---|
| `LICENSE` | The full text of the GNU AGPL v3 (661 lines), with the unmodified standard text |
| `pnpm check:headers` | OK on 253 source files (`.ts .tsx .js .mjs .cjs .css`; `docs/`, `spikes/` and generated files are excluded by design). The new scripts and workflows carry the header too |
| `pnpm check:licenses` | OK: 171 packages, all MIT, MIT-0, Apache-2.0, BSD-2/3-Clause, ISC, MPL-2.0, BlueOak-1.0.0 or CC0-1.0, none that conflicts with the AGPL. The MPL-2.0 packages are used unmodified |
| `pnpm audit --audit-level high` | **Failed on the old lockfile**: `ws` 8.18.0 (root dev dependency) was affected by GHSA-96hv-2xvq-fx4p (high) and a moderate advisory. The server's own `ws` was already 8.22.0. Fixed by pinning the root to `ws 8.22.0` (`package.json`, `pnpm-lock.yaml`); the audit is clean. The release workflow runs it again |
| Code that is not from npm | The RNNoise WebAssembly noise suppressor (153 kB) comes from an npm package covered by the licence scan. The brand artwork (`apps/web/public/brand`, icons) is in the repository; **confirm it is yours or licensed for this use** (the history says it was added with the "Tin Can brand artwork" commit; nothing says who drew it) |
| Container images | `deploy/Dockerfile` copies `LICENSE` into both images. The base images are `node:24-bookworm-slim` and `caddy:2` (and LiveKit and Grafana/Prometheus as separate images in the compose file); their licences are theirs and are not redistributed in this repository |
| The AGPL source offer (section 13) | `instance.sourceUrl` defaults to `DEFAULT_SOURCE_URL` = `https://github.com/GoranSalzmann/TinCan` (`apps/server/src/version.ts`). It equals the repository's `origin` URL (`gh repo view` returns exactly `https://github.com/GoranSalzmann/TinCan`) and is shown to every member in Settings and in the app layout. **If the repository is renamed or moved (the name check, 18 F4), change the constant, the README and the release workflow's image names together** |

## 4. Findings that need your decision

| # | Finding | Options | Recommendation |
|---|---|---|---|
| 1 | Your e-mail address is in every commit | (a) leave it; (b) rewrite the history to the GitHub no-reply address `<id>+GoranSalzmann@users.noreply.github.com` before making the repository public; (c) leave it and use the no-reply address from now on | **(b) if you do not want the address public, and only before the repository becomes public**, because after that every clone keeps the old history. Nothing is public yet, and the only copy besides your disk is the private GitHub repository. Commands in §5. For (c): `git config user.email <no-reply address>` and `git config user.name` |
| 2 | `mkarl.io` is named in in 9 files | (a) leave; (b) replace by `chat.example.com` in the docs that are instructions (admin guide, qa checklists) and keep the history | **(b) is cheap and reversible** (a normal commit, no history rewrite); the history will still show the name, which is only a problem if you consider the existence of the server secret. It is not secret: it is a public web site |
| 3 | 11 early commits (27 and 28 October: the initial commit, the design documents and the D5/T1 spike) have no `Signed-off-by` line | (a) leave; (b) add them with a rebase | **(a).** You are the only author of those commits and the DCO exists for outside contributions. The pull request check only looks at the commits of the pull request. If you rewrite history anyway (finding 1), `git rebase --signoff` fixes these in the same pass |
| 4 | Three gitleaks hits on the public LiveKit dev credentials | none needed | Already allow-listed in `.gitleaksignore` |
| 5 | The logo and icons: origin and licence unknown to me | confirm they are yours | Needs your answer before launch |
| 6 | `spikes/` is in the repository: throw-away experiment code with its own `package-lock.json`, excluded from the header, secret and licence checks | (a) keep; (b) move to a branch or a separate archive | (a): the results are referenced from docs 03 and 18. Dependabot only watches the root, so the spikes' lockfile is not updated; say in `spikes/README.md` that it is a record, not maintained code (a one-line change, not made here) |

## 5. Exact commands if you want to clean the history

**Do these on a fresh clone, never in your working copy, before the repository is public, and only if you want finding 1 handled by rewriting.** They change every commit id, so all other sessions' branches and the remote must be replaced afterwards. The private GitHub repository already has the old history; force-pushing replaces it, and GitHub keeps unreachable objects for a while, which only matters if the address were secret (it is only private).

```bash
# 0. a safety copy, outside the repository
git clone --mirror https://github.com/GoranSalzmann/TinCan.git TinCan-backup.git

# 1. a fresh clone to rewrite
git clone https://github.com/GoranSalzmann/TinCan.git TinCan-clean && cd TinCan-clean

# 2. tell git-filter-repo what to change (pip install git-filter-repo)
cat > ../mailmap.txt <<'EOF'
Mike Karl <NOREPLY_ID+GoranSalzmann@users.noreply.github.com> <karl.mike2002@gmail.com>
EOF
git filter-repo --mailmap ../mailmap.txt

# 3. optionally add the missing sign-offs to the 11 early commits in the same pass
git rebase --signoff --root          # (rewrites every commit again; skip if you do not care)

# 4. verify nothing of the old address is left, in any commit or message
git log --all --format='%an <%ae> | %cn <%ce>' | sort -u
git log --all -p | grep -c 'karl.mike2002' || true      # should print 0

# 5. replace the private remote (this is the step that needs your OK; it is destructive)
git remote add origin https://github.com/GoranSalzmann/TinCan.git
git push --force --all origin && git push --force --tags origin
```

Replace `NOREPLY_ID` with the number GitHub shows under Settings › Emails › "Keep my email addresses private". If `git-filter-repo` is not installed, `git filter-branch --env-filter` does the same slowly; the tool above is the one Git's own documentation recommends.

For finding 2 (a normal commit, no rewrite):

```bash
grep -rl 'mkarl\.io' docs deploy | xargs sed -i 's/mkarl\.io/chat.example.com/g'
git diff --stat && git commit -s -am "docs: use chat.example.com in the examples"
```

(Check the diff: `docs/qa` mentions of "the real server" are then slightly less clear, and `docs/18` notes that say "done on mkarl.io" are history you may want to keep as they are.)

## 6. How to repeat the scans

```bash
git clone --mirror . /tmp/tincan-mirror
docker run --rm -v /tmp/tincan-mirror:/repo:ro zricethezav/gitleaks:latest detect --source /repo --log-opts="--all" --redact
git clone . /tmp/tincan-clone
docker run --rm -v /tmp/tincan-clone:/repo:ro trufflesecurity/trufflehog:latest git file:///repo --no-verification --no-update
pnpm check:headers && pnpm check:licenses && pnpm check:secrets && pnpm audit --audit-level high
```

(`trufflehog` needs a normal clone, not a bare mirror.) Neither scanner is added to the repository's dependencies or to CI as a runtime tool; they run as throw-away containers. Run them again right before going public, because the answer is only valid for the commits scanned.

## Open items

- Decisions 1, 2, 5 and 6 above.
- Run the scans again on the final commit before the visibility change.
