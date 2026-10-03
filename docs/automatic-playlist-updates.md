# Private automatic playlist updates and browser notifications

This branch extends `codex/scheduled-catalog-scans`. Nothing is deployed by committing it.
Automatic scans and **Automatically update Spotify playlist** are separate per-show opt-ins.
Existing catalogues start with playlist automation **off**, including Dimension Door.
Channeling must remain manual and its copied third-party playlist must remain unlinked.

## Operation and safety

- The daily worker remains 09:00 Europe/Brussels, one due show, at most five episodes,
  18-minute execution budget, one task, no task/scheduler retries. Discovery frequency is unchanged.
- New matches use the existing confident `checked` rule. Uncertain candidates are saved unchecked;
  existing manual inclusions, exclusions and alternatives are not rewritten.
- Playlist targets use the existing episode chronology, original within-episode order and exact-URI
  deduplication. Reviewing another track later and manually applying updates places it in its episode,
  not at an arbitrary playlist end. Every operation reuses the linked ID; the worker has no creation path.
- A changed selected target runs a read-only preview, checks ownership against the permitted account,
  and compares Spotify with the last app-known snapshot, metadata and ordered-content fingerprint.
  Unexpected changes pause for review. No target change means no token refresh or Spotify playlist reads.
  Manual updates through the coordinated endpoint advance this baseline.
- First enable requires a currently linked, completely synchronized playlist. Newly created playlists
  have a server-side creation registry. Historical app-created links predate that registry: the owner
  must explicitly confirm their origin, and a read-only exact comparison must pass. Ownership alone is
  not proof of historical creation. This is an explicit migration attestation, never automatic adoption.
- An exclusive Firestore lease coordinates hosted scans, worker writes and hosted/manual playlist calls.
  Manifest-only revision checks fence catalogue changes before every mutation without loading every
  episode repeatedly. Immutable operation IDs, revision CAS and dispatch-before-write persistence use
  the existing resumable batch engine: replace the first 100, append remaining batches of at most 100,
  with bounded read-only settlement. Confirmed prefixes survive job/server restarts.
- The existing durable owner cooldown also blocks playlist work. A playlist 429 extends that deadline.
  Settlement can continue on a later daily invocation; it never blindly retries a mutation.
- A timeout does **not** prove Spotify cancelled a request. Ambiguous dispatch/acknowledgement outcomes
  remain quarantined and then read-only blocked. An uncertain write is not automatically restarted,
  even if a later preview looks synchronized. Manual inspection/operator resolution is required;
  there is no exactly-once guarantee across Spotify and Firestore. Pausing does not erase that fence.
  For acknowledged/non-ambiguous partial work, explicitly pause automation before taking over with a
  fresh manual preview. Genuine external edits require manual synchronization and explicit re-enable.
- A disconnect fences later dispatches, but cannot cancel a Spotify request already accepted upstream.
  Cloud selections can change after the last check and before Spotify responds; the next boundary stops
  safely. No cloud review data is overwritten. Reload the latest cloud copy before reviewing.
- Local Vite **with the approved cloud bridge connected** routes explicit catalogue playlist actions
  through the same hosted coordinator. The bridge exposes no background tokens. Standalone/offline
  local installations cannot acquire cloud leases: pause automatic scans **and playlist updates** before
  unbridged local work or using an older deployment. The old local workflow remains available.
- Automation settings, encrypted tokens, subscriptions and recovery/outbox records are owner-scoped
  Firestore documents, not browser progress or JSON backups. Restoring a backup never enables writes.

## Recovering acknowledged partial manual synchronization

