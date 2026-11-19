import picomatch from "picomatch";

/**
 * The dependency record and the rules that read it. Jest gives every test
 * file a module registry of its own, so the record is one dependency list per
 * test file, with the state of each of its tests beside it.
 */
export const RECORDS_VERSION = 1;

export type TestState = "passed" | "failed" | "skipped";

export interface FileRecord {
  /** Modules the test file loaded and files it read, itself aside. */
  deps: string[];
  /** Full name of every test in the file → how it ended the last time it ran. */
  tests: Record<string, TestState>;
  /** The file failed outside any test: a syntax error, a failed `beforeAll`. */
  failed?: boolean;
}

/** What one Jest run recorded. Paths are repository-relative with `/`. */
export interface RunRecord {
  at: number;
  /** Files every test file depends on: what `globalSetup` and Jest's own process loaded. */
  global: string[];
  files: Record<string, FileRecord>;
  /** Tests named `pending` in a `-t` run did not run; `files` holds only the ones that did. */
  partial: boolean;
}

export interface Records {
  version: number;
  at: number;
  global: string[];
  files: Record<string, FileRecord>;
}

export interface Options {
  /** Test file glob → globs of files those test files depend on that nothing reads. */
  dependencies?: Record<string, string | string[]>;
}

export type Decision = { run: false } | { run: true; reason: string };

export function emptyRecords(): Records {
  return { version: RECORDS_VERSION, at: 0, global: [], files: {} };
}

const list = (value: string | string[] | undefined): string[] =>
  value === undefined ? [] : [value].flat();

/** Every glob the `dependencies` option names. */
export function ruleGlobs(options: Options): string[] {
  return Object.values(options.dependencies ?? {}).flatMap(list);
}

/** The first of `changed` the test file `spec` depends on. */
function changedDependency(
  records: Records,
  spec: string,
  changed: string[],
  options: Options,
): string | undefined {
  const deps = new Set([
    spec,
    ...records.global,
    ...(records.files[spec]?.deps ?? []),
  ]);
  const globs: string[] = [];
  for (const [tests, files] of Object.entries(options.dependencies ?? {})) {
    if (picomatch.isMatch(spec, tests, { dot: true }))
      globs.push(...list(files));
  }
  const matches =
    globs.length > 0 ? picomatch(globs, { dot: true }) : () => false;
  return changed.find((file) => deps.has(file) || matches(file));
}

/**
 * Decides, per test file, whether it runs. A file is skipped only when it has
 * a record, nothing the record names changed, and every test in it ended
 * other than failed the last time it ran.
 */
export function select(
  records: Records,
  specs: string[],
  changed: string[],
  options: Options = {},
): Record<string, Decision> {
  const result: Record<string, Decision> = {};
  for (const spec of specs) {
    const entry = records.files[spec];
    if (!entry) {
      result[spec] = { run: true, reason: "no record" };
      continue;
    }
    const hit = changedDependency(records, spec, changed, options);
    if (hit !== undefined)
      result[spec] = { run: true, reason: `changed: ${hit}` };
    else if (entry.failed || Object.values(entry.tests).includes("failed"))
      result[spec] = { run: true, reason: "failed last time" };
    else result[spec] = { run: false };
  }
  return result;
}

const union = (a: string[] | undefined, b: string[]): string[] =>
  [...new Set([...(a ?? []), ...b])].sort();

/**
 * Merges what a run recorded into the stored record. `changed` is what the
 * anchor diff reported before the run started.
 *
 * 1. A stored file record that `changed` invalidates is dropped first: if the
 *    run then left the file out (a path filter, `--bail`), it has no record
 *    and runs next time.
 * 2. A file that ran in full replaces its record.
 * 3. A file that ran in part (`-t`) is marked failed unless a record survived
 *    step 1: the tests left out never ran against the current files. With a
 *    surviving record, the tests that ran replace their state and the
 *    dependencies are unioned.
 */
export function mergeRecords(
  stored: Records | null,
  run: RunRecord,
  changed: string[],
  options: Options = {},
): Records {
  const out =
    stored?.version === RECORDS_VERSION
      ? structuredClone(stored)
      : emptyRecords();
  const verdict = select(out, Object.keys(out.files), changed, options);
  for (const [spec, decision] of Object.entries(verdict)) {
    if (decision.run && decision.reason.startsWith("changed")) {
      delete out.files[spec];
    }
  }
  if (Object.keys(run.files).length > 0) out.global = [...run.global].sort();
  for (const [spec, entry] of Object.entries(run.files)) {
    const previous = out.files[spec];
    if (!run.partial) out.files[spec] = entry;
    else if (!previous) out.files[spec] = { ...entry, failed: true };
    else {
      out.files[spec] = {
        deps: union(previous.deps, entry.deps),
        tests: { ...previous.tests, ...entry.tests },
        ...(entry.failed || previous.failed ? { failed: true } : {}),
      };
    }
  }
  out.at = Math.max(out.at, run.at);
  return out;
}

/** Every repository path the record names: what the anchor has to cover. */
export function recordedPaths(records: Records): Set<string> {
  const paths = new Set<string>(records.global);
  for (const [spec, entry] of Object.entries(records.files)) {
    paths.add(spec);
    for (const file of entry.deps) paths.add(file);
  }
  return paths;
}
