import assert from "node:assert/strict";
import test from "node:test";
import { executePreferences } from "../../sp-hana-bridge/src/preferences.mjs";
import { createCommandExecutor } from "../../sp-hana-bridge/src/companion.mjs";
import { createPluginCode, loadPluginSources } from "../../sp-hana-bridge/scripts/build.mjs";
import { PREFERENCE_FIELDS, PREFERENCE_CONFIG_SECTIONS, validatePreferenceCommand, projectPreferences } from "../../sp-tasks/lib/preferences-contract.js";
import { validateCommand } from "../../sp-tasks/lib/bridge-protocol.js";

globalThis.fetch = async () => { throw new Error("Real network is forbidden in preference companion tests"); };
const clone = (value) => structuredClone(value);
const config = () => ({
  sound: { volume: 75, isIncreaseDoneSoundPitch: true, doneSound: "ding-small-bell.mp3", breakReminderSound: null, trackTimeSound: null, privateFile: "never-return" },
  focusMode: { focusModeSound: "off", focusModeSoundVolume: 50, autoStartFocusOnPlay: true, isPauseTrackingDuringBreak: true, isShowPreparation: false, isManualBreakStart: false, isSkipPreparation: false, isPlayTick: false },
  schedule: { isWorkStartEndEnabled: true, workStart: "9:00", workEnd: "17:00", isLunchBreakEnabled: false, lunchBreakStart: "13:00", lunchBreakEnd: "14:00" },
  pomodoro: { duration: 1500000, breakDuration: 300000, longerBreakDuration: 900000, cyclesBeforeLongerBreak: 4 },
  takeABreak: { isTakeABreakEnabled: true, takeABreakMinWorkingTime: 3600000, takeABreakSnoozeTime: 900000, isLockScreen: false, isTimedFullScreenBlocker: false, timedFullScreenBlockerDuration: 8000, isFocusWindow: false, takeABreakMessage: "never-return", motivationalImgs: ["never-return"] },
  tasks: { isConfirmBeforeDelete: true, isAutoAddWorkedOnToToday: true, isAutoMarkParentAsDone: false, isTrayShowCurrent: true, isMarkdownFormattingInNotesEnabled: true, defaultProjectId: "INBOX_PROJECT", notesTemplate: "never-return", priorityIconPreset: "chevrons" },
  timeTracking: { defaultEstimate: 0, defaultEstimateSubTasks: 0, isNotifyWhenTimeEstimateExceeded: true, isAutoStartNextTask: false, isTrackingReminderEnabled: false, isTrackingReminderShowOnMobile: false, trackingReminderMinTime: 300000, isTrackingReminderNotify: false, isTrackingReminderFocusWindow: false },
  reminder: { isCountdownBannerEnabled: true, countdownDuration: 600000, defaultTaskRemindOption: "AtStart", isFocusWindow: false, useAlarmStyleReminders: false, notifyOnDueDate: true, dueDateNotificationHour: 9 },
  sync: { accessToken: "never-return" }, misc: { isDisableAnimations: false, isVerticalActionBar: false, isDisableCelebration: true, isShowProductivityTipLonger: false, isShowDueTaskBadge: false, isTrayShowCurrentCountdown: true, startOfNextDay: 4, startOfNextDayTime: "04:00", unsplashApiKey: "never-return", backgroundImageDark: "never-return" },
});

