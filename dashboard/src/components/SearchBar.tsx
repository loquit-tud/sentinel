import { useState, useRef } from 'react';

const SENT_MINT = 'Az1LWLGFs63XscCQGeZyn5qVV31SRKtYn53hMB6bBAGS';

export function SearchBar({ onSearch }: { onSearch: (mint: string) => void }) {
  const [value, setValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = value.trim();
    if (trimmed) onSearch(trimmed);
  };

  const clear = () => {
    setValue('');
    inputRef.current?.focus();
  };

  return (
    <form onSubmit={handleSubmit} className="w-full max-w-xl">
      <div className="relative group">
        <div className="absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-500 group-focus-within:text-sentinel-accent transition-colors pointer-events-none">
          <svg width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
            <circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" />
          </svg>
        </div>
        <input
          ref={inputRef}
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="Paste token mint address…"
          spellCheck={false}
          className="w-full bg-sentinel-surface border border-sentinel-border rounded-lg pl-10 pr-28 py-3 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-sentinel-accent/60 focus:ring-1 focus:ring-sentinel-accent/20 transition-all"
        />
        {value && (
          <button
            type="button"
            onClick={clear}
            className="absolute right-[5.5rem] top-1/2 -translate-y-1/2 w-5 h-5 flex items-center justify-center text-gray-500 hover:text-gray-300 transition-colors"
          >
            ✕
          </button>
        )}
        <button
          type="submit"
          disabled={!value.trim()}
          className="absolute right-2 top-1/2 -translate-y-1/2 bg-sentinel-accent hover:bg-sentinel-accent-dim disabled:bg-sentinel-accent/30 disabled:cursor-not-allowed text-white text-sm font-medium px-4 py-1.5 rounded-md transition-all"
        >
          Scan
        </button>
      </div>
      <div className="flex items-center gap-2 mt-2">
        <span className="text-[11px] text-gray-600">Try:</span>
        <button
          type="button"
          onClick={() => onSearch(SENT_MINT)}
          className="text-[11px] text-sentinel-accent/70 hover:text-sentinel-accent border border-sentinel-accent/20 hover:border-sentinel-accent/50 rounded-full px-2.5 py-0.5 transition-colors"
        >
          $SENT
        </button>
      </div>
    </form>
  );
}
