# Contributing

Thanks for helping. A few rules keep this tool safe for agents:

- **Never touch a real system from tests.** Tests drive the built CLI against the fake `argo` and `kubectl` in `test/fixtures/fake-cli.mjs`, with a hermetic `PATH`, `HOME` and `KUBECONFIG` (see `test/helpers.ts`). Do not add tests that need a cluster, an Argo Server or credentials.
- **Every dependency call goes through `src/seam.ts`** and must be registered in `src/registry.ts`. New writes follow [ROADMAP.md](ROADMAP.md#adding-writes).
- **Follow the [AXI principles](https://github.com/kunchenguid/axi):** TOON on stdout, minimal default schemas, truncation with sizes, definitive empty states, structured errors with exit codes 0/1/2, unknown flags rejected before any call, and a few contextual `help` lines.
- **Use argo's own flag names.** Do not invent a parallel vocabulary.

Every pull request must use a [conventional commit title](.github/workflows/pr-title.yml) and be raised through no-mistakes and pass its required PR-body check. Reviewers classify the change against the existing contract:

- **restore**: restores documented or established behavior; may merge after review and green checks.
- **opt-in**: adds behavior users explicitly enable without changing existing defaults; may merge after review and green checks.
- **new-default**: changes behavior users get without opting in; requires maintainer approval before it may merge.
- **cannot-tell**: available evidence does not establish the contract effect; it cannot receive merge approval until clarified.

Before opening a pull request:

```sh
pnpm run format:check && pnpm run lint && pnpm run build && pnpm run check:skill && pnpm test
```

If you change `src/skill.ts` or the CLI description, run `pnpm run build:skill` and commit the regenerated `skills/argo-workflows-axi/SKILL.md`.

## Releases

Use conventional commit messages (`feat:`, `fix:`, `docs:`, ...). release-please turns them into a release PR on `main`; merging that PR tags the release and publishes to npm from `.github/workflows/release-please.yml` through npm trusted publishing with provenance (no stored npm token).

- Do not hand-edit `CHANGELOG.md` or `.release-please-manifest.json`, and do not bump `package.json`'s `version` by hand. release-please owns them, and `guard-generated-files.yml` fails PRs that edit the first two.
- Every `pull_request` workflow `paths-ignore`s the release-please output set (`.release-please-manifest.json`, `CHANGELOG.md`, `package.json`) so a release PR creates zero runs. `test/release-ci-exclusions.test.ts` derives that set from `release-please-config.json` and fails if a workflow drifts; update the ignore lists when adding `extra-files` or changing `release-type`.