function setup() {
  const state = { globalConfig: config(), reads: 0, writes: [], attempts: 0, ignoreWrite: false, afterWrite: null, readErrorAt: null, writeError: null };
  const api = {
    getAppState: async () => {
      state.reads++;
      if (state.readErrorAt === state.reads) throw new Error("Snapshot unavailable");
      return { globalConfig: clone(state.globalConfig), tasks: { private: { title: "never-return" } } };
    },
    dispatchAction: (action) => {
      state.writes.push(clone(action));
      if (!state.ignoreWrite) Object.assign(state.globalConfig[action.sectionKey], action.sectionCfg);
      state.afterWrite?.();
      if (state.writeError) throw state.writeError;
    },
  };
  const run = async (op, args) => {
    let attempted = false;
    try {
      const data = await executePreferences(api, op, args, {
        write: async (work) => { attempted = true; state.attempts++; return await work(); },
        fail: (code, message) => { throw Object.assign(new Error(message), { code }); },
      });
      return { ok: true, data };
    } catch (error) { return { ok: false, error: { code: error.code || "SP_PLUGIN_ERROR", message: error.message }, outcomeUnknown: attempted }; }
  };
  const expected = (section) => Object.fromEntries(PREFERENCE_FIELDS[section].map((key) => [key, state.globalConfig[PREFERENCE_CONFIG_SECTIONS[section]][key]]));
  const update = (section, updates, before = expected(section)) => run("preferences.update", { section, updates, expected: before });
  return { state, api, run, expected, update };
}

for (const section of Object.keys(PREFERENCE_FIELDS)) {
  test(`${section} projection returns only documented fields and never writes`, async () => {
    const f = setup();
    const result = await f.run("preferences.list", { section });
    assert.deepEqual(result, { ok: true, data: { section, settings: f.expected(section) } });
    assert.equal(f.state.attempts, 0);
    assert.equal(f.state.reads, 1);
    assert.doesNotMatch(JSON.stringify(result), /never-return|startOfNextDay|isSkipPreparation|isPlayTick|tasks|accessToken/);
  });
}

for (const [section, updates] of [
  ["sound", { volume: 100, doneSound: null, breakReminderSound: "done7.mp3" }],
  ["focusMode", { focusModeSound: "tick", focusModeSoundVolume: 0 }],
  ["schedule", { isLunchBreakEnabled: true, workStart: "08:30", lunchBreakStart: "12:00" }],
  ["pomodoro", { duration: 1800000, breakDuration: 0, longerBreakDuration: 1200000, cyclesBeforeLongerBreak: 3 }],
  ["focusDefaults", { autoStartFocusOnPlay: false, isPauseTrackingDuringBreak: false, isShowPreparation: true, isManualBreakStart: true }],
  ["takeABreak", { isTakeABreakEnabled: false, takeABreakMinWorkingTime: 0, takeABreakSnoozeTime: 2147483647, isLockScreen: true, isTimedFullScreenBlocker: true, timedFullScreenBlockerDuration: 0, isFocusWindow: true }],
  ["display", { isDisableAnimations: true, isVerticalActionBar: true, isDisableCelebration: false, isShowProductivityTipLonger: true, isShowDueTaskBadge: true, isTrayShowCurrentCountdown: false }],
  ["taskBehavior", { isConfirmBeforeDelete: false, isAutoAddWorkedOnToToday: false, isAutoMarkParentAsDone: true, isTrayShowCurrent: false, isMarkdownFormattingInNotesEnabled: false }],
  ["timeTracking", { defaultEstimate: 1800000, defaultEstimateSubTasks: 300000, isNotifyWhenTimeEstimateExceeded: false, isAutoStartNextTask: true, isTrackingReminderEnabled: true, isTrackingReminderShowOnMobile: true, trackingReminderMinTime: 0, isTrackingReminderNotify: true, isTrackingReminderFocusWindow: true }],
  ["reminderDefaults", { isCountdownBannerEnabled: false, countdownDuration: 0, defaultTaskRemindOption: "DoNotRemind", isFocusWindow: true }],
]) {
  test(`${section} update dispatches the exact persistent action, preserves other config and reads back`, async () => {
    const f = setup(), before = clone(f.state.globalConfig), expected = f.expected(section);
    const args = { section, updates: Object.freeze({ ...updates }), expected: Object.freeze(expected) };
    const result = await f.run("preferences.update", Object.freeze(args));
    assert.equal(result.ok, true, JSON.stringify(result));
    const configSection = PREFERENCE_CONFIG_SECTIONS[section];
    assert.deepEqual(f.state.writes, [{
      type: "[Global Config] Update Global Config Section", sectionKey: configSection, sectionCfg: updates, isSkipSnack: true,
      meta: { isPersistent: true, entityType: "GLOBAL_CONFIG", entityId: configSection, opType: "UPD" },
    }]);
    assert.deepEqual(f.state.globalConfig, { ...before, [configSection]: { ...before[configSection], ...updates } });
    assert.deepEqual(result.data, { section, settings: { ...expected, ...updates }, unchanged: false, verification: "applied-state" });
    assert.equal(f.state.reads, 2);
    assert.equal(f.state.attempts, 1);
    assert.doesNotMatch(JSON.stringify(result), /never-return|disk|persisted|synced/);
  });
}

