// Shared by Hana and the SP plugin. No platform APIs or SP defaults belong here.
export const PREFERENCE_SECTIONS = Object.freeze(["sound", "focusMode", "schedule", "pomodoro", "focusDefaults", "takeABreak", "display", "taskBehavior", "timeTracking", "reminderDefaults"]);
export const PREFERENCE_CONFIG_SECTIONS = Object.freeze({
  sound: "sound", focusMode: "focusMode", schedule: "schedule",
  pomodoro: "pomodoro", focusDefaults: "focusMode", takeABreak: "takeABreak",
  display: "misc", taskBehavior: "tasks", timeTracking: "timeTracking", reminderDefaults: "reminder",
});
export const PREFERENCE_MINIMUM_VERSIONS = Object.freeze({
  sound: "0.3.0", focusMode: "0.3.0", schedule: "0.3.0",
  pomodoro: "0.4.0", focusDefaults: "0.4.0", takeABreak: "0.4.0",
  display: "0.5.0", taskBehavior: "0.5.0", timeTracking: "0.5.0", reminderDefaults: "0.5.0",
});
export const PREFERENCE_FIELDS = Object.freeze({
  sound: Object.freeze(["volume", "isIncreaseDoneSoundPitch", "doneSound", "breakReminderSound", "trackTimeSound"]),
  focusMode: Object.freeze(["focusModeSound", "focusModeSoundVolume"]),
  schedule: Object.freeze(["isWorkStartEndEnabled", "workStart", "workEnd", "isLunchBreakEnabled", "lunchBreakStart", "lunchBreakEnd"]),
  pomodoro: Object.freeze(["duration", "breakDuration", "longerBreakDuration", "cyclesBeforeLongerBreak"]),
  focusDefaults: Object.freeze(["autoStartFocusOnPlay", "isPauseTrackingDuringBreak", "isShowPreparation", "isManualBreakStart"]),
  takeABreak: Object.freeze(["isTakeABreakEnabled", "takeABreakMinWorkingTime", "takeABreakSnoozeTime", "isLockScreen", "isTimedFullScreenBlocker", "timedFullScreenBlockerDuration", "isFocusWindow"]),
  display: Object.freeze(["isDisableAnimations", "isVerticalActionBar", "isDisableCelebration", "isShowProductivityTipLonger", "isShowDueTaskBadge", "isTrayShowCurrentCountdown"]),
  taskBehavior: Object.freeze(["isConfirmBeforeDelete", "isAutoAddWorkedOnToToday", "isAutoMarkParentAsDone", "isTrayShowCurrent", "isMarkdownFormattingInNotesEnabled"]),
  timeTracking: Object.freeze(["defaultEstimate", "defaultEstimateSubTasks", "isNotifyWhenTimeEstimateExceeded", "isAutoStartNextTask", "isTrackingReminderEnabled", "isTrackingReminderShowOnMobile", "trackingReminderMinTime", "isTrackingReminderNotify", "isTrackingReminderFocusWindow"]),
  reminderDefaults: Object.freeze(["isCountdownBannerEnabled", "countdownDuration", "defaultTaskRemindOption", "isFocusWindow"]),
});
const preferenceSounds = Object.freeze([null, "ding-small-bell.mp3", "copper-bell-ding.mp3", "done1.mp3", "done2.mp3", "done3.mp3", "done4.mp3", "done5.mp3", "done6.mp3", "done7.mp3"]);
export const PREFERENCE_PROPERTIES = Object.freeze({
  volume: { type: "integer", minimum: 0, maximum: 100 },
  isIncreaseDoneSoundPitch: { type: "boolean" },
  doneSound: { type: ["string", "null"], enum: preferenceSounds },
  breakReminderSound: { type: ["string", "null"], enum: preferenceSounds },
  trackTimeSound: { type: ["string", "null"], enum: preferenceSounds },
  focusModeSound: { type: "string", enum: ["off", "tick", "whiteNoise"] },
  focusModeSoundVolume: { type: "integer", minimum: 0, maximum: 100 },
  isWorkStartEndEnabled: { type: "boolean" },
  workStart: { type: "string", pattern: "^(?:[01]?\\d|2[0-3]):[0-5]\\d$" },
  workEnd: { type: "string", pattern: "^(?:[01]?\\d|2[0-3]):[0-5]\\d$" },
  isLunchBreakEnabled: { type: "boolean" },
  lunchBreakStart: { type: "string", pattern: "^(?:[01]?\\d|2[0-3]):[0-5]\\d$" },
  lunchBreakEnd: { type: "string", pattern: "^(?:[01]?\\d|2[0-3]):[0-5]\\d$" },
  duration: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER, description: "Pomodoro work duration in milliseconds. Changes defaults, not the active session timer. Zero has no default fallback; a session started with zero can complete on its next tick unless manual-break overtime is enabled." },
  breakDuration: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER, description: "Short break duration in milliseconds, used at the next break transition. SP treats zero as a 300000 ms (5 minute) break, not as disabled or skipped." },
  longerBreakDuration: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER, description: "Long break duration in milliseconds, used at the next break transition. SP also treats zero here as a 300000 ms (5 minute) break, not as disabled or skipped." },
  cyclesBeforeLongerBreak: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER, description: "Number of work sessions between long breaks. Does not reset the current cycle counter." },
  autoStartFocusOnPlay: { type: "boolean", description: "Start a focus session when task tracking starts and no session is active; does not start tracking by itself." },
  isPauseTrackingDuringBreak: { type: "boolean", description: "Pause task tracking at session completion or a break transition; can affect the current session's next transition." },
  isShowPreparation: { type: "boolean", description: "Show the preparation screen when starting focus through the overlay." },
  isManualBreakStart: { type: "boolean", description: "Enable overtime until a manual break for newly started Pomodoro sessions; does not change the active session's overtime flag." },
  isTakeABreakEnabled: { type: "boolean", description: "Enables reminders during current task tracking. Existing lock-screen, full-screen blocker or focus-window options can take effect when the threshold is exceeded." },
  takeABreakMinWorkingTime: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER, description: "Milliseconds of work before reminders. Lowering this can trigger a reminder and configured lock-screen/full-screen behavior during current tracking; does not reset elapsed work." },
  takeABreakSnoozeTime: { type: "integer", minimum: 0, maximum: 2147483647, description: "Milliseconds for future snooze clicks. SP uses a JavaScript timer, limited to 2147483647 ms; does not change an existing snooze." },
  isLockScreen: { type: "boolean", description: "Allows SP to lock the operating-system screen after a break reminder, including during current tracking." },
  isTimedFullScreenBlocker: { type: "boolean", description: "Allows SP to show its timed full-screen blocker after a break reminder, including during current tracking." },
  timedFullScreenBlockerDuration: { type: "integer", minimum: 0, maximum: 2147483647, description: "Full-screen blocker duration in milliseconds, limited to the JavaScript timer range. SP treats zero as its 5000 ms (5 second) fallback, not an immediate dismissal. Does not dismiss a blocker already shown." },
  isFocusWindow: { type: "boolean", description: "Allows reminders from the selected section to bring the SP window to the foreground, including during current tracking. takeABreak controls break reminders; reminderDefaults controls task reminders." },
  isDisableAnimations: { type: "boolean", description: "Disables SP interface animations and confetti; updates the current interface." },
  isVerticalActionBar: { type: "boolean", description: "Uses the vertical action bar on supported desktop layouts; updates the current interface." },
  isDisableCelebration: { type: "boolean", description: "Disables celebration confetti in day summaries and project completion dialogs; does not hide the dialogs." },
  isShowProductivityTipLonger: { type: "boolean", description: "Shows the startup productivity tip for longer on a future startup; does not reopen a tip now." },
  isShowDueTaskBadge: { type: "boolean", description: "Shows SP's due-task badge where the desktop platform supports it." },
  isTrayShowCurrentCountdown: { type: "boolean", description: "Shows the current countdown in supported desktop tray integration; does not change the countdown." },
  isConfirmBeforeDelete: { type: "boolean", description: "Controls SP's own task deletion confirmation UI. Does not waive user authorization or tool-specific deletion confirmation." },
  isAutoAddWorkedOnToToday: { type: "boolean", description: "Automatically plans an unscheduled task for today when tracking starts or time is recorded; enabling can affect an already-running unscheduled task on its next tracking event. Existing schedules and past-day backfills are preserved." },
  isAutoMarkParentAsDone: { type: "boolean", description: "On later child-completion events, marks the unfinished parent done when all children are done and at least one completed normally. Can cause completion side effects; does not bulk-complete existing tasks on update." },
  isTrayShowCurrent: { type: "boolean", description: "Displays the current task in supported desktop tray integration; does not change tracking." },
  isMarkdownFormattingInNotesEnabled: { type: "boolean", description: "Controls Markdown rendering in task notes; does not rewrite their text." },
  defaultEstimate: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER, description: "Default estimate in milliseconds for newly created parentless tasks whose estimate is absent or zero. Zero adds no estimate; does not change existing tasks." },
  defaultEstimateSubTasks: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER, description: "Default estimate in milliseconds for newly created subtasks whose estimate is absent or zero. Zero adds no estimate; does not change existing tasks." },
  isNotifyWhenTimeEstimateExceeded: { type: "boolean", description: "Shows SP's estimate-exceeded notification. Enabling can notify for an already-running task that exceeds its positive estimate." },
  isAutoStartNextTask: { type: "boolean", description: "Allows SP to start the next eligible task when the current task is completed. Affects subsequent completion events, including the task currently being tracked." },
  isTrackingReminderEnabled: { type: "boolean", description: "Shows reminders when no task is tracked, the user is not idle and no focus session is active. Changing tracking-reminder configuration can restart SP's reminder counter; does not start a task." },
  isTrackingReminderShowOnMobile: { type: "boolean", description: "Also shows tracking reminders on touch-only devices; the master tracking-reminder switch must be enabled." },
  trackingReminderMinTime: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER, description: "Milliseconds without task tracking before a reminder while the user is active and outside focus mode. Zero means the next positive timer tick, not disabled. This is a threshold, not a JavaScript timeout delay." },
  isTrackingReminderNotify: { type: "boolean", description: "Enables desktop notifications and the configured tracking-reminder sound when a tracking reminder is triggered; does not request operating-system notification permission." },
  isTrackingReminderFocusWindow: { type: "boolean", description: "Brings SP to the foreground with a tracking-reminder notification; also requires isTrackingReminderNotify and the master tracking-reminder switch." },
  isCountdownBannerEnabled: { type: "boolean", description: "Enables the advance countdown banner for existing task reminders. Disabling does not cancel task reminders or guarantee immediate dismissal of an already-visible banner." },
  countdownDuration: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER, description: "Milliseconds before a task's reminder time during which its advance countdown banner can appear. Zero gives no advance countdown window; the reminder at its scheduled time remains enabled." },
  defaultTaskRemindOption: { type: "string", enum: ["DoNotRemind", "AtStart", "m5", "m10", "m15", "m30", "h1"], description: "Default choice for SP scheduling flows that use defaults, including its scheduling dialog and short syntax: no reminder, at start, or 5/10/15/30/60 minutes before. Does not rewrite existing task or repeat-rule reminders, and explicit API scheduling need not use this default." },
});

