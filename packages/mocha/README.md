# @useblacksmith/mocha

Runs only the Mocha tests affected since the last run. While your tests run it
records what each spec file depends on; on later runs it skips the spec files
whose dependencies have not changed. On Blacksmith runners the record is kept
in the Actions cache between jobs, so no extra workflow steps are needed.

> Experimental. Start with `--shadow`, which runs everything and only reports
> what would have been selected.

## Usage

```sh
npm install --save-dev @useblacksmith/mocha
```

Put `blacksmith-mocha run --` in front of your Mocha arguments:

```sh
npx blacksmith-mocha run -- 'test/**/*.test.js'
npx blacksmith-mocha run --shadow -- 'test/**/*.test.js'
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

Changes to a lockfile, `package.json`, `tsconfig.json`, `.mocharc.*` or the
workflow file run everything.

## Commands

| Command | |
| --- | --- |
| `blacksmith-mocha run [--shard <i>/<n>] [--shadow] [--no-commit] -- <mocha arguments>` | Runs Mocha on the affected spec files and updates the record. |
| `blacksmith-mocha affected [--shard <i>/<n>] [--json] -- <mocha arguments>` | Prints the affected spec files and, per file, the tests that need to run. |
| `blacksmith-mocha commit [<run.json> ...]` | Merges recorded runs into the record. |

`--shard <i>/<n>` assigns spec files to shards by a hash of their path, so a
file stays in its shard when other files are added or skipped. With
`.mocharc.cjs`, set `BLACKSMITH_MOCHA_SHARD=<i>/<n>`.

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
- Installed packages are not tracked file by file; a lockfile change runs
  everything.
