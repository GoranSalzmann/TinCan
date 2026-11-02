# Automatic deployment

How the author's server (mkarl.io) gets a new release without anyone logging in, and how you can set up the same. Everything here is optional: other installations upgrade by hand ([hosting guide §6](hosting.md#6-upgrading-and-rolling-back)), and this setup is built on the same steps.

## 1. What happens

```
tag v1.0.1 pushed ─► Release workflow builds and publishes the images ─► Deploy workflow
                                                                              │ ssh, one command: "deploy 1.0.1"
                                                                              ▼
                                       deploy/deploy.sh on the server (installed once, run by a restricted key)
```

The **Deploy** workflow ([.github/workflows/deploy.yml](../../.github/workflows/deploy.yml)) starts when the Release workflow has finished successfully for a pushed tag `vX.Y.Z`. (It does not use the "release published" event: a release created with the workflow's own token starts no other workflows.) Pre-release tags (`-rc.1`) and the Release workflow's dry runs are not deployed. There is no approval step: publishing the tag is the decision. You can also start it by hand with a version (Actions › Deploy › Run workflow), for a re-deploy or to go to an older release.

On the server `deploy/deploy.sh` does, in this order:

1. **Checks the version** (strict `1.2.3` or `1.2.3-rc.1`; anything else is refused before Docker is touched) and takes a lock, so two deploys never overlap.
2. **Backs up** with the running version (encrypted if `~/.tincan-backup-key` exists), then **restores that backup into a scratch directory** to prove it opens. If either fails, nothing has changed and the run fails (exit 5).
3. **Pulls** `tincan-server:X.Y.Z` and `tincan-web:X.Y.Z` (exit 6 if that fails; nothing has changed).
4. **Edits `docker-compose.yml`**: only the `image:` lines of the app, the web server and the backup service are set, and a `build:` block under them is dropped. Every other line, including what the host changed by hand, stays. The old file is kept as `docker-compose.yml.pre-deploy`.
5. **`docker compose --profile voice --profile dashboards --profile backup up -d`**, then waits until the app is healthy **and reports the new version**, then runs `tincan doctor`, which is held against the new version only for checks that passed before the deploy (it is also run on the old version first; a port the probe cannot reach from the server would otherwise block every release). Only services whose definition changed are restarted; LiveKit is not. Restarting the app does not end calls (people rejoin the gateway); a LiveKit restart would.
6. **If anything in 5 fails, it rolls back**, see §4.

Every line goes to the Actions log and to `~/tincan-deploy.log` on the server.

Exit codes (the run fails on any non-zero one): `0` deployed · `2` bad version · `3` another deploy is running · `4` preflight failed · `5` backup failed · `6` pull failed · `10` new version failed, rolled back, **no data lost** · `11` new version failed, **database restored, data written since is lost** · `12` rollback failed too, a person is needed.

## 2. Setting it up (once)

Four things, in this order. Nothing here changes the running server until step 4.

**1. A key that can do one thing.** On your own computer:

```bash
ssh-keygen -t ed25519 -N "" -C "tincan-github-deploy" -f tincan_deploy
```

On the server, put the script where the key's owner cannot be tricked into running something else, and allow the key to run only it. The `restrict` option turns off terminals, port and agent forwarding and everything else:

```bash
mkdir -p ~/tincan-deploy
curl -fsSL https://raw.githubusercontent.com/GoranSalzmann/TinCan/main/deploy/deploy.sh -o ~/tincan-deploy/deploy.sh
echo "command=\"/bin/sh $HOME/tincan-deploy/deploy.sh\",restrict $(cat tincan_deploy.pub)" >> ~/.ssh/authorized_keys
```

(Paste the contents of `tincan_deploy.pub` where `$(cat …)` is if the key was made on another machine.) The server user needs to be in the `docker` group and nothing else: no `sudo`. The script reads `TINCAN_DIR` (default `~/tincan`), `PASSPHRASE_FILE` (default `~/.tincan-backup-key`; the script gives the path to the backup container and never reads the file), `PROFILES` and `IMAGE_BASE`; to change one, set it in the `command="…"` string: `command="TINCAN_DIR=/srv/tincan /bin/sh …"`.

**2. The host key**, so the workflow talks to your server and not to somebody in between. On the server:

```bash
echo "mkarl.io $(cut -d' ' -f1,2 /etc/ssh/ssh_host_ed25519_key.pub)"
```

**3. Three secrets and one variable** in the GitHub repository (Settings › Secrets and variables › Actions):

| Name | Value |
|---|---|
| secret `DEPLOY_SSH_KEY` | the whole private key file `tincan_deploy` (then delete the file) |
| secret `DEPLOY_HOST` | `user@host`, for example `karlm@mkarl.io` |
| secret `DEPLOY_KNOWN_HOSTS` | the line from step 2 |
| variable `DEPLOY_URL` (optional) | `https://mkarl.io`: after the deploy the workflow asks this address for its version |

**4. Move the server from locally built images to the release images.** A server installed from a checkout has `build:` blocks and `image: tincan-server`. The first deploy replaces them with release images; do it by hand once and watch it:

```bash
cd ~/tincan && grep -n 'image:\|build:\|context:' docker-compose.yml     # what is there now
sh ~/tincan-deploy/deploy.sh 1.0.0                                       # same version as the build, so only the image source changes
docker compose ps --format '{{.Service}} {{.Image}}'
```

Using the version the server already runs makes this a change of where the image comes from and nothing else; the backup, the check and the rollback are the same as in every later deploy. `~/tincan-src` is not needed afterwards.

## 3. Day to day

Release as the [release checklist](../release-checklist.md) says. Watch Actions › Deploy. A red run means the server is on a known state: look at the exit code in the annotation, the log in the run and `~/tincan-deploy.log`.

To **re-deploy or go to another release**, run the workflow by hand with the version. Going *back* works when the older version can still read the database. If a migration ran in between, the older version refuses to start; the script then rolls forward again and says so. Going back across a migration is a restore and loses data; do it by hand as [hosting guide §6](hosting.md#6-upgrading-and-rolling-back) describes.

To **update the script itself**, download it again (the command in step 1). The workflow compares the copy on the host with the one in the released commit and warns when they differ; it uses the host's copy either way.

To **stop automatic deploys**, disable the Deploy workflow, or remove the line from `~/.ssh/authorized_keys`.

## What members notice

- The connection drops for a short time while the app restarts (the status in the corner shows "Reconnecting"); the page reconnects by itself. A call in progress is not ended by the restart of the app; people rejoin the gateway.
- A tab that stayed open across the deploy keeps the old page in memory. When it reconnects, or when the person comes back to the tab, it compares its version with the server's. If they differ, a **banner with a Reload button** appears at the top; it takes no focus, and Dismiss hides it until the next check.
- If the old page needs a file that the new release no longer has (opening settings, for example), the page reloads itself once. It does not do that during a call: there the banner says that reloading will leave the call. An unsent message in the box is kept.

## 4. What a rollback does

The new version is judged by three things: the container becomes healthy, `/api/v1/capabilities` reports the new version, and `tincan doctor` shows no failed check that was fine before the deploy (warnings are fine). If any fails:

1. The old compose file is put back and the old images are started. The database is usually untouched or readable by the old version; the result is exit `10`: the previous version runs again and **no data is lost**.
2. If the old version does not start, a migration changed the database. The script then stops the app, puts back the **snapshot the server took just before the migration** (`data/backups/pre-migrate-*.db`; if there is none, the backup of step 2), and starts the old version. Exit `11`. **What members wrote between that snapshot and now is lost**; the output says since when. The seconds-to-minutes window is the time the new version ran before it was judged failed (the health wait is at most 3 minutes). The database as the new version left it is kept as `data/app.db.failed-<time>`.
3. If even that fails: exit `12`, the app stays stopped, and the output names the files to use. Nothing is deleted.

Uploaded files are not rolled back; a migration does not change them. The backup each deploy takes stays in `data/backups` (the deploy prunes nothing; the daily backup service keeps the newest 14 of its own).

## 5. Security

- The key can run `deploy <version>` and nothing else (`command=`, `restrict`). The version is checked against a strict pattern before anything else happens and is only ever used as part of an image tag. The script itself is on the server, not sent by the workflow.
- Whoever controls the repository's Actions secrets (or can start workflows) can deploy any version that exists as an image, including an old one with a known bug. That is the same trust as the release pipeline itself. Protect the repository settings and the tag creation accordingly. The private key sits in the secret store and, for the length of one run, on the runner; the run deletes it.
- The deploy user is in the `docker` group, which is root-equivalent on that machine, so the script is the part to review. It is short, has no `eval`, and is covered by tests and `shellcheck` in CI.
- The images are pulled from GHCR by tag. Check provenance as described in [SECURITY.md](../../SECURITY.md) if you want more than the tag.

## 6. Differences between the author's server and a fresh `tincan init`

`tincan init --image ghcr.io/goransalzmann/tincan --version X` writes `image: ghcr.io/goransalzmann/tincan-server:X` and `-web:X` and no `build:` blocks. A server installed from a checkout has `build:` with `context: ../tincan-src`. The deploy script converts that, and leaves `.env`, `config.yaml`, `Caddyfile` and `livekit.yaml` alone: it never reads them except `HOST_UID`, `HOST_GID`, `TINCAN_INSTANCE__PUBLIC_URL` and `TURN_DOMAIN` (for the `doctor` call), so the hand-made changes (TURN, ports, the dashboards profile) stay as they are.

## 7. Tests and the rehearsal

- `pnpm test` runs `tools/deploy/deploy.test.ts`: the script against a fake `docker`, covering version validation (including shell metacharacters), the lock, backup and restore failures, a failed pull, a compose file with `build:` blocks, rollback with and without a migration, and a rollback that fails. CI also runs `shellcheck`.
- `sh tools/deploy/rehearse.sh` does the real thing on a scratch machine (Docker in Docker, a local registry): an installation built from source, the first release deploy onto it through the forced-command entry, a release that never becomes healthy (rolled back, data intact), a release that does not exist, and a re-deploy. It never touches a real server. Not covered anywhere: a real migration the old version cannot read (`tools/upgrade-rehearsal` shows the refusal; the fake tests the script's reaction), the real registry, and ssh itself.