test("unchanged values are confirmed without dispatching a second operation", async () => {
  const f = setup();
  const result = await f.update("sound", { volume: 75 });
  assert.equal(result.ok, true);
  assert.equal(result.data.unchanged, true);
  assert.equal(f.state.writes.length, 0);
  assert.equal(f.state.attempts, 0);
});

test("an edit to any projected field conflicts even if only another field would be updated", async () => {
  const f = setup(), expected = f.expected("sound");
  f.state.globalConfig.sound.doneSound = "done1.mp3";
  const before = clone(f.state.globalConfig);
  const result = await f.update("sound", { volume: 10 }, expected);
  assert.equal(result.error.code, "SP_PREFERENCES_CONFLICT");
  assert.equal(result.outcomeUnknown, false);
  assert.deepEqual(f.state.globalConfig, before);
  assert.equal(f.state.attempts, 0);
});

test("unexposed settings are preserved and do not require sending them as expected", async () => {
  const f = setup(), expected = f.expected("focusMode");
  f.state.globalConfig.focusMode.autoStartFocusOnPlay = false;
  const result = await f.update("focusMode", { focusModeSound: "whiteNoise" }, expected);
  assert.equal(result.ok, true);
  assert.equal(f.state.globalConfig.focusMode.autoStartFocusOnPlay, false);
  assert.deepEqual(Object.keys(f.state.writes[0].sectionCfg), ["focusModeSound"]);
});

test("focusDefaults writes the real focusMode section and persistent entity, preserving the legacy sound projection", async () => {
  const f = setup();
  const beforeSound = f.expected("focusMode");
  const result = await f.update("focusDefaults", { isShowPreparation: true });
  assert.equal(result.ok, true);
  assert.equal(result.data.section, "focusDefaults");
  assert.equal(result.data.settings.isShowPreparation, true);
  assert.equal(f.state.writes[0].sectionKey, "focusMode");
  assert.equal(f.state.writes[0].meta.entityId, "focusMode");
  assert.equal(Object.hasOwn(f.state.globalConfig, "focusDefaults"), false);
  assert.deepEqual((await f.run("preferences.list", { section: "focusMode" })).data.settings, beforeSound);
  assert.doesNotMatch(JSON.stringify(result), /focusModeSound|isSkipPreparation|isPlayTick/);
});

for (const [section, updates, conflictingKey, conflictingValue] of [
  ["pomodoro", { duration: 1800000 }, "cyclesBeforeLongerBreak", 5],
  ["focusDefaults", { isShowPreparation: true }, "isPauseTrackingDuringBreak", false],
  ["takeABreak", { isTakeABreakEnabled: false }, "isLockScreen", true],
  ["display", { isDisableAnimations: true }, "isVerticalActionBar", true],
  ["taskBehavior", { isTrayShowCurrent: false }, "isAutoMarkParentAsDone", true],
  ["timeTracking", { defaultEstimate: 120000 }, "isAutoStartNextTask", true],
  ["reminderDefaults", { isFocusWindow: true }, "defaultTaskRemindOption", "m5"],
]) {
  test(`${section} checks the complete snapshot including unchanged behavior fields`, async () => {
    const f = setup(), expected = f.expected(section);
    f.state.globalConfig[PREFERENCE_CONFIG_SECTIONS[section]][conflictingKey] = conflictingValue;
    const result = await f.update(section, updates, expected);
    assert.equal(result.error.code, "SP_PREFERENCES_CONFLICT");
    assert.equal(result.outcomeUnknown, false);
    assert.equal(f.state.attempts, 0);
    assert.equal(f.state.writes.length, 0);
  });
}

