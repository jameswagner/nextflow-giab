#!/usr/bin/env bash
# Start a recorded pipeline run: a Step Functions execution that writes a run record to DynamoDB,
# runs Nextflow on AWS (the launcher job), reads the benchmark metrics, records the outcome and
# notifies. For an unrecorded one-off, scripts/run-on-aws.sh still submits the launcher directly.
#
# Usage: scripts/start-run.sh -s SAMPLE [-r REVISION] [-p PROFILE] [-t RUN_TYPE] [-P PR] [-b BASE] [-n NAME] -- <pipeline params>
#   -s  sample name, as in the samplesheet (required; the run record is keyed on it)
#   -r  git branch, tag or commit of the pipeline (default: main)
#   -p  Nextflow profile(s) (default: awsbatch)
#   -t  run type: main | pr | experiment (default: experiment)
#   -P  PR number, for PR runs        -b  base commit the PR is compared against
#   -n  run id / execution name (default: <sample>-<timestamp>)
# Results go to s3://<bucket>/runs/<run id>/. Set DRY_RUN=1 to print the input instead of starting.
set -euo pipefail

STACK=${STACK:-InfraStack}
export AWS_REGION=${AWS_REGION:-us-east-1}
sample=""; revision=main; profile=awsbatch; run_type=experiment; pr=""; base=""; name=""

while getopts "s:r:p:t:P:b:n:" opt; do
  case $opt in
    s) sample=$OPTARG ;; r) revision=$OPTARG ;; p) profile=$OPTARG ;; t) run_type=$OPTARG ;;
    P) pr=$OPTARG ;; b) base=$OPTARG ;; n) name=$OPTARG ;;
    *) sed -n '2,14p' "$0"; exit 2 ;;
  esac
done
shift $((OPTIND - 1))
[ "${1:-}" = "--" ] && shift
[ -n "$sample" ] || { echo "-s SAMPLE is required" >&2; exit 2; }
name=${name:-$(echo "$sample" | tr '[:upper:]' '[:lower:]')-$(date +%Y%m%d-%H%M%S)}

input=$(python3 - "$sample" "$revision" "$profile" "$run_type" "$pr" "$base" "$@" <<'PY'
import json, sys
sample, revision, profile, run_type, pr, base, *args = sys.argv[1:]
doc = {"sample": sample, "revision": revision, "profile": profile, "run_type": run_type, "pipeline_args": args}
if pr:
    doc["pr_number"] = int(pr)
if base:
    doc["base_commit"] = base
print(json.dumps(doc))
PY
)

if [ -n "${DRY_RUN:-}" ]; then echo "run id: $name"; echo "$input"; exit 0; fi

arn=$(aws cloudformation describe-stacks --stack-name "$STACK" \
  --query "Stacks[0].Outputs[?OutputKey=='RunStateMachineArn'].OutputValue" --output text)
[ -n "$arn" ] && [ "$arn" != "None" ] || { echo "No RunStateMachineArn output; is $STACK deployed?" >&2; exit 1; }

exec_arn=$(aws stepfunctions start-execution --state-machine-arn "$arn" --name "$name" --input "$input" \
  --query executionArn --output text)
echo "Started run $name. Nothing runs on this machine; it can be closed."
echo "Status:  aws stepfunctions describe-execution --execution-arn $exec_arn --query status"
echo "Record:  aws dynamodb query --table-name <RunsTableName> --key-condition-expression 'sample = :s' --expression-attribute-values '{\":s\":{\"S\":\"$sample\"}}'"
