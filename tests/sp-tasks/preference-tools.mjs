import assert from "node:assert/strict";
import test from "node:test";
import { registerPreferenceTools, PREFERENCE_CAPABILITIES } from "../../sp-tasks/lib/preference-tools.js";
import { SpError } from "../../sp-tasks/lib/sp.js";
import { readNotice, resetNoticeCache } from "../../sp-tasks/lib/notice.js";

globalThis.fetch = async () => { throw new Error("Real network is forbidden in preference tool tests"); };
const defaults = {
  sound: { volume: 75, isIncreaseDoneSoundPitch: true, doneSound: "ding-small-bell.mp3", breakReminderSound: null, trackTimeSound: null },
  focusMode: { focusModeSound: "off", focusModeSoundVolume: 50 },
  schedule: { isWorkStartEndEnabled: true, workStart: "9:00", workEnd: "17:00", isLunchBreakEnabled: false, lunchBreakStart: "13:00", lunchBreakEnd: "14:00" },
  pomodoro: { duration: 1500000, breakDuration: 300000, longerBreakDuration: 900000, cyclesBeforeLongerBreak: 4 },
  focusDefaults: { autoStartFocusOnPlay: false, isPauseTrackingDuringBreak: true, isShowPreparation: false, isManualBreakStart: false },
  takeABreak: { isTakeABreakEnabled: true, takeABreakMinWorkingTime: 3600000, takeABreakSnoozeTime: 900000, isLockScreen: false, isTimedFullScreenBlocker: false, timedFullScreenBlockerDuration: 8000, isFocusWindow: false },
  display: { isDisableAnimations: false, isVerticalActionBar: false, isDisableCelebration: true, isShowProductivityTipLonger: false, isShowDueTaskBadge: false, isTrayShowCurrentCountdown: true },
  taskBehavior: { isConfirmBeforeDelete: true, isAutoAddWorkedOnToToday: true, isAutoMarkParentAsDone: false, isTrayShowCurrent: true, isMarkdownFormattingInNotesEnabled: true },
  timeTracking: { defaultEstimate: 0, defaultEstimateSubTasks: 0, isNotifyWhenTimeEstimateExceeded: true, isAutoStartNextTask: false, isTrackingReminderEnabled: false, isTrackingReminderShowOnMobile: false, trackingReminderMinTime: 300000, isTrackingReminderNotify: false, isTrackingReminderFocusWindow: false },
  reminderDefaults: { isCountdownBannerEnabled: true, countdownDuration: 600000, defaultTaskRemindOption: "AtStart", isFocusWindow: false },
};
const edit = (section = "sound", updates = { volume: 20 }) => ({ action: "update", section, expected: structuredClone(defaults[section]), updates });

async function setup() {
  const tools = new Map();
  const state = {
    status: { enabled: true, running: true, connected: true, protocol: 1, pluginVersion: "0.5.0" },
    calls: [], errors: [], statusReads: 0, statusError: null, error: null, override: null, settings: structuredClone(defaults), noticeReads: 0,
  };
  const sdk = {
    tools: { register: async (tool) => { tools.set(tool.name, tool); } },
    config: { getAll: async () => ({ baseUrl: "http://sp.invalid", accessToken: "fixture" }) },
    network: { fetch: async (url) => {
      assert.equal(new URL(url).origin, "http://sp.invalid");
      state.noticeReads++;
      return new Response(JSON.stringify({ ok: true, data: url.endsWith("/tasks") ? [{ id: "task", isDone: false, title: "Fixture" }] : null }));
    } },
  };
  const bridge = {
    status: async () => { state.statusReads++; if (state.statusError) throw state.statusError; return structuredClone(state.status); },
    execute: async (op, args) => {
      state.calls.push({ op, args: structuredClone(args) });
      if (state.error) throw state.error;
      if (state.override) return state.override(op, args);
      if (op === "preferences.update") Object.assign(state.settings[args.section], args.updates);
      return { section: args.section, settings: structuredClone(state.settings[args.section]), ...(op === "preferences.update" ? { unchanged: false, verification: "applied-state" } : {}) };
    },
  };
  const guard = (work) => async (args) => {
    try { return await work(args); }
    catch (error) { state.errors.push(error); return { ok: false, code: error.code, outcomeUnknown: error.outcomeUnknown === true }; }
  };
  await registerPreferenceTools(sdk, { bridge, guard, ok: (data) => ({ ok: true, ...data }) });
  return { state, tools, sdk, call: (args) => tools.get("sp_tasks_preferences").execute(args) };
}

