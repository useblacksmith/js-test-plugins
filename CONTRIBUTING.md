# Contributing

Bug reports and pull requests are welcome. For a bug, open an issue with the
package version, the test runner version, and the smallest project that shows
it. Report a security problem as [SECURITY.md](SECURITY.md) describes, not in
an issue.

## Submitting a pull request

1. Fork and clone the repository.
1. Install the dependencies: `corepack enable && pnpm install`.
1. Make your change and add a test for it. A case every plugin must handle goes
   in `packages/shared/test/scenarios.ts`, which runs through all three.
1. Run `pnpm run check:types`, `pnpm run build` and `pnpm test`.
1. Push to your fork and open a pull request that says what changes for
   someone using the plugin.

The [README](README.md#development) describes the workspace layout, the
end-to-end scenarios and how releases are cut.

Workflows on a pull request from a fork run once a maintainer approves them.

## Keep it public-safe

This repository is public. Issues, pull requests, commits, tests and fixtures
must not name a private repository or organization, or include logs, paths or
identifiers copied from one. Reduce a problem to a synthetic project first.
[AGENTS.md](AGENTS.md) has the full rules, which apply to people as well as to
coding agents.
