# Contributing · dsh-cross-workspace

Thanks for helping improve the cross-workspace courier. This project is a
small, dependency-free Cordis bundle for DeepSeek Harness; please keep changes
focused.

## Before you start

- Read [`AGENTS.md`](AGENTS.md), [`docs/API.md`](docs/API.md) and
  [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).
- For security issues, **do not open a public issue**; follow [`SECURITY.md`](SECURITY.md).
- By participating you agree to the [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md).

## Development

Requirements: Node.js `>=22.13.0`, a DSH Desktop checkout with Plugin Manager,
and no npm runtime dependencies.

```text
git clone https://github.com/dream-office/dsh-cross-workspace.git
cd dsh-cross-workspace
node --test test/store.test.mjs test/resolve.test.mjs test/format.test.mjs test/route.test.mjs
node --check index.js
node --check client.js
```

The explicit test-file list is intentional: some Node versions do not expand a
bare `test/` directory the same way. The package also provides `npm test`.

To try the plugin locally, install the checkout with
`plugin_manager install_bundle target="<absolute path>"`; Host changes need a
plugin reload, Client changes need a page refresh.

## Change rules

- Keep the Host/Client boundary: persistence in `lib/store.js`, rendering in
  `client.js`, no business rules in the Client.
- Do not add build steps or runtime dependencies without prior discussion.
- Preserve the privacy/visibility invariants in `AGENTS.md` §3.
- Add a regression test for every bug. Run the suite twice before opening a PR.
- Do not commit `reports/`, `.tmp/`, local store data, or personal paths.

## Pull requests

1. One focused change per PR.
2. Include the motivation, user-visible behavior, and test evidence.
3. Update `README.md` / `docs/API.md` / `docs/ARCHITECTURE.md` when the contract changes.
4. Use the PR template; CI must pass.

## License

Contributions are accepted under the project's **MIT License**. By submitting a
pull request you confirm that you have the right to contribute the code and
that it may be distributed under the same license.
