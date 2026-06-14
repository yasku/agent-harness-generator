// iter 145 — unit coverage for the pre-publish GCP secret-list resolver.
// The validate-gcp-secrets.mjs script's I/O (gcloud, npm whoami) needs a
// live GCP connection, but the pure REQUIRED_SECRETS parsing is testable
// in isolation — and it's the part most likely to regress when a new
// publish-time secret (e.g. PINATA_API_JWT) is added.
import { describe, it, expect } from 'vitest';
// @ts-expect-error — .mjs script, no types; runtime import is fine under vitest.
import { parseRequiredSecrets } from '../scripts/validate-gcp-secrets.mjs';

describe('parseRequiredSecrets', () => {
  it('defaults to just NPM_TOKEN with the npm liveness check', () => {
    const out = parseRequiredSecrets({});
    expect(out).toEqual([{ name: 'NPM_TOKEN', npmCheck: true }]);
  });

  it('honors NPM_SECRET_NAME override', () => {
    const out = parseRequiredSecrets({ NPM_SECRET_NAME: 'NPM_PUBLISH_TOKEN' });
    expect(out[0]).toEqual({ name: 'NPM_PUBLISH_TOKEN', npmCheck: true });
  });

  it('adds extra REQUIRED_SECRETS without an npm check', () => {
    const out = parseRequiredSecrets({ REQUIRED_SECRETS: 'PINATA_API_JWT' });
    expect(out).toEqual([
      { name: 'NPM_TOKEN', npmCheck: true },
      { name: 'PINATA_API_JWT', npmCheck: false },
    ]);
  });

  it('puts the npm token FIRST regardless of list order', () => {
    const out = parseRequiredSecrets({ REQUIRED_SECRETS: 'PINATA_API_JWT,GH_TOKEN' });
    expect(out[0].name).toBe('NPM_TOKEN');
    expect(out.map((s) => s.name)).toEqual(['NPM_TOKEN', 'PINATA_API_JWT', 'GH_TOKEN']);
  });

  it('de-duplicates the npm token if it also appears in REQUIRED_SECRETS', () => {
    const out = parseRequiredSecrets({ REQUIRED_SECRETS: 'NPM_TOKEN,PINATA_API_JWT' });
    expect(out.filter((s) => s.name === 'NPM_TOKEN')).toHaveLength(1);
    expect(out).toHaveLength(2);
  });

  it('de-duplicates repeated extras and ignores blank entries / whitespace', () => {
    const out = parseRequiredSecrets({ REQUIRED_SECRETS: ' PINATA_API_JWT , , PINATA_API_JWT ,GH_TOKEN' });
    expect(out.map((s) => s.name)).toEqual(['NPM_TOKEN', 'PINATA_API_JWT', 'GH_TOKEN']);
  });

  it('only the npm token ever carries npmCheck=true', () => {
    const out = parseRequiredSecrets({ REQUIRED_SECRETS: 'A,B,C' });
    expect(out.filter((s) => s.npmCheck)).toEqual([{ name: 'NPM_TOKEN', npmCheck: true }]);
  });
});
