import { useState, useEffect, useCallback } from 'react';
import type { RiskAlert, AlertSeverity, AlertType, RiskTier } from '../../../shared/types';
import { TierBadge } from '../components/RiskDisplay';
import { fetchAlertFeed, triggerAlertScan, resolveTelegramChatId, subscribeAlerts, unsubscribeAlerts, fetchSubscription, fetchTelegramBotInfo, fetchAlertSubscriberCount } from '../api';

const SEVERITY_STYLES: Record<AlertSeverity, { border: string; bg: string; icon: string }> = {
  critical: { border: 'border-sentinel-danger/50', bg: 'bg-sentinel-danger/5', icon: '🚨' },
  warning:  { border: 'border-sentinel-caution/50', bg: 'bg-sentinel-caution/5', icon: '⚠️' },
  info:     { border: 'border-sentinel-safe/50', bg: 'bg-sentinel-safe/5', icon: '✅' },
};

const TYPE_LABELS: Record<AlertType, string> = {
  tier_change: 'Tier Change',
  lp_unlock: 'LP Unlocked',
  lp_drain: 'LP Drain 🚨',
  holder_spike: 'Holder Concentration',
  mint_authority: 'Mint Authority',
  new_danger: 'New Danger Token',
  creator_rug_history: 'Creator History',
};

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

function AlertCard({
  alert,
  onViewToken,
  onViewCreator,
}: {
  alert: RiskAlert;
  onViewToken: (mint: string) => void;
  onViewCreator: (wallet: string) => void;
}) {
  const sev = SEVERITY_STYLES[alert.severity];

  return (
    <div className={`p-4 rounded-xl border ${sev.border} ${sev.bg} space-y-2 transition-all hover:border-opacity-80`}>
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-lg shrink-0">{sev.icon}</span>
          <div className="min-w-0">
            <h3 className="text-sm font-medium text-white truncate">{alert.title}</h3>
            <div className="flex items-center gap-2 mt-0.5">
              <span className="text-[10px] uppercase tracking-wider text-gray-500 font-medium">
                {TYPE_LABELS[alert.type]}
              </span>
              <span className="text-[10px] text-gray-600">·</span>
              <span className="text-[10px] text-gray-500">{timeAgo(alert.timestamp)}</span>
            </div>
          </div>
        </div>
        <div className="shrink-0 flex items-center gap-2">
          {alert.previousTier && alert.currentTier !== alert.previousTier && (
            <div className="flex items-center gap-1 text-xs">
              <TierBadge tier={alert.previousTier} />
              <span className="text-gray-500">→</span>
              <TierBadge tier={alert.currentTier} />
            </div>
          )}
          {(!alert.previousTier || alert.currentTier === alert.previousTier) && (
            <TierBadge tier={alert.currentTier} />
          )}
        </div>
      </div>

      {/* Description */}
      <p className="text-xs text-gray-400 leading-relaxed">{alert.description}</p>

      {/* Score change bar */}
      {alert.previousScore !== null && (
        <div className="flex items-center gap-2 text-xs">
          <span className="text-gray-500">Score:</span>
          <span className="font-mono text-gray-400">{alert.previousScore}</span>
          <span className="text-gray-600">→</span>
          <span className={`font-mono font-medium ${
            alert.currentScore > (alert.previousScore ?? 0) ? 'text-sentinel-safe' : 'text-sentinel-danger'
          }`}>
            {alert.currentScore}
          </span>
          <span className={`text-[10px] font-mono ${
            alert.currentScore > (alert.previousScore ?? 0) ? 'text-sentinel-safe' : 'text-sentinel-danger'
          }`}>
            ({alert.currentScore > (alert.previousScore ?? 0) ? '+' : ''}{alert.currentScore - (alert.previousScore ?? 0)})
          </span>
        </div>
      )}

      {/* Actions */}
      <div className="flex items-center gap-3 pt-1">
        <button
          onClick={() => onViewToken(alert.mint)}
          className="text-xs text-sentinel-accent hover:underline"
        >
          View risk report →
        </button>
        {alert.creatorWallet && (
          <button
            onClick={() => onViewCreator(alert.creatorWallet!)}
            className="text-xs text-gray-400 hover:text-sentinel-accent hover:underline"
          >
            Creator profile →
          </button>
        )}
        <span className="text-[10px] text-gray-600 font-mono ml-auto">
          {alert.tokenSymbol} · {alert.mint.slice(0, 6)}…{alert.mint.slice(-4)}
        </span>
      </div>
    </div>
  );
}

