# Hana SP Bridge 0.6.0

0.6.0 long-polls: after the bridge answers a poll with `longPoll: true`, the
plugin sends `wait: true` and the bridge holds the request until a command
arrives or about 20 seconds pass. Older bridges never see the field.

A standard Super Productivity 19.3.1+ companion plugin for the Hana task desk.
This is a user-installed integration using SP's public plugin APIs, not an
upstream SP product. No ASAR patch, direct database write, Node permission, or
SP restart is needed by this plugin.

## Build and install

1. Download the bundled extension from Hana Task Desk 0.9.0 settings. For a
   source build, run `node scripts/bundle-companion.mjs` in the sibling
   `sp-tasks` directory (Node 20+; no dependencies). This also embeds the ZIP
   and verified version metadata in the Hana application.
2. In SP Settings > Plugins, upload `hana-sp-bridge.zip` and enable it.
   `manifest.json` and `plugin.js` are at the ZIP root.
3. In the Hana task desk, explicitly enable its managed local bridge and copy
   the pairing code. It has the form `HANA-SP1.<base64url-json>`.
4. Open **配对 Hana 任务台** from the SP menu or the **Hana 任务台桥接** plugin's
   settings button, paste the code, and select **配对**. Check status in Hana.
5. Select **断开配对** in the same dialog to erase the local secret. Disable or
   uninstall the plugin to stop its fetches, polling, and timers.

The code decodes to `{protocol:1,url: 'http://127.0.0.1:3877',token: '...'}`.
Do not share, screenshot, commit, or send it in a chat. It is stored only with
`PluginAPI.setSecret`; it never enters synced config, exported plugin data,
query strings, status output, or diagnostic logs. SP's local secret store is
not encrypted at rest and does not protect against other local applications.

## Supported operations

- `projects.list`: all live-store projects including archived projects; returns
  only ID, title, icon, color, archive/backlog/menu flags and item counts.
- `projects.create` / `projects.update`: title, Material icon name, `#RRGGBB`
  color, `isEnableBacklog`, `isHiddenFromMenu`. Empty icon clears it; empty
  project color resets SP's default `#29a1aa`. Disabling backlog moves its tasks
  into the regular project list through SP's own effect.
- `projects.delete`: exact `projectId`, `allowCascade:true`, and `confirmTitle`
  exactly matching the current name are always required. Deletion cascades to
  tasks, backlog, subtasks, notes, repeat rules, archive and time tracking. It
  cannot be undone by this plugin. It returns observed impact counts, not a
  complete dry run: SP's archive getter can silently return an empty list on
  failure, and asynchronous archive cleanup cannot be independently confirmed.
- `tags.list` / `tags.create` / `tags.update`: ID-based operations on title,
  Material icon, and color; empty icon or tag color clears to null.
- `tasks.repairCompletion`: restores one active task's exact `isDone` and
  historical `doneOn`, after checking the expected completion metadata. It
  preserves `wontDoOn`; changing that marker is not supported by SP's public API.
- `counters.list` / `counters.update` / `counters.delete`: configure existing
  counters' title, icon, enabled state and button visibility. Deleting requires
  the exact current title and `allowHistoryDelete:true`, and rejects a counter
  whose `isOn` is true. Disabling an active stopwatch pauses its counting;
  enabling it can resume counting. Types and historical values are not changed.
- `taskOrder.list` / `taskOrder.update`: read or replace a complete project
  main-list or parent-task child-list order, at most 200 IDs. The set must be
  unchanged and `expectedTaskIds` must match the current order. Backlog is
  preserved. Readback verifies the complete order.
- `selection.list` / `selection.select`: read or open a task's detail panel;
  this is not keyboard focus or starting the task timer.
- `counterControl.list` / `counterControl.start` / `counterControl.stop`:
  read and explicitly start/stop an existing enabled stopwatch. Writes require
  the complete previously read counter state as `expected`; an already-achieved
  target never toggles back. Disabled counters are not implicitly enabled.
  Repeated countdown reminders support read/stop only: SP's public toggle does
  not initialize their UI-owned countdown. Stopping pauses the countdown without
  clearing its cache or completion banner. Click counters have no start/stop.
  `localOnly:true` applies to the switch state; SP still persists accumulated
  stopwatch time periodically and when stopped.
- `workContext.list` / `workContext.switch`: read or switch the local active
  project/tag, including TODAY and INBOX_PROJECT. A switch requires the current
  `{id,type}` as `expected`, validates a live destination, and rejects archived
  projects. It clears task-detail selection and refreshes existing integrations;
  it does not navigate the router, stop task tracking, or start a focus session.
