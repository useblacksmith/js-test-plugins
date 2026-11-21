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

With the plugin, vitest only runs tests impacted by changes since the last successful run. `--shard=i/n` works as usual: Vitest assigns the test files to shards, or your `test.sequence.sequencer` does.

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
| `maxShards` | `20` | The largest `--shard` count accepted; a run split further fails. Each shard looks up the records of all shards up to this number, so changing the count reruns nothing. |
| `dependencies` | `{}` | Dependencies the tracking cannot see, as globs of test files mapped to the glob(s) of the files they depend on, relative to the config root (`../shared/**` reaches outside a package): `{ 'tests/**/*.spec.ts': 'fixtures/**' }`. A change to a matching file reruns the mapped tests, git-ignored files (generated code, build output) included; a glob that matches no file in the repository warns. |

## Narrowing

A change to a file does not rerun every test file that loaded it. The plugin records, for each test file, which top-level functions it entered in every module it loaded, and looks at what a change actually touched:

| What changed in the file | Test files that rerun |
| --- | --- |
| The body of a top-level function (`function f() {}`, `const f = () => {}`) | Those that called the function |
| Another top-level declaration (a constant, a class, an enum), or a function's parameter list | Those that loaded a module importing it by name, through re-exports too. A namespace import, a dynamic `import()` or a mock of the module counts as importing every name |
| One key of an object literal held in a `const` (`const FLAGS = { A: 'a', B: 'b' }`): changed, added or removed | Those that called a function reading that key as `FLAGS.A`, or using the object in any other way (`FLAGS[name]`, `Object.values(FLAGS)`, passing it on), in the file or in a module importing it by name. Those that loaded a module doing so outside a function, too. Any other object counts as one declaration: one with a spread, a computed key, an accessor, a method or a `function` value |
| Types, comments, or a new declaration nothing uses yet | None. A type annotation inside a class that has a decorator is not a type here: emitted decorator metadata makes it a value, so it counts as a change to the class |
| A new import | Those that had not loaded the imported module |
| Any other top-level statement, an `export *`, or declarations that changed places | All that loaded the file |

A value built from a changed one counts as changed, and a function that mentions a changed value reruns the test files that called it. Files the plugin cannot take apart (CommonJS, files using `eval`, anything that is not JavaScript or TypeScript) and test files run in browser mode rerun for any change to a file they loaded, as does a run with `sequence.hooks` set to anything but `'stack'`.

To record function entries the plugin adds one call at the start of each top-level function while Vite transforms the module; source maps account for it. The call names nothing of the module's and does nothing where the plugin is not recording, so a function turned into text with `toString()` still runs wherever that text is evaluated. The record is kept beside the dependency record and travels with it.

What narrowing cannot see: a test whose result depends on a function's source text or `length` rather than on calling it.

A changed top-level value that calls something as it is evaluated (a call, `new`, a tagged template, an assignment, a class's static initializer) reruns every test file that loaded the module, since the call may have done more than make the value. A value of literals, objects, arrays, functions and other names reruns only the test files that loaded a module importing it. A value that is unchanged itself and is built from a changed one counts as the second kind.

## Caveats

- **Only dependencies the test reaches through node are tracked.** `import`, `require`, and `fs` are tracked automatically, in the test process, in every node process it starts through `child_process` and in every `worker_threads` worker (each gets a preloaded recorder; their own children inherit it). A child or worker records what it has loaded as it goes, so one the test kills or terminates still counts, up to the end of its test file. For any child, the command and the arguments that name files are recorded too. A child started with `env: { ..., NODE_OPTIONS: undefined }`, or a worker with `env: SHARE_ENV`, gets no recorder, only its command line. A file the test, or a node child it started, wrote before reading it is the test's own output and is not tracked (a git-ignored directory the test copies into and reads back, say); what it was produced from is. A file a non-node program wrote and the test then read, or a module the test wrote and then imported, is still tracked, and reruns the test on every fresh checkout where it is absent. Files read by `globalSetup`, by non-node programs, or build outputs a child runs in place of their sources are not; declare them with the `dependencies` option. In browser mode, vitest itself reports nothing, so the plugin records the modules the browser loaded from the project's Vite module graph instead; files a browser test fetches at run time are not tracked.
- **Installed packages are compared by version.** The plugin records the packages each test file loaded, transitive ones included, with the version in their `package.json`. After an install, a test file reruns when one of its packages has another version or is gone; a lockfile change alone reruns nothing, and neither does a `package.json` change that only touches its dependency fields. With pnpm, which links each name to one of the versions it keeps side by side, a package also counts as changed when a link that led to it now leads to another version. With Yarn and npm workspaces, which hoist one copy of a package and install another version inside the workspace that asks for it, a copy installed later in front of the one a test file loaded counts as a change too. A new version of Vitest, of a package a config or `globalSetup` file imports, or of anything those declare as a dependency runs every test. Not seen: a package changed in place at the same version (`patch-package`, a git or `file:` dependency) and a package installed outside the repository. Browser-mode test files have no package list and rerun on any lockfile change, as does every test file on a Node without `module.registerHooks` (before 22.15), which cannot see what an ES module package loads.
- **Shards.** Vitest's sequencer, or a custom `test.sequence.sequencer`, assigns test files to shards; the plugin asks it to split the full test list, whatever the change selects, so every test file belongs to exactly one shard. A test file of several projects runs in all of them on one shard. A test file that moves to another shard does not rerun there with the Actions cache, since each shard looks up the records of all shards.
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