test("registers one closed-schema preference tool and its capability", async () => {
  const f = await setup();
  assert.deepEqual([...f.tools.keys()], ["sp_tasks_preferences"]);
  const schema = f.tools.get("sp_tasks_preferences").parameters;
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.expected.additionalProperties, false);
  assert.equal(schema.properties.updates.additionalProperties, false);
  assert.deepEqual(schema.properties.section.enum, ["sound", "focusMode", "schedule", "pomodoro", "focusDefaults", "takeABreak", "display", "taskBehavior", "timeTracking", "reminderDefaults"]);
  assert.deepEqual(PREFERENCE_CAPABILITIES[0].tools, ["sp_tasks_preferences"]);
  assert.equal(PREFERENCE_CAPABILITIES[0].minimumPluginVersion, "0.3.0");
  assert.deepEqual(PREFERENCE_CAPABILITIES.slice(1).map((entry) => [entry.id, entry.minimumPluginVersion]), [["focus_preferences", "0.4.0"], ["break_preferences", "0.4.0"], ["display_preferences", "0.5.0"], ["task_behavior_preferences", "0.5.0"], ["tracking_preferences", "0.5.0"], ["reminder_preferences", "0.5.0"]]);
});

for (const section of Object.keys(defaults)) {
  test(`get ${section} uses a read operation and strips extra response data and host context`, async () => {
    const f = await setup();
    f.state.override = () => ({ section, settings: { ...defaults[section], accessToken: "must-not-leak" }, rawState: { token: "must-not-leak" } });
    const args = Object.freeze({ action: "get", section, context: { callToken: "must-not-leak" } });
    const result = await f.call(args);
    assert.deepEqual(result, { ok: true, section, settings: defaults[section] });
    assert.deepEqual(f.state.calls, [{ op: "preferences.list", args: { section } }]);
    assert.equal(args.context.callToken, "must-not-leak");
    assert.doesNotMatch(JSON.stringify(result) + JSON.stringify(f.state.calls), /must-not-leak/);
  });
}

const badInputs = [
  null, [], "sound", {}, { action: "delete", section: "sound" },
  { action: "get", section: "sync" }, { action: "get", section: "misc" }, { action: "get", section: "flowtime" },
  { action: "get", section: "sound", updates: { volume: 10 } }, { action: "get", section: "sound", expected: defaults.sound },
  { action: "get", section: "sound", foo: true }, { action: "get", section: "sound", callToken: "untrusted" },
  { ...edit(), action: "dispatchAction" }, { ...edit(), meta: { isPersistent: true } },
  { ...edit(), expected: undefined }, { ...edit(), expected: { volume: 75 } }, { ...edit(), expected: { ...defaults.sound, extra: true } },
  { ...edit(), updates: {} }, { ...edit(), updates: [] }, { ...edit(), updates: { workStart: "9:00" } },
  { ...edit(), updates: { volume: -1 } }, { ...edit(), updates: { volume: 101 } }, { ...edit(), updates: { volume: 0.5 } },
  { ...edit(), updates: { volume: "50" } }, { ...edit(), updates: { volume: null } }, { ...edit(), updates: { doneSound: "https://example.invalid/a.mp3" } },
  edit("focusMode", { focusModeSound: "rain" }), edit("focusMode", { autoStartFocusOnPlay: true }),
  edit("schedule", { workStart: "24:00" }), edit("schedule", { workEnd: "9:60" }), edit("schedule", { isLunchBreakEnabled: 1 }),
  edit("pomodoro", { duration: -1 }), edit("pomodoro", { duration: 0.5 }), edit("pomodoro", { duration: "25m" }),
  edit("pomodoro", { duration: Number.MAX_SAFE_INTEGER + 1 }), edit("pomodoro", { breakDuration: null }),
  edit("pomodoro", { longerBreakDuration: Infinity }), edit("pomodoro", { cyclesBeforeLongerBreak: 0 }),
  edit("pomodoro", { cyclesBeforeLongerBreak: 1.5 }), edit("focusDefaults", { autoStartFocusOnPlay: 1 }),
  edit("focusDefaults", { focusModeSound: "tick" }), edit("takeABreak", { takeABreakSnoozeTime: 2147483648 }),
  edit("takeABreak", { timedFullScreenBlockerDuration: 2147483648 }),
  edit("takeABreak", { takeABreakMessage: "arbitrary" }), edit("takeABreak", { motivationalImgs: [] }),
  { ...edit("pomodoro", { duration: 60000 }), expected: { duration: 1500000 } },
  { ...edit("takeABreak", { isTakeABreakEnabled: false }), expected: { isTakeABreakEnabled: true } },
  edit("display", { isDisableAnimations: "false" }), edit("display", { startOfNextDayTime: "00:00" }),
  edit("display", { backgroundImageDark: "file:///private" }), edit("display", { isUseCustomWindowTitleBar: true }),
  edit("taskBehavior", { notesTemplate: "arbitrary" }), edit("taskBehavior", { defaultProjectId: "project" }),
  edit("taskBehavior", { isAutoMarkParentAsDone: 1 }), edit("timeTracking", { defaultEstimate: -1 }),
  edit("timeTracking", { defaultEstimateSubTasks: 0.5 }), edit("timeTracking", { trackingReminderMinTime: Infinity }),
  edit("timeTracking", { isAutoStartNextTask: "true" }), edit("reminderDefaults", { countdownDuration: -1 }),
  edit("reminderDefaults", { countdownDuration: Number.MAX_SAFE_INTEGER + 1 }),
  edit("reminderDefaults", { defaultTaskRemindOption: "d1" }), edit("reminderDefaults", { defaultTaskRemindOption: "never" }),
  edit("reminderDefaults", { disableReminders: true }), edit("reminderDefaults", { dueDateNotificationHour: 9 }),
  { ...edit("display", { isDisableAnimations: true }), expected: { isDisableAnimations: false } },
  { ...edit("taskBehavior", { isTrayShowCurrent: false }), expected: { ...defaults.taskBehavior, defaultProjectId: "INBOX_PROJECT" } },
];
for (const [index, args] of badInputs.entries()) {
  test(`invalid input ${index + 1} fails before bridge status or operations`, async () => {
    const f = await setup();
    assert.equal((await f.call(args)).code, "SP_BAD_INPUT");
    assert.equal(f.state.statusReads, 0);
    assert.equal(f.state.calls.length, 0);
  });
}