- `tasks.reparent`: change or remove a leaf task's parent through the official
  batch API. Requires `expectedParentId`, the same active project, root-level
  parents, an empty project backlog, no related repeat rules, consistent
  references, matching completion states, and no time/estimate values in the
  affected family. SP's batch reducer does not recalculate parent effort, so
  existing tracked or estimated effort is rejected before writing. A full
  explicit project order prevents the batch API from reordering unrelated roots.
- `preferences.list` / `preferences.update`: get or change fixed fields in
  `sound`, `focusMode`, `schedule`, `pomodoro`, `focusDefaults`, `takeABreak`,
  `display`, `taskBehavior`, `timeTracking`, or `reminderDefaults`. The four
  new sections require 0.5.0; the focus/break sections require 0.4.0 and the original three remain
  compatible with 0.3.0. Updates require the complete previously
  read settings as `expected`; no arbitrary section, action or metadata can be
  supplied. The fixed public configuration action includes SP's persistence
  metadata (`GLOBAL_CONFIG`, `UPD`). Readback confirms applied state; disk and
  remote synchronization completion are not independently confirmed.
- `ui.command`: eight fixed commands: `focus.show`, `focus.hide`,
  `addTask.show`, `addTask.hide`, `notes.toggle`, `issues.toggle`,
  `sidePanel.hide`, and `pluginPanel.hide`. These use only allowlisted public
  actions. A receipt has `verification:submitted`, not rendered-state proof.
  Closing the focus overlay cancels an unstarted preparation countdown, not
  an active session. Notes/issues toggles hide other non-task panels; hiding
  the plugin panel also clears its selection. Never blindly retry a toggle.
- `attachments.list/add/remove`: link metadata for one exact active task.
  Add/remove require `expectedRevision` from list; SHA256 includes every raw
  attachment and hidden field. Only uniquely identified HTTP/HTTPS links are
  editable; other entries are counted and preserved. New URLs are normalized
  and duplicate URLs rejected. No link is fetched/opened, no local file is
  uploaded/downloaded/deleted. Re-read immediately before writing, then verify
  the complete array; maximum 1000 entries and 256 KiB of metadata.
- `keyboard.list/update`: built-in application/task bindings only. Update
  requires the whole raw configuration's `expectedRevision`, accepts `null`
  to unbind, and rejects newly introduced conflicts unless explicitly accepted
  with `allowConflicts:true`. Existing collisions remain unchanged. Global,
  plugin and unknown bindings cannot be edited but are preserved and included
  in the fingerprint and full `sectionCfg` payload. SP's keyboard effect
  re-registers system shortcuts using that payload: a partial payload would
  unregister omitted global bindings. State readback does not prove operating
  system registration or actual key responsiveness. No keystrokes are sent.
  Introducing `showHelp:?` also requires explicit risk acceptance through
  `allowConflicts:true`, because its event-key/AltGr behavior depends on an
  unexposed keyboard layout; success includes `warnings:["help-layout-dependent"]`.
  Existing `?` bindings are preserved. Static checks are not a guarantee that
  every keyboard layout is collision-free. Dynamic conflict field names are
  projected as `external-binding`, never raw plugin configuration names.

Names must be unique after whitespace trimming, Unicode NFKC normalization,
and case folding. Existing same-name objects are never reused silently.
`INBOX_PROJECT` and `TODAY` cannot be changed or deleted. Unknown fields, stale
IDs, blank titles, unsupported URLs, arbitrary actions, and executable code are rejected.

Project `color` maps to `theme.primary`; other theme fields are preserved.
When creating a project with a color, the plugin first lets SP build its full
default theme, then changes the primary color. Clearing a newly created tag's
color likewise requires a follow-up update because SP randomizes null on add.
If a later step fails, the operation is marked `outcomeUnknown`; it is **not**
automatically recreated or rolled back. Inspect SP before retrying.

Not provided: tag deletion, project archive/unarchive, arbitrary global
settings or actions, counter creation, database access, arbitrary UI automation, or a
claim of complete control over all SP features. The existing Hana REST tools
continue to handle other task, repeat-rule, note and counter operations separately.

Counter creation is deliberately unavailable: SP 19.3.1's public `setCounter`
creation branch dispatches an upsert without persistent operation metadata.
The subsequent config update cannot recreate a missing entity during replay.
Create counters in SP's own UI; an in-memory creation success is not a durable
result. Updates and deletion of existing counters use persistent public APIs.
The separate `upstream-patches` directory contains a review-only source patch
and an in-memory replay test against the installed 19.3.1 source. It is not
applied to SP or included as executable patch code in the extension. The
counter creation tool remains unavailable until a fixed SP build is verified.