A settlement rejection now includes only fixed mismatch field names: `snapshot`, `title`,
`description`, `visibility`, or (during explicit recovery) `tracks`. Neither the UI nor the
response exposes the differing values. A mismatch is not proof of propagation delay or an external edit.
Automatic synchronization and ordinary settlement keep exact snapshot checks. Explicit manual
acknowledged-prefix recovery can adopt a different currently observed snapshot only after reading
the complete exact ordered prefix and matching metadata, then re-reading metadata to ensure the
snapshot and raw fields stayed unchanged throughout pagination. The server marks this verified
response; the client persists its snapshot through the existing revision CAS before any append.
This read-only recovery is unavailable to background requests. No mismatching tracks, extra items,
changed settings, or unstable reads are accepted. Description-to-target comparison accepts only
the requested text or that same text with ASCII apostrophes represented as `&#x27;`, as confirmed
by a read-only Spotify response. This is a one-pass encoding comparison, not HTML decoding or
stripping: literal entity text, double encoding and other description differences remain distinct.
The original requested description is still sent unchanged. Raw read-to-read metadata checks and
external-change fingerprints are not normalized. An unexpected upstream representation remains
blocked until its cause is established.

For a saved, non-ambiguous acknowledged prefix (for example 100 of 257):

1. After deploying the same image to the web service and worker, reload the current cloud catalogue.
   Keep its playlist link and reviewed choices; do not forget the link or clear synchronization records.
2. Wait for any displayed lease/cooldown deadline. Compare with Spotify explicitly.
3. If incomplete, use **Verify and resume Spotify synchronization**. It requires the unchanged target,
   operation/revision lease, matching metadata, stable observed snapshot, and complete ordered prefix before
   appending 100 and 57 remaining tracks. It does not repeat the first replacement or create a playlist.
4. If verification still fails, stop and record the fixed mismatch names. A genuine metadata/content
   difference or changing snapshot still blocks writes; do not keep restarting Apply.
5. Compare again after completion; it should report exact synchronization. A completely synchronized
   fresh preview already needs no mutation.

Dispatching/uncertain records and hosted uncertainty fences remain blocked. This procedure does not
resolve an ambiguous accepted write or prove exactly-once delivery. If the browser has lost its
acknowledged record, the app cannot infer that acknowledgement solely from 100 matching playlist items.
No migration clears records or changes progress/backup versions.

If final hosted read verification fails, the acknowledged result is retained but the pending manual
target still fences automatic writes. After exact synchronization, explicitly re-enable automation
only if desired, after the displayed cooldown/lease expires; re-enabling verifies the full state.
An uncertain registry is never cleared by this recovery path.

For this code-only redeployment, use a clean Cloud Shell checkout of this branch at the fix commit
reported in the PR. Keep all existing environment, IAM/IAP, secrets and scheduler settings; do not
regenerate keys, configure a new trigger, or rerun one-time setup. Pin both workloads to one digest:

```bash
git fetch origin codex/automatic-playlist-updates
git switch codex/automatic-playlist-updates
git pull --ff-only origin codex/automatic-playlist-updates
git rev-parse HEAD # Verify against the reviewed fix commit before building.
nts_build_id=$(gcloud builds submit . --project=gen-lang-client-0941278185 --region=europe-west1 \
  --tag=europe-west1-docker.pkg.dev/gen-lang-client-0941278185/nts-staging/app:sync-settlement-fix --format='value(id)')
nts_digest=$(gcloud builds describe "$nts_build_id" --project=gen-lang-client-0941278185 --region=europe-west1 --format='value(results.images[0].digest)')
nts_image="europe-west1-docker.pkg.dev/gen-lang-client-0941278185/nts-staging/app@$nts_digest"
gcloud run services update nts-staging --project=gen-lang-client-0941278185 --region=europe-west1 --image="$nts_image" --no-traffic
nts_revision=$(gcloud run services describe nts-staging --project=gen-lang-client-0941278185 --region=europe-west1 --format='value(status.latestCreatedRevisionName)')
gcloud run revisions describe "$nts_revision" --project=gen-lang-client-0941278185 --region=europe-west1
# Stop unless the exact revision is Ready and existing configuration/secrets remain correct.
gcloud run jobs update nts-catalog-scans --project=gen-lang-client-0941278185 --region=europe-west1 --image="$nts_image"
gcloud run services update-traffic nts-staging --project=gen-lang-client-0941278185 --region=europe-west1 --to-revisions="$nts_revision=100"
```

These instructions have not been executed by this implementation.

## Spotify authorization