test("zero durations match SP's duration input semantics without resetting the active session or cycle", async () => {
  const f = setup();
  const activeSession = { timer: { duration: 1500000, elapsed: 120000, isRunning: true, purpose: "work" }, currentCycle: 3 };
  const sessionBefore = clone(activeSession);
  const read = f.api.getAppState;
  f.api.getAppState = async () => ({ ...await read(), focusMode: clone(activeSession) });
  const result = await f.update("pomodoro", { duration: 0, breakDuration: 0, longerBreakDuration: 0, cyclesBeforeLongerBreak: 1 });
  assert.equal(result.ok, true);
  assert.deepEqual(result.data.settings, { duration: 0, breakDuration: 0, longerBreakDuration: 0, cyclesBeforeLongerBreak: 1 });
  assert.deepEqual(activeSession, sessionBefore);
  assert.equal(f.state.writes.length, 1);
  assert.equal(f.state.writes[0].type, "[Global Config] Update Global Config Section");
  assert.equal(f.state.writes[0].sectionKey, "pomodoro");
  assert.doesNotMatch(JSON.stringify(f.state.writes), /elapsed|currentCycle|Start Session|Reset Cycles/);
});

for (const [section, updates] of [
  ["pomodoro", { duration: NaN }], ["pomodoro", { duration: Infinity }],
  ["pomodoro", { breakDuration: -1 }], ["pomodoro", { longerBreakDuration: 0.1 }],
  ["pomodoro", { cyclesBeforeLongerBreak: 0 }], ["pomodoro", { cyclesBeforeLongerBreak: 1.5 }],
  ["pomodoro", { cyclesBeforeLongerBreak: Number.MAX_SAFE_INTEGER + 1 }],
  ["focusDefaults", { isPauseTrackingDuringBreak: "false" }], ["focusDefaults", { isSkipPreparation: true }],
  ["takeABreak", { takeABreakSnoozeTime: 2147483648 }], ["takeABreak", { isLockScreen: 1 }],
  ["takeABreak", { timedFullScreenBlockerDuration: 2147483648 }],
  ["takeABreak", { takeABreakMessage: "not-exposed" }], ["takeABreak", { motivationalImgs: ["not-exposed"] }],
  ["display", { isDisableAnimations: 1 }], ["display", { startOfNextDay: 0 }], ["display", { startOfNextDayTime: "00:00" }],
  ["taskBehavior", { isAutoMarkParentAsDone: "false" }], ["taskBehavior", { defaultProjectId: "INBOX_PROJECT" }],
  ["taskBehavior", { notesTemplate: "not-exposed" }], ["timeTracking", { defaultEstimate: -1 }],
  ["timeTracking", { defaultEstimateSubTasks: NaN }], ["timeTracking", { trackingReminderMinTime: 0.5 }],
  ["timeTracking", { trackingReminderMinTime: Number.MAX_SAFE_INTEGER + 1 }], ["timeTracking", { isAutoStartNextTask: 1 }],
  ["reminderDefaults", { countdownDuration: -1 }], ["reminderDefaults", { countdownDuration: "10m" }],
  ["reminderDefaults", { defaultTaskRemindOption: "d1" }], ["reminderDefaults", { defaultTaskRemindOption: "w1" }],
  ["reminderDefaults", { disableReminders: true }], ["reminderDefaults", { useAlarmStyleReminders: true }],
  ["reminderDefaults", { notifyOnDueDate: false }], ["reminderDefaults", { dueDateNotificationHour: 9 }],
]) {
  test(`new preference values fail before reading or dispatching: ${section} ${JSON.stringify(updates)}`, async () => {
    const f = setup();
    const result = await f.update(section, updates);
    assert.equal(result.error.code, "SP_BAD_INPUT");
    assert.equal(result.outcomeUnknown, false);
    assert.equal(f.state.reads, 0);
    assert.equal(f.state.attempts, 0);
  });
}

