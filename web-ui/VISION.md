# Nanoclaw Frontend Vision

This is the source of truth for how the Nanoclaw web UI looks and feels. Read it before making any frontend change. Components, redesigns, refactors — all must align. If a need conflicts with this vision, raise it before coding so the vision evolves, not the implementation drifts.

## Core principles

1. **Calm, professional, a little personal.** Warm and human, never cute. The assistant speaks to a specific user; first-person warmth in copy is welcome ("Good morning, [user]"). Tone is restrained, not chirpy.
2. **Brand identity = the coral gradient.** Coral `#ff7348` (light) / `#ff906d` (dark) → pink. Used SPARINGLY on small surfaces only: send button, brand mark, persona pill, "Good morning" headline text fill, mood dot. Never on chrome backgrounds. Never on long text runs.
3. **Gradients structure, never decorate.** Background gradient meshes are full-bleed but soft and pushed to corners — they sit under empty space and forms, never under chrome (sidebar, top bars, composer, message column always solid). Two intensities: `bgGreeting` for empty/greeting states, `bgMesh` (subtler) for filled/streaming where text traffic is high.
4. **Mood blob is quiet.** The agent's emotional state is signaled, not shouted. 9-10px dot in sidebar footer and next to bot sender label. 5.5s breathing pulse via `nc-mood-breathe`. Coral when focused; the per-mood color when not.
5. **Conventional patterns over invention.** No novel interactions. Bottom tab bar on mobile (Slack/iOS pattern: Chat / Memory / Flows / Tasks / More). Sidebar nav on desktop. Familiar chat bubble layout. Generic web-app phone shell on mobile (NOT iOS chrome — Nanoclaw is a web app).
6. **2026 polish without 2018 bounce.** Spring physics on user-driven motion (drawers, tab indicators). Tactile feedback (0.96 press scale). Shared element transitions for context expansion. No heavy overshoots, no decorative motion on every element.
7. **Same quality everywhere.** Mobile and desktop are equal citizens. Settings has full parity (one column on mobile, bento grid on desktop — same content). Animations work in both. Theme works in both.

## Design tokens

(Source of truth: `web-ui/src/styles/tokens.css` + `tailwind.config.js`. Do not hardcode color values in components.)

### Color (light)

| Token | Value |
|---|---|
| bg | `oklch(0.985 0 0)` — pure neutral white |
| surface | `oklch(1 0 0)` |
| surfaceAlt | `oklch(0.975 0 0)` |
| surfaceHi | `oklch(0.95 0 0)` |
| border | `oklch(0.91 0 0)` |
| borderSoft | `oklch(0.94 0 0)` |
| text | `oklch(0.18 0 0)` |
| textMuted | `oklch(0.48 0 0)` |
| textDim | `oklch(0.62 0 0)` |
| accent | `#ff7348` |
| accentSoft | `oklch(0.96 0.025 35)` |
| bubbleUser | `oklch(0.955 0 0)` |
| bubbleBot | `transparent` |
| accentGradient | `linear-gradient(135deg, #ff8a5e 0%, #ff6a3d 60%, #ff5a7a 100%)` |
| bgGreeting | See `tokens.css` — large radial ellipses, coral+pink, top-center + bottom-right |
| bgMesh | See `tokens.css` — same but pushed to corners, lower opacity |

### Color (dark)

| Token | Value |
|---|---|
| bg | `oklch(0.16 0.005 60)` — warm dark, NOT black |
| surface | `oklch(0.19 0.006 60)` |
| surfaceAlt | `oklch(0.18 0.006 60)` |
| surfaceHi | `oklch(0.235 0.007 60)` |
| border | `oklch(0.27 0.007 60)` |
| borderSoft | `oklch(0.23 0.006 60)` |
| text | `oklch(0.97 0.004 60)` |
| textMuted | `oklch(0.68 0.008 60)` |
| textDim | `oklch(0.55 0.008 60)` |
| accent | `#ff906d` |
| accentSoft | `oklch(0.28 0.04 35)` |
| accentGradient | `linear-gradient(135deg, #ffa37e 0%, #ff7c52 60%, #ff5e8a 100%)` |

### Badge tokens (theme-aware)

Memory badges (amber): `--nc-badge-memory-bg/fg/bd` — light uses muted amber, dark raises lightness for contrast.
Workflow badges (green): `--nc-badge-wf-bg/fg/bd` — same pattern.

### Typography

| Role | Font | Weight | Size | Line height |
|---|---|---|---|---|
| Sans (UI body) | Inter | 400/500/600/700 | 14.5px | 1.5 |
| Mono (paths, tools) | JetBrains Mono | 400/500 | ~11-12.5px | 1.4 |
| Small / labels | Inter | 400/500 | 12-13px | 1.4 |
| Greeting headline | Inter | 500 | 26px mobile / 32px desktop | 1.2 |

### Spacing rhythm

4 / 6 / 8 / 10 / 14 / 18 / 24 / 32. Padding/gaps prefer this scale.