for (const [section, updates] of [
  ["sound", { volume: 0, doneSound: null }], ["focusMode", { focusModeSound: "whiteNoise", focusModeSoundVolume: 100 }],
  ["schedule", { workStart: "08:30", isLunchBreakEnabled: true }],
  ["pomodoro", { duration: 1800000, breakDuration: 0, longerBreakDuration: 1200000, cyclesBeforeLongerBreak: 3 }],
  ["focusDefaults", { autoStartFocusOnPlay: true, isPauseTrackingDuringBreak: false, isShowPreparation: true, isManualBreakStart: true }],
  ["takeABreak", { isTakeABreakEnabled: false, takeABreakMinWorkingTime: 0, takeABreakSnoozeTime: 2147483647, isLockScreen: true, isTimedFullScreenBlocker: true, timedFullScreenBlockerDuration: 0, isFocusWindow: true }],
  ["display", { isDisableAnimations: true, isVerticalActionBar: true, isDisableCelebration: false, isShowProductivityTipLonger: true, isShowDueTaskBadge: true, isTrayShowCurrentCountdown: false }],
  ["taskBehavior", { isConfirmBeforeDelete: false, isAutoAddWorkedOnToToday: false, isAutoMarkParentAsDone: true, isTrayShowCurrent: false, isMarkdownFormattingInNotesEnabled: false }],
  ["timeTracking", { defaultEstimate: 1800000, defaultEstimateSubTasks: 300000, isNotifyWhenTimeEstimateExceeded: false, isAutoStartNextTask: true, isTrackingReminderEnabled: true, isTrackingReminderShowOnMobile: true, trackingReminderMinTime: 0, isTrackingReminderNotify: true, isTrackingReminderFocusWindow: true }],
  ["reminderDefaults", { isCountdownBannerEnabled: false, countdownDuration: 0, defaultTaskRemindOption: "DoNotRemind", isFocusWindow: true }],
]) {
  test(`update ${section} sends scoped expected values and verifies every projected field`, async () => {
    const f = await setup();
    const args = edit(section, updates), original = structuredClone(args);
    const result = await f.call({ ...args, context: { callToken: "private-host-token" } });
    assert.equal(result.ok, true);
    assert.deepEqual(result.settings, { ...defaults[section], ...updates });
    assert.equal(result.verification, "applied-state");
    assert.deepEqual(f.state.calls, [{ op: "preferences.update", args: { section, updates, expected: defaults[section] } }]);
    assert.deepEqual(args, original);
  });
}

