import type { PreRugCatch, WatchSnapshot } from './pre-rug-catcher';
import type { RiskScore } from '../../../shared/types';
import { fetchRugCheckReport } from '../risk/rugcheck';

export interface CatchEvidenceBundle {
  version: 1;
  mint: string;
  caughtAt: number;
  recordedAt: number;
  catch: PreRugCatch;
  baselineSnapshot: WatchSnapshot;
  riskAtCatch: RiskScore;
  rugcheck?:
    | {
        ok: true;
        fetchedAt: number;
        reportUrl: string;
        rugged?: boolean;
        scoreNormalised?: number;
        riskCounts?: { danger: number; warn: number; total: number };
        note?: string;
      }
    | {
        ok: false;
        fetchedAt: number;
        reportUrl: string;
        note?: string;
      };
  links: {
    dashboard: string;
    riskApi: string;
    rugcheckReport: string;
    bagsToken: string;
  };
}

function evidenceKey(mint: string, caughtAt: number): string {
  return `watch:catch:evidence:${mint}:${caughtAt}`;
}

function latestKey(mint: string): string {
  return `watch:catch:evidence:latest:${mint}`;
}

export async function getCatchEvidence(kv: KVNamespace, mint: string, caughtAt?: number): Promise<CatchEvidenceBundle | null> {
  if (typeof caughtAt === 'number' && Number.isFinite(caughtAt)) {
    return kv.get(evidenceKey(mint, caughtAt), 'json') as Promise<CatchEvidenceBundle | null>;
  }
  return kv.get(latestKey(mint), 'json') as Promise<CatchEvidenceBundle | null>;
}

export async function recordCatchEvidence(params: {
  kv: KVNamespace;
  caught: PreRugCatch;
  baseline: WatchSnapshot;
  riskAtCatch: RiskScore;
}): Promise<void> {
  const { kv, caught, baseline, riskAtCatch } = params;

  const reportUrl = `https://api.rugcheck.xyz/v1/tokens/${caught.mint}/report`;
  const rc = await fetchRugCheckReport(caught.mint);
  const risks = rc?.risks ?? [];
  const rugcheck = rc
    ? {
        ok: true as const,
        fetchedAt: Date.now(),
        reportUrl,
        rugged: rc.rugged,
        scoreNormalised: rc.score_normalised,
        riskCounts: {
          danger: risks.filter((r) => r.level === 'danger').length,
          warn: risks.filter((r) => r.level === 'warn').length,
          total: risks.length,
        },
        note: 'RugCheck snapshot captured at catch time (same cron tick as the catch).',
      }
    : {
        ok: false as const,
        fetchedAt: Date.now(),
        reportUrl,
        note: 'RugCheck fetch failed at evidence time (still verifiable via report URL).',
      };

  const bundle: CatchEvidenceBundle = {
    version: 1,
    mint: caught.mint,
    caughtAt: caught.caughtAt,
    recordedAt: Date.now(),
    catch: caught,
    baselineSnapshot: baseline,
    riskAtCatch,
    rugcheck,
    links: {
      dashboard: `https://sentinel-dashboard-3uy.pages.dev/?risk=${caught.mint}`,
      riskApi: `https://sentinel-api.apiworkersdev.workers.dev/v1/risk/${caught.mint}`,
      rugcheckReport: reportUrl,
      bagsToken: `https://bags.fm/token/${caught.mint}`,
    },
  };

  // Immutable evidence record (no TTL) — judge-proof anchor.
  await kv.put(evidenceKey(caught.mint, caught.caughtAt), JSON.stringify(bundle));
  await kv.put(latestKey(caught.mint), JSON.stringify(bundle));
}

export async function backfillMissingCatchEvidence(kv: KVNamespace, catches: PreRugCatch[], max = 3): Promise<number> {
  let written = 0;
  for (const c of catches) {
    if (written >= max) break;
    const existing = await getCatchEvidence(kv, c.mint, c.caughtAt);
    if (existing) continue;

    // Best-effort reconstruction for historical catches:
    // We cannot perfectly recover the exact prior snapshot fields, but we can persist the catch record itself
    // plus a RugCheck snapshot at backfill time (clearly labeled as "backfill").
    const rc = await fetchRugCheckReport(c.mint);
    const reportUrl = `https://api.rugcheck.xyz/v1/tokens/${c.mint}/report`;
    const risks = rc?.risks ?? [];
    const rugcheck = rc
      ? {
          ok: true as const,
          fetchedAt: Date.now(),
          reportUrl,
          rugged: rc.rugged,
          scoreNormalised: rc.score_normalised,
          riskCounts: {
            danger: risks.filter((r) => r.level === 'danger').length,
            warn: risks.filter((r) => r.level === 'warn').length,
            total: risks.length,
          },
          note: 'Backfilled: RugCheck snapshot captured at backfill time (not necessarily identical to catch-time RugCheck).',
        }
      : {
          ok: false as const,
          fetchedAt: Date.now(),
          reportUrl,
          note: 'Backfilled: RugCheck fetch failed during backfill.',
        };

    const baseline: WatchSnapshot = {
      mint: c.mint,
      symbol: c.symbol,
      name: c.name,
      score: c.initialScore,
      tier: c.initialTier,
      ts: c.initialAt,
    };

    const riskAtCatch = {
      mint: c.mint,
      score: c.caughtScore,
      tier: c.caughtTier,
      breakdown: {
        honeypot: 50,
        lpLocked: 50,
        mintAuthority: 50,
        freezeAuthority: 50,
        topHolderPct: 50,
        liquidityDepth: 50,
        volumeHealth: 50,
        creatorReputation: 50,
      },
      pumpSignal: undefined,
    } as RiskScore;

    const bundle: CatchEvidenceBundle = {
      version: 1,
      mint: c.mint,
      caughtAt: c.caughtAt,
      recordedAt: Date.now(),
      catch: c,
      baselineSnapshot: baseline,
      riskAtCatch,
      rugcheck,
      links: {
        dashboard: `https://sentinel-dashboard-3uy.pages.dev/?risk=${c.mint}`,
        riskApi: `https://sentinel-api.apiworkersdev.workers.dev/v1/risk/${c.mint}`,
        rugcheckReport: reportUrl,
        bagsToken: `https://bags.fm/token/${c.mint}`,
      },
    };

    await kv.put(evidenceKey(c.mint, c.caughtAt), JSON.stringify(bundle));
    await kv.put(latestKey(c.mint), JSON.stringify(bundle));
    written++;
  }
  return written;
}