Preference fields include volume, bundled sound names, completion pitch,
focus background sound, work/lunch clock times, Pomodoro durations and cycles,
four focus behavior defaults, and seven break-reminder settings. `focusDefaults`
maps to the real `focusMode` configuration section and persistence entity ID.
Duration fields use milliseconds. Pomodoro changes do not reset the active
session timer or cycle count; break durations and focus defaults can affect its
next transition. Enabling break reminders or lowering the work threshold can
trigger configured lock-screen, full-screen blocking, and window-focus behavior
during current tracking. Disabling the option does not guarantee cancellation
of already queued actions. The full-screen blocker treats a zero duration as
five seconds; blocker and snooze durations cannot exceed 2147483647 ms because
SP passes them to JavaScript timers. Sync credentials, backups, the day boundary,
and direct focus-session start/pause/cancel/complete remain excluded. These are
global preferences, and SP may synchronize them to other devices. Expected-value
checks are not atomic transactions with manual edits or sync.

The 0.5.0 preference sections add visual flags, task behavior, default estimates,
tracking reminders and scheduled-reminder defaults. Auto-add-to-today can
affect a currently tracked unscheduled task. Auto-complete-parent and auto-next
apply to later completion events, potentially starting a different task.
Default estimates do not rewrite existing tasks; zero adds no default estimate.
Tracking-reminder threshold zero is not disabled: a later eligible positive
tick may notify. Reminder lead duration zero disables advance countdown, not
the at-time reminder. Default reminder choices do not rewrite existing tasks
or repeat rules; explicit REST scheduling does not necessarily use UI defaults.
Missing or malformed fields fail instead of inventing upstream defaults.

Remaining public API gaps include real board/column CRUD and visibility getters
for these UI panels. File/image transfer, additional list ordering and remaining
preferences/day-boundary adaptation are task-desk engineering gaps, not a claim
that SP lacks all corresponding capabilities.

## Completion repair

This operation is available from plugin 0.2.0. Hana must check that version and
a live connection before issuing it; 0.1.0 does not accept the operation. It
uses only `PluginAPI.getAppState` and `PluginAPI.updateTask`, without adding
permissions or exposing arbitrary task fields.

The exact arguments are:

```json
{
  "taskId": "exact-task-id",
  "expected": { "isDone": false, "doneOn": null, "wontDoOn": 123 },
  "desired": { "isDone": true, "doneOn": 123, "wontDoOn": 123 }
}
```

All fields are required; extra fields are rejected. Timestamps must be `null`
or safe integer milliseconds from 0 through 8640000000000000. Missing internal
timestamps are represented as `null`. Only the active task store is read;
the plugin does not restore an archived task or search the archive for it.

If the task already equals `desired`, the operation returns success with
`unchanged:true`, even when `expected` is stale. Otherwise all three current
fields must match `expected`, or it fails with `SP_COMPLETION_CONFLICT` before
writing. A change to `wontDoOn`, or an unavailable `updateTask` API, fails with
`SP_COMPLETION_UNSUPPORTED` before writing. Hana should retain the repair
record when either failure occurs.

The write contains `doneOn`, and includes `isDone` only when its value must
change. Omitting an unchanged `isDone` prevents SP from treating a date repair
as another completion event. Explicit `doneOn:null` uses SP's mapper to clear
the internal timestamp; omitting `doneOn` when marking done would let SP stamp
the current time instead. Preserving a historical `wontDoOn` and restoring the
matching `doneOn` also preserves SP's "won't do" classification. The marker
itself is never written.

Before a false-to-true completion change, a referenced repeat rule must exist
and have neither `waitForCompletion` nor `repeatFromCompletionDate` enabled.
Otherwise the operation fails with `SP_COMPLETION_REPEAT_UNSUPPORTED` before
writing, including when the rule is paused: SP's completion effect can still
move the recurrence anchor. Ordinary repeat rules are allowed. A child also
requires an active, already-done parent, or the operation fails with
`SP_COMPLETION_PARENT_UNSUPPORTED`. This prevents SP's automatic parent update
from changing another task or accessing an absent archived parent. These
guards do not block a date-only correction or reopening a task. Hana checks
these conditions before native restore as well; declined repairs must retain
their recovery records rather than silently changing related tasks or rules.
An issue association on the task or its direct parent also blocks this
completion change with `SP_COMPLETION_ISSUE_UNSUPPORTED`. Any nonempty
`issueId`, `issueProviderId`, or `issueType` is treated conservatively as an
association, because SP can trigger issue status or worklog workflows when a
task or an issue-linked parent's child is completed. Date-only corrections do
not send another completion event and remain supported.

After updating, all three fields are read back and must match `desired` before
success is reported:

```json
{
  "ok": true,
  "data": {
    "id": "exact-task-id",
    "completion": { "isDone": true, "doneOn": 123, "wontDoOn": 123 },
    "unchanged": false
  }
}
```

An API error or mismatched readback after the write starts returns failure
with `outcomeUnknown:true`; the plugin does not retry the write. This is a
checked update, not an atomic compare-and-set: SP's public API cannot lock out
manual edits or sync between the snapshot and update. SP's other normal
task-update effects still apply. Verification covers the selected task's
applied state, not unrelated tasks, persistence or remote sync.

