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
    <form onSubmit={handleSubmit} className="w-full max-w-2xl">
      <div className="relative group">
        <div className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-500 group-focus-within:text-cyan-400 transition-colors duration-200 pointer-events-none">
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
          className="w-full bg-slate-900/60 border border-slate-700/60 rounded-2xl pl-11 pr-32 py-4 text-sm text-white placeholder-slate-600 shadow-[0_2px_24px_rgba(0,0,0,0.3)] backdrop-blur-md focus:outline-none focus:border-cyan-500/60 focus:ring-2 focus:ring-cyan-500/20 focus:shadow-[0_0_0_2px_rgba(6,182,212,0.15),0_4px_32px_rgba(6,182,212,0.08)] transition-all duration-200"
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
          className="absolute right-2 top-1/2 -translate-y-1/2 bg-gradient-to-r from-cyan-500 to-cyan-400 hover:from-cyan-400 hover:to-cyan-300 disabled:from-slate-700 disabled:to-slate-700 disabled:text-slate-500 disabled:cursor-not-allowed text-slate-950 text-sm font-bold px-5 py-2.5 rounded-xl shadow-[0_0_16px_rgba(6,182,212,0.25)] hover:shadow-[0_0_24px_rgba(6,182,212,0.4)] disabled:shadow-none transition-all duration-200"
        >
          Scan
        </button>
      </div>
      <div className="flex items-center gap-2 mt-2">
        <span className="text-[11px] text-gray-600">Try:</span>
        <button
          type="button"
          onClick={() => onSearch(SENT_MINT)}
          className="text-[11px] text-cyan-400/60 hover:text-cyan-300 border border-cyan-500/20 hover:border-cyan-500/50 rounded-full px-2.5 py-0.5 transition-all hover:bg-cyan-500/5"
        >
          $SENT
        </button>
      </div>
    </form>
  );
}
