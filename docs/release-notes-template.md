# Release notes template

Copy the text between the lines into the new `## [x.y.z]` section of `CHANGELOG.md` when you cut a release. The release workflow publishes that section as the body of the GitHub Release, so what you write here is what hosts read before they upgrade. Delete headings that have nothing under them.

---

One or two plain sentences: what this release is and who should care. For a beta, say what you want tested.

### Before you upgrade

Hosts read this first. Say "nothing to do" when that is true.

- **Back up first:** `tincan backup --include-secrets --passphrase-file ...` and copy it off the machine ([admin guide](docs/guides/admin-guide.md#4-backups-and-restore)).
- Manual steps, in order, with the exact commands (new `.env` lines, Caddyfile changes, firewall ports).
- Database migrations: yes or no. A migration means an older version will refuse to start on the new database, so a rollback means restoring the pre-upgrade backup.
- How to upgrade: edit the image tags in `docker-compose.yml` to `x.y.z`, then `docker compose pull && docker compose up -d` ([hosting guide](docs/guides/hosting.md#6-upgrading-and-rolling-back)).

### Added

### Changed

### Fixed

### Security

Say what was fixed, who was affected and since which version. Link the advisory when there is one.

### Known problems

What you know is broken or untested in this release.

### Images and checks

- `ghcr.io/goransalzmann/tincan-server:x.y.z` and `ghcr.io/goransalzmann/tincan-web:x.y.z` (linux/amd64 and linux/arm64). Stable releases also move `x.y` and `latest`; betas never do.
- `SHA256SUMS`, the SBOMs (`*.cdx.json`) and `IMAGES.txt` (image digests) are attached to the release. Verify an image with `gh attestation verify oci://ghcr.io/goransalzmann/tincan-server@sha256:... --repo GoranSalzmann/TinCan`.

---

## Choosing the version

- `x.y.z-beta.n` for betas (never moves `latest`); `x.y.z` for a stable release. Before 1.0, a change that needs manual steps raises the minor number (0.2.0 to 0.3.0), a fix raises the patch.
- Both `package.json` files must say the same version as the tag, and `CHANGELOG.md` must have a filled `## [x.y.z]` section: the release workflow checks both before it builds anything.
