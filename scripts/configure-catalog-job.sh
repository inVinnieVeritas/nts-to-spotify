#!/usr/bin/env bash
set -euo pipefail

# This configures a private job only. It does not execute scans or modify web traffic.
nts_job_image=${1:?Pass the new image URL pinned with @sha256:...}
if [[ ! "$nts_job_image" =~ ^europe-west1-docker\.pkg\.dev/gen-lang-client-0941278185/nts-staging/app@sha256:[a-f0-9]{64}$ ]]; then
  echo 'Use a digest from the nts-staging app repository.' >&2
  exit 1
fi
gcloud run jobs deploy nts-catalog-scans \
  --project=gen-lang-client-0941278185 \
  --region=europe-west1 \
  --image="$nts_job_image" \
  --service-account=nts-staging-runtime@gen-lang-client-0941278185.iam.gserviceaccount.com \
  --command=node \
  --args=build-jobs/catalog-schedules.mjs \
  --tasks=1 --parallelism=1 --max-retries=0 --task-timeout=20m \
  --cpu=1 --memory=1Gi \
  --set-env-vars=NTS_HOSTED_STAGING=1,ORIGIN=https://nts2spotify.vincentvanderveken.com,NTS_FIRESTORE_PROJECT=gen-lang-client-0941278185,NTS_CATALOG_SCHEDULES=1 \
  --set-secrets=SPOTIFY_CLIENT_ID=nts-client-id:1,SPOTIFY_CLIENT_SECRET=nts-client-secret:1,STAGING_SPOTIFY_USER_ID=nts-owner-id:1,STAGING_SESSION_SECRET=nts-session-key:1
