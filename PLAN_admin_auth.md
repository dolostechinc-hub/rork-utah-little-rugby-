# Tie admin to a user, not a device

## The problem

Today admin is bound to a single device. The "user identity" the app relies on is a random UUID minted by `generateUUID()` at org-create time, kept only in the device's AsyncStorage, and pushed to the server as a fact the server has to trust:

- `organizations.owner_id` is that random UUID, **not** an `auth.users.id`.
- `org_members.user_id` is also a random UUID per device.
- The app does not use Supabase auth at all (see migration 016: *"the app does NOT use Supabase auth, so `auth.uid()` is always NULL"*). Every admin RPC has a `p_admin_user_id` parameter that the client passes from local state because there is no real `auth.uid()`.
- The local check `RegistrationContext.isOrgOwner` only flips true when the **device's** local `OrgMember.userId` matches `currentOrg.ownerId`. That match only ever happens on the device that originally created the org.

Practical consequences:

- Admin disappears the moment the creator's phone is reinstalled or replaced.
- A second device of the same human cannot become admin.
- An org has exactly one admin per its lifetime, and there is no mechanism to add or transfer one without DB access.
- An org that is created and then has its creator device retired is permanently orphaned — it still exists in Supabase but no one in the world can become admin of it again.

## What we want

Two tiers of admin, both tied to humans (real `auth.users.id`), neither tied to devices:

1. **League admins** — a small fixed list (initially: just the project owner; Thomas to be added once he has signed in once). Admin of *every* org, automatically. This is the orphan-proof root: as long as one league admin exists, every org has a path back to admin.
2. **Org admins** — per-org, granted by a league admin or by an existing admin of that org. Admin powers in that one org only.

Both tiers identified by `auth.users.id` from the magic-link sign-in.

## Design

Three things, one phase, no claim flow.

### 1. `app_admins` table — the league admin list

```sql
CREATE TABLE public.app_admins (
  auth_uid UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email    TEXT NOT NULL,
  added_by UUID REFERENCES auth.users(id),
  added_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

Flat, top-level. Bootstrapped manually (one INSERT). After that, RPCs gated by "caller is an existing app admin" let league admins manage it from inside the app.

### 2. `is_admin_of_org` learns two new clauses

The existing function already accepts:

- caller's id matches `organizations.owner_id` (synthetic UUID), or
- caller's id matches `org_members.user_id` for an `'owner'/'admin'` row (synthetic UUID).

We add:

- `auth.uid()` is in `app_admins`, **OR**
- `auth.uid()` matches a row in `org_members.auth_uid` for an `'owner'/'admin'` row in this org.

`auth.uid()` is null today (we don't use Supabase auth), so adding these clauses is a strict superset — nothing breaks. Once a user signs in, the new clauses start mattering.

### 3. `org_members.auth_uid` for per-org admins

```sql
ALTER TABLE org_members ADD COLUMN auth_uid UUID REFERENCES auth.users(id);
CREATE UNIQUE INDEX ON org_members(org_id, auth_uid) WHERE auth_uid IS NOT NULL;
```

The unique-when-non-null index means a given auth user can be a member of an org at most once, but the existing synthetic-UUID rows are unaffected.

A new RPC `grant_org_admin_by_email(p_org_id, p_email)`:

- Authorised by `is_admin_of_org(p_org_id, auth.uid())` (so a league admin or an existing org admin can call it).
- Looks up `auth.users` by email. The user must have signed in at least once.
- Upserts an `org_members` row with `auth_uid = <found id>, role = 'admin'`.

### Bootstrap (one-time, manual)

1. The first league admin (you) opens the app on your usual device and taps "Sign in". Magic link → tap → app receives the redirect → `auth.users` row is created.
2. From the Supabase SQL editor, run:
   ```sql
   INSERT INTO public.app_admins (auth_uid, email)
   VALUES ((SELECT id FROM auth.users WHERE email = 'you@example.com'),
           'you@example.com');
   ```
3. From here on, you can add Thomas (or anyone else) directly from inside the app via the new "League Admins" Settings section once he has signed in once to mint his `auth.users` row.

## What stops a random person from claiming admin

Three layers:

1. To be a league admin, your `auth.uid()` must already be in `app_admins`. Inserts into that table are gated by `is_app_admin(auth.uid())` — i.e. you have to already be a league admin to add another league admin. The very first row is bootstrapped manually with a service-role SQL statement; you can't bootstrap yourself from the client.
2. To be an org admin, an existing admin of that org (org admin or league admin) must have explicitly granted you via `grant_org_admin_by_email`. Joining via the org code only ever gets you `role='volunteer'`.
3. Both writes go through `SECURITY DEFINER` RPCs that re-check `is_admin_of_org` / `is_app_admin` server-side. The client passes its synthetic UUID *as a fallback only*; the moment `auth.uid()` is non-null the RPC trusts auth, not the client-provided id.

## What goes away

- The "claim this org" flow I sketched in earlier drafts. Not needed: signing in plus `app_admins` covers the orphan-prevention concern more cleanly.
- The artificial Phase 1 / Phase 2 split. We can land all of it in one migration.
- The `isOrgOwner` device-bound gate as a hard requirement for admin. Once the user is signed in *and* in `app_admins` (or an org admin via `auth_uid`), the device check is no longer relevant. The local derivation of `isAdmin` becomes:
  ```
  isAdmin = signedIn && (isAppAdmin || isOrgAdminViaAuth || isLegacyDeviceOwner)
  ```
  The third clause stays for backwards compat with orgs that have no auth-linked admin yet.

## Files to touch

- `expo/supabase/migrations/032_supabase_auth_admins.sql` — new
- `expo/lib/supabase.ts` — already configured for AsyncStorage / autoRefresh / persistSession; verify only
- `expo/lib/appAdmin.ts` — new TS wrappers for the new RPCs
- `expo/contexts/AuthContext.tsx` — add `authUserId`, `authEmail`, `isAppAdmin`, `signInWithEmail`, `signOut`; subscribe to `onAuthStateChange`; widen `isAdmin` derivation
- `expo/contexts/RegistrationContext.tsx` — broaden `isOrgOwner` derivation so signed-in app admins / signed-in org admins flip it true
- `expo/app/(tabs)/settings.tsx` — new Account section (sign in/out), new League Admins section, new "grant by email" path inside Permanent Admins
- A top-level URL handler in `expo/app/_layout.tsx` that calls `supabase.auth.exchangeCodeForSession` when the app is opened via the magic-link redirect on iOS/Android. Web is already handled by `detectSessionInUrl`.

## Out of scope (for now)

- Editor PIN flow — unchanged. Volunteers stay anonymous.
- RLS using real `auth.uid()` — deferred. We continue going through `SECURITY DEFINER` RPCs because the existing fallback path still needs to work for orgs without an auth-linked admin.
- Deleting / migrating synthetic UUIDs — deferred. They keep working as-is and are simply no longer load-bearing once a real user is signed in.

## Definition of done

1. The first league admin (you) can sign in with email on any device, anywhere, and have admin powers in every org without configuring anything per-device.
2. The same admin reinstalls the app, signs in again, and is admin again. No data loss.
3. Adding Thomas as a second league admin is a single in-app action (paste his email after he signs in once).
4. An attacker without an admin grant — no matter how many times they join via an org code or sign in with an unrelated email — is never an admin of anything.
5. Editor PIN flow still works for volunteers, untouched.
