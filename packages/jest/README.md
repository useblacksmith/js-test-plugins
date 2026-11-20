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

- **Installed packages.** The record names the packages a test file loaded,
  transitive ones included, each with the version in its `package.json`. After
  an install, a test file reruns when one of its packages has another version
  or is gone. Lockfiles are not compared, and a `package.json` change that only
  touches its dependency fields reruns nothing by itself. A new version of a
  package Jest's own process or a transformer loaded runs everything.

Changes to anything else in `package.json`, to `tsconfig.json`, `jest.config.*`,
`babel.config.*`, `.babelrc`, `.swcrc`, the workflow file, or anything the
config file imports or `globalSetup` loads or reads run everything. So does a run with coverage, and watch
mode is left to Jest.

## Options

The second argument of `withBlacksmith`:

| Option | |
| --- | --- |
| `dependencies` | Test file glob → globs of files those test files depend on that nothing reads, e.g. `{ 'test/db/**': 'migrations/**' }`. Paths are relative to the repository root. |

## Narrowing

A change to a file does not rerun every test file that loaded it. The plugin records, for each test file, which top-level functions it entered in every module it loaded, and looks at what a change actually touched:

| What changed in the file | Test files that rerun |
| --- | --- |
| The body of a top-level function (`function f() {}`, `const f = () => {}`) | Those that called the function |
| Another top-level declaration (a constant, a class, an enum), or a function's parameter list | Those that loaded a module importing it by name, through re-exports too. A namespace import, a `require`, a dynamic `import()` or a `jest.mock` of the module counts as importing every name |
| Types, comments, or a new declaration nothing uses yet | None. A type annotation inside a class that has a decorator is not a type here: emitted decorator metadata makes it a value, so it counts as a change to the class |
| A new import | Those that had not loaded the imported module |
| Any other top-level statement, an `export *`, or declarations that changed places | All that loaded the file |

A value built from a changed one counts as changed, and a function that mentions a changed value reruns the test files that called it. A change to a file the plugin cannot take apart reruns every test file that loaded it: CommonJS modules, files using `eval`, files that take an inline snapshot or mention `Function`, and anything that is not JavaScript or TypeScript. So does any change in a run with coverage, or of more than one project.

To record function entries the plugin adds one call at the start of each top-level function before the project's transformer sees the module. Line numbers stay as they are; a column on the first line of a function moves right by the length of the added call (about 60 characters). The call does nothing outside its module, so a function turned into text with `toString()` still runs wherever that text is evaluated. Jest caches the transformed module as usual, so the cost is paid once per changed file. The record is kept beside the dependency record and travels with it.

What narrowing cannot see: a test whose result depends on a function's source text or `length` rather than on calling it, and a module whose top-level value is there only for the side effects of evaluating it while something else exports or mentions that value.

## Limits

- The plugin sets `runtime`, `testSequencer` and `passWithNoTests`, and adds a
  reporter. A config that sets `runtime` or `testSequencer` itself is refused,
  and `--reporters` on the command line replaces the plugin's reporter, which
  stops the record from updating.
- In `projects`, inline project objects are wrapped. A project given as a path
  needs `runtime: require.resolve('@useblacksmith/jest/runtime')` in its own
  config.
- A package is known by its directory and version. Not seen: a package
  changed in place at the same version (`patch-package`, a git or `file:`
  dependency), a package installed outside the repository, and a newly
  installed copy that shadows the one a test loaded before.
  With pnpm, which links each name to one of the versions it keeps side by
  side, a package also counts as changed when a link that led to it now leads
  to another version.
- A test that reads `package.json` through a helper package reruns on any
  change to it, unless the helper reads it while being imported.
- What a test reaches over the network (a database, a mock server) is not
  recorded; map it with `dependencies`.
- A file that a module of Jest's own process (a custom transformer, a custom
  environment) reads once and keeps is recorded for the first test file of
  that process only. Babel, SWC and TypeScript config files are exempt: a
  change to one, in any directory, runs everything.
- A child process started with an `env` that drops `NODE_OPTIONS` is not
  recorded.
- A Jest that a test starts with the same config runs every test file it
  matches and keeps no record of its own: what it loads and reads is recorded
  for the test file that started it.
