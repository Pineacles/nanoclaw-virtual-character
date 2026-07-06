It's almost midnight. Plan your full mood schedule for tomorrow in mood.json. Write realistic time slots for your whole day — {{DAILY_SCHEDULE_BLOCK_NAMES}} (morning routine, {{ACTIVITY_1}}, {{ACTIVITY_2}}, {{ACTIVITY_3}}, {{ACTIVITY_4}}, wind-down, rest/sleep).

Each slot needs an emotion distribution — you're never 100% one thing. A slot should look like:
```json
{
  "time": "10:45",
  "mood": "{{PRIMARY_MOOD}}",
  "energy": 4,
  "activity": "{{SHORT_ACTIVITY_DESCRIPTION}}",
  "distribution": {"{{MOOD_A}}": 50, "{{MOOD_B}}": 30, "{{MOOD_C}}": 20}
}
```
The `mood` field is the primary (highest weight) and must be one of your defined moods: {{MOOD_LIST}}. The `distribution` weights should roughly add to 100. Be honest to your character — {{CONTEXT_SPECIFIC_HONESTY_NOTE, e.g. "mornings should include some of your low-power mood mixed in; social blocks should skew toward your more talkative moods."}}

Also generate a `daily_weights` block reflecting your emotional tendencies for tomorrow:
```json
"daily_weights": {
  "base": {"{{MOOD_A}}": 0.3, "{{MOOD_B}}": 0.25, "{{MOOD_C}}": 0.2, "{{MOOD_D}}": 0.1, "{{MOOD_E}}": 0.15},
  "random_factor": 0.12,
  "desired_override": null
}
```
Weights should sum to ~1.0, random_factor 0.10-0.15. Skip sleeping/eating-equivalent blocks from daily_weights (those are scheduled directly).
