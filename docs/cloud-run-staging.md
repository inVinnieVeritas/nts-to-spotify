# Private Cloud Run staging (not deployed)

Prepared against v0.1.1. This is a **single-user, single-active-browser staging
profile**, not a public multi-user service. The local Windows edition, its
launchers, versions, matching, backups and playlist protocol are unchanged.
Do not run the local launcher inside Cloud Run.

## Architecture and access

- The existing adapter-node build runs as an unprivileged container user. The
  separate entrypoint listens on `0.0.0.0:$PORT` as Cloud Run requires; TLS ends
  at Google. It accepts only the fixed origin
  `https://nts2spotify.vincentvanderveken.com`. It never loads an environment
  file or trusts forwarded host/protocol headers.
- Use **IAP directly on Cloud Run**, grant access only to your Google account,
  and keep Cloud Run IAM authentication enabled. Do not grant `allUsers` or
  `allAuthenticatedUsers`. IAP configuration is a deployment prerequisite,
  not something application source can verify. Never rely on a client-supplied
  IAP identity header; this app does not trust one.
- A second application boundary verifies the OAuth token against Spotify
  `/v1/me` before issuing cookies. The ID must equal the configured Spotify
  account ID (not its display name or email). An HttpOnly, Secure, host-only,
  SameSite=Lax signed authorization cookie binds both token-cookie hashes to
  that ID and origin. Substituted tokens, expired or unsigned proofs fail closed.
  Refresh rebinds a rotated token only after the existing proof has been checked.
  Proofs last eight hours and renew during token refresh; reauthenticate when
  expired. Changing the allowed ID or signing secret invalidates existing proofs.
- Anonymous users see only a static sign-in page. Catalogue acquisition, NTS
  pages, Spotify Search, playlist APIs and server-rendered application data
  require the proof. Hosted writes additionally require the exact Origin header.
  Logout clears the proof as well as the Spotify cookies. Local mode is unchanged.
- OAuth state/return-path checks, playlist ownership verification, timeouts,
  ambiguous-creation handling and read-only preview remain in place.
  Responses are private/no-store and use no-referrer. Do not add CDN caching.

## Runtime settings (no real values in source or build)

| Setting                   | Source / purpose                                                                 |
| ------------------------- | -------------------------------------------------------------------------------- |
| `PORT`                    | Injected by Cloud Run (normally 8080); required valid TCP port                   |
| `NTS_HOSTED_STAGING=1`    | Fixed in image; enables fail-closed hosted boundary                              |
| `ORIGIN`                  | Fixed HTTPS origin above, also fixed in image                                    |
| `HOST=0.0.0.0`            | Container listener, not the local Windows default                                |
| `SPOTIFY_CLIENT_ID`       | Secret Manager runtime reference                                                 |
| `SPOTIFY_CLIENT_SECRET`   | Secret Manager runtime reference                                                 |
| `STAGING_SPOTIFY_USER_ID` | Secret Manager runtime reference, exact owner ID                                 |
| `STAGING_SESSION_SECRET`  | Secret Manager: cryptographically random 32 bytes as 64 lowercase hex characters |

Pin numbered secret versions, not `latest`. Grant the dedicated runtime service
account Secret Accessor on **only these secrets**, not across the project.
No service-account key file is needed. Enter secret values through the Cloud
Console; do not paste values into shell commands, YAML, image build arguments,
logs or source. Never copy a local installation's environment file into the image.

The entrypoint rejects alternate socket/forwarded-header controls, unsafe Node
options and TLS disabling; optional `NODE_OPTIONS=--use-system-ca` is permitted.
Node reads its runtime options before JavaScript, so only trusted administrators
may configure the service environment/command. Never supply unreviewed runtime
options. Request bodies are bounded to 2 MiB, matching the playlist endpoint's
limit; adapter-node drains SIGTERM for at most eight seconds. Cloud Run shutdown
can still interrupt requests; it does not prove an upstream mutation was cancelled.

## State, storage and staging limits

**Storage choice: no volume, no database and no durable server cache for this test.**

| State                                        | Location / restart behavior                                                              |
| -------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Catalogue results, choices, playlist linkage | Browser IndexedDB at the HTTPS origin; unaffected by server restart                      |
| Scan history, sync revision/lease/quarantine | Same browser's local IndexedDB; existing recovery rules apply                            |
| Catalogue backups                            | User-downloaded JSON; use existing restore controls                                      |
| Global Search cooldown                       | Browser-origin local state, plus a process-local server queue; not a shared cloud record |
| Search results                               | Existing bounded process-memory cache/coalescing; lost on cold start                     |
| Search metrics, app token                    | Process memory; reset on restart, not quota remaining                                    |
| Spotify playlist                             | Spotify itself; existing preview/reconciliation reads it again                           |

