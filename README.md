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

Releases are cut per package: `pnpm run release <vitest|mocha|jest> <major|minor|patch>`.
