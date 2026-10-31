# SP 19.3.1 counter creation persistence

`0001-persist-plugin-counter-creation.patch` is an upstream source patch for review. It is not applied to the installed application or included as executable plugin code. The Hana adapter continues to reject counter creation until a supported SP release contains this fix and that release has been verified.

The public `PluginAPI.setCounter(id, value)` method creates a missing ID using `upsertSimpleCounter`. That action intentionally has no persistence metadata because it is also used for sync/import. The new counter is visible in live state, but no create operation reaches the operation log. A later update contains only changed fields, so replay from an earlier snapshot cannot reconstruct the missing counter.

The patch changes only the new-ID branch to the existing `addSimpleCounter` action. That creator supplies `isPersistent: true`, `entityType: SIMPLE_COUNTER`, the new entity ID, `opType: CRT`, and the complete counter payload. The existing-ID branch still uses `updateSimpleCounter`. The patch does not change the public method signature, input checks, defaults, plugin permissions, action allowlist, or the general-purpose upsert action.

Baseline: the installed SP 19.3.1 source map's `src/app/plugins/plugin-bridge.service.ts`, SHA-256 `71df894a5ed614819670c04c0e29d7334d0d2db2fcd30bcaec758b54aad9a496`. It matches the local extracted source byte for byte. Relevant upstream sources are:

- `src/app/plugins/plugin-bridge.service.ts`: `setCounter`, `incrementCounter`, `decrementCounter`.
- `src/app/features/simple-counter/store/simple-counter.actions.ts`: persistent `addSimpleCounter` and nonpersistent `upsertSimpleCounter`.
- `src/app/features/simple-counter/store/simple-counter.reducer.ts`: `addOne`, `updateOne`, and `upsertOne` handlers.
- `src/app/op-log/capture/operation-log.effects.ts`: filters persistent actions and captures their payload without `type` or `meta`.
- `src/app/op-log/apply/operation-converter.util.ts`: converts captured payloads back into remote actions for replay.

Run the isolated test against an unchanged official source checkout:

```powershell
$env:SP_UPSTREAM_SOURCE_DIR = 'D:\source\super-productivity'
node --test sp-hana-bridge/upstream-patches/counter-create-replay.mjs
```

Or read an installed ASAR with source maps, without modifying it:

```powershell
$env:SP_UPSTREAM_ASAR = 'D:\MyApplications\Super-productivity\Super Productivity\resources\app.asar'
node --test sp-hana-bridge/upstream-patches/counter-create-replay.mjs
```

The test applies the patch in memory. It executes the actual extracted bridge methods, action creators, counter reducer, persistence predicate, and operation converter. Small NgRx action/entity shims replace framework plumbing; the operation-log capture envelope is modeled from the official source. All entities, operations, and replays exist only in memory. No SP API, database, network, user counter, or installation is written.

The regression covers the old failure, complete create payload replay, existing-ID history preservation, repeated calls, increment/decrement creation, unrelated entities, and input validation. It does not claim to verify IndexedDB durability, sync-service delivery, or simultaneous same-ID writers. Before upstream release, run SP's official unit/integration suite and add a real operation-log reload/sync test. Existing counters created through the buggy path are not retroactively repaired by this patch.