function preferenceError(code, message) {
  throw Object.assign(new Error(message), { code });
}
const preferenceRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
function preferenceSection(section) {
  if (!PREFERENCE_SECTIONS.includes(section)) preferenceError("SP_BAD_INPUT", `Supported preference sections: ${PREFERENCE_SECTIONS.join(", ")}.`);
  return PREFERENCE_FIELDS[section];
}
function preferenceValue(key, value) {
  const schema = PREFERENCE_PROPERTIES[key];
  if (schema.enum) return schema.enum.includes(value);
  if (schema.type === "boolean") return typeof value === "boolean";
  if (schema.type === "integer") return Number.isSafeInteger(value) && value >= schema.minimum && value <= schema.maximum;
  return typeof value === "string" && new RegExp(schema.pattern).test(value);
}

export function validatePreferenceCommand(op, args) {
  if (!["preferences.list", "preferences.update"].includes(op)) preferenceError("SP_BAD_INPUT", "Unsupported preferences operation.");
  const writing = op === "preferences.update";
  const allowed = writing ? ["section", "updates", "expected"] : ["section"];
  if (!preferenceRecord(args)) preferenceError("SP_BAD_INPUT", "Preferences arguments must be an object.");
  const unknown = Object.keys(args).filter((key) => !allowed.includes(key));
  if (unknown.length) preferenceError("SP_BAD_INPUT", `Unexpected preferences argument: ${unknown.join(", ")}.`);
  const fields = preferenceSection(args.section);
  if (!writing) return { section: args.section };
  if (!preferenceRecord(args.updates) || !Object.keys(args.updates).length ||
      Object.keys(args.updates).some((key) => !fields.includes(key) || !preferenceValue(key, args.updates[key]))) {
    preferenceError("SP_BAD_INPUT", "updates must contain supported fields with valid values for this section.");
  }
  if (!preferenceRecord(args.expected) || Object.keys(args.expected).length !== fields.length ||
      Object.keys(args.expected).some((key) => !fields.includes(key)) ||
      fields.some((key) => !Object.hasOwn(args.expected, key) || !preferenceValue(key, args.expected[key]))) {
    preferenceError("SP_BAD_INPUT", "expected must be the complete settings object returned by get for this section.");
  }
  return {
    section: args.section,
    updates: Object.fromEntries(Object.entries(args.updates)),
    expected: Object.fromEntries(fields.map((key) => [key, args.expected[key]])),
  };
}

export function projectPreferences(section, value) {
  const fields = preferenceSection(section);
  if (!preferenceRecord(value) || fields.some((key) => !Object.hasOwn(value, key) || !preferenceValue(key, value[key]))) {
    preferenceError("SP_PREFERENCES_UNSUPPORTED", "SP did not return every supported preference with a valid type. No defaults were guessed.");
  }
  return Object.fromEntries(fields.map((key) => [key, value[key]]));
}
