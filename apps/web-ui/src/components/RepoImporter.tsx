import { useState } from 'react';
import { Github, Loader2, Sparkles, Wand2 } from 'lucide-react';
import {
  HIGH_SIGNAL_FILES,
  analyzeFiles,
  parseGitHubUrl,
  planToConfig,
  recommendPlan,
  scoreArchetypes,
} from '../generator';
import type { HarnessConfig, HarnessPlan, RepoInput, ScoredArchetype } from '../generator';
import { Field, Section } from './ui';

/** Fetch the high-signal files from a public repo via the GitHub contents API. */
async function fetchRepoFiles(owner: string, repo: string, token?: string): Promise<Record<string, string>> {
  const headers: Record<string, string> = { Accept: 'application/vnd.github.raw+json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const out: Record<string, string> = {};
  await Promise.all(
    HIGH_SIGNAL_FILES.map(async (path) => {
      try {
        const r = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${path}`, { headers });
        if (r.ok) out[path] = await r.text();
      } catch {
        /* missing file — skip */
      }
    }),
  );
  // A second call to detect CI presence cheaply.
  try {
    const r = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/.github/workflows`, { headers });
    if (r.ok) out['.github/workflows/ci.yml'] = '# present';
  } catch {
    /* ignore */
  }
  return out;
}

export function RepoImporter({ onUse }: { onUse: (cfg: HarnessConfig) => void }) {
  const [url, setUrl] = useState('https://github.com/ruvnet/ruflo');
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [plan, setPlan] = useState<HarnessPlan | null>(null);
  const [ranked, setRanked] = useState<ScoredArchetype[]>([]);

  async function analyze() {
    setError(null);
    setPlan(null);
    const parsed = parseGitHubUrl(url);
    if (!parsed) {
      setError('Not a GitHub URL — expected https://github.com/<owner>/<repo>');
      return;
    }
    setBusy(true);
    try {
      const files = await fetchRepoFiles(parsed.owner, parsed.repo, token.trim() || undefined);
      if (Object.keys(files).length === 0) {
        setError('No readable files found (private repo? rate-limited? paste a token below).');
        return;
      }
      const input: RepoInput = { owner: parsed.owner, repo: parsed.repo, files };
      const profile = analyzeFiles(input);
      setRanked(scoreArchetypes(profile));
      setPlan(recommendPlan(profile));
    } catch {
      setError('Analysis failed — check the URL or paste a token for rate limits.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <div className="space-y-5">
        <Section
          title="Paste a GitHub repo"
          desc="Analysis-only — repository code is never executed. We read manifests, docs, CI, and host configs."
        >
          <div className="space-y-4">
            <Field label="Repository URL">
              <div className="flex items-center gap-2">
                <span className="text-slate-400">
                  <Github size={16} />
                </span>
                <input className="input" value={url} onChange={(e) => setUrl(e.target.value)} aria-label="Repository URL" spellCheck={false} />
              </div>
            </Field>
            <Field label="GitHub token (optional)" hint="Stays in your browser. Use for private repos or to dodge rate limits.">
              <input
                className="input font-mono"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                aria-label="GitHub token"
                type="password"
                placeholder="ghp_…"
              />
            </Field>
            <button data-testid="analyze-repo" className="btn btn-primary" onClick={analyze} disabled={busy}>
              {busy ? <Loader2 size={16} className="animate-spin" /> : <Wand2 size={16} />}
              Analyze → recommend
            </button>
            {error && <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-200">{error}</div>}
          </div>
        </Section>

        <Section title="How it works" desc="Embeddings recommend. Rules generate. Tests prove parity.">
          <ol className="list-decimal space-y-1 pl-5 text-xs text-slate-400">
            <li>Fetch high-signal files (README, manifests, CI, host configs).</li>
            <li>Build a deterministic repo profile — languages, build/test commands, MCP/host signals.</li>
            <li>Score archetypes: 0.45 semantic + 0.25 manifest + 0.15 CI + 0.10 structure + 0.05 intent.</li>
            <li>Emit an editable plan; the scaffold itself stays rule-based and byte-deterministic.</li>
          </ol>
        </Section>
      </div>

      <div className="space-y-5 lg:sticky lg:top-5 lg:self-start">
        {plan ? (
          <Section
            title="Recommended harness"
            desc="Review, then open it in the builder to edit agents, skills, MCP, and policy."
            right={
              <button data-testid="use-plan" className="btn btn-primary" onClick={() => onUse(planToConfig(plan))}>
                <Sparkles size={16} /> Open in builder
              </button>
            }
          >
            <div className="space-y-4">
              <div className="rounded-lg border border-brand/40 bg-brand/10 p-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-semibold text-white">{plan.name}</span>
                  <span className="rounded bg-ink-800 px-2 py-0.5 text-xs text-accent">{Math.round(plan.confidence * 100)}% confidence</span>
                </div>
                <div className="mt-1 text-xs text-slate-300">
                  Best archetype: <span className="font-mono text-brand-glow">{plan.archetypeId}</span> · template{' '}
                  <span className="font-mono">{plan.template}</span>
                </div>
                <div className="mt-1 text-xs text-slate-400">
                  Hosts: {plan.hosts.join(', ')} · MCP: {plan.mcp} · Risk: {plan.riskProfile}
                </div>
              </div>

              <Detail label="Agents" items={plan.agents} />
              <Detail label="Skills" items={plan.skills.length ? plan.skills : ['—']} />
              <Detail label="Commands" items={plan.commands} />

              {plan.suggestedCommands.length > 0 && (
                <div>
                  <div className="field-label">Suggested commands (execution disabled)</div>
                  <div className="space-y-1">
                    {plan.suggestedCommands.map((c) => (
                      <div key={c.command} className="flex items-center justify-between rounded border border-ink-700 bg-ink-900/60 px-2 py-1 font-mono text-xs">
                        <span className="text-slate-200">{c.command}</span>
                        <span className="text-slate-500">trust: {c.trust} · {c.execution}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <details className="text-xs text-slate-400">
                <summary className="cursor-pointer text-slate-300">Archetype scores</summary>
                <div className="mt-2 space-y-1">
                  {ranked.slice(0, 5).map((r) => (
                    <div key={r.archetype.id} className="flex justify-between font-mono">
                      <span>{r.archetype.id}</span>
                      <span>{r.score.toFixed(3)}</span>
                    </div>
                  ))}
                </div>
              </details>
            </div>
          </Section>
        ) : (
          <Section title="Recommendation" desc="Analyze a repo to see the recommended harness plan.">
            <div className="flex items-center gap-2 rounded-lg border border-ink-700 bg-ink-900/50 px-3 py-6 text-sm text-slate-400">
              <Wand2 size={16} /> Paste a repo URL and click Analyze.
            </div>
          </Section>
        )}
      </div>
    </div>
  );
}

function Detail({ label, items }: { label: string; items: string[] }) {
  return (
    <div>
      <div className="field-label">{label}</div>
      <div className="flex flex-wrap gap-1.5">
        {items.map((i) => (
          <span key={i} className="rounded border border-ink-700 bg-ink-800/60 px-2 py-0.5 font-mono text-xs text-slate-200">
            {i}
          </span>
        ))}
      </div>
    </div>
  );
}
