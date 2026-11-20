# Agent instructions

This repository is public. Everything written here is published: committed
code, tests, fixtures and documentation; branch names and commit messages; PR
titles, bodies, comments and reviews; issues; and screenshots or recordings
with their captions and filenames. These rules apply to contributors and to
coding agents. Publishing first and scrubbing later is unacceptable.

## No customer information

Never copy private customer data from support threads, investigations, logs or
connected sources here. Remove customer names; organization, repository,
domain, tenant and account identifiers; identifying keys, paths and log
excerpts; and private customer job, support or incident links.

Describe a customer-reported problem by its behaviour ("a test that reads a
generated file reran on every run"), and reproduce it with a synthetic project
under a package's `test/` fixtures.

## No internal identifiers

Describe Blacksmith by what a user of these packages sees: the packages, their
options and log lines, Blacksmith runners, and the Actions cache. Leave out:

- private repositories, their paths, and their PR or issue numbers;
- internal service, host, database, table, queue and dashboard names, and
  staging or other non-public URLs;
- internal ticket IDs, chat threads, meeting notes, and links to private
  agent sessions or review tools;
- how Blacksmith's infrastructure implements something, where the public
  documentation does not say it;
- names of employees who are not public authors of the change.

Keep credentials, tokens and secrets out entirely, including in test fixtures;
use obviously fake values.

## What stays

Keep this repository's public identity: the `@useblacksmith/*` package names,
`useblacksmith/js-test-plugins`, public commit authors, and third-party
software. Do not add a list of real customer names to check against.

## Existing disclosures

If you find something here that breaks these rules, do not repeat it or quote
it in new content. Flag it privately to a maintainer. Do not delete content or
rewrite history without approval.

## Working in this repository

`corepack enable && pnpm install`, then `pnpm run check:types`, `pnpm run
build` and `pnpm test`. The Vitest package's browser test needs
`pnpm --filter @useblacksmith/vitest exec playwright install chromium`.
[README.md](README.md#development) covers the layout, the shared end-to-end
scenarios and releases.