The hosted account gate and Google IAP remain required. The owner clicks **Authorize background
Spotify** explicitly; the server verifies `/me` and encrypts the refresh token using AES-256-GCM with
an installation-specific Secret Manager key and origin/user/purpose authenticated context. Only
ciphertext is stored. Access tokens remain in memory, are refreshed once per active worker operation,
and are never returned to the browser or saved in progress, logs or exports. Rotation is CAS-protected;
an old refresh cannot undo a disconnect/reconnect.

Sign out and sign in again after deployment to grant `playlist-read-private` alongside the existing
playlist modification scopes. **Authorize background Spotify** again after Spotify expires/revokes
the grant. Missing/revoked authorization stops playlist updates, not saved matching progress.
Disconnect background Spotify removes the server grant for all shows; to revoke Spotify-side app
permissions, also remove the app at https://www.spotify.com/account/apps/.

Current official Spotify documentation: access tokens expire after one hour; refresh tokens issued
to dashboard apps expire after six months and refreshing does not extend their lifetime. Refresh
responses can omit a replacement refresh token; the existing one must then be retained. An expired
refresh token requires a new sign-in, not unbounded retry:
https://developer.spotify.com/documentation/web-api/tutorials/refreshing-tokens
https://developer.spotify.com/blog/2026-06-18-refresh-token-expiration
Playlist reads/writes use current `/playlists/{id}/items` endpoints, not deprecated `/tracks`.

## Browser push and history

Browser push is the chosen external channel, primarily Pixel Chrome. No email integration or paid
notification provider is used. `web-push` implements standard VAPID encryption; browser push services
deliver the notification. The homepage offers opt-in registration, up to ten named devices, removal
of any device, and a persistent last-100-event history. Subscription capabilities are encrypted and
never returned by the history API. Chrome/FCM and Firefox push endpoints are allowlisted; arbitrary
endpoints/private addresses are not accepted. Safari is not currently supported.

The registration control checks this browser's permission and local subscription against the saved
server device ID. It shows **Notifications enabled on this device** only when all three match,
including after reload. A saved device entry on its own is not evidence that the current browser
is registered. Removing the current device makes the enable action available again; blocked browser
permission directs the user to the site's browser settings.

**Send test notification** sends only to the current registered device through the real encrypted
Web Push path. It requires the permitted hosted session and same-origin JSON request. A persistent
installation-wide 30-second CAS cooldown bounds concurrent and repeated tests, including failed sends.
Expired subscriptions are removed; other network errors are sanitized and never automatically retried.
The test does not create a catalogue event, consume event-history capacity, or claim real catalogue
alerts. It changes no scan or playlist settings. The UI reports push-service acceptance, not proof of
phone delivery. Tapping the test opens the protected homepage. The notification worker activates its
updated script before a test dispatch, with a bounded wait and no application-page caching.

To check delivery after deploying the updated image, reload the homepage in Pixel Chrome, confirm the
registered status, click **Send test notification**, then check Android's notification shade and tap
that notification. Repeat on the PC if desired after at least 30 seconds. Actual phone/browser delivery
still needs this live acceptance check; mocked tests cannot establish it.

Stable per-episode event IDs distinguish discovery from matches-ready. Up to 10,000 event IDs are
remembered even after rolling off the visible history (capacity exhaustion fails closed rather than
reusing IDs). Firestore claims each device/event **before** a bounded send. At most ten sends per daily
job, one attempt per event/device; ambiguous network failure is not resent. This prevents duplicate
alerts across retries, but a crash after claiming can lose a push. The history is authoritative, not
a claim of guaranteed external delivery. The notification-only service worker also deduplicates
locally, caches only 200 seen IDs, and never intercepts HTTP requests or caches application pages.
Expired subscriptions are removed. Lock-screen text is generic; tapping opens the protected catalogue.

Delivery can be delayed by Chrome/Android battery policy, offline devices, permission or IAP/session
expiry. Test the installed worker and click-through on Pixel; no browser permission is requested on
page load. Existing browser service workers/extensions and IAP must permit same-origin registration.
If Firestore fails before an event is recorded, progress remains saved but that alert is not guaranteed;
do not use notifications as a substitute for inspecting saved catalogue status.

