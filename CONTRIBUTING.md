# Contributing to Tin Can

Thank you for wanting to help. Tin Can is a small project with one maintainer, so a few simple rules keep review quick. Be kind: everyone taking part follows the [code of conduct](CODE_OF_CONDUCT.md).

Not sure where to start? Fixing something in the guides, trying an install on a different setup and writing down what tripped you up, and testing the things marked "not run" in [docs/qa](docs/qa/m5.md) (Firefox, Safari, phones) are all useful. For anything bigger than a small fix, open an issue or a discussion first so you do not build something that does not fit the scope ([docs/01](docs/01-vision-scope-requirements.md), backlog in [docs/17 §7](docs/17-roadmap-and-milestones.md)).

## Licence and sign-off (DCO)

Tin Can is AGPL-3.0-or-later. There is **no CLA**. Instead every commit carries a `Signed-off-by` line, which says you wrote the change or have the right to submit it under the project's licence (the [Developer Certificate of Origin](https://developercertificate.org/)):

```bash
git commit -s -m "fix(chat): keep the draft when switching channels"
```

If you forgot: `git rebase --signoff origin/main`, then force-push your branch. The pull request check (`node scripts/check-dco.mjs`) fails otherwise. Because there is no CLA, the project cannot be relicensed later without every contributor's agreement.

## Setting up

You need Node.js 24 or newer and [pnpm](https://pnpm.io/) 12 (the exact version is in `package.json`; `corepack enable` installs it). Docker is needed for the media test and the image build.

```bash
git clone https://github.com/GoranSalzmann/TinCan.git && cd TinCan
pnpm install
pnpm check
```

`pnpm check` is what CI runs: typecheck, lint and format (Prettier), SPDX headers, all tests, build, licence scan, secret scan. **Please make it pass before opening a pull request.** Useful pieces on their own: `pnpm typecheck`, `pnpm lint`, `pnpm format`, `pnpm test:unit`, `pnpm test:contract`, `pnpm test:matrix`, `pnpm vitest run --project web`.

### The media test

Voice, camera and screen share are covered by a test with a real LiveKit and three headless Chromium clients on fake devices ([docs/16 §6](docs/16-testing-and-ci.md)). Run it when you change `apps/server/src/modules/voice`, `apps/web/src/core/voice`, `apps/web/src/modules/voice` or `tools/media-test`:

```bash
pnpm exec playwright-core install chromium
pnpm build && pnpm media-test                  # Linux (host networking)
sh tools/media-test/docker.sh                  # Windows and macOS: runs it in Docker
```

It takes a few minutes. CI runs it nightly and on pull requests that touch those paths.

### Running the dev server

Create `dev/config.yaml` (git does not ignore `dev/`, so do not commit it or put real secrets in it; `data/` folders are ignored):

```yaml
instance: { name: Dev, publicUrl: "http://localhost:5173" }
server: { allowedOrigins: ["http://localhost:5173"] }
dataDir: ./dev/data
security: { instanceSecret: "dev-only-secret-dev-only-secret-0123456789" }
adapters:
  database: { kind: sqlite, path: ./dev/data/app.db }
  storage: { kind: local, path: ./dev/data/files }
modules:
  accounts: { signup: invite-only }
```

Then, in two terminals:

```bash
pnpm dev                          # the server on http://localhost:3000 (restarts on change)
pnpm --filter @tincan/web dev     # the web client on http://localhost:5173, forwarding /api and /gateway
```

The first start creates a setup token in `dev/data/setup-token`; open <http://localhost:5173/setup>.

**With a local LiveKit** (to work on voice): run LiveKit with the media test's config, which has a fixed development key. On Linux:

```bash
docker run --rm --network host -v "$PWD/tools/media-test/livekit.yaml:/etc/livekit.yaml:ro" \
  livekit/livekit-server:v1.13.10 --config /etc/livekit.yaml
```

and add this to `dev/config.yaml`:

```yaml
livekit:
  url: ws://localhost:7880
  apiUrl: http://127.0.0.1:7880
  apiKey: mediakey
  apiSecret: media-test-secret-0123456789abcdef
```

LiveKit posts its webhooks to `127.0.0.1:3000`, which is why host networking is used. On Docker Desktop (Windows and macOS) host networking does not reach your machine: use `tools/media-test/docker.sh` for the automated test, and expect to adapt the webhook address for manual work. The LiveKit image tag above is the one in `apps/server/src/cli/templates.ts`; keep the two equal.

## Rules of the code

- **Module boundary.** Feature modules under `apps/server/src/modules/<name>/` never import each other. They talk through events, shared ports (`packages/*`), or a type-only import of the other module's `api` file. ESLint enforces it (`tools/eslint/module-boundary.js`, [docs/04 §5, §11](docs/04-feature-module-system.md)); do not turn the rule off.
- **SPDX header.** Every `.ts`, `.tsx`, `.js`, `.mjs`, `.cjs` and `.css` file starts with `// SPDX-License-Identifier: AGPL-3.0-or-later` (a `/* ... */` comment in CSS). `pnpm check:headers` fails otherwise.
- **Dependencies.** Adding a runtime dependency needs a reason in the pull request. `pnpm check:licenses` rejects licences that cannot be combined with the AGPL, and `pnpm audit` must stay clean at "high".
- **Secrets and personal data** never go into the repository, logs or test fixtures. `pnpm check:secrets` is a cheap net, not a guarantee.
- **Tests.** A change in behaviour comes with a test. Permission rules are covered by the authorisation matrix (`apps/server/src/authz.matrix.test.ts`); add rows when you add an endpoint. A route that is neither authenticated nor on the public list fails `security.test.ts` on purpose.
- **Files:** LF line endings, 2 spaces, UTF-8 (`.editorconfig`; `pnpm format` fixes it).
- **Commits:** a short imperative subject, optionally prefixed (`feat(voice):`, `fix(web):`, `docs:`, `test:`, `chore:`), and a body that says why. One logical change per commit.

## Documentation conventions

The design lives in `docs/` and is kept current with the code ([docs/00-index.md](docs/00-index.md) lists it). If your change makes a document wrong, change the document in the same pull request.

- Identifiers: requirements `R-xxx`, decisions `D-n` and `ADR-nnn` (docs/03), risks `K-nn`, technical items `T-nn`, wireframe screens `W-nn` and UI design calls `Un` ([docs/design](docs/design/README.md)). Refer to them instead of repeating them.
- Each document ends with an **Open items** section that feeds [docs/18](docs/18-open-questions-and-risks.md). New facts learned while building go into docs/18 under the next section letter, with the date.
- Diagrams are ASCII or Mermaid so that they diff well.
- Write for the person who runs the server, plainly: no marketing language, and no numbers that were not measured or taken from a document.
- User-visible changes get a line in `CHANGELOG.md` under "Unreleased".

## Pull requests

Keep them small and focused. The template has a checklist (sign-off, `pnpm check`, header, docs, changelog). CI runs the same checks plus CodeQL and an image build. The maintainer reviews, and may ask for changes or say no to something that does not fit the scope; that is not a judgement of the work. Dependabot sends weekly grouped updates for npm, the Docker base images and GitHub Actions.

Security problems: **do not** send a pull request or issue first; follow [SECURITY.md](SECURITY.md).
