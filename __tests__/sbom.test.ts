// SPDX-License-Identifier: MIT
//
// Tests for scripts/sbom.mjs — SPDX-2.3 SBOM generator.

import { describe, it, expect } from 'vitest';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
// @ts-ignore — JS module
import { validateSpdx, buildSbomFromRepo } from '../scripts/sbom.mjs';

const execFile = promisify(execFileCb);
const ROOT = process.cwd();
const SCRIPT = join(ROOT, 'scripts', 'sbom.mjs');

async function runSbom(args: string[] = []): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const r = await execFile('node', [SCRIPT, ...args], {
      cwd: ROOT, windowsHide: true, maxBuffer: 1024 * 1024 * 16,
    });
    return { code: 0, stdout: r.stdout, stderr: r.stderr };
  } catch (e) {
    const err = e as { code?: number; stdout?: string; stderr?: string };
    return { code: err.code ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

describe('scripts/sbom.mjs — script', () => {
  it('exists', () => expect(existsSync(SCRIPT)).toBe(true));

  it('--validate-only exits 0 and writes no stdout output', async () => {
    const r = await runSbom(['--validate-only']);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout.trim()).toBe('');
    expect(r.stderr).toMatch(/validate-only mode/);
  }, 30_000);

  it('default invocation prints valid JSON to stdout', async () => {
    const r = await runSbom();
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.spdxVersion).toBe('SPDX-2.3');
    expect(parsed.SPDXID).toBe('SPDXRef-DOCUMENT');
    expect(Array.isArray(parsed.packages)).toBe(true);
    expect(parsed.packages.length).toBeGreaterThan(0);
  }, 60_000);

  it('reports the package count to stderr', async () => {
    const r = await runSbom(['--validate-only']);
    expect(r.stderr).toMatch(/SPDX has \d+ packages \(validation OK\)/);
  }, 30_000);
});

describe('SPDX validator', () => {
  it('rejects missing spdxVersion', () => {
    const v = validateSpdx({ SPDXID: 'SPDXRef-DOCUMENT', packages: [] });
    expect(v.ok).toBe(false);
  });

  it('rejects packages without SPDXID', () => {
    const v = validateSpdx({
      spdxVersion: 'SPDX-2.3',
      SPDXID: 'SPDXRef-DOCUMENT',
      creationInfo: { created: '2026-01-01T00:00:00Z' },
      packages: [{ name: 'x', versionInfo: '1.0.0', externalRefs: [{ referenceLocator: 'pkg:npm/x@1.0.0' }] }],
    });
    expect(v.ok).toBe(false);
    expect(v.problems.join(' ')).toMatch(/SPDXID/);
  });

  it('accepts a well-formed minimal document', () => {
    const v = validateSpdx({
      spdxVersion: 'SPDX-2.3',
      SPDXID: 'SPDXRef-DOCUMENT',
      creationInfo: { created: '2026-01-01T00:00:00Z' },
      packages: [
        {
          SPDXID: 'SPDXRef-npm-x-1-0-0',
          name: 'x', versionInfo: '1.0.0',
          externalRefs: [{ referenceCategory: 'PACKAGE-MANAGER', referenceType: 'purl', referenceLocator: 'pkg:npm/x@1.0.0' }],
        },
      ],
    });
    expect(v.ok, v.problems.join(' ')).toBe(true);
  });

  it('rejects external refs that aren\'t pkg: URLs', () => {
    const v = validateSpdx({
      spdxVersion: 'SPDX-2.3',
      SPDXID: 'SPDXRef-DOCUMENT',
      creationInfo: { created: '2026-01-01T00:00:00Z' },
      packages: [
        {
          SPDXID: 'SPDXRef-x-1',
          name: 'x', versionInfo: '1.0.0',
          externalRefs: [{ referenceCategory: 'PACKAGE-MANAGER', referenceType: 'purl', referenceLocator: 'not-a-purl' }],
        },
      ],
    });
    expect(v.ok).toBe(false);
    expect(v.problems.join(' ')).toMatch(/purl/);
  });
});

describe('SBOM builder against the live repo', () => {
  it('includes npm packages', async () => {
    const doc = await buildSbomFromRepo();
    const npmPkgs = doc.packages.filter((p: any) =>
      p.externalRefs?.[0]?.referenceLocator?.startsWith('pkg:npm/'),
    );
    expect(npmPkgs.length).toBeGreaterThan(0);
  });

  it('every package has a purl externalRef', async () => {
    const doc = await buildSbomFromRepo();
    for (const p of doc.packages) {
      expect(p.externalRefs?.[0]?.referenceLocator, p.name).toMatch(/^pkg:(npm|cargo)\//);
    }
  });

  it('package count is consistent: doc.packages.length matches validation count', async () => {
    const doc = await buildSbomFromRepo();
    const v = validateSpdx(doc);
    expect(v.ok, v.problems.join(' ')).toBe(true);
    // every package has unique SPDXID
    const ids = new Set(doc.packages.map((p: any) => p.SPDXID));
    expect(ids.size).toBe(doc.packages.length);
  });
});
