import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";

import type { Decision, Options } from "./core.ts";

/** Overrides where the record and anchor are kept. */
export const ENV_DIR = "BLACKSMITH_JEST_DIR";
/** The directory the processes running tests write what each test file loaded to; made by the config helper. */
export const ENV_RECORD = "BLACKSMITH_JEST_RECORD";
/** The `jest-runtime` the project's Jest runs tests with, which the recording runtime extends. */
export const ENV_RUNTIME = "BLACKSMITH_JEST_RUNTIME";

export interface Shard {
  index: number;
  count: number;
}

export const suffix = (shard: Shard | null): string =>
  shard ? `.${shard.index}of${shard.count}` : "";

/** Under `node_modules`, like other tools' caches: git ignores it and the recorder never records it. */
export function dataDir(cwd: string): string {
  return (
    process.env[ENV_DIR] ??
    path.join(cwd, "node_modules", ".cache", "blacksmith-jest")
  );
}

/** What the sequencer decided, kept for the reporter that follows the run. */
export interface Pending {
  shard: Shard | null;
  /** Every test file Jest was about to run, repository-relative. */
  owned: string[];
  changed: string[];
  selection: Record<string, Decision>;
}

/** Shared by the config helper, the sequencer and the reporter, which Jest loads into its main process one by one. */
export interface State {
  cwd: string;
  repo: string;
  options: Options;
  /** Whether the project's own config lets a run without test files pass. */
  passWithNoTests: boolean;
  coverage: boolean;
  shard: Shard | null;
  pending: Pending | null;
}

const KEY = Symbol.for("blacksmith.jest.state");
const holder = globalThis as { [KEY]?: State };

export function repoOf(cwd: string): string {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return cwd;
  }
}

export function state(): State {
  return (holder[KEY] ??= {
    cwd: process.cwd(),
    repo: repoOf(process.cwd()),
    options: {},
    passWithNoTests: false,
    coverage: false,
    shard: null,
    pending: null,
  });
}

export function log(message: string): void {
  process.stderr.write(`[blacksmith] ${message}\n`);
}

/**
 * Where the package `name` of the project's Jest is: Jest's own packages are
 * dependencies of `jest`, not of the project, so strict installs (pnpm) only
 * reach them through it.
 */
export function resolveFromJest(cwd: string, name: string): string {
  const chains = [
    [name],
    ["jest", "@jest/core", name],
    ["jest", "jest-cli", "@jest/core", name],
    ["jest-cli", "@jest/core", name],
    ["@jest/core", name],
  ];
  for (const chain of chains) {
    try {
      let from = path.join(cwd, "package.json");
      for (const step of chain) {
        from = createRequire(from).resolve(step);
      }
      return from;
    } catch {}
  }
  throw new Error(
    `@useblacksmith/jest: cannot find ${name} from ${cwd}; is jest installed?`,
  );
}
