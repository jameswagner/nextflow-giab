#!/usr/bin/env bash
# Run the HG002 chr20 benchmark for one pipeline revision through the run state machine, and optionally
# wait for the result. Used by the GitHub workflows and by hand; inputs live in benchmarks/hg002-chr20.args.
#
# Usage: scripts/run-benchmark.sh -r REVISION [-t main|pr|experiment] [-P PR] [-b BASE_COMMIT] [-w] [-- extra pipeline params]
#        scripts/run-benchmark.sh -R RUN_ID        (report on an existing run, no new run)
#   -w  wait for the run to finish, then write benchmark-result.json and benchmark-result.md here.
#       Exit status when reporting: 0 passed, 2 regressed or incomparable, 1 failed or did not finish.
# DRY_RUN=1 prints what would be started.
set -euo pipefail

STACK=${STACK:-InfraStack}
export AWS_REGION=${AWS_REGION:-us-east-1}
HERE=$(cd "$(dirname "$0")/.." && pwd)
ARGS_FILE="$HERE/benchmarks/hg002-chr20.args"
BASELINE="$HERE/benchmarks/hg002-chr20.json"
revision=""; run_type=experiment; pr=""; base=""; wait=""; report=""

while getopts "r:t:P:b:wR:" opt; do
  case $opt in
    r) revision=$OPTARG ;; t) run_type=$OPTARG ;; P) pr=$OPTARG ;; b) base=$OPTARG ;; w) wait=1 ;; R) report=$OPTARG ;;
    *) sed -n '2,11p' "$0"; exit 1 ;;
  esac
done
shift $((OPTIND - 1)); [ "${1:-}" = "--" ] && shift
[ -n "$revision$report" ] || { echo "-r REVISION is required (a branch, tag or commit)" >&2; exit 1; }

outputs=$(aws cloudformation describe-stacks --stack-name "$STACK" --query 'Stacks[0].Outputs' --output json)
out() { python3 -c "import json,sys; print(next(o['OutputValue'] for o in json.load(sys.stdin) if o['OutputKey']=='$1'))" <<<"$outputs"; }
bucket=$(out BucketName); table=$(out RunsTableName)

# Pipeline arguments from the args file, with the bucket filled in; quoting follows shell rules.
args=()
while IFS= read -r word; do args+=("$word"); done < <(python3 - "$ARGS_FILE" "$bucket" <<'PY'
import shlex, sys
path, bucket = sys.argv[1:]
for line in open(path):
    line = line.strip()
    if line and not line.startswith("#"):
        for word in shlex.split(line.replace("@BUCKET@", bucket)):
            print(word)
PY
)

if [ -n "$report" ]; then
  name=$report; status=UNKNOWN
else
short=$(printf '%s' "$revision" | tr -c 'A-Za-z0-9-' '-' | cut -c1-12)
name="${run_type}${pr:+-$pr}-${short}-$(date -u +%m%d-%H%M%S)"
start=(scripts/start-run.sh -s HG002 -r "$revision" -p awsbatch,chr20 -t "$run_type" -n "$name")
[ -n "$pr" ] && start+=(-P "$pr"); [ -n "$base" ] && start+=(-b "$base")
if [ -n "${DRY_RUN:-}" ]; then echo "run id: $name"; printf '%q ' "${start[@]}" -- "${args[@]}" "$@"; echo; exit 0; fi
started=$(cd "$HERE" && "${start[@]}" -- "${args[@]}" "$@")
exec_arn=$(grep -oE 'arn:aws[a-z-]*:states:[^ ]+:execution:[^ ]+' <<<"$started" | head -1)
[ -n "$exec_arn" ] || { echo "$started" >&2; exit 1; }
echo "$exec_arn" > execution-arn.txt
echo "Started benchmark run $name"
[ -n "$wait" ] || exit 0

status=RUNNING
for _ in $(seq 1 240); do
  status=$(aws stepfunctions describe-execution --execution-arn "$exec_arn" --query status --output text)
  [ "$status" = RUNNING ] || break
  sleep 60
done
fi

# The run record: find its key through the run-id index, then read it.
keys=$(aws dynamodb query --table-name "$table" --index-name by_run_id \
  --key-condition-expression 'run_id = :r' --expression-attribute-values "{\":r\":{\"S\":\"$name\"}}" \
  --query 'Items[0].{sample: sample, run_key: run_key}' --output json)
echo null > benchmark-record.json
if [ "$keys" != "null" ]; then
  aws dynamodb get-item --table-name "$table" --key "$keys" --query Item --output json > benchmark-record.json
fi

python3 - "$name" "$status" "$revision" "$BASELINE" <<'PY'
import json, sys
name, execution_status, revision, baseline_path = sys.argv[1:]
raw = json.load(open("benchmark-record.json"))
record = {k: list(v.values())[0] for k, v in (raw or {}).items()}
baseline = json.load(open(baseline_path))["scores"]
rows = []
for group, label in (("snp", "SNPs"), ("non_snp", "Indels and other"), ("all", "All")):
    value = record.get(f"{group}_f1")
    base = baseline[group]["f1"]
    if value is None:
        rows.append(f"| {label} | - | {base:.4f} | - |")
    else:
        value = float(value)
        change = value - base
        change = 0.0 if abs(change) < 0.00005 else change  # float noise, not a real change
        rows.append(f"| {label} | {value:.4f} | {base:.4f} | {change:+.4f} |")
status = record.get("status", execution_status)
gate = record.get("gate_status", "none")
reasons = record.get("gate_reasons", "none")
icon = {"SUCCEEDED": "PASS", "REGRESSED": "REGRESSED", "INCOMPARABLE": "INCOMPARABLE"}.get(status, status)
lines = [f"### Benchmark: {icon}", "",
         f"HG002 chr20 against GIAB v4.2.1, pipeline commit `{record.get('head_commit') or revision or 'not recorded'}`, run `{name}`.", "",
         "| F1 | This run | Baseline | Change |", "|---|---|---|---|", *rows, ""]
if reasons not in ("none", None):
    lines += [f"Gate: **{gate}**. {reasons}", ""]
elif gate != "none":
    lines += [f"Gate: **{gate}**.", ""]
if status in ("FAILED", "ABORTED", "TIMED_OUT", "RUNNING"):
    lines += [f"The run did not finish normally (status {status}, error: {record.get('error', 'n/a')}).", ""]
open("benchmark-result.md", "w").write("\n".join(lines))
json.dump({"run_id": name, "status": status, "gate_status": gate, "record": record}, open("benchmark-result.json", "w"), indent=2)
print("\n".join(lines))
PY

case "$(python3 -c "import json; print(json.load(open('benchmark-result.json'))['status'])")" in
  SUCCEEDED) exit 0 ;; REGRESSED|INCOMPARABLE) exit 2 ;; *) exit 1 ;;
esac
