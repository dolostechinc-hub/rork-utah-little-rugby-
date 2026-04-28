# Make sure every volunteer's local edits get pushed to the cloud

## The problem

Right now, when a volunteer updates a player's weight, photo, or check-in status, the change saves to their phone immediately but is sent to the cloud "fire-and-forget." If their device was offline, on flaky Wi-Fi, or hit any error, the change stays trapped on their phone with no automatic recovery. That's why edits made tonight haven't all shown up.

## What I'll add

### A persistent cloud sync queue (the safety net)
- [x] Every time a player is added, edited, checked in, or has a photo/weight change, the change is added to a **persistent queue stored on the device**.
- [x] The queue survives app restarts, force quits, and reboots.
- [x] The app keeps retrying queued items in the background until the cloud confirms each one.
- [x] Each queued change carries a timestamp so the cloud can apply **"newest wins"**.

### Auto-sync on launch and reconnect
- [x] When the app opens, it automatically flushes the queue to Supabase.
- [x] When the device regains internet, it flushes again automatically.
- [x] Volunteers don't have to do anything — opening the app is enough.

### A visible "unsynced changes" banner
- [x] A bright banner appears at the top of the home screen whenever there are local edits not yet confirmed by the cloud.
- [x] Tapping the banner shows a list of pending edits and a **"Sync Now"** button.
- [x] The banner disappears automatically once everything is confirmed.

### A "Force Sync to Cloud" button in Settings
- [x] New section in Settings called **Cloud Sync** showing last sync time, pending count, and a Force Sync Now button.
- [x] Success/failure feedback after it runs.
- [x] Panic button volunteers can tap tonight to flush stuck data.

### Newest-wins conflict handling
- [x] Each queued edit carries a `lastEditedAt` timestamp stamped at edit time on the device.
- [x] When pushing to Supabase, we skip if remote `updated_at` is newer than the local timestamp.

## What volunteers will see

1. **Open the app tonight** → it auto-pushes anything stuck on their phone.
2. **Yellow banner at top of home screen** if anything is still unsynced, with a one-tap retry.
3. **Settings → Cloud Sync** with a Force Sync Now button and a "Last synced: 2 minutes ago" timestamp for peace of mind.
4. **Toast confirmation** ("All changes synced ✓") when a sync completes successfully.

## What you (admin) get

- Confidence that no edit can silently die on a volunteer's phone again.
- A direct way to tell volunteers: *"open the app and tap Force Sync Now in Settings"* — and know it actually pushes everything.
- Clear visual proof on each device of whether they're caught up or behind.

## Final reconcile (one-shot, ships in this update)

When a volunteer opens the app after this update, a one-time reconcile runs automatically in the background:

- [x] Sweep every AsyncStorage scope on the device (current org + any legacy org_ids) and collect every cached player.
- [x] Look up every cloud org that shares the same invite code as the org the user is signed into; pull rosters from all of them in case duplicates exist.
- [x] Combine local + cloud rosters and dedupe by name+DOB, keeping the richest record (photos, weight, check-in, age verified).
- [x] Force-push the merged roster to the canonical cloud org with a fresh "now" timestamp so this update wins over any stale data.
- [x] Persist the merged roster locally under the canonical org scope.
- [x] Tracked via a `final_reconcile_v2_done` flag so it only runs once per install (the existing **Force Sync to Cloud** button re-runs it on demand).

## Out of scope (not changing)

- The Google Sheets queue stays as it is — this is a separate Supabase queue.
- No changes to the database schema beyond reading the existing `updated_at` column for conflict detection.
- No new orgs created or data migrated — this is purely about getting stuck edits off devices and into the cloud you already have.