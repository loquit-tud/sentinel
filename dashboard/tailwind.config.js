/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        sentinel: {
          bg: '#0a0e1a',
          surface: '#111827',
          border: '#1f2937',
          accent: '#06b6d4',
          'accent-dim': '#0891b2',
          'accent-2': '#a855f7',
          'accent-2-dim': '#7e22ce',
          safe: '#22c55e',
          caution: '#eab308',
          danger: '#ef4444',
          rug: '#991b1b',
        },
      },
      keyframes: {
        shimmer: {
          '0%':   { backgroundPosition: '200% 0' },
          '100%': { backgroundPosition: '-200% 0' },
        },
        'fade-in': {
          '0%':   { opacity: '0', transform: 'translateY(4px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
      },
      animation: {
        shimmer: 'shimmer 1.6s ease-in-out infinite',
        'fade-in': 'fade-in 240ms ease-out',
      },
    },
  },
  plugins: [],
};