test("full-screen duration keeps SP's zero fallback and accepts only representable timer delays", async () => {
  const f = setup();
  for (const timedFullScreenBlockerDuration of [0, 2147483647]) {
    const result = await f.update("takeABreak", { timedFullScreenBlockerDuration });
    assert.equal(result.ok, true);
    assert.equal(result.data.settings.timedFullScreenBlockerDuration, timedFullScreenBlockerDuration);
    assert.equal(f.state.writes.at(-1).sectionCfg.timedFullScreenBlockerDuration, timedFullScreenBlockerDuration);
  }
  const writes = f.state.writes.length;
  const rejected = await f.update("takeABreak", { timedFullScreenBlockerDuration: 2147483648 });
  assert.equal(rejected.error.code, "SP_BAD_INPUT");
  assert.equal(rejected.outcomeUnknown, false);
  assert.equal(f.state.writes.length, writes);
});

for (const [section, key] of [["sound", "volume"], ["focusMode", "focusModeSound"], ["schedule", "workStart"], ["pomodoro", "breakDuration"], ["focusDefaults", "isShowPreparation"], ["takeABreak", "isLockScreen"], ["display", "isVerticalActionBar"], ["taskBehavior", "isAutoMarkParentAsDone"], ["timeTracking", "isTrackingReminderNotify"], ["reminderDefaults", "defaultTaskRemindOption"]]) {
  for (const defect of ["missing", "wrong-type"]) {
    test(`${defect} ${section}.${key} reports unsupported without guessing a default`, async () => {
      const f = setup();
      const expected = f.expected(section);
      if (defect === "missing") delete f.state.globalConfig[PREFERENCE_CONFIG_SECTIONS[section]][key];
      else f.state.globalConfig[PREFERENCE_CONFIG_SECTIONS[section]][key] = {};
      const get = await f.run("preferences.list", { section });
      assert.equal(get.error.code, "SP_PREFERENCES_UNSUPPORTED");
      const result = await f.update(section, { [key]: expected[key] }, expected);
      assert.equal(result.error.code, "SP_PREFERENCES_UNSUPPORTED");
      assert.equal(f.state.attempts, 0);
    });
  }
}

for (const [section, configKey, updates] of [
  ["display", "misc", { isVerticalActionBar: true }],
  ["taskBehavior", "tasks", { isConfirmBeforeDelete: false }],
  ["timeTracking", "timeTracking", { defaultEstimate: 60000 }],
  ["reminderDefaults", "reminder", { defaultTaskRemindOption: "m15" }],
]) {
  test(`${section} reads and persists only its real ${configKey} section, never an alias entity`, async () => {
    const f = setup(), before = clone(f.state.globalConfig);
    const result = await f.update(section, updates);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.data.section, section);
    assert.equal(f.state.writes[0].sectionKey, configKey);
    assert.equal(f.state.writes[0].meta.entityId, configKey);
    assert.equal(f.state.writes[0].meta.isPersistent, true);
    assert.deepEqual(f.state.globalConfig, { ...before, [configKey]: { ...before[configKey], ...updates } });
    if (section !== configKey) assert.equal(Object.hasOwn(f.state.globalConfig, section), false);
    assert.equal(f.state.globalConfig.misc.startOfNextDay, 4);
    assert.equal(f.state.globalConfig.misc.startOfNextDayTime, "04:00");
    assert.doesNotMatch(JSON.stringify(f.state.writes), /startOfNextDay|unsplash|notesTemplate|defaultProjectId/);
  });
}

test("reminder focus-window updates do not alter the independent break-reminder setting", async () => {
  const f = setup();
  assert.equal((await f.update("reminderDefaults", { isFocusWindow: true })).ok, true);
  assert.equal(f.state.globalConfig.reminder.isFocusWindow, true);
  assert.equal(f.state.globalConfig.takeABreak.isFocusWindow, false);
  assert.equal((await f.update("takeABreak", { isFocusWindow: true })).ok, true);
  assert.equal((await f.update("reminderDefaults", { isFocusWindow: false })).ok, true);
  assert.equal(f.state.globalConfig.takeABreak.isFocusWindow, true);
});