## Protocol and lifecycle

All requests use native `fetch`, `Authorization: Bearer <pluginToken>`, JSON,
`credentials:omit`, and `redirect:error`. Only the exact HTTP origin
`http://127.0.0.1:3877` is accepted. SP 19.3.1's ordinary code plugins run in
the renderer; its CSP permits loopback fetch. `PluginAPI.request` instead
blocks private networks, so it is deliberately not used. The manifest declares
HTTP reach and project-delete capability for visible install disclosure.

- POST `/plugin/poll` body `{clientId,version,protocol:1}` returns
  `{ok:true,data:{command:{id,op,args,expiresAt}|null}}`.
- POST `/plugin/result` body `{clientId,id,result}`; success result is
  `{ok:true,data}`, failure is `{ok:false,error:{code,message},outcomeUnknown?,createdId?}`.
  The server acknowledges with `{ok:true,data:{accepted:true,id}}`.
- `expiresAt` is a Unix millisecond timestamp. Every load generates a new
  client ID. The managed bridge owns single-client leases and stale-client
  quarantine; the plugin cannot bypass them.

The plugin processes one command at a time, remembers executed command IDs for
the session, retries only result delivery, and does not poll for another command
until the prior result is acknowledged. A lost response never retries a write.
Backoff grows from one to thirty seconds. `onReady` starts the loop without
blocking activation; `onUnload` synchronously aborts fetches and clears timers.
After reload or disconnect during a write, Hana may report unknown outcome.
After a Hana restart loses an old receipt, that result is discarded with a
visible notice; the write is not repeated, and polling resumes. Disconnect
waits for any already-entered SP API call before allowing a new pairing.
The receipt cache has 1,024 entries and an 8 MiB budget, with capacity reserved
before executing a command. Write receipts are never evicted; reads retain
compact completion markers. At the limit, new commands fail without executing;
check pending results, then disable/re-enable the plugin to start a new session.
Responses over 1 MiB become a small explicit failure instead of being retried
forever. A rejected result envelope is reduced and reported once; repeated
rejection stops the connection and asks for explicit disconnect/re-pair.

Successful mutation verification means the official API's current app-state
snapshot reflects the requested fields. It does not promise disk flush, remote
sync completion, archive cleanup completion, or protection from simultaneous
manual edits/sync on another device. Error details do not echo SP content.

## Verification status and source evidence

The isolated Node tests use an in-memory SP API and mocked fetch only. They
exercise the actual source and generated `plugin.js`, without connecting to
SP or Hana. Completion fixtures follow SP 19.3.1's null mapping, automatic
timestamp helper and final reducer overlay, including historical completion
and "won't do" classification. Installing, rendering the native pairing dialog, real Electron
loopback networking, permissions consent, and real data writes require a
separate user-approved acceptance test; generating this package does none.

The installed 19.3.1 source excerpts are under the workspace's ignored
`_probe/sp-api-19.3.1` directory. Relevant upstream source paths:

- `packages/plugin-api/src/types.ts`: project/tag methods, `setSecret`, hooks.
- `src/app/plugins/plugin-runner.ts`: ordinary renderer code and lifecycle.
- `src/app/plugins/plugin-bridge.service.ts`: validated official service calls,
  projection source, project cascade, archive getter failure behavior.
- `src/app/plugins/plugin-api-mapper.ts`: project/tag fields pass through;
  explicit `doneOn:null` becomes an own `doneOn:undefined` property.
- `src/app/plugins/plugin-bridge.service.ts`: `updateTask` rejects `wontDoOn`;
  supported completion fields use the ordinary task update service.
- `src/app/features/tasks/store/task.reducer.util.ts` and
  `src/app/root-store/meta/task-shared-meta-reducers/task-shared-crud.reducer.ts`:
  automatic completion timestamps run before explicit update fields are applied.
- `src/app/features/tasks/util/is-wont-do-task.ts`: a done task is classified
  as "won't do" when its non-null `wontDoOn` equals `doneOn`.
- `src/app/features/task-repeat-cfg/store/task-repeat-cfg.effects.ts`:
  `isDone:true` can advance a completion-based rule or create another instance.
- `src/app/features/tasks/store/task-internal.effects.ts`: child completion
  can finish its parent; an already-done parent short-circuits that effect.
- `src/app/features/project/project.service.ts` and `project.const.ts`: default
  theme and deletion cascade.
- `src/app/features/tag/tag.service.ts`: tag color randomization on create.
- `src/app/plugins/plugin-security.ts`: native fetch is permitted independently
  of the scoped `PluginAPI.request` API.
- `electron/main-window.js`: origin stripping and response CORS headers. Do not
  treat CORS or the request Origin header as authentication.