for (const section of Object.keys(defaults)) {
  test(`0.3.0 bridge compatibility is decided per section: ${section}`, async () => {
    const f = await setup();
    f.state.status.pluginVersion = "0.3.0";
    const legacy = ["sound", "focusMode", "schedule"].includes(section);
    const key = Object.keys(defaults[section])[0];
    for (const args of [{ action: "get", section }, edit(section, { [key]: defaults[section][key] })]) {
      const result = await f.call(args);
      assert.equal(result.ok, legacy, JSON.stringify(result));
      if (!legacy) assert.equal(result.code, "SP_BRIDGE_UPGRADE_REQUIRED");
    }
    assert.equal(f.state.calls.length, legacy ? 2 : 0);
  });
}

for (const section of Object.keys(defaults)) {
  test(`0.4.0 keeps all six prior preference sections while gating new section ${section}`, async () => {
    const f = await setup();
    f.state.status.pluginVersion = "0.4.0";
    const supported = ["sound", "focusMode", "schedule", "pomodoro", "focusDefaults", "takeABreak"].includes(section);
    const key = Object.keys(defaults[section])[0];
    for (const args of [{ action: "get", section }, edit(section, { [key]: defaults[section][key] })]) {
      const result = await f.call(args);
      assert.equal(result.ok, supported, JSON.stringify(result));
      if (!supported) assert.equal(result.code, "SP_BRIDGE_UPGRADE_REQUIRED");
    }
    assert.equal(f.state.calls.length, supported ? 2 : 0);
  });
}

for (const pluginVersion of ["0.4.99", "0.5.0-beta", "0.5.0-rc.1"]) {
  test(`display preferences require a supported stable plugin: ${pluginVersion}`, async () => {
    const f = await setup();
    f.state.status.pluginVersion = pluginVersion;
    assert.equal((await f.call({ action: "get", section: "display" })).code, "SP_BRIDGE_UPGRADE_REQUIRED");
    assert.equal(f.state.calls.length, 0);
  });
}

for (const [section, field] of [["display", "isVerticalActionBar"], ["taskBehavior", "isAutoMarkParentAsDone"], ["timeTracking", "trackingReminderMinTime"], ["reminderDefaults", "defaultTaskRemindOption"]]) {
  test(`missing ${section}.${field} in a legacy response is never filled with a guessed value`, async () => {
    const f = await setup();
    f.state.override = () => {
      const settings = { ...defaults[section] };
      delete settings[field];
      return { section, settings };
    };
    assert.equal((await f.call({ action: "get", section })).code, "SP_BRIDGE_BAD_RESPONSE");
    assert.equal(f.state.calls.length, 1);
  });
}

for (const pluginVersion of ["0.3.99", "0.4.0-beta", "0.4.0-rc.1"]) {
  test(`new preference sections reject incompatible release ${pluginVersion}`, async () => {
    const f = await setup();
    f.state.status.pluginVersion = pluginVersion;
    assert.equal((await f.call({ action: "get", section: "pomodoro" })).code, "SP_BRIDGE_UPGRADE_REQUIRED");
    assert.equal(f.state.calls.length, 0);
  });
}

test("new-section write verification detects a changed field omitted from updates", async () => {
  const f = await setup();
  f.state.override = () => ({ section: "pomodoro", settings: { ...defaults.pomodoro, duration: 1800000, breakDuration: 600000 }, unchanged: false, verification: "applied-state" });
  const result = await f.call(edit("pomodoro", { duration: 1800000 }));
  assert.equal(result.code, "SP_BRIDGE_BAD_RESPONSE");
  assert.equal(result.outcomeUnknown, true);
  assert.equal(f.state.calls.length, 1);
});

for (const status of [
  { connected: false }, { enabled: false }, { running: false }, { available: false }, { accepting: false }, { stopping: true }, { error: { code: "FAIL" } }, { protocol: 2 },
  { pluginVersion: "0.2.0" }, { pluginVersion: "0.3.0-beta" }, { pluginVersion: "garbage" },
]) {
  test(`unavailable or incompatible bridge ${JSON.stringify(status)} prevents execution`, async () => {
    const f = await setup();
    Object.assign(f.state.status, status);
    const result = await f.call(edit());
    assert.match(result.code, /SP_BRIDGE_(?:NOT_CONNECTED|UPGRADE_REQUIRED)/);
    assert.equal(f.state.calls.length, 0);
    assert.equal(result.outcomeUnknown, false);
  });
}

test("status errors and preference conflicts are translated into SpError", async () => {
  const f = await setup();
  f.state.statusError = new Error("fixture status failure");
  assert.equal((await f.call(edit())).code, "SP_BRIDGE_UNAVAILABLE");
  f.state.statusError = null;
  f.state.error = Object.assign(new Error("Conflict"), { code: "SP_PREFERENCES_CONFLICT" });
  assert.equal((await f.call(edit())).code, "SP_PREFERENCES_CONFLICT");
  assert.ok(f.state.errors.every((error) => error instanceof SpError));
});