test("new timing fields retain zero and values above timer-delay limits because they are estimates or thresholds", async () => {
  const f = setup();
  for (const value of [0, 2147483648, Number.MAX_SAFE_INTEGER]) {
    const tracking = await f.update("timeTracking", { defaultEstimate: value, defaultEstimateSubTasks: value, trackingReminderMinTime: value });
    assert.equal(tracking.ok, true);
    assert.equal(tracking.data.settings.defaultEstimate, value);
    assert.equal(tracking.data.settings.defaultEstimateSubTasks, value);
    assert.equal(tracking.data.settings.trackingReminderMinTime, value);
    const reminder = await f.update("reminderDefaults", { countdownDuration: value });
    assert.equal(reminder.ok, true);
    assert.equal(reminder.data.settings.countdownDuration, value);
  }
});

for (const defaultTaskRemindOption of ["DoNotRemind", "AtStart", "m5", "m10", "m15", "m30", "h1"]) {
  test(`the global reminder default accepts the real UI enum ${defaultTaskRemindOption}`, async () => {
    const f = setup();
    const result = await f.update("reminderDefaults", { defaultTaskRemindOption });
    assert.equal(result.ok, true);
    assert.equal(result.data.settings.defaultTaskRemindOption, defaultTaskRemindOption);
  });
}

test("absent optional legacy reminder and title-bar fields are not guessed or persisted", async () => {
  const f = setup();
  assert.equal(Object.hasOwn(f.state.globalConfig.reminder, "disableReminders"), false);
  assert.equal(Object.hasOwn(f.state.globalConfig.misc, "isUseCustomWindowTitleBar"), false);
  assert.equal((await f.update("reminderDefaults", { defaultTaskRemindOption: "m5" })).ok, true);
  assert.equal((await f.update("display", { isDisableAnimations: true })).ok, true);
  assert.equal(Object.hasOwn(f.state.globalConfig.reminder, "disableReminders"), false);
  assert.equal(Object.hasOwn(f.state.globalConfig.misc, "isUseCustomWindowTitleBar"), false);
});

for (const [name, op, args] of [
  ["old read spelling", "preferences.get", { section: "sound" }],
  ["sync section", "preferences.list", { section: "sync" }],
  ["day-boundary section", "preferences.update", { section: "misc", updates: { startOfNextDayTime: "00:00" }, expected: {} }],
  ["arbitrary action", "preferences.update", { section: "sound", updates: { volume: 5 }, expected: {}, type: "some-action" }],
  ["arbitrary meta", "preferences.update", { section: "sound", updates: { volume: 5 }, expected: {}, meta: { isRemote: true } }],
  ["missing expected", "preferences.update", { section: "sound", updates: { volume: 5 } }],
  ["cross section field", "preferences.update", { section: "sound", updates: { workStart: "9:00" }, expected: {} }],
  ["sound file path", "preferences.update", { section: "sound", updates: { doneSound: "../../file.mp3" }, expected: {} }],
  ["NaN", "preferences.update", { section: "sound", updates: { volume: NaN }, expected: {} }],
  ["Infinity", "preferences.update", { section: "sound", updates: { volume: Infinity }, expected: {} }],
]) {
  test(`${name} is rejected before reading SP`, async () => {
    const f = setup();
    const result = await f.run(op, args);
    assert.equal(result.error.code, "SP_BAD_INPUT");
    assert.equal(result.outcomeUnknown, false);
    assert.equal(f.state.reads, 0);
    assert.equal(f.state.attempts, 0);
  });
}

test("unknown input errors identify only the argument name, never its sensitive value", () => {
  assert.throws(() => validatePreferenceCommand("preferences.list", { section: "sound", foo: "sensitive-value" }), (error) => {
    assert.match(error.message, /foo/);
    assert.doesNotMatch(error.message, /sensitive-value/);
    return true;
  });
});

