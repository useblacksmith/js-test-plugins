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

A pnpm workspace. `packages/shared` holds the code the plugins share (file-read
recording, the git anchor, the cache client); it is not published, each
plugin compiles it into its own `dist/`.

```sh
corepack enable
pnpm install
pnpm run check:types
pnpm run build
pnpm test
```

### End-to-end scenarios

`packages/shared/test/scenarios.ts` lists the cases every plugin must pass: a
small sample project, a real run of the test runner, a change (a source file,
`package.json`, the lockfile, the workflow file, a new or failing test), and
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

Releases are cut per package: `pnpm run release <vitest|mocha|jest> <major|minor|patch>`.