### Radii

| Name | Value | Used for |
|---|---|---|
| `rounded-pill` | `999px` | Badges, status pills |
| `rounded-composer` | `22px` | Composer container |
| `rounded-bubble` | `18px` | Message bubbles |
| `rounded-card` | `14px` | Suggestion cards |
| `rounded-btn` | `8px` | Buttons, icon buttons |
| `rounded-brand` | `7px` | Brand mark, nav items |

### Shadows

Subtle. Composer desktop: `0 1px 2px rgba(0,0,0,0.06), 0 8px 24px rgba(0,0,0,0.05)`. Send button: `0 2px 8px var(--nc-accent-shadow), inset 0 1px 0 rgba(255,255,255,0.25)`. No big drop shadows on large surfaces.

## Component conventions

- One component per file. Sub-components used only locally can stay inline.
- Props are TypeScript interfaces, named `<Component>Props`. No `any`.
- Tokens consumed via Tailwind classes (`bg-nc-surface`, `text-nc-text`) or CSS variable (`var(--nc-accent)`). Hex/oklch literals in components is a code-review block.
- Mobile + desktop variants: responsive Tailwind classes preferred. Split into separate files only when layouts are fundamentally different (sidebar + main vs tab bar + stack).
- State management: React hooks. No global state library. `useChat`, `useWebSocket`, `useMood` patterns from legacy adapt cleanly.
- Files are ≤ 250 lines preferred, ≤ 400 hard cap. If longer, split.
- No CSS-in-JS, no inline `style={{...}}` except for dynamic values that can't be Tailwind classes (computed gradients, animated transforms, dynamic colors from data).
- Icon system: `web-ui/src/components/icons/index.tsx` exports named SVG components. Match the design's NC_ICON set exactly.

## Motion system

Tokens in `web-ui/src/styles/tokens.css`:

```css
--nc-ease-entrance: cubic-bezier(0.16, 1, 0.3, 1);  /* gentle ease-out */
--nc-ease-state:    cubic-bezier(0.4, 0, 0.2, 1);   /* Material standard */
--nc-ease-confirm:  cubic-bezier(0.34, 1.56, 0.64, 1); /* overshoot spring */
--nc-dur-micro:     140ms;
--nc-dur-standard:  240ms;
--nc-dur-expressive: 360ms;
```

Named motions (defined in `web-ui/src/styles/animations.css`):

| Class | Animation | Duration |
|---|---|---|
| `nc-msg` | Message arrival: fade + rise 8px | 280ms entrance |
| `nc-press` | Button press: scale 0.96 on `:active` | 100ms state |
| `nc-page` | Theme crossfade: bg/text/border transition | 240ms state (always on) |
| `nc-mood-breathe` | 5.5s loop, scale 1→1.06→1, opacity 0.85→1→0.85 | 5.5s loop |
| `nc-tab-indicator` | Tab indicator spring | 220ms confirm |
| `nc-bounce` | Thinking dots | 1.2s loop |
| `nc-pulse-anim` | Tool status dot | 1.4s loop |
| `nc-blink` | Streaming cursor | 1s loop |
| `nc-stagger-N` (N=0..5) | Entrance with delay = 60ms × N | — |
| `nc-bottom-sheet` | Slide up + scrim fade | 240ms entrance |
| `nc-tool-slide` | Tool badge slide from left + scale | 220ms entrance |
| `nc-skeleton` | Gradient sweep | 1.6s loop linear |

Rules:
- Animate only `transform` and `opacity` for 60fps. Use `will-change` only during the animation, remove after.
- Wrap every animation block in `@media (prefers-reduced-motion: no-preference) { ... }`. Reduced-motion users get only the theme color transition.
- No animation > 400ms in primary flows. Shared element / page transitions can hit 380ms; everything else stays ≤ 280ms.

## Accessibility

- Touch targets ≥ 44×44 px on mobile. Smaller affordances need padding to reach 44px.
- Every icon-only button has `aria-label`.
- Nav uses `<nav>` with proper roles. Lists are real `<ul>`/`<li>`.
- Focus-visible: 2px ring, accent color.
- Contrast: ≥ 4.5:1 body / ≥ 3:1 large text in BOTH themes. Verify badges in dark mode (the design's transcript flags this — memory + workflow badge colors are theme-aware via CSS vars).
- All page transitions and animations gate on `prefers-reduced-motion`.

## Backend contract (frozen)

- REST endpoints and WS events: see `web-ui-redesign-brief.md` sections "REST API the UI Calls" and "WebSocket Events".
- Auth: bearer token in `localStorage['nanoclaw_auth_token']`, sent as `Authorization: Bearer <token>` header.
- Don't change `src/channels/web/web-server.ts` or `src/channels/web/api-routes.ts` to fit the UI. Raise it first.
- Uploads served at `/uploads/<filename>?token=<token>`.
- Voice WebSocket at `/voice-ws`.
