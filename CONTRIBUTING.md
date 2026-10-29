# Contributing

Thanks for helping. A few rules keep this tool safe for agents:

- **Never touch a real system from tests.** Tests drive the built CLI against the fake `argo` and `kubectl` in `test/fixtures/fake-cli.mjs`, with a hermetic `PATH`, `HOME` and `KUBECONFIG` (see `test/helpers.ts`). Do not add tests that need a cluster, an Argo Server or credentials.
- **Every dependency call goes through `src/seam.ts`** and must be registered in `src/registry.ts`. New writes follow [ROADMAP.md](ROADMAP.md#adding-writes).
- **Follow the [AXI principles](https://github.com/kunchenguid/axi):** TOON on stdout, minimal default schemas, truncation with sizes, definitive empty states, structured errors with exit codes 0/1/2, unknown flags rejected before any call, and a few contextual `help` lines.
- **Use argo's own flag names.** Do not invent a parallel vocabulary.

Before opening a pull request:

```sh
pnpm run format:check && pnpm run lint && pnpm run build && pnpm run check:skill && pnpm test
```

If you change `src/skill.ts` or the CLI description, run `pnpm run build:skill` and commit the regenerated `skills/argo-workflows-axi/SKILL.md`.