## Cloud Shell deployment (manual; not executed by this implementation)

Keep a fresh catalogue JSON backup. Deploy web and worker from the **same pinned image** before enabling
automatic updates. Do not route traffic to an old uncoordinated revision while updates are enabled.
No DNS, IAP, domain or scheduler timing changes are needed.

```bash
git -C ~/nts-to-spotify-staging fetch origin codex/automatic-playlist-updates
git -C ~/nts-to-spotify-staging worktree add --detach ~/nts-auto-playlists FETCH_HEAD
cd ~/nts-auto-playlists
npm ci
set +x
# First setup only: stop if these names already exist; do not rotate encryption keys blindly.
for nts_secret in nts-playlist-auth-key nts-push-public-key nts-push-private-key; do
  if gcloud secrets describe "$nts_secret" --project=gen-lang-client-0941278185 >/dev/null 2>&1; then
    echo "Secret already exists: use its existing approved version; stop first-time setup."; exit 1
  fi
done
for nts_secret in nts-playlist-auth-key nts-push-public-key nts-push-private-key; do
  gcloud secrets create "$nts_secret" --project=gen-lang-client-0941278185 --replication-policy=automatic
  gcloud secrets add-iam-policy-binding "$nts_secret" --project=gen-lang-client-0941278185 \
    --member=serviceAccount:nts-staging-runtime@gen-lang-client-0941278185.iam.gserviceaccount.com \
    --role=roles/secretmanager.secretAccessor
done
node --input-type=module -e 'import {randomBytes} from "node:crypto"; process.stdout.write(randomBytes(32).toString("hex"))' \
  | gcloud secrets versions add nts-playlist-auth-key --project=gen-lang-client-0941278185 --data-file=-
nts_push_keys=$(mktemp)
chmod 600 "$nts_push_keys"
node --input-type=module -e 'import webpush from "web-push"; import {writeFileSync} from "node:fs"; writeFileSync(process.argv[1], JSON.stringify(webpush.generateVAPIDKeys()), {mode:0o600})' "$nts_push_keys"
node --input-type=module -e 'import {readFileSync} from "node:fs"; process.stdout.write(JSON.parse(readFileSync(process.argv[1])).publicKey)' "$nts_push_keys" \
  | gcloud secrets versions add nts-push-public-key --project=gen-lang-client-0941278185 --data-file=-
node --input-type=module -e 'import {readFileSync} from "node:fs"; process.stdout.write(JSON.parse(readFileSync(process.argv[1])).privateKey)' "$nts_push_keys" \
  | gcloud secrets versions add nts-push-private-key --project=gen-lang-client-0941278185 --data-file=-
rm -f -- "$nts_push_keys"
```

Do not paste token/key values into commands, logs or Git. The three new secret versions should be `1`
on first setup. Retain the existing four secret mappings, Firestore IAM, IAP and disabled default URL.
If key generation/upload fails, remove only the named temporary key file and stop; do not deploy.

