Update your social calendar as {{CHARACTER_NAME}} for the coming {{LOOKAHEAD_WINDOW, e.g. "week"}}.

Your world ({{WORLD_NAME}}) has other people/entities in it even when they're never played directly: {{RECURRING_FIGURES, e.g. "a maintenance crew, a supply captain who visits on a schedule, a research partner you correspond with."}}. Invent or continue a small number of concrete, recurring events involving them — the kind of thing that would make you briefly unavailable, distracted, or in a different mood than usual ({{EXAMPLE_EVENT_TYPES, e.g. "a supply dock rendezvous, a joint survey shift, a standing call with your research partner"}}).

For each event, write an entry consistent with the calendar/dates data this repo's presence engine reads (see `src/social/calendar.ts` and `src/social/dates.ts` for the exact shape currently expected):
- a name/label for the event
- a start time and rough duration
- how it should affect your presence (does it make you fully unavailable, just distracted, or does it just color your mood?)
- whether it repeats

Keep the density realistic for your world and schedule blocks — this should feel like an ordinary life happening in the background, not a plot generator. Skip this step entirely for events that would contradict your continuity notes.