test("public API absence permits reads but blocks changed writes before any attempt", async () => {
  const f = setup();
  delete f.api.dispatchAction;
  assert.equal((await f.run("preferences.list", { section: "sound" })).ok, true);
  const result = await f.update("sound", { volume: 20 });
  assert.equal(result.error.code, "SP_PREFERENCES_UNSUPPORTED");
  assert.equal(result.outcomeUnknown, false);
  assert.equal(f.state.attempts, 0);
});

test("a successful-looking dispatch that did not apply is an unknown failed write", async () => {
  const f = setup();
  f.state.ignoreWrite = true;
  const result = await f.update("sound", { volume: 20 });
  assert.equal(result.error.code, "SP_VERIFY_FAILED");
  assert.equal(result.outcomeUnknown, true);
  assert.equal(f.state.writes.length, 1);
  assert.equal(f.state.globalConfig.sound.volume, 75);
});

test("readback detects unexpected concurrent changes without rolling them back", async () => {
  const f = setup();
  f.state.afterWrite = () => { f.state.globalConfig.sound.doneSound = "done2.mp3"; };
  const result = await f.update("sound", { volume: 20 });
  assert.equal(result.error.code, "SP_VERIFY_FAILED");
  assert.equal(result.outcomeUnknown, true);
  assert.equal(f.state.globalConfig.sound.doneSound, "done2.mp3");
  assert.equal(f.state.writes.length, 1);
});

test("a dispatch error after mutation is not retried; a subsequent read reveals the applied value", async () => {
  const f = setup();
  f.state.writeError = new Error("Reply lost after dispatch");
  const result = await f.update("sound", { volume: 20 });
  assert.equal(result.outcomeUnknown, true);
  assert.equal(f.state.writes.length, 1);
  const read = await f.run("preferences.list", { section: "sound" });
  assert.equal(read.data.settings.volume, 20);
  assert.equal(f.state.writes.length, 1);
});

test("read failures are only marked unknown after a write was attempted", async () => {
  const f = setup();
  f.state.readErrorAt = 1;
  assert.equal((await f.run("preferences.list", { section: "sound" })).outcomeUnknown, false);
  f.state.readErrorAt = 3;
  const result = await f.update("sound", { volume: 20 });
  assert.equal(result.outcomeUnknown, true);
  assert.equal(f.state.attempts, 1);
});

test("projection supports actual SP one-digit hours and rejects invalid clock strings", () => {
  assert.equal(projectPreferences("schedule", config().schedule).workStart, "9:00");
  for (const time of ["24:00", "9:60", "9:0", "-1:00", "09:00\n", " 09:00", null]) {
    assert.throws(() => projectPreferences("schedule", { ...config().schedule, workStart: time }), { code: "SP_PREFERENCES_UNSUPPORTED" });
  }
});

test("real bridge protocol and companion executor accept the shared preferences contract", async () => {
  const f = setup(), execute = createCommandExecutor(f.api);
  const getArgs = { section: "sound" };
  assert.equal(validateCommand("preferences.list", getArgs).op, "preferences.list");
  const current = await execute("preferences.list", getArgs);
  assert.equal(current.ok, true);
  const args = { section: "sound", expected: current.data.settings, updates: { volume: 10 } };
  assert.equal(validateCommand("preferences.update", args).op, "preferences.update");
  const result = await execute("preferences.update", args);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.data.settings.volume, 10);
  assert.equal(f.state.writes.length, 1);
  assert.throws(() => validateCommand("preferences.update", { ...args, foo: "secret" }), { code: "SP_BRIDGE_BAD_INPUT" });
});