```bash
nts_build_id=$(gcloud builds submit . --project=gen-lang-client-0941278185 --region=europe-west1 \
  --tag=europe-west1-docker.pkg.dev/gen-lang-client-0941278185/nts-staging/app:auto-playlists --format='value(id)')
nts_digest=$(gcloud builds describe "$nts_build_id" --project=gen-lang-client-0941278185 --region=europe-west1 --format='value(results.images[0].digest)')
nts_image="europe-west1-docker.pkg.dev/gen-lang-client-0941278185/nts-staging/app@$nts_digest"
gcloud run services update nts-staging --project=gen-lang-client-0941278185 --region=europe-west1 \
  --image="$nts_image" --update-env-vars=NTS_CATALOG_SCHEDULES=1 \
  --update-secrets=NTS_PLAYLIST_AUTH_KEY=nts-playlist-auth-key:1,NTS_PUSH_PUBLIC_KEY=nts-push-public-key:1,NTS_PUSH_PRIVATE_KEY=nts-push-private-key:1 --no-traffic
nts_revision=$(gcloud run services describe nts-staging --project=gen-lang-client-0941278185 --region=europe-west1 --format='value(status.latestCreatedRevisionName)')
# Verify this exact revision is Ready and inspect its secret mappings before routing traffic.
gcloud run revisions describe "$nts_revision" --project=gen-lang-client-0941278185 --region=europe-west1
gcloud run services update-traffic nts-staging --project=gen-lang-client-0941278185 --region=europe-west1 --to-revisions="$nts_revision=100"
bash scripts/configure-catalog-job.sh "$nts_image"
gcloud run jobs update nts-catalog-scans --project=gen-lang-client-0941278185 --region=europe-west1 \
  --update-secrets=NTS_PLAYLIST_AUTH_KEY=nts-playlist-auth-key:1,NTS_PUSH_PUBLIC_KEY=nts-push-public-key:1,NTS_PUSH_PRIVATE_KEY=nts-push-private-key:1
gcloud run jobs describe nts-catalog-scans --project=gen-lang-client-0941278185 --region=europe-west1
```

Verify the job image, one task, no retries, 20-minute task timeout, private owner, fixed origin and
all seven secret mappings. Key rotation requires explicit reconnect/device re-registration; do not
replace keys just to deploy a new image. Firestore must remain inaccessible to unauthenticated clients.

## Small Dimension Door acceptance test

1. Keep Channeling's schedules/playlist automation off and its copied playlist unlinked. Enable no
   other show. Sign in to the hosted site again for the updated scopes; connect cloud progress.
2. Back up Dimension Door, confirm its linked app-created playlist ID, review selections and ordering.
   Manually preview; if not synchronized, consciously apply the existing manual update first.
3. Authorize background Spotify. Enable automatic playlist updates **only** for Dimension Door.
   Enabling performs reads, not writes. Keep its fortnightly scan discovery and wait out any cooldown.
4. Register Pixel Chrome and optionally a desktop through the notification control. A fresh IAP
   login may be required. This is actual external push opt-in, separate from viewing the history.
5. Execute one job explicitly:

   ```bash
   gcloud run jobs execute nts-catalog-scans --project=gen-lang-client-0941278185 --region=europe-west1 --wait
   ```

6. With no new episode/selected target change, expect zero playlist calls/writes and the same ID.
   A genuinely new episode is matched once; confident tracks enter that playlist in configured order,
   uncertain tracks stay unchecked. Refresh the cloud copy and automatic status/history. Confirm the
   Pixel alert and protected click-through when a discovery/matching event actually occurs.
7. Review one real uncertain candidate deliberately, save to cloud, preview and apply manually.
   Confirm that the same ID is used and the track sits within its episode. Do not fabricate progress
   or use your live playlist as an automated failure fixture. External-edit/429/ambiguity cases were
   tested only with mocks; defer their live destructive variants.
8. Only after the single-show test passes, create the daily trigger (it has not yet been created):

   ```bash
   bash scripts/start-catalog-scheduler.sh
   gcloud scheduler jobs describe nts-catalog-scans-daily --project=gen-lang-client-0941278185 --location=europe-west1
   ```

No live test or deployment is claimed here. No new episode means there is no forced write test.

## Cost, rollback and limits

No paid AI or notification delivery provider is introduced. Existing Cloud Run, Artifact Registry,
Cloud Build, Scheduler, Firestore and Secret Manager remain metered. New cost is bounded owner-scoped
Firestore coordination/history, three secrets, and outbound Web Push HTTPS traffic; exact charges
depend on the project's existing free allowance and region. Monitor billing before expanding shows
or devices. One unchanged target avoids Spotify reads; source fencing reads only catalogue manifests.
Neither cache nor session metrics represent remaining Spotify quota.

Pause automatic playlist updates and scans before rollback; disconnect background authorization if
needed. Do not downgrade to an image lacking coordination while the job can still write. Preserve
uncertain recovery records and inspect Spotify manually; deleting a record is not safe recovery.
Backups preserve catalogue choices/linkage, not server authorization or synchronization diagnostics.