Hosted mode disables the file-backed `.data/spotify-match-cache` adapter. Losing
this optional cache increases requests but cannot change selected matches or
playlist order. No `.data` is copied, mounted or claimed durable. Do not mount
Cloud Storage FUSE beneath the local file-lock implementation: object storage is
not a drop-in distributed lock. Local mode still uses its existing file cache.
Cache hits do not increase or reveal Spotify quota.

Use one browser profile on the staging origin, no parallel devices, and no
simultaneous local/staging scans using the same Spotify application credentials.
Browser storage is origin-specific: `http://127.0.0.1:5173` data does not
automatically appear at the staging HTTPS origin. Download a local backup, then
explicitly restore it on staging if desired. Backups exclude synchronization
diagnostics; **never transfer during an incomplete/ambiguous playlist operation**.
A restored playlist link still points to the real playlist: preview is read-only,
Apply is not. Prefer a separate disposable test playlist for first acceptance.

Set service and revision maximum instances to one, minimum zero, concurrency four.
This limits cost and normal routing, **not distributed correctness**. Cloud Run
can temporarily exceed max instances and overlap revisions during maintenance.
Queue pacing, server cooldowns and metrics are per process. Browser cooldown
gating survives same-origin reload/restart, but a cold server cannot enforce an
old cooldown against another browser or a manually forged owner request. Do not
clear storage to bypass cooldown; wait for the full deadline. After storage loss,
recover the saved deadline/backup or wait and investigate before another scan.

Playlist operation CAS/leases coordinate tabs in one browser, not all devices.
Multiple instances do not own playlist progress: each request still validates
ownership, snapshots and ordered prefix. There is no distributed lock spanning
external Spotify mutations and no exactly-once guarantee. Do not redeploy while
scanning or synchronizing; cancel, let active work settle, back up, then deploy.
After interruption, resume through read-only reconciliation and quarantine;
never Forget/Create merely to recover an incomplete update.

**Before multi-device/public use**, add a durable shared cooldown/dispatch
coordinator and server-side playlist-operation coordination (for example
transactional Firestore). That is intentionally outside this small staging
profile. If these single-browser limitations are unacceptable, do not deploy this
profile. Min instances 1 is neither durability nor a locking solution.

## Domain choice and costs

Checked against official documentation on 21 September 2026:

