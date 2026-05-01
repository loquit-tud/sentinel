import { useState, useEffect, useCallback, lazy, Suspense } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui';
import bs58 from 'bs58';
import type { TokenFeedItem } from '../../shared/types';
import { SearchBar } from './components/SearchBar';
import { ErrorBoundary } from './components/ErrorBoundary';
import { FeedPage } from './pages/FeedPage';
import { RiskDetailPage } from './pages/RiskDetailPage';
import { LandingPage } from './pages/LandingPage';
import { ClaimPage } from './pages/ClaimPage';
import { authChallenge, authVerify, fetchTokenFeed, getSessionToken, getSessionWallet, setSessionToken, setSessionWallet } from './api';

// Lazy-loaded heavy/secondary pages — split out of main bundle
const WalletXRayPage     = lazy(() => import('./pages/WalletXRayPage').then(m => ({ default: m.WalletXRayPage })));
const AlertFeedPage      = lazy(() => import('./pages/AlertFeedPage').then(m => ({ default: m.AlertFeedPage })));
const CreatorProfilePage = lazy(() => import('./pages/CreatorProfilePage').then(m => ({ default: m.CreatorProfilePage })));
const TokenLaunchPage    = lazy(() => import('./pages/TokenLaunchPage').then(m => ({ default: m.TokenLaunchPage })));

type View =
  | { page: 'landing' }
  | { page: 'feed' }
  | { page: 'risk'; mint: string }
  | { page: 'xray' }
  | { page: 'alerts' }
  | { page: 'creator'; wallet: string }
  | { page: 'claim'; claimId: string }
  | { page: 'token-launch' };

function SentinelLogo({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path
        d="M16 3L4 8v8c0 6.627 5.148 12.347 12 13.93C22.852 28.347 28 22.627 28 16V8L16 3z"
        fill="rgba(6,182,212,0.12)"
        stroke="rgba(6,182,212,0.5)"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <circle cx="16" cy="16" r="4" fill="none" stroke="#06b6d4" strokeWidth="1.5" />
      <circle cx="16" cy="16" r="1.5" fill="#06b6d4" />
      <path d="M16 10v2M16 20v2M10 16h2M20 16h2" stroke="#06b6d4" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}

type TabId = 'discover' | 'xray' | 'alerts' | 'token-launch';

const ALL_TABS: { id: TabId; label: string }[] = [
  { id: 'discover',     label: 'Discovery' },
  { id: 'alerts',       label: '🎯 Alerts' },
  { id: 'xray',         label: '🔍 Wallet X-Ray' },
  { id: 'token-launch', label: '🚀 Launch Guard' },
];

function NavTab({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`px-3 py-1.5 text-sm font-medium rounded-lg transition-all whitespace-nowrap ${
        active
          ? 'bg-sentinel-accent/15 text-sentinel-accent border border-sentinel-accent/25'
          : 'text-gray-500 hover:text-gray-300 hover:bg-white/5 border border-transparent'
      }`}
    >
      {children}
    </button>
  );
}

function PageLoader() {
  return (
    <div className="space-y-3 animate-fade-in">
      <div className="h-8 w-1/3 rounded-md bg-gradient-to-r from-sentinel-border/30 via-sentinel-border/60 to-sentinel-border/30 bg-[length:200%_100%] animate-shimmer" />
      <div className="h-32 rounded-xl bg-gradient-to-r from-sentinel-border/20 via-sentinel-border/40 to-sentinel-border/20 bg-[length:200%_100%] animate-shimmer" />
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {[1,2,3].map(i => (
          <div key={i} className="h-24 rounded-xl bg-gradient-to-r from-sentinel-border/20 via-sentinel-border/40 to-sentinel-border/20 bg-[length:200%_100%] animate-shimmer" style={{ animationDelay: `${i*120}ms` }} />
        ))}
      </div>
    </div>
  );
}