export function AlertFeedPage({
  onViewToken,
  onViewCreator,
}: {
  onViewToken: (mint: string) => void;
  onViewCreator: (wallet: string) => void;
}) {
  const [alerts, setAlerts] = useState<RiskAlert[]>([]);
  const [scannedTokens, setScannedTokens] = useState(0);
  const [lastScan, setLastScan] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [filter, setFilter] = useState<'all' | 'critical' | 'warning'>('all');

  // Creator alerts subscription (Telegram)
  const [tgUsername, setTgUsername] = useState('');
  const [creatorWallet, setCreatorWallet] = useState('');
  const [resolvedChatId, setResolvedChatId] = useState<string | null>(null);
  const [subStatus, setSubStatus] = useState<string | null>(null);
  const [subBusy, setSubBusy] = useState(false);
  const [subInfo, setSubInfo] = useState<{ subscribed: boolean; wallet?: string | null } | null>(null);
  const [botInfo, setBotInfo] = useState<{ username: string; deepLink: string } | null>(null);
  const [subscriberCount, setSubscriberCount] = useState<number | null>(null);

  useEffect(() => {
    fetchTelegramBotInfo().then(setBotInfo).catch(() => {});
    fetchAlertSubscriberCount().then(setSubscriberCount).catch(() => {});
  }, []);

  const loadFeed = useCallback(() => {
    setLoading(true);
    setError(null);
    fetchAlertFeed()
      .then((feed) => {
        setAlerts(feed.alerts);
        setScannedTokens(feed.scannedTokens);
        setLastScan(feed.lastScanAt);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { loadFeed(); }, [loadFeed]);

  // Auto-refresh every 60s
  useEffect(() => {
    const id = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      loadFeed();
    }, 60_000);
    return () => clearInterval(id);
  }, [loadFeed]);

  const handleScan = async () => {
    setScanning(true);
    try {
      await triggerAlertScan();
      loadFeed();
    } catch {
      // silently fail manual scan
    } finally {
      setScanning(false);
    }
  };

  const handleSubscribe = async () => {
    setSubBusy(true);
    setSubStatus(null);
    try {
      const username = tgUsername.trim();
      // Username is optional; if omitted, we auto-detect the most recent private chat update.
      const chatId = await resolveTelegramChatId(username || undefined);
      setResolvedChatId(chatId);
      const msg = await subscribeAlerts({
        chatId,
        wallet: creatorWallet.trim() || undefined,
      });
      setSubStatus(msg);
      const info = await fetchSubscription(chatId);
      setSubInfo({ subscribed: info.subscribed, wallet: info.wallet ?? null });
    } catch (e) {
      setSubStatus(e instanceof Error ? e.message : 'Subscribe failed');
    } finally {
      setSubBusy(false);
    }
  };

  const handleUnsubscribe = async () => {
    setSubBusy(true);
    setSubStatus(null);
    try {
      const chatId = resolvedChatId;
      if (!chatId) throw new Error('Resolve chatId first (subscribe once)');
      await unsubscribeAlerts(chatId);
      setSubStatus('Unsubscribed.');
      const info = await fetchSubscription(chatId);
      setSubInfo({ subscribed: info.subscribed, wallet: info.wallet ?? null });
    } catch (e) {
      setSubStatus(e instanceof Error ? e.message : 'Unsubscribe failed');
    } finally {
      setSubBusy(false);
    }
  };

  const filtered = filter === 'all'
    ? alerts
    : alerts.filter((a) => a.severity === filter);

  const criticalCount = alerts.filter((a) => a.severity === 'critical').length;
  const warningCount = alerts.filter((a) => a.severity === 'warning').length;

  return (
    <div className="max-w-3xl mx-auto space-y-6 animate-fade-in">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-xl font-bold">Risk Alert Feed</h2>
          <p className="text-sm text-gray-500 mt-1">
            Live monitoring of Bags tokens. Tier changes, LP unlocks, holder concentration spikes.
          </p>
          <p className="text-xs text-gray-600 mt-2">
            This feed shows <span className="text-gray-400">daily events</span>. “Catches” are rare by design — see <span className="font-mono">/v1/watch/catches</span> for high-quality pre-rug catches.
          </p>
        </div>
        <button
          onClick={handleScan}
          disabled={scanning}
          className={`text-xs px-3 py-1.5 rounded-md font-medium transition-all ${
            scanning
              ? 'bg-sentinel-accent/20 text-sentinel-accent/60 cursor-wait'
              : 'bg-sentinel-accent hover:bg-sentinel-accent-dim text-white'
          }`}
        >
          {scanning ? 'Scanning…' : 'Scan Now'}
        </button>
      </div>

      {/* Creator Alerts (Telegram) */}
      <div className="p-4 rounded-xl border border-sentinel-border/60 bg-black/20 space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-white">Creator Alerts (Telegram)</h3>
            <p className="text-xs text-gray-500 mt-1">
              Get DMs when <span className="text-gray-300">your</span> tokens hit <span className="text-gray-300">LP unlock / LP drain</span>.
              Step 1: DM the bot once on Telegram (send <span className="font-mono text-gray-300">/start</span>), then subscribe here.
            </p>
            {botInfo && (
              <a
                href={botInfo.deepLink}
                target="_blank"
                rel="noopener"
                className="inline-flex mt-2 text-[11px] px-2.5 py-1.5 rounded-md border border-sentinel-border/60 text-gray-300 hover:border-sentinel-accent/40 hover:text-sentinel-accent transition-all"
              >
                Open bot DM @{botInfo.username} →
              </a>
            )}
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 p-3 rounded-lg border border-sentinel-border/50 bg-black/20">
          <div className="text-[11px] text-gray-500">
            <span className="text-gray-300 font-semibold">Bot commands</span>
            <div className="mt-1 space-y-1">
              <div><span className="font-mono text-gray-300">/status &lt;mint&gt;</span> — score + tier</div>
              <div><span className="font-mono text-gray-300">/why &lt;mint&gt;</span> — explanation</div>
              <div><span className="font-mono text-gray-300">/watch &lt;mint&gt;</span> — watchlist</div>
              <div><span className="font-mono text-gray-300">/report</span> — quick summary</div>
            </div>
          </div>
          <div className="text-[11px] text-gray-500">
            <span className="text-gray-300 font-semibold">Docs</span>
            <div className="mt-1 space-y-1">
              <a
                href="https://github.com/loquit-doru/sentinel/blob/master/docs/telegram.md"
                target="_blank"
                rel="noopener"
                className="text-sentinel-accent hover:underline"
              >
                Setup + troubleshooting ↗
              </a>
              <div className="text-[10px] text-gray-600">Developers: how to set webhook + secret token.</div>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="space-y-1">
            <label className="text-[11px] text-gray-500">Telegram username</label>
            <input
              value={tgUsername}
              onChange={(e) => setTgUsername(e.target.value)}
            placeholder="@yourname (optional)"
              className="w-full px-3 py-2 text-sm rounded-lg bg-black/30 border border-sentinel-border/60 text-gray-200 placeholder:text-gray-600 focus:outline-none focus:border-sentinel-accent/60"
            />
          </div>
          <div className="space-y-1">
            <label className="text-[11px] text-gray-500">Creator wallet (optional filter)</label>
            <input
              value={creatorWallet}
              onChange={(e) => setCreatorWallet(e.target.value)}
              placeholder="Your Solana wallet (creator)"
              className="w-full px-3 py-2 text-sm rounded-lg bg-black/30 border border-sentinel-border/60 text-gray-200 placeholder:text-gray-600 focus:outline-none focus:border-sentinel-accent/60"
            />
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={handleSubscribe}
            disabled={subBusy}
            className={`text-xs px-3 py-2 rounded-md font-medium transition-all ${
              subBusy
                ? 'bg-sentinel-accent/20 text-sentinel-accent/60 cursor-wait'
                : 'bg-sentinel-accent hover:bg-sentinel-accent-dim text-white'
            }`}
          >
            {subBusy ? 'Working…' : 'Subscribe'}
          </button>
          <button
            onClick={handleUnsubscribe}
            disabled={subBusy || !resolvedChatId}
            className="text-xs px-3 py-2 rounded-md border border-sentinel-border/60 text-gray-300 hover:border-sentinel-accent/40 disabled:opacity-40"
          >
            Unsubscribe
          </button>
          {resolvedChatId && (
            <span className="text-[10px] text-gray-600 font-mono ml-auto">
              chatId: {resolvedChatId}
            </span>
          )}
        </div>

        {(subStatus || subInfo) && (
          <div className="text-xs text-gray-400">
            {subStatus && <div>{subStatus}</div>}
            {subInfo && (
              <div className="text-[11px] text-gray-600 mt-1">
                Status: <span className="text-gray-400">{subInfo.subscribed ? 'subscribed' : 'not subscribed'}</span>
                {subInfo.wallet ? <> · wallet filter: <span className="font-mono">{subInfo.wallet.slice(0, 6)}…{subInfo.wallet.slice(-4)}</span></> : null}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Stats bar */}
      <div className="flex items-center gap-4 text-xs">
        <span className="text-gray-500">
          {scannedTokens > 0 ? `${scannedTokens} tokens monitored` : 'No scans yet'}
        </span>
        {typeof subscriberCount === 'number' && (
          <>
            <span className="text-gray-700">·</span>
            <span className="text-gray-500">{subscriberCount} Telegram subscribers</span>
          </>
        )}
        {lastScan > 0 && (
          <>
            <span className="text-gray-700">·</span>
            <span className="text-gray-500">Last scan: {timeAgo(lastScan)}</span>
          </>
        )}
        {criticalCount > 0 && (
          <>
            <span className="text-gray-700">·</span>
            <span className="text-sentinel-danger font-medium">{criticalCount} critical</span>
          </>
        )}
        {warningCount > 0 && (
          <>
            <span className="text-gray-700">·</span>
            <span className="text-sentinel-caution font-medium">{warningCount} warnings</span>
          </>
        )}
      </div>

      {/* Filter pills */}
      <div className="flex items-center gap-2">
        {(['all', 'critical', 'warning'] as const).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`text-xs px-3 py-1 rounded-full border transition-all capitalize ${
              filter === f
                ? 'border-sentinel-accent/50 bg-sentinel-accent/10 text-sentinel-accent'
                : 'border-sentinel-border/50 text-gray-500 hover:text-gray-300'
            }`}
          >
            {f === 'all' ? `All (${alerts.length})` : f === 'critical' ? `Critical (${criticalCount})` : `Warning (${warningCount})`}
          </button>
        ))}
      </div>

      {/* Loading */}
      {loading && alerts.length === 0 && (
        <div className="text-center py-12">
          <div className="w-6 h-6 border-2 border-sentinel-accent border-t-transparent rounded-full animate-spin mx-auto" />
          <p className="text-sm text-gray-500 mt-3">Loading alert feed…</p>
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="p-3 bg-sentinel-danger/5 border border-sentinel-danger/20 rounded-lg flex items-center justify-between">
          <p className="text-sm text-gray-400">{error}</p>
          <button onClick={loadFeed} className="text-xs text-sentinel-accent hover:underline">Retry</button>
        </div>
      )}

      {/* Empty state */}
      {!loading && alerts.length === 0 && !error && (
        <div className="text-center py-16 space-y-3">
          <p className="text-4xl">🔍</p>
          <p className="text-lg font-medium text-gray-300">No alerts yet</p>
          <p className="text-sm text-gray-500 max-w-sm mx-auto">
            Click "Scan Now" to run the first risk scan across top Bags tokens.
            Alerts will appear here when token risk profiles change.
          </p>
        </div>
      )}

      {/* Alert list */}
      <div className="space-y-3">
        {filtered.map((alert) => (
          <AlertCard
            key={alert.id}
            alert={alert}
            onViewToken={onViewToken}
            onViewCreator={onViewCreator}
          />
        ))}
      </div>

      {/* Footer */}
      {alerts.length > 0 && (
        <p className="text-center text-[10px] text-gray-600 pt-4">
          Alerts auto-refresh every 60s · Scans run every 15 min · Data from RugCheck + Helius + Birdeye
        </p>
      )}
    </div>
  );
}
