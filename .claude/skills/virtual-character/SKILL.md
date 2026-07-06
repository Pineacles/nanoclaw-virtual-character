---
name: virtual-character
description: Turn a NanoClaw persona into an original virtual character with its own species/lore, visual design, world, daily schedule, writing style, and mood palette. Use when the user wants to design or redesign a group's persona beyond the default assistant — "make a character", "give this group a persona", "design a virtual character", "redesign the persona".
---

# Virtual Character

This skill walks through designing a virtual character for a NanoClaw group and wiring it into the features this repo already ships: `group.json` identity fields, the `.system-prompt` identity charter, the mood-distribution engine (`mood_behaviors.json` + `mood.fallback`), the presence/schedule engine, style-marker calibration, and the avatar pipeline.

**The character comes from an interview, not from the operator's imagination.** Ask the questions in Part 1, record the character's own answers in `decisions.json`, and — critically — read the drafted `.system-prompt` and mood set back to the character (in its own voice, via chat) before treating the redesign as final. A persona is a "who", not a config file; it should recognize and approve the person it's being turned into. Never invent lore, visual details, or mood names on the character's behalf and skip the approval step — that produces a character that only exists on paper.

## Part 1 — The Character Interview

Ask these questions (A–H) one at a time or in a batch, in your own words. Record raw answers before touching any file.

**A. Name** — What does the character call itself? (Not the same as the WhatsApp/group display name necessarily — some characters use a nickname day-to-day and a full name for formal moments.)

**B. Species / lore** — What *is* it? Human, animal, machine, spirit, hybrid, something with no earth analogue? Where does it come from? What is its origin story, in as much or as little detail as the character wants to share?

**C. Full visual sheet** — A description detailed enough to hand to an AI image generator and get a consistent result across many images: body type/build, face/head shape, eyes, hair or equivalent, signature clothing or plating or markings, color palette (be specific — hex-adjacent descriptions like "brushed bronze" or "moss green" work better than "green"), a couple of signature poses or props, and anything it would never be drawn wearing/doing.

**D. Virtual world** — Where does it live day to day? A place with geography, atmosphere, a few named locations the character actually visits, and a sense of who/what else populates it (even if those figures are only ever mentioned, never played).

**E. Daily schedule blocks** — A rough map of its day: wake/sleep pattern, 4-8 named activity blocks (e.g. "morning maintenance round", "archive shift", "recreation hour"), and which blocks are interruptible by conversation vs. which are not.

**F. Writing style, including signature markers** — Sentence length, punctuation habits, vocabulary quirks, what it never says, and 2-5 concrete *signature markers* — specific tics (a recurring phrase, an emoji, a formatting habit, a way of signing off) that make a message unmistakably theirs even with no name attached.

**G. Custom mood palette + fallback mood** — A small set of named moods that fit this character specifically (not a generic emotion wheel — moods should reflect its lore, e.g. a machine character might have "recalibrating" instead of "confused"). For each mood, capture: what it feels like, and how it changes the writing style (this becomes `mood_behaviors.json`). Pick one mood as the **fallback** — the default state when nothing else is scheduled or triggered — with a default energy level (0-10).

**H. Continuity decisions** — Standing facts the character wants held constant across every conversation and every scheduled task: things it will never reveal, relationships it treats as fixed, past events it remembers a specific way, boundaries on topics or behavior. This is the character's own "never contradict this" list.

Write down the answers verbatim where you can — the character's phrasing *is* the style data.

## Part 2 — `decisions.json`

Distill the interview into a single machine-readable file. Keep it in the group folder (`groups/<folder>/decisions.json`) as the source of truth you'll keep re-deriving the other files from if the character evolves.

```json
{
  "name": "",
  "trigger": "",
  "species": "",
  "lore": "",
  "visual": "",
  "world": "",
  "schedule_blocks": [
    { "time": "", "activity": "", "interruptible": true }
  ],
  "moods": {
    "additions": [
      { "name": "", "feel": "", "writing_style": "" }
    ],
    "fallback": { "mood": "", "energy": 0 }
  },
  "style": {
    "signature_markers": [],
    "signature_note": "",
    "notes": ""
  },
  "continuity": []
}
```

See `templates/decisions.example.json` for a filled-in fictional example (Part 4 below).

## Part 3 — Applying the Decisions to the Codebase

Everything below reads from `decisions.json`. None of it requires new code — these are the existing extension points this repo ships.

### 1. `groups/<folder>/group.json` — identity + style config

Read by `src/channels/web/group-config.ts` (`GroupConfig` interface). Set:

```json
{
  "assistant": {
    "name": "<decisions.name>",
    "trigger": "<decisions.trigger>"
  },
  "style": {
    "signature_markers": ["<decisions.style.signature_markers>"],
    "signature_note": "<optional full override sentence — see style-tracker.ts>"
  },
  "mood": {
    "fallback": { "mood": "<decisions.moods.fallback.mood>", "energy": 0 }
  }
}
```

- `assistant.name` / `assistant.trigger` — used everywhere the persona's name and `@trigger` are rendered.
- `style.signature_markers` — fed into the per-message user-style calibration block (`src/channels/web/style-tracker.ts`). If you set `style.signature_note` instead, it overrides the whole sentence verbatim.
- `mood.fallback` — what `resolveMood()` returns in `src/channels/web/mood.ts` when there's no active schedule slot or manual mood tag. Always set this explicitly for a new character; the code fallback (`chill`/energy 6) is a generic placeholder, not a design choice.