export function App() {
  const { publicKey, signMessage, connected } = useWallet();
  const connectedWallet = publicKey?.toBase58() ?? null;
  const [authStatus, setAuthStatus] = useState<'idle' | 'authing' | 'authed' | 'unsupported' | 'error'>('idle');
  const [authAttempt, setAuthAttempt] = useState(0);
  const [authError, setAuthError] = useState<string | null>(null);

  const [view, setView] = useState<View>(() => {
    const params = new URLSearchParams(window.location.search);
    const claimId = params.get('claim');
    if (claimId && claimId.length >= 10) return { page: 'claim', claimId };
    const risk = params.get('risk');
    if (risk && risk.length >= 32) return { page: 'risk', mint: risk };
    return { page: 'landing' };
  });
  const [tokens, setTokens] = useState<TokenFeedItem[]>([]);
  const [feedLoading, setFeedLoading] = useState(true);
  const [feedError, setFeedError] = useState(false);

  // Wallet auth: real Ed25519 signature session (worker verifies)
  useEffect(() => {
    if (!connected || !connectedWallet) {
      setAuthStatus('idle');
      // Important: do NOT clear session on transient disconnect during refresh.
      // Wallet-adapter often initializes with connected=false before rehydration.
      setAuthError(null);
      return;
    }

    // If wallet can't sign messages, we still function, but without verified session.
    if (!signMessage) {
      setAuthStatus('unsupported');
      setSessionToken(null);
      setSessionWallet(null);
      setAuthError('Wallet does not support message signing (signMessage unavailable).');
      return;
    }

    // If we already have a session token for THIS wallet, keep it.
    const existing = getSessionToken();
    const existingWallet = getSessionWallet();
    if (existing && existingWallet === connectedWallet) {
      setAuthStatus('authed');
      setAuthError(null);
      return;
    }
    // Token exists but wallet changed (or wallet not stored) → re-auth.
    if (existing && existingWallet && existingWallet !== connectedWallet) {
      setSessionToken(null);
      setSessionWallet(null);
    }

    let cancelled = false;
    setAuthStatus('authing');
    setAuthError(null);

    (async () => {
      try {
        const ch = await authChallenge(connectedWallet);
        const sig = await signMessage(new TextEncoder().encode(ch.message));
        const verified = await authVerify({
          challengeId: ch.challengeId,
          wallet: connectedWallet,
          signature: bs58.encode(sig),
        });
        if (cancelled) return;
        setSessionToken(verified.sessionToken);
        setSessionWallet(verified.wallet);
        setAuthStatus('authed');
        setAuthError(null);
      } catch (e) {
        if (cancelled) return;
        setSessionToken(null);
        setSessionWallet(null);
        setAuthStatus('error');
        const msg = e instanceof Error ? e.message : 'Auth failed';
        setAuthError(msg);
        // Helpful for debugging Phantom / wallet-adapter behavior
        console.error('Wallet auth failed:', msg, { wallet: connectedWallet });
      }
    })();

    return () => { cancelled = true; };
  }, [connected, connectedWallet, signMessage, authAttempt]);


  const loadFeed = useCallback(() => {
    setFeedLoading(true);
    setFeedError(false);
    fetchTokenFeed()
      .then(setTokens)
      .catch(() => setFeedError(true))
      .finally(() => setFeedLoading(false));
  }, []);

  useEffect(() => { loadFeed(); }, [loadFeed]);

  useEffect(() => {
    if (view.page !== 'feed') return;
    const id = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      loadFeed();
    }, 60_000);
    return () => clearInterval(id);
  }, [view.page, loadFeed]);

  const handleSearch = (mint: string) => setView({ page: 'risk', mint });
  const goFeed     = () => setView({ page: 'feed' });
  const goXRay     = () => setView({ page: 'xray' });
  const goAlerts   = () => setView({ page: 'alerts' });
  const goCreator  = (wallet: string) => setView({ page: 'creator', wallet });
  const goTokenLaunch = () => setView({ page: 'token-launch' });

  const tabGoHandlers: Record<TabId, () => void> = {
    discover: goFeed, xray: goXRay, alerts: goAlerts, 'token-launch': goTokenLaunch,
  };

  const activeTab: TabId =
    view.page === 'alerts' || view.page === 'creator' ? 'alerts'       :
    view.page === 'xray'                              ? 'xray'         :
    view.page === 'token-launch'                      ? 'token-launch' :
    'discover';

  if (view.page === 'landing') return <LandingPage onLaunch={goFeed} onScanToken={handleSearch} />;

  if (view.page === 'claim') {
    return (
      <ClaimPage
        claimId={view.claimId}
        onDone={() => {
          window.history.replaceState({}, '', window.location.pathname);
          goFeed();
        }}
      />
    );
  }

  return (
    <div className="min-h-screen flex flex-col">
      {/* Header */}
      <header className="border-b border-sentinel-border/50 px-4 sm:px-6 py-3 flex items-center justify-between backdrop-blur-md bg-sentinel-bg/90 sticky top-0 z-20">
        <button onClick={goFeed} className="flex items-center gap-2 hover:opacity-90 transition-opacity group shrink-0">
          <SentinelLogo size={28} />
          <h1 className="text-base font-bold leading-tight tracking-tight bg-gradient-to-r from-sentinel-accent via-cyan-300 to-sentinel-accent-2 bg-clip-text text-transparent">Sentinel</h1>
        </button>

        {/* Nav pills — desktop */}
        <nav className="hidden md:flex items-center gap-0.5 flex-1 justify-center min-w-0">
          {ALL_TABS.map(tab => (
            <NavTab key={tab.id} active={activeTab === tab.id} onClick={tabGoHandlers[tab.id]}>
              {tab.label}
            </NavTab>
          ))}
        </nav>

        <div className="flex items-center gap-2 shrink-0">
          {connectedWallet && (
            <>
              <span
                className={`hidden lg:inline-flex text-[11px] px-2 py-1 rounded-md border ${
                authStatus === 'authed'
                  ? 'border-emerald-400/20 text-emerald-300 bg-emerald-400/5'
                  : authStatus === 'authing'
                    ? 'border-cyan-400/20 text-cyan-200 bg-cyan-400/5'
                    : authStatus === 'unsupported'
                      ? 'border-yellow-400/20 text-yellow-200 bg-yellow-400/5'
                      : authStatus === 'error'
                        ? 'border-red-400/20 text-red-200 bg-red-400/5'
                        : 'border-sentinel-border/40 text-gray-400 bg-white/5'
              }`}
              title={
                authStatus === 'authed'
                  ? 'Wallet authenticated (signature verified)'
                  : authStatus === 'authing'
                    ? 'Authenticating wallet…'
                    : authStatus === 'unsupported'
                      ? 'Wallet does not support message signing; using read-only mode'
                      : authStatus === 'error'
                        ? `Wallet auth failed: ${authError ?? 'unknown error'}`
                        : 'Not authenticated'
              }
            >
              {authStatus === 'authed'
                ? 'Verified'
                : authStatus === 'authing'
                  ? 'Verifying…'
                  : authStatus === 'unsupported'
                    ? 'Unverified'
                    : authStatus === 'error'
                      ? 'Auth failed'
                      : 'Unverified'}
              </span>
              {authStatus === 'error' && (
                <button
                  onClick={() => {
                    setSessionToken(null);
                    setAuthStatus('idle');
                    setAuthError(null);
                    setAuthAttempt((n) => n + 1);
                  }}
                  className="hidden lg:inline-flex text-[11px] px-2 py-1 rounded-md border border-red-400/20 text-red-200 bg-red-400/5 hover:bg-red-400/10 transition-colors"
                  title="Retry wallet authentication"
                >
                  Retry
                </button>
              )}
            </>
          )}
          <a
            href="https://bags.fm"
            target="_blank"
            rel="noopener"
            className="text-xs text-gray-500 hover:text-sentinel-accent transition-colors px-2.5 py-1.5 rounded-lg border border-sentinel-border/50 hover:border-sentinel-accent/30 hidden lg:block"
          >
            bags.fm ↗
          </a>
          <WalletMultiButton className="!bg-sentinel-accent/15 !border !border-sentinel-accent/25 !rounded-lg !h-9 !text-xs !font-medium !text-sentinel-accent hover:!bg-sentinel-accent/25 !transition-all !px-3" />
        </div>
      </header>

      {/* Auth error banner (visible, non-hover) */}
      {authStatus === 'error' && authError && (
        <div className="px-4 sm:px-6 py-2 border-b border-red-400/15 bg-red-400/5">
          <div className="max-w-5xl mx-auto w-full flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="text-[11px] uppercase tracking-wider text-red-200/80 font-medium">
                Wallet auth failed
              </div>
              <div className="text-xs text-red-200/80 break-words">
                {authError}
              </div>
            </div>
            <button
              onClick={() => {
                try { navigator.clipboard.writeText(authError); } catch { /* ignore */ }
              }}
              className="shrink-0 text-[11px] px-2 py-1 rounded-md border border-red-400/20 text-red-200/80 hover:bg-red-400/10 transition-colors"
              title="Copy error"
            >
              Copy
            </button>
          </div>
        </div>
      )}

      {/* Mobile nav */}
      <div className="md:hidden px-4 py-2 border-b border-sentinel-border/30 bg-sentinel-surface/10 flex items-center gap-1.5 overflow-x-auto scrollbar-hide">
        {ALL_TABS.map(tab => (
          <button
            key={tab.id}
            onClick={tabGoHandlers[tab.id]}
            className={`flex-shrink-0 px-3 py-1.5 text-xs font-medium rounded-lg transition-all ${
              activeTab === tab.id
                ? 'bg-sentinel-accent/15 text-sentinel-accent border border-sentinel-accent/25'
                : 'text-gray-500 hover:text-gray-300 border border-sentinel-border/40'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Search bar */}
      {view.page === 'feed' && (
        <div className="px-4 sm:px-6 py-4 flex justify-center border-b border-sentinel-border/30 bg-sentinel-surface/10">
          <SearchBar onSearch={handleSearch} />
        </div>
      )}

      {/* Content */}
      <main className="flex-1 px-4 sm:px-6 py-6 max-w-5xl mx-auto w-full">
        <ErrorBoundary key={view.page}>
          <Suspense fallback={<PageLoader />}>
            {view.page === 'feed' && (
              <>
                {feedError && !feedLoading && (
                  <div className="mb-4 p-3 bg-sentinel-danger/5 border border-sentinel-danger/20 rounded-lg flex items-center justify-between">
                    <p className="text-sm text-gray-400">Failed to load token feed.</p>
                    <button onClick={loadFeed} className="text-xs text-sentinel-accent hover:underline">Retry</button>
                  </div>
                )}
                <FeedPage tokens={tokens} loading={feedLoading} onSelectToken={handleSearch} />
              </>
            )}
            {view.page === 'risk'     && <RiskDetailPage mint={view.mint} onBack={goFeed} connectedWallet={connectedWallet} />}
            {view.page === 'xray'     && <WalletXRayPage onViewToken={handleSearch} connectedWallet={connectedWallet} />}
            {view.page === 'alerts'   && <AlertFeedPage onViewToken={handleSearch} onViewCreator={goCreator} />}
            {view.page === 'creator'  && <CreatorProfilePage wallet={view.wallet} onBack={goAlerts} onViewToken={handleSearch} />}
            {view.page === 'token-launch' && <TokenLaunchPage />}
          </Suspense>
        </ErrorBoundary>
      </main>

      {/* Footer */}
      <footer className="border-t border-sentinel-border/30 px-6 py-4 flex items-center justify-between text-[11px] text-gray-600">
        <div className="flex items-center gap-2">
          <SentinelLogo size={14} />
          <span>Sentinel v0.13.0</span>
        </div>
        <a href="https://bags.fm" target="_blank" rel="noopener" className="text-sentinel-accent/60 hover:text-sentinel-accent transition-colors">
          bags.fm ↗
        </a>
      </footer>
    </div>
  );
}
