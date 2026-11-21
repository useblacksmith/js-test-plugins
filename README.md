# Blacksmith test plugins

Plugins that run only the tests a change affects. Each records what every
test file depends on while it runs, and on later runs skips the files whose
dependencies have not changed. On Blacksmith runners the record is kept in the
Actions cache between jobs.

| Package | Test runner |
| --- | --- |
| [`@useblacksmith/vitest`](packages/vitest) | Vitest |
| [`@useblacksmith/mocha`](packages/mocha) | Mocha |
| [`@useblacksmith/jest`](packages/jest) | Jest |

## Development

A pnpm workspace. `packages/core` is the test selection itself, written
without a test runner in mind; it is not published, each plugin compiles it
into its own `dist/`. It owns:

| Module | What it decides |
| --- | --- |
| `record.ts` | The record of a run: per test file, and per test where the runner can tell, what was loaded, what passed, and how it is stored |
| `select.ts` | Which test files and tests a set of changed files reaches, and how a run's record merges into the stored one |
| `anchor.ts` | Which files are compared between runs (recorded files, manifests, lockfiles, the workflow file, `dependencies` globs) and what changed |
| `store.ts` | The record on disk, its cache key, and restoring and saving it through the Actions cache, one entry per shard |
| `engine.ts` | `Session.plan(testFiles)` and `Session.commit(runRecords)`, the two calls a plugin makes |
| `unitstore.ts`, `narrow.ts`, `units.ts` | Narrowing a changed file to the tests that entered the functions that changed |
| `fs-recorder.ts`, `git.ts`, `packages.ts`, `actions-cache.ts`, `shard.ts` | File-read recording, git trees, installed packages, the cache client, shard assignment |

A plugin is the adapter between its runner and those two calls: it lists the
runner's test files, turns what the runner loaded into a run record, and
applies the decision the way the runner allows (Jest's sequencer, Mocha's
`--ignore` list, Vitest's changed-files provider). Vitest 5.1 keeps the
dependency record itself and Vitest 4.x leaves it to the plugin; both become
the same run record. A selection rule, a record field or a cache behaviour
belongs in `packages/core`, so that every plugin gets it.

```sh
corepack enable
pnpm install
pnpm run check:types
pnpm run build
pnpm test
```

### End-to-end scenarios

`packages/core/test/scenarios.ts` lists the cases every plugin must pass: a
small sample project, a real run of the test runner, a change (a source file,
`package.json`, a new version of an installed package, the workflow file, a new
or failing test), and
which test files the next run executes. Each package's
`test/scenarios.test.ts` runs the list with its own runner, once with the
record on disk and once with the record travelling only through a cache. To
cover a new case in all three plugins, add it to that list.

| Run | Plugin | Cache |
| --- | --- | --- |
| `pnpm test` (CI workflow) | this checkout's source | a fake Actions cache in the test process |
| E2E workflow | the packed tarball, installed with npm | the job's real Actions cache |

To run the packed plugin locally against the fake cache:

```sh
cd packages/jest
pnpm pack --pack-destination /tmp/tarball
BLACKSMITH_E2E_TARBALL=/tmp/tarball/useblacksmith-jest-0.1.0.tgz pnpm run test:e2e
```

### Releases

Releases are cut per package from `main` with `pnpm run release <vitest|mocha|jest> <action>`.
The script sets the version, pushes the commit and the `<package>-v<version>`
tag, and the Release workflow stages that version on npm.

| Current version | Command | New version | npm dist-tag |
| --- | --- | --- | --- |
| `1.2.3` | `patch`, `minor` or `major` | `1.2.4`, `1.3.0` or `2.0.0` | `latest` |
| `1.2.3` | `patch`, `minor` or `major` with `--rc` | `1.2.4-rc1`, `1.3.0-rc1` or `2.0.0-rc1` | `rc` |
| `1.3.0-rc1` | `rc` | `1.3.0-rc2` | `rc` |
| `1.3.0-rc1` | `promote` | `1.3.0` | `latest` |

A release candidate is not what `npm install @useblacksmith/<package>` or a
version range resolves; install one with `@useblacksmith/<package>@rc` or its
exact version. From a release candidate, `patch`, `minor` and `major` are
refused; from a production version, `rc` and `promote` are.
