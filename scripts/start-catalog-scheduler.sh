#!/usr/bin/env bash
set -euo pipefail

# Run only after the web revision and a manually executed job have been verified.
nts_scheduler_account=nts-catalog-scheduler@gen-lang-client-0941278185.iam.gserviceaccount.com
gcloud services enable cloudscheduler.googleapis.com --project=gen-lang-client-0941278185
if ! gcloud iam service-accounts describe "$nts_scheduler_account" --project=gen-lang-client-0941278185 >/dev/null 2>&1; then
  gcloud iam service-accounts create nts-catalog-scheduler \
    --project=gen-lang-client-0941278185 --display-name='NTS catalogue scheduler'
fi
gcloud run jobs add-iam-policy-binding nts-catalog-scans \
  --project=gen-lang-client-0941278185 --region=europe-west1 \
  --member="serviceAccount:$nts_scheduler_account" --role=roles/run.invoker --format=none
gcloud scheduler jobs create http nts-catalog-scans-hourly \
  --project=gen-lang-client-0941278185 --location=europe-west1 \
  --schedule='0 * * * *' --time-zone=Etc/UTC \
  --uri='https://run.googleapis.com/v2/projects/gen-lang-client-0941278185/locations/europe-west1/jobs/nts-catalog-scans:run' \
  --http-method=POST --headers=Content-Type=application/json --message-body='{}' \
  --oauth-service-account-email="$nts_scheduler_account" \
  --max-retry-attempts=0
