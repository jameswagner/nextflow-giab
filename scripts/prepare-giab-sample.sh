#!/usr/bin/env bash
# Prepare a GIAB sample as input for the main pipeline, on AWS: slice chr20 from GIAB's public 2x250
# Illumina BAM, downsample to about 30x, convert to FASTQ, fetch the v4.2.1 truth set and write a
# samplesheet, all under s3://<bucket>/results/giab-<sample>/ (the launcher may write only under work/,
# runs/ and results/). Runs prep/giab_sample.nf through the same
# launcher as the pipeline, so nothing runs on this machine.
#
# Usage: scripts/prepare-giab-sample.sh [-r REVISION] SAMPLE      (HG002, HG003 or HG004)
#   -r  git branch, tag or commit of this repository (default: main)
# Set DRY_RUN=1 to print the job instead of submitting it.
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
STACK=${STACK:-InfraStack}
export AWS_REGION=${AWS_REGION:-us-east-1}
revision=main
while getopts "r:" opt; do
  case $opt in r) revision=$OPTARG ;; *) sed -n '2,10p' "$0"; exit 2 ;; esac
done
shift $((OPTIND - 1))
sample=${1:-}

# Folder of each sample on the GIAB FTP (ReferenceSamples/giab/{data,release}/<path>).
case "$sample" in
  HG002) giab_path=AshkenazimTrio/HG002_NA24385_son ;;
  HG003) giab_path=AshkenazimTrio/HG003_NA24149_father ;;
  HG004) giab_path=AshkenazimTrio/HG004_NA24143_mother ;;
  *) echo "Usage: $0 [-r REVISION] HG002|HG003|HG004" >&2; exit 2 ;;
esac

bucket=$(aws cloudformation describe-stacks --stack-name "$STACK" \
  --query "Stacks[0].Outputs[?OutputKey=='BucketName'].OutputValue" --output text)
[ -n "$bucket" ] && [ "$bucket" != "None" ] || { echo "No BucketName output; is $STACK deployed?" >&2; exit 1; }
lower=$(echo "$sample" | tr '[:upper:]' '[:lower:]')

exec "$HERE/run-on-aws.sh" -r "$revision" -p awsbatch,chr20 -n "prep-$lower-$(date +%m%d-%H%M)" -o "results/giab-$lower" -- \
  -main-script prep/giab_sample.nf \
  --sample "$sample" --giab_path "$giab_path" --dest "s3://$bucket/results/giab-$lower"
