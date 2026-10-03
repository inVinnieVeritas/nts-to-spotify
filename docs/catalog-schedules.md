# Opt-in scheduled catalogue scans

This feature discovers episodes and saves matching results to the existing owner's Firestore
catalogue while the browser and PC are off. Matching uses application credentials and never creates
or adopts a Spotify playlist. Reviewed selections, playlist settings, and links remain in cloud progress.
Every catalogue starts with scheduling off. A separate playlist-update opt-in can write an existing
app-created linked playlist using separately authorized, encrypted owner credentials; it remains off
by default. See [automatic playlist updates and browser push](automatic-playlist-updates.md) before
enabling that feature. The scan frequency, daily trigger and matching batch limits are unchanged.

## How it runs

- One private Cloud Run Job, invoked daily at 09:00 Europe/Brussels by Cloud Scheduler using a
  dedicated service account.
- One due catalogue per invocation, at most five episodes, an 18-minute worker deadline and a
  20-minute Cloud Run task deadline. Task and scheduler retries are disabled.
- Daily, weekly, fortnightly or 30-day discovery intervals. An unfinished catalogue continues
  on later daily checks independently of that discovery interval.
- The owner-scoped Firestore lease excludes concurrent scheduled workers and hosted manual
  matching. A crashed lease expires after five minutes. Existing parallel manual workers remain
  supported. The longest observed Spotify cooldown is stored across instances and revisions.
- Completed episodes save individually. A changed episode or stale Firestore version stops the
  job; edits to other episodes and playlist settings are preserved. Disabling a schedule stops new
  episodes and prevents its status from overwriting the user's new schedule settings.
- Failed episodes remain retryable on later jobs. A service error ends the current batch instead
  of spinning through requests. Current status shows saved episodes and actual search calls in
  the last run; this does not report Spotify's remaining allowance.

Cloud Run execution, Firestore reads/writes, and Scheduler are metered services. This is not a
promise of zero cost: monitor Billing and the job's execution time. A cooldown/idle job exits
quickly. Use daily checks as configured; do not increase tasks, parallelism, or retries.
During initial testing enable **one catalogue only**. Each daily invocation handles one due
catalogue, so multiple due catalogues may wait for subsequent days. The daily trigger reduces idle
starts; it does not limit the duration or search usage of an active matching batch.

## Build and deploy in Cloud Shell

Start from `codex/scheduled-catalog-scans`. Save a progress JSON backup before deployment.
Do not deploy an older image that lacks the hosted scan coordinator while this job is active.

```bash
git -C ~/nts-to-spotify-staging fetch origin codex/scheduled-catalog-scans
git -C ~/nts-to-spotify-staging worktree add --detach ~/nts-scheduled-scans FETCH_HEAD
cd ~/nts-scheduled-scans
git rev-parse --short HEAD
gcloud builds submit . \
  --project=gen-lang-client-0941278185 --region=europe-west1 \
  --tag=europe-west1-docker.pkg.dev/gen-lang-client-0941278185/nts-staging/app:scheduled-scans
```

Describe the successful build to obtain `results.images[0].digest`, then set `nts_image` to the
full repository URL with that digest (not the mutable tag).

```bash
# Replace BUILD_ID with the ID printed by the successful build.
gcloud builds describe BUILD_ID \
  --project=gen-lang-client-0941278185 --region=europe-west1 \
  --format='value(results.images[0].digest)'
# Assign the full URL using the digest printed above.
# nts_image=europe-west1-docker.pkg.dev/gen-lang-client-0941278185/nts-staging/app@sha256:...
gcloud run services update nts-staging \
  --project=gen-lang-client-0941278185 --region=europe-west1 \
  --image="$nts_image" --update-env-vars=NTS_CATALOG_SCHEDULES=1 --no-traffic
```

Verify the returned revision is ready and the old revision still has 100% traffic. Then route
100% to the **specific new revision name**. Retain `NTS_FIRESTORE_PROJECT`, the four existing
secret mappings, IAP, and the disabled default URL.

```bash
bash scripts/configure-catalog-job.sh "$nts_image"
gcloud run jobs describe nts-catalog-scans \
  --project=gen-lang-client-0941278185 --region=europe-west1
# With no schedules enabled this must exit idle, without NTS/Spotify search calls.
gcloud run jobs execute nts-catalog-scans \
  --project=gen-lang-client-0941278185 --region=europe-west1 --wait
```

On the hosted catalogue page, confirm cloud progress is connected, choose a frequency, then
click **Enable automatic scans**. It explicitly authorizes background matching for that catalogue,
including its unfinished backlog. Wait out any existing Spotify cooldown. Execute the job once
and check its logs/status. Reload the cloud copy in another browser; completed counts and reviews
should agree. The existing local/cloud conflict chooser still protects older local progress.

After the single-run test passes, start the daily trigger:

```bash
bash scripts/start-catalog-scheduler.sh
gcloud scheduler jobs describe nts-catalog-scans-daily \
  --project=gen-lang-client-0941278185 --location=europe-west1
```

The creation script is for first setup; it reports an error if that Scheduler job already exists.
Use `gcloud scheduler jobs update http` for future trigger changes. Google API targets use an
OAuth service-account token, not a browser session or IAP bypass:
https://docs.cloud.google.com/run/docs/execute/jobs-on-schedule

## Pause, manual work, and rollback

For one show, **Pause automatic scans** on its hosted page. If a manual scan finds an active
background episode, it pauses without consuming Spotify searches. Wait for that episode's
lease to be released before trying again. Cloud conflicts continue to require an explicit choice.
An already open browser is not live-refreshed by the worker; load the new cloud copy before editing.

Schedules are managed on the hosted site. Local Vite retains the working cloud bridge and can
load background results, but local matching does not acquire the hosted Firestore lease. **Pause
automatic scans before starting a local Vite scan** to avoid simultaneous use of the same Spotify
application allowance. Do not set `NTS_CATALOG_SCHEDULES=1` in a local environment.

To stop the trigger globally:

```bash
gcloud scheduler jobs pause nts-catalog-scans-daily \
  --project=gen-lang-client-0941278185 --location=europe-west1
```

Pausing the trigger does not cancel an execution already running. Pause each enabled show and
check Cloud Run Job executions; cancel a running execution if necessary. Then an older web
revision can be restored. Keep the trigger paused with an older revision, since it does not enforce
the shared scan lease. Cloud progress, reviews, and schedule settings remain in Firestore.
Re-enabling the trigger later uses `gcloud scheduler jobs resume` after both images are current.

## Development verification

`npm run check`, `npm test`, `npm run build` and `npm run build:jobs`.
Tests use an atomic in-memory Firestore REST emulator and mocked NTS/Spotify responses.
The job bundle uses an environment shim for SvelteKit's private environment imports; it is
independent of the HTTP launcher and of development-only runtime packages.
