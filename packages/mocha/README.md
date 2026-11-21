# @useblacksmith/mocha

Runs only the Mocha tests affected since the last run. While your tests run it
records what each spec file depends on; on later runs it skips the spec files
whose dependencies have not changed. On Blacksmith runners the record is kept
in the Actions cache between jobs, so no extra workflow steps are needed.

> Experimental.

## Usage

```sh
npm install --save-dev @useblacksmith/mocha
```

Put `blacksmith-mocha run --` in front of your Mocha arguments:

```sh
npx blacksmith-mocha run -- 'test/**/*.test.js'
```

Or keep the plain `mocha` command and select from `.mocharc.cjs`:

```js
module.exports = require('@useblacksmith/mocha/mocharc')({
	spec: ['test/**/*.test.js'],
})
```

Serial and `--parallel` runs are both supported. Requires Node 22.15 or newer
and Mocha 10 or newer.

## How it works

- **Imports.** Every `require()` and `import` is recorded as an edge between
  two files. A spec file depends on everything reachable from it.
- **Files, processes, workers.** Files read through `node:fs`, and the modules
  and reads of node child processes and worker threads, are recorded for the
  test that caused them. A file a module reads once and keeps is recorded for
  the module, so every spec importing it depends on the file.
- **Per test.** A record is kept for each test. A spec file is skipped only
  when every test in it has passed against the current files, so files run in
  part with `--grep` are handled: tests that have not run yet keep the file
  selected.
- **Changes.** The recorded files are compared by content with what they were
  when the record was made, so compiled output that git ignores (`dist/`)
  works too.

- **Installed packages.** The import graph names the packages a spec file
  loaded, transitive ones included, each with the version in its
  `package.json`. After an install, a spec file reruns when one of its packages
  has another version or is gone. Lockfiles are not compared, and a
  `package.json` change that only touches its dependency fields reruns nothing
  by itself. A new version of a package loaded before the first spec file
  (Mocha, what `.mocharc.*` requires) runs everything.

A `package.json` or `tsconfig*.json` in a directory below the project reruns
the test files that loaded a file under that directory.

Changes to anything else in `package.json`, to `tsconfig.json`, `.mocharc.*`
or the workflow file run everything.

## Commands

| Command | |
| --- | --- |
| `blacksmith-mocha run [--shard <i>/<n>] [--no-commit] -- <mocha arguments>` | Runs Mocha on the affected spec files and updates the record. |
| `blacksmith-mocha affected [--shard <i>/<n>] [--json] -- <mocha arguments>` | Prints the affected spec files and, per file, the tests that need to run. |
| `blacksmith-mocha commit [<run.json> ...]` | Merges recorded runs into the record. |

`--shard <i>/<n>` assigns spec files to shards by a hash of their path, so a
file stays in its shard when other files are added or skipped. With
`.mocharc.cjs`, set `BLACKSMITH_MOCHA_SHARD=<i>/<n>`.

Each shard saves a record of its own to the Actions cache and looks up the
records of all shards, so changing the shard count reruns nothing. A count
above `maxShards` in `blacksmith-mocha.json`, 20 by default, fails: a shard
looks up the records of that many shards.

If you split tests yourself, read `affected --json` to build your own list.
When several jobs each run part of the same spec files, run them with
`--no-commit` and `BLACKSMITH_MOCHA_RUN=<file>`, collect the files, and merge
them in one step with `blacksmith-mocha commit <files>`.

## Dependencies nothing reads

A database or a mock service is not a file a test reads. The plugin records
which `host:port` each test talks to; `blacksmith-mocha.json` maps those to
the files that define what answers there. `dependencies` covers anything else.

```json
{
	"services": {
		"localhost:5432": ["db/migrations/**"],
		"localhost:4010": ["mocks/**"]
	},
	"dependencies": {
		"test/e2e/**": ["docker/**"]
	}
}
```

Globs are relative to the repository root.

## Caveats

- Mocha loads all spec files of a process into one module cache. State a spec
  leaves in memory for a later one is not a file, and is not tracked; a test
  that only passes after another spec file ran can fail when that file is
  skipped.
- Tests are identified by their full title. Two tests with the same title in
  one file share a record.
- A package is known by its directory and version. Not seen: a package
  changed in place at the same version (`patch-package`, a git or `file:`
  dependency) and a package installed outside the repository.
  A copy installed later in front of the one a spec file loaded (inside a
  workspace, as Yarn and npm do for a version that differs from the hoisted
  one, or inside the package that loads it) counts as a change.
  With pnpm, which links each name to one of the versions it keeps side by
  side, a package also counts as changed when a link that led to it now leads
  to another version.
- A test that reads `package.json` through a helper package reruns on any
  change to it, unless the helper reads it while being imported.
