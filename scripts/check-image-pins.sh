#!/usr/bin/env bash
# Ask Nextflow itself which container every process will use (`nextflow inspect`) and require each one to
# be pinned by digest (name@sha256:...). This is the ground truth: it covers modules, config selectors and
# inline containers alike, wherever the image string happens to live. Fails and names the processes that
# are not pinned. Needs nextflow and jq. The CDK launcher image is checked by tests/test_image_pins.py.
#
# Usage: scripts/check-image-pins.sh [path/to/nextflow]
set -euo pipefail
NEXTFLOW=${1:-nextflow}
cd "$(dirname "$0")/.."
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
params="$tmp/params.json"  # Nextflow picks the parser from the extension
# inspect only reads the script and config; these inputs need to be declared, not to exist.
cat > "$params" <<'JSON'
{"samplesheet": "x.csv", "fasta": "x.fa", "dbsnp": "x.vcf.gz", "dbsnp_tbi": "x.tbi", "mills": "x.vcf.gz", "mills_tbi": "x.tbi"}
JSON
prep_params="$tmp/prep-params.json"
cat > "$prep_params" <<'JSON'
{"sample": "x", "giab_path": "x", "dest": "x"}
JSON

status=0
for target in "." "smoke/fail.nf" "prep/giab_sample.nf"; do
  args=("$target")
  [ "$target" = "." ] && args+=(-params-file "$params")
  [ "$target" = "prep/giab_sample.nf" ] && args+=(-params-file "$prep_params")
  # Nextflow prints a banner before the JSON and a status line after it; keep only the object.
  if ! raw=$("$NEXTFLOW" inspect "${args[@]}" < /dev/null 2> "$tmp/err.txt"); then
    echo "FAIL: nextflow inspect '$target' did not run:" >&2; head -5 "$tmp/err.txt" >&2; status=1; continue
  fi
  json=$(echo "$raw" | sed -n '/^{/,/^}/p')
  if echo "$json" | jq -e '(.processes | length) > 0 and ([.processes[].container] | all(. != null and test("@sha256:[0-9a-f]{64}$")))' > /dev/null; then
    echo "ok: $(echo "$json" | jq '.processes | length') process(es) in '$target', all pinned by digest"
  else
    echo "FAIL: '$target' has processes that are not pinned by digest:" >&2
    echo "$json" | jq -r '.processes[] | select((.container // "") | test("@sha256:[0-9a-f]{64}$") | not) | "  \(.name): \(.container)"' >&2
    status=1
  fi
done
exit $status
