# @useblacksmith/vitest

Speed up vitest execution by only running tests impacted by a change, with automatic caching when run on Blacksmith.

> **Alpha.** The plugin is under active development; options and the cache format may change between releases.

## Usage

```sh
npm install --save-dev @useblacksmith/vitest
```

```ts
// vitest.config.ts
import { defineConfig } from 'vitest/config'
import blacksmith from '@useblacksmith/vitest'

export default defineConfig({
	plugins: [blacksmith()],
})
```

With the plugin, vitest only runs tests impacted by changes since the last successful run. `--shard=i/n` works as usual; the plugin assigns files to shards itself so each shard's cache stays stable.

Requires Vitest 4.1.1 or later 4.x, or 5.1 or newer. From 5.1 the plugin selects from Vitest's own record of what each test file loaded; on 4.x, which keeps none, it records that itself.

### Vite+

Vite+ runs Vitest under `vp test`, so the plugin is loaded from the shared `vite.config.ts`:

```ts
// vite.config.ts
import 'vite-plus/test/config'
import { defineConfig } from 'vite-plus'
import blacksmith from '@useblacksmith/vitest'

export default defineConfig({
	plugins: [blacksmith()],
})
```

`vp test run` then runs the affected selection, including with `--shard`, test file filters, and `--config <path> --dir .` from a workspace package. Requires `vite-plus` 1.5.0 or newer, the first release that ships Vitest 5.1.

## Running locally

The same selection applies locally: a run reruns what changed on disk since the last successful run, committed or not. To run every test locally and select only in CI:

```ts
plugins: [blacksmith({ runAllTests: !process.env.CI })],
```

## How it works

The plugin uses Vitest's dependency tracking: each run records which modules and files every test depends on, and the next run compares the checkout against that record to calculate the impacted test set; a test the last successful run did not cover always runs. The record is stored in the Actions cache when run on Blacksmith, so runs on different runners pick up where the last successful run left off.

Each run ends with a line saying how much it skipped: `[blacksmith] filtered out 512 of 540 test files as unaffected, ran 28`.

## Options

| option | default | effect |
|---|---|---|
| `runAllTests` | `false` | Run every test instead of the affected selection. |
| `dependencies` | `{}` | Dependencies the tracking cannot see, as globs of test files mapped to the glob(s) of the files they depend on, relative to the config root (`../shared/**` reaches outside a package): `{ 'tests/**/*.spec.ts': 'fixtures/**' }`. A change to a matching file reruns the mapped tests, git-ignored files (generated code, build output) included; a glob that matches no file in the repository warns. |
| `narrow` | `false` | Experimental. Look inside a changed file instead of rerunning every test file that loaded it; see [Narrowing](#narrowing). |

## Narrowing

By default a change to a file reruns every test file that loaded it. With `narrow: true` the plugin also records, for each test file, which top-level functions it entered in every module it loaded, and looks at what a change actually touched:

| What changed in the file | Test files that rerun |
| --- | --- |
| The body of a top-level function (`function f() {}`, `const f = () => {}`) | Those that called the function |
| Another top-level declaration (a constant, a class, an enum), or a function's parameter list | Those that loaded a module importing it by name, through re-exports too. A namespace import, a dynamic `import()` or a mock of the module counts as importing every name |
| Types, comments, or a new declaration nothing uses yet | None |
| A new import | Those that had not loaded the imported module |
| Any other top-level statement, an `export *`, or declarations that changed places | All that loaded the file, as without the option |

A value built from a changed one counts as changed, and a function that mentions a changed value reruns the test files that called it. Files the plugin cannot take apart (CommonJS, files using `eval`, anything that is not JavaScript or TypeScript) and test files run in browser mode keep the default behaviour.

To record function entries the plugin adds one call at the start of each top-level function while Vite transforms the module; source maps account for it. The record is kept beside the dependency record and travels with it.

What narrowing cannot see: a test whose result depends on a function's source text or `length` rather than on calling it, and a module whose top-level value is there only for the side effects of evaluating it while something else exports or mentions that value.

## Caveats

- **Only dependencies the test reaches through node are tracked.** `import`, `require`, and `fs` are tracked automatically, in the test process, in every node process it starts through `child_process` and in every `worker_threads` worker (each gets a preloaded recorder; their own children inherit it). A child or worker records what it has loaded as it goes, so one the test kills or terminates still counts, up to the end of its test file. For any child, the command and the arguments that name files are recorded too. A child started with `env: { ..., NODE_OPTIONS: undefined }`, or a worker with `env: SHARE_ENV`, gets no recorder, only its command line. A file the test, or a node child it started, wrote before reading it is the test's own output and is not tracked (a git-ignored directory the test copies into and reads back, say); what it was produced from is. A file a non-node program wrote and the test then read, or a module the test wrote and then imported, is still tracked, and reruns the test on every fresh checkout where it is absent. Files read by `globalSetup`, by non-node programs, or build outputs a child runs in place of their sources are not; declare them with the `dependencies` option. In browser mode, vitest itself reports nothing, so the plugin records the modules the browser loaded from the project's Vite module graph instead; files a browser test fetches at run time are not tracked.
- **Installed packages are compared by version.** The plugin records the packages each test file loaded, transitive ones included, with the version in their `package.json`. After an install, a test file reruns when one of its packages has another version or is gone; a lockfile change alone reruns nothing, and neither does a `package.json` change that only touches its dependency fields. With pnpm, which links each name to one of the versions it keeps side by side, a package also counts as changed when a link that led to it now leads to another version. A new version of Vitest, of a package a config or `globalSetup` file imports, or of anything those declare as a dependency runs every test. Not seen: a package changed in place at the same version (`patch-package`, a git or `file:` dependency) and a package installed outside the repository. Browser-mode test files have no package list and rerun on any lockfile change, as does every test file on a Node without `module.registerHooks` (before 22.15), which cannot see what an ES module package loads.
- **Shards must be stable for maximal efficacy.** The plugin assigns test files to shards by a hash of their path, so a file stays in its shard as others are added or removed. A custom `test.sequence.sequencer` is honoured, but every test that moves to another shard reruns there.
- **Each workflow job keeps its own record.** A job only skips tests that an earlier run of the same job in the same workflow file passed, since another job may run them under a different `env` or setup. The first run of a new or renamed job runs everything.
- **A run with coverage runs every test.** With `--changed`, Vitest measures coverage for the changed files alone, so thresholds would pass without covering anything. The plugin logs a warning and selects nothing. A run that fails only its coverage thresholds vouches for no test.

## Development

From the repository root (a pnpm workspace):

```sh
corepack enable
pnpm install
pnpm run check:types
pnpm run build         # dist/ (not committed; built on publish)
pnpm test              # runs the fixtures under test/ with a fake backend
```
