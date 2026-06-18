// SPDX-License-Identifier: MIT
//
// ADVERSARIAL SECURITY AUDIT — runVariantTask() sandbox (ADR-070 §sandbox).
//
// Two properties under attack:
//   1. ENV SCRUB — ambient secrets in process.env never reach a variant's test
//      command (only PATH + four identifying vars are exposed).
//   2. SHELL-FREE — the command is argv-split and run via execFile, NEVER a
//      shell, so `;`, `&&`, `|`, `$(...)` are inert ARGS, not metacharacters.
// Plus: a disqualified variant's command never runs (exitCode 99).

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runVariantTask } from '../../src/sandbox.js';
import { FILE_BY_SURFACE } from '../../src/safety.js';
import type { HarnessVariant, RepoProfile } from '../../src/types.js';

const SAFE = "// SPDX\nexport const policy = { name: 'stub' };\n";

async function writeApprovedVariant(dir: string): Promise<void> {
  for (const filename of Object.values(FILE_BY_SURFACE)) {
    await writeFile(join(dir, filename), SAFE, 'utf8');
  }
}

function makeVariant(dir: string, id = 'g1_v0_sec'): HarnessVariant {
  return {
    id,
    parentId: 'baseline',
    generation: 1,
    dir,
    mutationSurface: 'planner',
    mutationSummary: 'sec stub',
    createdAt: new Date().toISOString(),
  };
}

function makeProfile(root: string, testCommand: string): RepoProfile {
  return {
    root,
    packageManager: 'npm',
    testCommand,
    sourceFiles: [],
    riskFiles: [],
    summary: 'sec repo',
  };
}

let variantDir: string;
let repoDir: string;

beforeEach(async () => {
  variantDir = await mkdtemp(join(tmpdir(), 'darwin-sec-sbx-var-'));
  repoDir = await mkdtemp(join(tmpdir(), 'darwin-sec-sbx-repo-'));
});

afterEach(async () => {
  await rm(variantDir, { recursive: true, force: true });
  await rm(repoDir, { recursive: true, force: true });
});

describe('sandbox — environment scrubbing (no secret leak)', () => {
  const SECRETS = {
    AWS_SECRET_ACCESS_KEY: 'AKIA-LEAK-aws-1234567890',
    HTTP_PROXY: 'http://leak-proxy.internal:8080',
    DARWIN_SECRET: 'darwin-leak-value-xyz',
  };

  beforeEach(async () => {
    await writeApprovedVariant(variantDir);
    for (const [k, v] of Object.entries(SECRETS)) process.env[k] = v;
  });

  afterEach(() => {
    for (const k of Object.keys(SECRETS)) delete process.env[k];
  });

  it('none of the ambient secret values reach the command (they read undefined)', async () => {
    const variant = makeVariant(variantDir);
    // Use String(...) so an undefined value renders the literal "undefined"
    // (a bare Array.join would coerce undefined to "" and hide the signal).
    const profile = makeProfile(
      repoDir,
      'node -e console.log([String(process.env.AWS_SECRET_ACCESS_KEY),String(process.env.HTTP_PROXY),String(process.env.DARWIN_SECRET)].join("|"))',
    );

    const trace = await runVariantTask(variant, profile, 'task-env');

    expect(trace.exitCode).toBe(0);
    for (const v of Object.values(SECRETS)) {
      expect(trace.stdout).not.toContain(v);
      expect(trace.stderr).not.toContain(v);
    }
    // All three are absent from the scrubbed env ⇒ each reads as undefined.
    expect(trace.stdout.trim()).toBe('undefined|undefined|undefined');
  });
});

describe('sandbox — shell-free execution (no command injection)', () => {
  beforeEach(async () => {
    await writeApprovedVariant(variantDir);
  });

  it('`node --version ; echo PWNED` does not run echo (";" is an arg)', async () => {
    const variant = makeVariant(variantDir);
    const profile = makeProfile(repoDir, 'node --version ; echo PWNED');

    const trace = await runVariantTask(variant, profile, 'task-inject-semi');

    // execFile passed ["--version", ";", "echo", "PWNED"] to node, which errors
    // on the extra args — but crucially PWNED is never *executed*/echoed.
    expect(trace.stdout).not.toContain('PWNED');
    expect(trace.stderr).not.toContain('PWNED\n'); // not echoed onto its own line
  });

  it('`node --version && echo PWNED` does not run echo ("&&" is an arg)', async () => {
    const variant = makeVariant(variantDir);
    const profile = makeProfile(repoDir, 'node --version && echo PWNED');

    const trace = await runVariantTask(variant, profile, 'task-inject-and');

    expect(trace.stdout).not.toContain('PWNED');
  });

  it('`node -e ...` with a $(...) substitution leaves the substitution inert', async () => {
    const variant = makeVariant(variantDir);
    // If a shell ran, $(id) would expand; with execFile it is a literal arg string.
    const profile = makeProfile(repoDir, 'node -e console.log("safe$(id)end")');

    const trace = await runVariantTask(variant, profile, 'task-inject-subst');

    expect(trace.exitCode).toBe(0);
    // The literal text survives; no `uid=` from an expanded `id` command.
    expect(trace.stdout).toContain('safe$(id)end');
    expect(trace.stdout).not.toMatch(/uid=\d+/);
  });
});

describe('sandbox — disqualified variant never runs its command', () => {
  it('an extra file yields exitCode 99 and the command output never appears', async () => {
    await writeApprovedVariant(variantDir);
    await writeFile(join(variantDir, 'evil.ts'), SAFE, 'utf8');

    const variant = makeVariant(variantDir);
    // A command that WOULD print a sentinel if it ran.
    const profile = makeProfile(repoDir, 'node -e console.log("WOULD_HAVE_RUN")');

    const trace = await runVariantTask(variant, profile, 'task-dq');

    expect(trace.exitCode).toBe(99);
    expect(trace.stdout).toBe('');
    expect(trace.stdout).not.toContain('WOULD_HAVE_RUN');
    expect(trace.blockedActions.length).toBeGreaterThan(0);
    expect(trace.stderr).toBe(trace.blockedActions.join('\n'));
  });

  it('a blocked-content variant is disqualified before the command runs', async () => {
    await writeApprovedVariant(variantDir);
    await writeFile(
      join(variantDir, 'planner.ts'),
      '// SPDX\nexport const x = process.env.AWS_SECRET_ACCESS_KEY;\n',
      'utf8',
    );

    const variant = makeVariant(variantDir);
    const profile = makeProfile(repoDir, 'node -e console.log("WOULD_HAVE_RUN")');

    const trace = await runVariantTask(variant, profile, 'task-dq-content');

    expect(trace.exitCode).toBe(99);
    expect(trace.stdout).not.toContain('WOULD_HAVE_RUN');
    expect(trace.blockedActions.join(' ')).toMatch(/environment access/i);
  });
});
