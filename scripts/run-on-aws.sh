#!/usr/bin/env bash
# Start a pipeline run on AWS from the command line. Nextflow itself runs inside a Batch (Fargate)
# job, so nothing runs on this machine and it can be closed once the job is submitted.
#
# Usage: scripts/run-on-aws.sh [-r REVISION] [-p PROFILE] [-n RUN_NAME] [-o OUTPUT_PREFIX] -- <pipeline params and flags>
#   -r  git branch, tag or commit of the pipeline to run (default: main)
#   -p  Nextflow profile(s) (default: awsbatch; add chr20 for the chr20-sized resources)
#   -n  run name, used for the Batch job and the results folder (default: run-<timestamp>)
#   -o  where results go, as a folder under the bucket (default: results/<run name>)
# Everything after `--` goes straight to `nextflow run`, e.g.
#   scripts/run-on-aws.sh -n hg002 -p awsbatch,chr20 -- --samplesheet s3://<bucket>/samplesheet.csv ...
# Set DRY_RUN=1 to print the job instead of submitting it.
set -euo pipefail

STACK=${STACK:-InfraStack}
REPO=${GIAB_REPO:-jameswagner/nextflow-giab}
export AWS_REGION=${AWS_REGION:-us-east-1}
revision=main; profile=awsbatch; name="run-$(date +%Y%m%d-%H%M%S)"; outprefix=""

while getopts "r:p:n:o:" opt; do
  case $opt in
    r) revision=$OPTARG ;; p) profile=$OPTARG ;; n) name=$OPTARG ;; o) outprefix=$OPTARG ;;
    *) sed -n '2,13p' "$0"; exit 2 ;;
  esac
done
shift $((OPTIND - 1))
[ "${1:-}" = "--" ] && shift

# Names come from the deployed stack's outputs, so nothing account-specific lives in the repo.
out() {
  aws cloudformation describe-stacks --stack-name "$STACK" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text
}
bucket=$(out BucketName); queue=$(out LauncherQueueName); jobdef=$(out LauncherJobDefinitionName)
for v in bucket queue jobdef; do
  [ -n "${!v}" ] && [ "${!v}" != "None" ] || { echo "Missing stack output for $v; is $STACK deployed?" >&2; exit 1; }
done

overrides=$(python3 - "$REPO" "$revision" "$profile" "$bucket" "$name" "${outprefix:-results/$name}" "$@" <<'PY'
import json, sys
repo, rev, profile, bucket, name, outprefix, *extra = sys.argv[1:]
cmd = ["nextflow", "run", repo, "-r", rev, "-profile", profile,
       "-work-dir", f"s3://{bucket}/work", "-output-dir", f"s3://{bucket}/{outprefix}", *extra]
print(json.dumps({"command": cmd}))
PY
)

if [ -n "${DRY_RUN:-}" ]; then
  echo "job: $name  queue: $queue  definition: $jobdef"; echo "$overrides"; exit 0
fi

job_id=$(aws batch submit-job --job-name "$name" --job-queue "$queue" --job-definition "$jobdef" \
  --container-overrides "$overrides" --query jobId --output text)
echo "Submitted $name (job $job_id). Nextflow now runs on AWS; this machine can be closed."
echo "Follow the log:  aws logs tail /giab/batch-jobs --follow --log-stream-name-prefix nextflow-launcher"
echo "Results:         s3://$bucket/${outprefix:-results/$name}/"