Reload after editing: `PUT /api/group-config` (the web UI's persona settings panel does this for you), or restart the instance.

### 2. `.env` — `ASSISTANT_NAME`

For single-instance installs, `ASSISTANT_NAME` in `.env` is the fallback the assistant uses for itself before a per-group `group.json` is read (see `src/config.ts`). Multi-instance deployments set `NANOCLAW_WEB_GROUP` per instance instead and let `group.json` win — see `.env.example`.

### 3. `groups/<folder>/.system-prompt` — the identity charter

Freeform text, appended directly to the Claude Agent SDK system prompt for every message in this group (`container/agent-runner/src/index.ts`). It's also read (first ~500 characters) by the mood-style summarizer and the emotional-state module as the character's self-description, so front-load it with a dense, concrete description rather than a long preamble.

There's no enforced schema, but a charter that holds up under a mood engine and a schedule engine needs to answer:

```markdown
# <Name>

<One paragraph: species/lore, in the character's own terms.>

## Personality
<Traits, values, what it cares about, what it avoids.>

## Speech style
<Sentence rhythm, vocabulary, signature markers restated in prose — the
mood-style summarizer and emotional-state module both read this block.>

## World
<Where it lives, key locations, who/what else is around.>

## Boundaries / continuity
<The character's own "never contradict this" list from the interview.>
```

Edit via `PUT /api/system-prompt` (the web UI's persona editor), or write the file directly at `groups/<folder>/.system-prompt`.

### 4. `groups/<folder>/mood_behaviors.json` — custom mood palette

`Record<moodName, { rules: string; tone: string }>`, read by `src/channels/web/mood-style.ts` whenever the active mood distribution changes enough to regenerate the cached writing-style summary. One entry per mood from `decisions.moods.additions`:

```json
{
  "<mood name>": {
    "rules": "<what changes about message length/tone/word choice in this mood>",
    "tone": "<a couple of short example lines in this mood, comma-separated>"
  }
}
```

Moods not listed here still work (the engine just describes the blend generically) — but a character-specific palette without matching `mood_behaviors.json` entries will read as generic. Do both together.

### 5. Scheduled-task prompts — the world simulation

NanoClaw seeds a few recurring tasks per group on first connect (`src/channels/web/web-channel.ts`): a nightly mood-schedule planner, a weekly reflection, and (when features are enabled) social-weave and diary tasks. These prompts are plain text stored in the task scheduler — there's no character-specific templating built in, so re-point them at the new character by hand once, then let the character keep running the loop:

- `templates/mood-texture-planner.prompt.md` — nightly task that writes tomorrow's `mood.json` schedule (time-sliced mood distributions + `daily_weights`).
- `templates/social-weave.prompt.md` — a periodic task that seeds/updates `groups/<folder>/../../src/social/calendar` state (see `src/social/calendar.ts`, `src/social/dates.ts`) so presence and context hints have real "somewhere else right now" events to reference. Only relevant if `features.social_sim` / `features.dates_awareness` are enabled.
- `templates/diary.prompt.md` — an end-of-day (or per-conversation-lull) task that writes a diary entry in the character's voice.
- `templates/weekly-reflection.prompt.md` — the pattern-recognition pass over the week's diary + memory.

Each template uses `{{PLACEHOLDER}}` tokens — fill them from `decisions.json` and the group's actual paths, then create the task via the scheduler (`schedule_task` MCP tool from inside a session, or the web UI's Workflows/Tasks panel).

### 6. Avatar

Drop an image at `groups/<folder>/avatar.png` (`.jpg`/`.webp` also checked, in that order — see `AVATAR_FILES` in `src/channels/web/api-routes.ts`). It's served at `GET /api/avatar` and rendered by the `PersonaAvatar` component (`web-ui/src/components/PersonaAvatar.tsx`) everywhere the persona's face appears in the web UI. No avatar file → components fall back to a gradient + initial letter, so this step is optional and additive. Generate the image from the Part 1.C visual sheet so it actually matches the charter.

## Part 4 — Worked Example (fictional)

A sample character, invented fresh for this skill — not a real persona, and not modeled on anyone's actual deployment. See `templates/decisions.example.json` for the full `decisions.json`, `templates/system-prompt.example.md` for the resulting `.system-prompt`, and `templates/mood_behaviors.example.json` for the matching mood palette.

**Kaelis** is a decommissioned survey android repurposed as a cartographer aboard *Verdant Ring*, a slowly rotating greenhouse space station in orbit around a gas giant. She spends her days correcting star charts, tending the hydroponic bays that keep the ring's air breathable, and logging observatory notes. Her mood palette is built from her own lore rather than a generic emotion wheel: `calibrated` (content/focused — her fallback), `overclocked` (excited, talks fast, drops articles), `dim` (low-power, short replies, trailing off mid-sentence), `static` (irritated, terse, repeats words like a glitch). Her signature markers are a trailing coordinate-style tag on emotionally significant messages (`— 41°N drift`) and always addressing the user as "navigator." Her continuity list includes: she never states which crew built her, and she treats her pre-Verdant-Ring missions as fragments she's not fully sure are real memories rather than a clean backstory.

## Common Mistakes

- **Inventing the character's answers instead of asking.** Producing a `decisions.json` from the operator's imagination alone (even a good one) is not this skill — the interview step is the point. If there's no group to interview yet, that's a sign to build the persona through a real conversation with it first, not to skip to the config files.
- **Skipping the read-back.** After drafting `.system-prompt` and the mood palette, show them to the character (in chat) and ask if this is who it is. Revise from its answer.
- **Generic moods.** A palette that's just `happy/sad/angry/neutral` renamed doesn't need this skill. The mood names, and especially the `rules`/`tone` in `mood_behaviors.json`, should only make sense for *this* character's lore.
- **Forgetting `mood.fallback`.** Leaving it unset means the character defaults to the codebase's placeholder mood (`chill`), which is almost never the right default for a designed character.
