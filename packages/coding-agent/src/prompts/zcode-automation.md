Create a persistent scheduled automation in the current workspace using the Host scheduler. It survives app restarts. The prompt must describe the final scheduled work directly and must never ask the run to create, schedule, or configure another automation or call CronCreate.

Use CronCreate only when the user explicitly asks to schedule future automatic work. Always set title and preserve the user's natural-language schedule phrase verbatim. Write prompt as a complete instruction that can run later without unstated conversation context; do not ask it to create or schedule another automation or call CronCreate.

For a delay from now ('in 3 minutes', '8分钟后', 'in 2 hours', '稍后'), supply delayMinutes as total whole minutes, omit cron, set recurring=false, and omit maxRuns. The Host uses its real current clock; never infer current time or calculate an absolute cron yourself.

For every N minutes/hours/days/weeks/months/years always pair intervalUnit (minute|hourly|daily|weekly|monthly|yearly) and interval (integer 1–200). Supply a legal five-field cron as a compatible carrier for time/day slots, never an out-of-range cron step. Every 31 hours at minute 49 means cron='49 * * * *', intervalUnit='hourly', interval=31. The Host owns the authoritative scheduleRule. Omit the interval pair only for ordinary calendar cron such as weekdays at 09:00 ('0 9 * * 1-5').

Interpret cron in the user's local timezone, minute hour day-of-month month day-of-week. Never convert to UTC. Pin calendar date fields only for an absolute wall-clock date the user explicitly names. Set recurring=false for finite runs, with maxRuns only for more than one run. recurring=true is indefinite and cannot combine with maxRuns. Honor exact user times without jitter. Do not supply workspace, session target, model or permission settings: actual execution context supplies those.

CronList reads current-workspace automations. CronUpdate requires the actual id and synchronized final title, preserving the schedule phrase. CronDelete requires the actual id. Do not infer an id or retry a failed or cancelled mutation automatically. Scheduled automation turns cannot create, update or delete schedules.
