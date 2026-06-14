#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// Pre-publish GCP Secret Manager validation. Called from
// .github/workflows/publish.yml before any `npm publish` runs — exits
// non-zero if the publish-side secret fetch would fail.
//
// Verifies (in this order, fail-fast):
//   1. gcloud is on PATH
//   2. active gcloud project resolves
//   3. active gcloud auth principal exists
//   4. NPM_TOKEN secret exists in Secret Manager
//   5. the secret's latest version is fetchable
//   6. the fetched token passes `npm whoami`
//
// Reads required GCP_PROJECT, optional NPM_SECRET_NAME (default NPM_TOKEN)
// from env. Runs all 6 checks with structured output for CI grep.
//
// This is the "fail loud before publish" gate the user asked for.

import { execFile as execFileCb, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(execFileCb);

const PROJECT = process.env.GCP_PROJECT;
const SECRET = process.env.NPM_SECRET_NAME ?? 'NPM_TOKEN';
const VERBOSE = process.env.VERBOSE === '1' || process.argv.includes('--verbose');

/**
 * Pure helper (exported for unit tests). Resolves which secrets the
 * pre-publish gate must validate.
 *
 * - The npm token (NPM_SECRET_NAME, default NPM_TOKEN) is ALWAYS required
 *   and is the one that gets the extra `npm whoami` liveness check.
 * - Additional secrets come from REQUIRED_SECRETS (comma-separated). These
 *   only need to exist + be fetchable (e.g. PINATA_API_JWT for the IPFS
 *   marketplace pin). The npm token is de-duplicated if listed there too.
 *
 * Returns [{ name, npmCheck }] in a stable order, npm token first.
 */
export function parseRequiredSecrets(env = process.env) {
  const npmName = (env.NPM_SECRET_NAME ?? 'NPM_TOKEN').trim();
  const extra = (env.REQUIRED_SECRETS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((s) => s !== npmName);
  const seen = new Set();
  const out = [{ name: npmName, npmCheck: true }];
  seen.add(npmName);
  for (const name of extra) {
    if (seen.has(name)) continue;
    seen.add(name);
    out.push({ name, npmCheck: false });
  }
  return out;
}

function log(level, msg) {
  const tag = { pass: 'PASS', fail: 'FAIL', warn: 'WARN', info: 'INFO' }[level] ?? level;
  process.stderr.write(`[gcp-validate] ${tag}: ${msg}\n`);
}

function fail(msg) {
  log('fail', msg);
  process.exit(1);
}

async function which(cmd) {
  return new Promise(resolve => {
    const tool = process.platform === 'win32' ? 'where' : 'which';
    const p = spawn(tool, [cmd], { stdio: 'ignore', windowsHide: true });
    p.on('error', () => resolve(false));
    p.on('exit', code => resolve(code === 0));
  });
}

async function gcloud(args, opts = {}) {
  try {
    const r = await execFile('gcloud', args, { maxBuffer: 1024 * 1024, windowsHide: true, ...opts });
    return { code: 0, stdout: r.stdout, stderr: r.stderr };
  } catch (e) {
    return { code: e.code ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? e.message ?? '' };
  }
}

async function main() {
  if (!PROJECT) {
    fail('GCP_PROJECT env var is required (set in publish.yml from gcloud-auth output)');
  }

  // 1. gcloud on PATH
  if (!(await which('gcloud'))) {
    fail('gcloud CLI not on PATH (install: https://cloud.google.com/sdk/docs/install)');
  }
  log('pass', 'gcloud on PATH');

  // 2. Project resolves
  const proj = await gcloud(['config', 'get-value', 'project']);
  const activeProject = proj.stdout.trim();
  if (!activeProject || activeProject === '(unset)') {
    fail(`no active gcloud project — expected ${PROJECT}`);
  }
  if (activeProject !== PROJECT) {
    log('warn', `active project (${activeProject}) != requested (${PROJECT}) — using ${PROJECT}`);
  } else {
    log('pass', `project = ${PROJECT}`);
  }

  // 3. Auth
  const auth = await gcloud(['auth', 'list', '--filter=status:ACTIVE', '--format=value(account)']);
  const principal = auth.stdout.trim();
  if (auth.code !== 0 || !principal) {
    fail('no active gcloud auth principal (in CI: WIF should have provisioned one)');
  }
  log('pass', `auth principal = ${principal.split('\n')[0]}`);

  // 4-6. Per-secret: exists → fetchable → (npm token only) npm whoami.
  // iter 145: validate EVERY required publish-time secret, not just the
  // npm token. REQUIRED_SECRETS (e.g. "PINATA_API_JWT") adds the secrets
  // the IPFS marketplace pin needs, so a missing Pinata key fails the
  // gate BEFORE publish rather than mid-pipeline.
  const required = parseRequiredSecrets(process.env);
  log('info', `validating ${required.length} secret(s): ${required.map((s) => s.name).join(', ')}`);

  for (const { name, npmCheck } of required) {
    // exists
    const desc = await gcloud([
      'secrets', 'describe', name,
      `--project=${PROJECT}`,
      '--format=value(name)',
    ]);
    if (desc.code !== 0) {
      fail(`secret '${name}' not found in project ${PROJECT}: ${desc.stderr.trim()}`);
    }
    log('pass', `secret '${name}' exists`);

    // fetchable
    const ver = await gcloud([
      'secrets', 'versions', 'access', 'latest',
      `--secret=${name}`,
      `--project=${PROJECT}`,
    ]);
    if (ver.code !== 0) {
      fail(`cannot fetch latest version of '${name}': ${ver.stderr.trim()}`);
    }
    const value = ver.stdout.trim();
    if (!value) {
      fail(`'${name}' returned empty content`);
    }
    if (VERBOSE) log('info', `'${name}' length = ${value.length} chars`);
    log('pass', `fetched '${name}' from Secret Manager`);

    // npm whoami liveness — only for the npm token
    if (npmCheck) {
      try {
        const who = await execFile('npm', ['whoami', '--registry=https://registry.npmjs.org/'], {
          env: { ...process.env, npm_config__authToken: value },
          windowsHide: true,
        });
        const user = who.stdout.trim();
        if (!user) {
          fail(`npm whoami returned empty (token may be revoked)`);
        }
        log('pass', `npm whoami = ${user}`);
      } catch (e) {
        fail(`npm whoami failed: ${(e.stderr ?? e.message ?? '').toString().trim() || 'unknown'}`);
      }
    }
  }

  log('info', 'ALL CHECKS PASSED — publish gate OPEN');
  process.exit(0);
}

// Only run main() when invoked directly, not when imported for tests.
const invokedDirectly = process.argv[1] && process.argv[1].endsWith('validate-gcp-secrets.mjs');
if (invokedDirectly) {
  main().catch((err) => {
    fail(`unexpected error: ${err?.message ?? err}`);
  });
}
