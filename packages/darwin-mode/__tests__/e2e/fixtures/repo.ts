// SPDX-License-Identifier: MIT
//
// Shared throwaway-fixture builders for the Darwin Mode e2e suite.
//
// Each fixture is a self-contained repo in a fresh `node:os` tmpdir: a
// `package.json` whose `scripts.test` is a fast, deterministic, dependency-free
// command, plus a couple of plain source files for the profiler to discover.
//
// IMPORTANT (sandbox semantics): the sandbox runs the RepoProfile's
// `testCommand`, which `repo_profiler.ts` resolves to "<pm> test" (e.g.
// "npm test"). So the *effective* command a variant runs is `npm test`, which
// invokes `scripts.test` via the package manager. The script is therefore kept
// fast and shell-safe (quoted `-e` payload) so `npm test` exits 0 in well under
// a second with no network and no installed dependencies.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** A built fixture repo + work tree pair, with a disposer. */
export interface Fixture {
  /** Absolute path to the fixture repo (what `evolve` profiles + runs). */
  repoRoot: string;
  /** Absolute path to the throwaway `.metaharness` work tree for this run. */
  workRoot: string;
  /** Remove both trees. Always call in afterEach/finally. */
  cleanup: () => Promise<void>;
}

/**
 * Build a deterministic fixture repo in a tmpdir. `scripts.test` is a fast,
 * shell-safe, dependency-free command that exits 0 every time, so every variant
 * — which all run the same `npm test` against the same repo — passes cleanly.
 *
 * Built with JSON.stringify so the quoting of the `node -e "..."` payload is
 * always correct (npm runs the script string through a shell).
 */
export async function makeFixtureRepo(
  label = 'darwin-e2e',
): Promise<{ repoRoot: string; cleanup: () => Promise<void> }> {
  const repoRoot = await mkdtemp(join(tmpdir(), `${label}-repo-`));

  const pkg = {
    name: 'darwin-e2e-fixture',
    version: '1.0.0',
    private: true,
    // Resolved by the profiler to "npm test"; kept fast + shell-safe.
    scripts: { test: 'node -e "process.exit(0)"' },
  };
  await writeFile(join(repoRoot, 'package.json'), JSON.stringify(pkg, null, 2), 'utf8');

  // A couple of plain source files for the profiler to discover (no behaviour).
  await mkdir(join(repoRoot, 'src'), { recursive: true });
  await writeFile(
    join(repoRoot, 'src', 'add.js'),
    'export function add(a, b) {\n  return a + b;\n}\n',
    'utf8',
  );
  await writeFile(
    join(repoRoot, 'src', 'mul.js'),
    'export function mul(a, b) {\n  return a * b;\n}\n',
    'utf8',
  );
  await writeFile(
    join(repoRoot, 'README.md'),
    '# darwin-e2e fixture\n\nDeterministic throwaway repo.\n',
    'utf8',
  );

  return {
    repoRoot,
    cleanup: () => rm(repoRoot, { recursive: true, force: true }),
  };
}

/**
 * Build a repo + a (separate) empty work tree, returning a single disposer.
 * Use `makeWorkRoot` directly when a test needs several work trees against the
 * same repo (e.g. the reproducibility test).
 */
export async function makeFixture(label = 'darwin-e2e'): Promise<Fixture> {
  const { repoRoot, cleanup: cleanRepo } = await makeFixtureRepo(label);
  const workRoot = await mkdtemp(join(tmpdir(), `${label}-work-`));
  return {
    repoRoot,
    workRoot,
    cleanup: async () => {
      await rm(workRoot, { recursive: true, force: true });
      await cleanRepo();
    },
  };
}

/** A fresh, empty work-tree tmpdir. Caller is responsible for removing it. */
export async function makeWorkRoot(label = 'darwin-e2e'): Promise<string> {
  return mkdtemp(join(tmpdir(), `${label}-work-`));
}