test("preference transport errors never reflect raw secrets or malformed codes", async () => {
  const secret = "private-preference-token-sentinel";
  for (const action of ["get", "update"]) for (const outcomeUnknown of [false, true]) {
    for (const code of ["SP_BRIDGE_TIMEOUT", "SP_PREFERENCES_CONFLICT", secret, `SP_BAD\n${secret}`, "SP_" + "X".repeat(81), "SP_", null, undefined, 42, { token: secret }]) {
      const f = await setup();
      f.state.error = Object.assign(new Error(`Authorization: Bearer ${secret}`), { code, outcomeUnknown });
      const result = await f.call(action === "get" ? { action, section: "sound" } : edit());
      const safeCode = ["SP_BRIDGE_TIMEOUT", "SP_PREFERENCES_CONFLICT"].includes(code) ? code : "SP_BRIDGE_ERROR";
      assert.equal(result.code, safeCode); assert.equal(result.outcomeUnknown, outcomeUnknown);
      assert.equal(f.state.calls.length, 1); assert.equal(f.state.errors.length, 1);
      assert.ok(f.state.errors[0] instanceof SpError);
      assert.equal(f.state.errors[0].message, "SP 偏好设置请求未能确认完成。请先重新读取当前设置，不要自动重试更新。");
      assert.doesNotMatch(JSON.stringify(result) + JSON.stringify(f.state.errors[0]) + f.state.errors[0].message, /private-preference-token-sentinel|Authorization|Bearer/);
      assert.deepEqual(f.state.settings, defaults);
    }
  }
});

test("local preference validation retains field and value guidance without contacting the bridge", async () => {
  for (const [args, message] of [
    [{ action: "get", section: "sound", foo: "private-input" }, /Unexpected preferences argument: foo/],
    [edit("sound", { volume: 101 }), /updates must contain supported fields with valid values/],
    [{ ...edit(), expected: { volume: 75 } }, /expected must be the complete settings object/],
  ]) {
    const f = await setup(), result = await f.call(args);
    assert.equal(result.code, "SP_BAD_INPUT"); assert.match(f.state.errors[0].message, message);
    assert.doesNotMatch(f.state.errors[0].message, /private-input/);
    assert.equal(f.state.statusReads, 0); assert.equal(f.state.calls.length, 0);
  }
});

for (const [label, value] of [
  ["null", null], ["empty", {}], ["wrong section", { section: "schedule", settings: defaults.sound }],
  ["missing field", { section: "sound", settings: { volume: 20 } }],
  ["wrong field type", { section: "sound", settings: { ...defaults.sound, volume: "20" } }],
]) {
  for (const action of ["get", "update"]) {
    test(`malformed ${action} reply ${label} is never a success`, async () => {
      const f = await setup();
      f.state.override = () => value;
      const result = await f.call(action === "get" ? { action, section: "sound" } : edit());
      assert.equal(result.code, "SP_BRIDGE_BAD_RESPONSE");
      assert.equal(result.outcomeUnknown, action === "update");
    });
  }
}

for (const override of [
  { settings: defaults.sound, unchanged: false, verification: "applied-state" },
  { settings: { ...defaults.sound, volume: 20, doneSound: null }, unchanged: false, verification: "applied-state" },
  { settings: { ...defaults.sound, volume: 20 }, unchanged: "false", verification: "applied-state" },
  { settings: { ...defaults.sound, volume: 20 }, unchanged: false },
]) {
  test(`update rejects unconfirmed or unexpected settings ${JSON.stringify(override)}`, async () => {
    const f = await setup();
    f.state.override = () => ({ section: "sound", ...override });
    const result = await f.call(edit());
    assert.equal(result.code, "SP_BRIDGE_BAD_RESPONSE");
    assert.equal(result.outcomeUnknown, true);
  });
}

test("a lost write reply is not retried and invalidates the pending-task summary", async () => {
  resetNoticeCache();
  const f = await setup();
  await readNotice(f.sdk);
  const before = f.state.noticeReads;
  await readNotice(f.sdk);
  assert.equal(f.state.noticeReads, before);
  f.state.error = Object.assign(new Error("Reply lost"), { code: "SP_BRIDGE_TIMEOUT", outcomeUnknown: true });
  const result = await f.call(edit());
  assert.equal(result.outcomeUnknown, true);
  assert.equal(f.state.calls.length, 1);
  await readNotice(f.sdk);
  assert.ok(f.state.noticeReads > before);
  resetNoticeCache();
});