- Use **Cloud Run direct domain mapping** for this private test in
  `europe-west1`, which is on Google's supported-region list. Map only
  `nts2spotify.vincentvanderveken.com` to `/`. Google issues and renews the
  HTTPS certificate; provisioning usually takes about 15 minutes but can take
  up to 24 hours. Domain ownership must be verified before mapping.
  [Domain mapping](https://docs.cloud.google.com/run/docs/mapping-custom-domains)
- Direct mapping has **limited availability and Preview status**. Google
  documents latency issues, does not recommend it for production, and does not
  let us disable TLS 1.0/1.1 or use our own certificate. These are accepted
  staging limitations, not production guarantees.
- Firebase Hosting is not compatible unchanged: its 60-second timeout and
  cookie stripping except `__session` conflict with this application's existing
  cookies and long requests.
  [Timeout](https://firebase.google.com/docs/hosting/cloud-run),
  [cookies](https://firebase.google.com/docs/hosting/manage-cache)
- Enable **IAP directly on the Cloud Run service** with `--iap` and
  `--no-allow-unauthenticated`. Google documents direct IAP protection for
  `run.app` and load-balancer ingress, but does not explicitly guarantee the
  combined **IAP + direct domain mapping** path in those guides. Treat IAP
  enforcement, redirects and OAuth cookies on the mapped hostname as a required
  live acceptance test. If it fails, keep the service inaccessible; do not
  remove IAP or allow anonymous access. Personal Google accounts outside an
  organization may need Console OAuth-client setup.
  [IAP setup](https://docs.cloud.google.com/run/docs/securing/identity-aware-proxy-cloud-run)
- Direct mapped internet traffic requires `--ingress all`; the previous
  `internal-and-cloud-load-balancing` setting would block it. This also makes
  `run.app` reachable at the network layer until its default URL is disabled.
  Verify that IAP and IAM reject unauthorized requests on **both** hostnames
  before disabling that URL. The app also rejects requests whose inbound Host
  is not the fixed mapped hostname; forwarded-host headers cannot override it.
  [Ingress settings](https://docs.cloud.google.com/run/docs/securing/ingress)

Budget estimate in USD/month, excluding tax, at current list rates (not a
quote; billing-account free allowances are shared):

- No dedicated load balancer, forwarding rule or reserved IP is proposed, so
  the former approximately **$18.25/month** forwarding-rule estimate does not
  apply. Google's domain-mapping guide lists no separate mapping price; verify
  the project estimate and billing before deployment. Ordinary IAP protection
  for Google Cloud resources has no separate IAP charge; optional premium
  features are outside this setup.
  [IAP pricing](https://cloud.google.com/iap/pricing),
  [domain mapping](https://docs.cloud.google.com/run/docs/mapping-custom-domains)
- Request-based 1 vCPU / 1 GiB, min zero: ten active hours cost about
  **$0.95** before free tier ($0.000024/vCPU-second + $0.0000025/GiB-second).
  Idle scale-to-zero compute is zero. Actual cost depends on startup/shutdown
  time, requests, usage region and any shared free-tier allowance.
  [Cloud Run pricing](https://cloud.google.com/run/pricing)
- Artifact Registry image storage, Cloud Build minutes/source staging, Logging,
  Secret Manager versions/access, internet egress,
  DNS hosting (if used) and domain registration are separate. Four active secret
  versions and low access volume may fit free allowances; otherwise secret
  versions start at $0.06/month each. Do not provision Filestore or Cloud SQL.
  [Secrets](https://cloud.google.com/secret-manager/pricing),
  [images](https://cloud.google.com/artifact-registry/pricing)
- Create budget alerts before deployment; alerts and maximum instances are not
  hard spend caps. Configure registry cleanup for old untagged images.

## Manual deployment runbook — do not execute until approved

Use a **new dedicated project** if possible. Confirm the project, Google account,
billing account, Spotify user ID, and budget first. Never change the main
`vincentvanderveken.com` site, its DNS records, or the Duty Calendar service.
Commands below use placeholders and Bash/Cloud Shell continuation syntax.

1. In the chosen project enable Cloud Run, Artifact Registry, Cloud Build,
   Secret Manager and IAP APIs. Create an Artifact Registry
   Docker repository `nts-staging` in `europe-west1` and a dedicated service
   account `nts-staging-runtime`. Grant deploy/build permissions only to the
   appropriate operators; the runtime identity needs only the four secret
   accesses, not Editor or service-account-key permissions.
2. In Spotify Developer Dashboard use a development-mode application allowed
   for your own account. Add the exact redirect
   **https://nts2spotify.vincentvanderveken.com/login** (no trailing slash).
   Preserve any existing local redirect. Add only your Spotify account to the
   app's user allowlist as required by Spotify. Set the four runtime secrets
   above through Secret Manager. Do not alter the local credentials.
3. Review the clean build context. `.gcloudignore` and `.dockerignore` use a
   positive allowlist. Source/tests should contain no credentials; generated
   files, local environment files, Git, dependencies and data are excluded.
   Pin the reviewed Node 22 base image digest before deployment for reproducible
   releases (the development Dockerfile uses the supported moving security tag).
   Build, scan, and obtain the immutable image digest:

   ```sh
   gcloud builds submit --project PROJECT_ID --region europe-west1 \
     --tag europe-west1-docker.pkg.dev/PROJECT_ID/nts-staging/app:REVIEWED_COMMIT .
   ```

   No secrets at build time. Do not run this from an old installation.

4. Before first traffic, configure Cloud Logging exclusions for callback request
   URLs on this service (`/login?` can contain a short-lived authorization code).
   Do not enable HTTP header/body logging or Cloud Trace capture.
   Application logs must remain fixed/sanitized. Restrict log viewer roles and
   retention. In Logs Router, exclude Cloud Run request log entries for this
   service with `httpRequest.requestUrl =~ "/login[?]"`; configure equivalent
   exclusions on any additional sinks, not just the default sink. This prevents
   retention, not the platform processing a callback. Never paste callback URLs
   into tickets or shell history.
5. Deploy with pinned secret **version numbers**, not secret values. For a first
   personal/no-organization IAP setup use the Cloud Run Console, Security >
   Require authentication > IAP; complete custom OAuth setup there if requested.
   Equivalent deployment settings after that setup:

   ```sh
   gcloud run deploy nts-staging --project PROJECT_ID --region europe-west1 \
     --image europe-west1-docker.pkg.dev/PROJECT_ID/nts-staging/app@sha256:IMAGE_DIGEST \
     --service-account nts-staging-runtime@PROJECT_ID.iam.gserviceaccount.com \
     --port 8080 --cpu 1 --memory 1Gi --cpu-throttling \
      --min 0 --max 1 --min-instances 0 --max-instances 1 --concurrency 4 --timeout 360 \
      --ingress all --no-allow-unauthenticated --iap \
     --set-secrets SPOTIFY_CLIENT_ID=nts-client-id:1,SPOTIFY_CLIENT_SECRET=nts-client-secret:1,STAGING_SPOTIFY_USER_ID=nts-owner-id:1,STAGING_SESSION_SECRET=nts-session-key:1
   ```

   Do not override the image entrypoint, ORIGIN, or disable CSRF/TLS. No volume
   mounts. Cloud Run termination remains bounded; a 360-second gateway timeout
   exceeds the existing 180/300-second route scopes.

6. Grant the project's IAP service agent
   `service-PROJECT_NUMBER@gcp-sa-iap.iam.gserviceaccount.com` Cloud Run Invoker
   **on this service only**. In IAP grant only your Google email the
   IAP-secured Web App User role (`roles/iap.httpsResourceAccessor`) on this
   service. Verify IAP enabled and no anonymous IAM access. Do not expose a
   public service as a workaround for OAuth problems.
7. In Cloud Run domain mappings, verify ownership of the base domain
   `vincentvanderveken.com` for this project if needed (Search Console).
   Confirm the exact subdomain is not already mapped; never use
   `--force-override`. Create only the staging mapping:

   ```sh
   gcloud domains list-user-verified --project PROJECT_ID
   gcloud beta run domain-mappings create --project PROJECT_ID \
     --region europe-west1 --service nts-staging \
     --domain nts2spotify.vincentvanderveken.com
   gcloud beta run domain-mappings describe --project PROJECT_ID \
     --region europe-west1 --domain nts2spotify.vincentvanderveken.com
   ```

   If the mapping is unavailable in the project/region, stop and review the
   outcome. Do not introduce another ingress route as a workaround. The
   `describe` output provides the exact `resourceRecords` needed for DNS;
   do not assume an A record or invent an IP.

8. At the current DNS provider, check whether the exact `nts2spotify` label
   already has records. If it does, stop for review. Add **only** the
   mapping's listed `resourceRecords` for that label (possibly CNAME, A or
   AAAA). Do not change nameservers, apex, www, MX or Duty Calendar records.
   If CAA blocks certificate issuance, request a separate DNS review: Google
   documents `pki.goog` and `letsencrypt.org` as required issuers. Do not
   remove existing CAA protections without review. Wait for certificate
   provisioning and HTTPS; it can take up to 24 hours.
9. **Live compatibility gate:** verify that IAP intercepts the mapped HTTPS
   hostname **before** the application sign-in page. Incognito and a second
   Google account must be denied; your allowed Google account must pass. Also
   verify direct `run.app` requests require IAP/IAM. Confirm IAP remains
   enabled in the Cloud Run service's Security settings. If mapped-domain IAP
   fails or bypasses protection,
   stop testing, do not sign in to Spotify or scan, and keep the service
   inaccessible while investigating. This combination is not proven by the
   separate Google guides. Confirm that an allowed request to `run.app` is
   rejected by the app's Host check, including `/login` and protected APIs.
   Once the domain mapping is active and these checks pass, disable the default
   `run.app` URL on this service with
   `gcloud run services update nts-staging --project PROJECT_ID --region europe-west1 --no-default-url`.
   Google requires mapping the domain **before** disabling the default URL.
   Verify the mapped hostname still works and the `run.app` URL is unavailable;
   do not disable IAP or change ingress to work around a failure.
10. After that gate, sign in to Spotify as the configured account. A different
    Spotify account must be refused before catalogue data/requests are available.
    Confirm the exact HTTPS `/login` callback, OAuth state/return path and
    Secure/HttpOnly/SameSite cookies across the Google IAP redirect.
11. Check the homepage without scanning: no NTS/Search request. Restore only a
    completed backup explicitly; verify choices, order and linked ID. Perform
    read-only playlist preview first, then (with separate authorization) test a
    disposable playlist. Test a cold restart with mocked failure or a safe idle
    session; preserve browser storage and observe pending recovery/cooldown.
    Do not clear leases or ignore ambiguous outcomes.

## Local validation and remaining acceptance gates

`npm ci`, `npm test`, `npm run check`, `npm run lint`, `npm run build`,
`git diff --check`, `npm audit --omit=dev`. Hosted tests use dummy configuration
and mocked HTTP, covering account denial, cookie binding/tampering/expiry,
cross-origin writes, login callback origin, local bypass, cache disabling and
startup rejection. No real environment/data files are required.

On a machine with Docker, also build the image with a clean context, inspect
image layers for excluded files, and run it with dummy runtime values on a
**loopback-published disposable port**. Check the static private sign-in page and
401 on all APIs; do not follow OAuth. Stop only that container. Never publish a
dummy container port on the LAN. A Node entrypoint smoke test is not a Docker,
IAP, managed certificate or Google IAM acceptance test.

Before deployment choose a project and account identities, check mapping
availability, current quotas/prices and IAP personal-account setup, finish
the real container build test, and accept the Preview and single-browser/state
limitations above. No cloud resource or DNS change is performed by this code.