for (const [section, updates] of [
  ["pomodoro", { duration: 1800000 }],
  ["focusDefaults", { isManualBreakStart: true }],
  ["takeABreak", { isTakeABreakEnabled: false }],
  ["display", { isDisableAnimations: true }],
  ["taskBehavior", { isAutoMarkParentAsDone: true }],
  ["timeTracking", { isAutoStartNextTask: true }],
  ["reminderDefaults", { defaultTaskRemindOption: "m30" }],
]) {
  test(`real bridge protocol and companion executor expose ${section} through fixed preferences operations`, async () => {
    const f = setup(), execute = createCommandExecutor(f.api);
    const get = { section };
    assert.equal(validateCommand("preferences.list", get).op, "preferences.list");
    const read = await execute("preferences.list", get);
    assert.equal(read.ok, true, JSON.stringify(read));
    const args = { section, expected: read.data.settings, updates };
    assert.equal(validateCommand("preferences.update", args).op, "preferences.update");
    const result = await execute("preferences.update", args);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(result.data.settings, { ...read.data.settings, ...updates });
    assert.equal(f.state.writes.length, 1);
    assert.equal(f.state.writes[0].meta.entityId, PREFERENCE_CONFIG_SECTIONS[section]);
  });
}

test("real executor preserves conflict codes, read failure certainty and write outcomeUnknown", async () => {
  const f = setup(), execute = createCommandExecutor(f.api), expected = f.expected("sound");
  f.state.globalConfig.sound.volume = 50;
  const conflict = await execute("preferences.update", { section: "sound", expected, updates: { volume: 10 } });
  assert.equal(conflict.error.code, "SP_PREFERENCES_CONFLICT");
  assert.notEqual(conflict.outcomeUnknown, true);
  f.state.readErrorAt = f.state.reads + 1;
  const failedRead = await execute("preferences.list", { section: "sound" });
  assert.notEqual(failedRead.outcomeUnknown, true);
  f.state.ignoreWrite = true;
  const failedWrite = await execute("preferences.update", { section: "sound", expected: f.expected("sound"), updates: { volume: 10 } });
  assert.equal(failedWrite.error.code, "SP_VERIFY_FAILED");
  assert.equal(failedWrite.outcomeUnknown, true);
  assert.equal(f.state.writes.length, 1);
});

const modules = await loadPluginSources();

test("the real plugin modules bundle into runnable code without imports or Node dependencies", () => {
  const code = createPluginCode(modules);
  assert.doesNotMatch(code, /^\s*(?:import|export)\b/m);
  assert.doesNotMatch(code, /node:|require\s*\(/);
  const registered = [];
  const globalsBefore = Object.getOwnPropertyNames(globalThis);
  new Function("PluginAPI", code)({
    registerConfigHandler: (handler) => { assert.equal(typeof handler, "function"); registered.push("config"); },
    registerMenuEntry: (entry) => { assert.equal(typeof entry.onClick, "function"); registered.push("menu"); },
    onUnload: (handler) => { assert.equal(typeof handler, "function"); registered.push("unload"); },
    onReady: (handler) => { assert.equal(typeof handler, "function"); registered.push("ready"); },
  });
  assert.deepEqual(registered, ["config", "menu", "unload", "ready"]);
  assert.deepEqual(Object.getOwnPropertyNames(globalThis), globalsBefore);
});

test("bundled preferences resolve their shared contract and execute a persistent update", async () => {
  const f = setup();
  let execute;
  const entry = 'import { executePreferences } from "./preferences.mjs";\nexport function installCompanion(api) { api.capture(executePreferences); }';
  const code = createPluginCode({ ...modules, companion: entry });
  new Function("PluginAPI", code)({ capture: (fn) => { execute = fn; } });
  const result = await execute(f.api, "preferences.update", { section: "focusMode", expected: f.expected("focusMode"), updates: { focusModeSound: "whiteNoise" } }, {
    write: (fn) => fn(), fail: (code, message) => { throw Object.assign(new Error(message), { code }); },
  });
  assert.equal(result.settings.focusModeSound, "whiteNoise");
  assert.equal(f.state.writes[0].meta.opType, "UPD");
});

test("bundler rejects new unsupported imports instead of producing a broken plugin", () => {
  assert.throws(() => createPluginCode({ ...modules, companion: 'import { readFile } from "node:fs";\nexport function installCompanion() {}' }), /Unsupported bundled import/);
  assert.throws(() => createPluginCode({ ...modules, companion: 'export function installCompanion() { return import("node:fs"); }' }), /unresolved module/);
});
