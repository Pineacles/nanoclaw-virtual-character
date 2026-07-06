/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', '-apple-system', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'monospace'],
      },
      colors: {
        // NC design tokens — all reference CSS custom properties
        // Usage: bg-nc-bg, text-nc-text, border-nc-border, etc.
        nc: {
          bg: 'var(--nc-bg)',
          surface: 'var(--nc-surface)',
          'surface-alt': 'var(--nc-surface-alt)',
          'surface-hi': 'var(--nc-surface-hi)',
          border: 'var(--nc-border)',
          'border-soft': 'var(--nc-border-soft)',
          text: 'var(--nc-text)',
          'text-muted': 'var(--nc-text-muted)',
          'text-dim': 'var(--nc-text-dim)',
          accent: 'var(--nc-accent)',
          'accent-soft': 'var(--nc-accent-soft)',
          'bubble-user': 'var(--nc-bubble-user)',
          'badge-memory-bg': 'var(--nc-badge-memory-bg)',
          'badge-memory-fg': 'var(--nc-badge-memory-fg)',
          'badge-memory-bd': 'var(--nc-badge-memory-bd)',
          'badge-wf-bg': 'var(--nc-badge-wf-bg)',
          'badge-wf-fg': 'var(--nc-badge-wf-fg)',
          'badge-wf-bd': 'var(--nc-badge-wf-bd)',
          warning: 'var(--nc-warning)',
          'warning-soft': 'var(--nc-warning-soft)',
          'warning-text': 'var(--nc-warning-text)',
          'end-call': 'var(--nc-end-call)',
          'voice-listening': 'var(--nc-voice-listening)',
        },
      },
      borderRadius: {
        pill: '999px',
        composer: '22px',
        bubble: '18px',
        card: '14px',
        btn: '8px',
        brand: '7px',
      },
      boxShadow: {
        composer: '0 1px 2px rgba(0,0,0,0.06), 0 8px 24px rgba(0,0,0,0.05)',
        send: '0 2px 8px var(--nc-accent-shadow), inset 0 1px 0 rgba(255,255,255,0.25)',
      },
      maxWidth: {
        chat: '960px',
        suggestions: '560px',
      },
      animation: {
        'nc-bounce': 'nc-bounce 1.2s ease-in-out infinite',
        'nc-pulse': 'nc-pulse 1.4s ease-in-out infinite',
        'nc-blink': 'nc-blink 1s infinite',
        'nc-mood-breathe': 'nc-mood-breathe 5.5s ease-in-out infinite',
        'nc-skeleton': 'nc-skeleton 1.6s linear infinite',
        'nc-spin': 'nc-spin 1s linear infinite',
        'nc-msg': 'nc-msg 280ms var(--nc-ease-entrance) forwards',
        'nc-tool-slide': 'nc-tool-slide 220ms var(--nc-ease-entrance) forwards',
      },
      keyframes: {
        'nc-bounce': {
          '0%, 80%, 100%': { transform: 'translateY(0)', opacity: '0.4' },
          '40%': { transform: 'translateY(-4px)', opacity: '1' },
        },
        'nc-pulse': {
          '0%, 100%': { opacity: '1', transform: 'scale(1)' },
          '50%': { opacity: '0.5', transform: 'scale(1.3)' },
        },
        'nc-blink': {
          '0%, 50%': { opacity: '1' },
          '51%, 100%': { opacity: '0' },
        },
        'nc-mood-breathe': {
          '0%, 100%': { transform: 'scale(1)', opacity: '0.85' },
          '50%': { transform: 'scale(1.06)', opacity: '1' },
        },
        'nc-skeleton': {
          '0%': { backgroundPosition: '-200% 0' },
          '100%': { backgroundPosition: '200% 0' },
        },
        'nc-spin': {
          '0%': { transform: 'rotate(0deg)' },
          '100%': { transform: 'rotate(360deg)' },
        },
        'nc-msg': {
          '0%': { opacity: '0', transform: 'translateY(8px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        'nc-tool-slide': {
          '0%': { opacity: '0', transform: 'translateX(-8px) scale(0.96)' },
          '100%': { opacity: '1', transform: 'translateX(0) scale(1)' },
        },
      },
      transitionTimingFunction: {
        'nc-entrance': 'cubic-bezier(0.16, 1, 0.3, 1)',
        'nc-state': 'cubic-bezier(0.4, 0, 0.2, 1)',
        'nc-confirm': 'cubic-bezier(0.34, 1.56, 0.64, 1)',
      },
    },
  },
  plugins: [],
};
