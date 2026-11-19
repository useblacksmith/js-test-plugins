# @useblacksmith/jest

Runs only the Jest test files affected since the last run. While your tests
run it records what each test file depends on; on later runs it skips the test
files whose dependencies have not changed. On Blacksmith runners the record is
kept in the Actions cache between jobs, so no extra workflow steps are needed.

> Experimental.

## Usage

```sh
npm install --save-dev @useblacksmith/jest
```

Wrap your Jest config:

```js
// jest.config.js
const { withBlacksmith } = require('@useblacksmith/jest')

module.exports = withBlacksmith({
	testEnvironment: 'node',
})
```

Then run `jest` as before. Worker processes, `--runInBand`, `--workerThreads`
and `--shard` are supported. Requires Node 22.15 or newer and Jest 29 or newer.

## How it works

- **Modules.** Jest gives every test file a module registry of its own. The
  plugin sets the config's `runtime` to a subclass of Jest's that notes every
  file Jest loads as a module of the test file, CommonJS or ESM.
- **Files and processes.** Files the test file reads through `node:fs`, and
  the modules and reads of the node processes it starts, are recorded too.
- **Selection.** The config's `testSequencer` drops the test files nothing
  changed for. A test file runs when it has no record, when a file it depends
  on changed, or when one of its tests failed the last time.
- **Changes.** The recorded files are compared by content with what they were
  when the record was made, so files git ignores (`dist/`) work too.
- **`-t`.** A run with `--testNamePattern` runs part of a test file. After a
  change the file stays selected until a run without the pattern passes.
- **Shards.** `--shard` assigns test files by a hash of their path, so a new
  test file moves no other file to another shard. Each shard keeps a record of
  its own.

Changes to a lockfile, `package.json`, `tsconfig.json`, `jest.config.*`,
`babel.config.*`, `.babelrc`, `.swcrc`, the workflow file, or anything the
config file imports or `globalSetup` loads or reads run everything. So does a run with coverage, and watch
mode is left to Jest.

## Options

The second argument of `withBlacksmith`:

| Option | |
| --- | --- |
| `dependencies` | Test file glob → globs of files those test files depend on that nothing reads, e.g. `{ 'test/db/**': 'migrations/**' }`. Paths are relative to the repository root. |

## Limits

- The plugin sets `runtime`, `testSequencer` and `passWithNoTests`, and adds a
  reporter. A config that sets `runtime` or `testSequencer` itself is refused,
  and `--reporters` on the command line replaces the plugin's reporter, which
  stops the record from updating.
- In `projects`, inline project objects are wrapped. A project given as a path
  needs `runtime: require.resolve('@useblacksmith/jest/runtime')` in its own
  config.
- What a test reaches over the network (a database, a mock server) is not
  recorded; map it with `dependencies`.
- A file that a module of Jest's own process (a custom transformer, a custom
  environment) reads once and keeps is recorded for the first test file of
  that process only. Babel, SWC and TypeScript config files are exempt: a
  change to one, in any directory, runs everything.
- A child process started with an `env` that drops `NODE_OPTIONS` is not
  recorded.
