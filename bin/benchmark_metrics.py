#!/usr/bin/env python3
"""Turn RTG vcfeval output into a benchmark metrics record (schemas/benchmark-metrics.v1.schema.json).

Reads summary.txt, snp_roc.tsv.gz and non_snp_roc.tsv.gz from a vcfeval output directory and
writes one JSON file with the scores plus where they came from (pipeline revision, run type,
containers, truth set, parameters). Exits non-zero if the files don't look like vcfeval output or
don't agree with each other, so a format change fails loudly instead of producing wrong numbers.
Standard library only.
"""
import argparse
import datetime
import gzip
import hashlib
import json
import re
import sys
from pathlib import Path

SCHEMA_VERSION = "1.0.0"
RUN_TYPES = ("main", "pr", "experiment")
# vcfeval prints precision, sensitivity and F-measure to 4 decimal places.
REPORTED_TOLERANCE = 1e-4

ROC_COLUMNS = ("true_positives_baseline", "false_positives", "true_positives_call",
               "false_negatives", "precision", "sensitivity", "f_measure")
SUMMARY_COLUMNS = ("Threshold", "True-pos-baseline", "True-pos-call", "False-pos",
                   "False-neg", "Precision", "Sensitivity", "F-measure")


class FormatError(Exception):
    pass


def as_count(value, what):
    number = float(value)
    if number != int(number) or number < 0:
        raise FormatError(f"{what}: expected a whole non-negative count, got {value!r}")
    return int(number)


def scores(tp_baseline, tp_call, fp, fn, reported, what):
    """Counts plus precision/recall/F1 recomputed at full precision and checked against vcfeval's."""
    precision = tp_call / (tp_call + fp) if tp_call + fp else 0.0
    recall = tp_baseline / (tp_baseline + fn) if tp_baseline + fn else 0.0
    f1 = 2 * precision * recall / (precision + recall) if precision + recall else 0.0
    for name, ours, theirs in (("precision", precision, reported[0]),
                               ("recall", recall, reported[1]),
                               ("f1", f1, reported[2])):
        if abs(ours - theirs) > REPORTED_TOLERANCE:
            raise FormatError(f"{what}: computed {name} {ours:.6f} but vcfeval reported {theirs}")
    return {
        "true_positives_baseline": tp_baseline,
        "true_positives_call": tp_call,
        "false_positives": fp,
        "false_negatives": fn,
        "precision": precision,
        "recall": recall,
        "f1": f1,
    }


def read_roc(path):
    """Return (tool_version, score_field, scores) for the all-calls row (the last row) of a ROC file."""
    tool_version = score_field = None
    columns, rows = None, []
    with gzip.open(path, "rt") as handle:
        for line in handle:
            line = line.rstrip("\n")
            if line.startswith("#Version"):
                match = re.search(r"RTG Tools (\S+)", line)
                tool_version = match.group(1) if match else None
            elif line.startswith("#score field:"):
                score_field = line.split(":", 1)[1].strip()
            elif line.startswith("#score\t"):
                columns = line[1:].split("\t")
            elif line and not line.startswith("#"):
                rows.append(line.split("\t"))
    if columns is None or not rows:
        raise FormatError(f"{path}: no ROC header or no data rows")
    missing = [c for c in ROC_COLUMNS if c not in columns]
    if missing:
        raise FormatError(f"{path}: missing columns {missing}")
    row = dict(zip(columns, rows[-1]))
    result = scores(
        as_count(row["true_positives_baseline"], path), as_count(row["true_positives_call"], path),
        as_count(row["false_positives"], path), as_count(row["false_negatives"], path),
        (float(row["precision"]), float(row["sensitivity"]), float(row["f_measure"])), str(path))
    return tool_version, score_field, result


def read_summary(path):
    """Return scores for the "None" row of summary.txt: every call included, no score threshold."""
    lines = [l.split() for l in Path(path).read_text().splitlines() if l.strip()]
    if not lines or tuple(lines[0]) != SUMMARY_COLUMNS:
        raise FormatError(f"{path}: unexpected header {lines[0] if lines else None}")
    row = dict(zip(SUMMARY_COLUMNS, lines[-1]))
    if row["Threshold"] != "None":
        raise FormatError(f"{path}: last row is threshold {row['Threshold']!r}, expected 'None'")
    return scores(
        as_count(row["True-pos-baseline"], path), as_count(row["True-pos-call"], path),
        as_count(row["False-pos"], path), as_count(row["False-neg"], path),
        (float(row["Precision"]), float(row["Sensitivity"]), float(row["F-measure"])), str(path))


def key_values(pairs, flag):
    out = {}
    for pair in pairs or []:
        key, sep, value = pair.partition("=")
        if not sep or not key:
            raise SystemExit(f"{flag} expects KEY=VALUE, got {pair!r}")
        out[key] = value
    return out


def or_none(value):
    return value if value not in (None, "", "null") else None


def build_record(args):
    vcfeval = Path(args.vcfeval_dir)
    snp_version, snp_field, snp = read_roc(vcfeval / "snp_roc.tsv.gz")
    non_version, non_field, non_snp = read_roc(vcfeval / "non_snp_roc.tsv.gz")
    overall = read_summary(vcfeval / "summary.txt")

    # SNP + non-SNP must add up to the all-calls row, or we are reading the wrong rows.
    for key in ("true_positives_baseline", "true_positives_call", "false_positives", "false_negatives"):
        if snp[key] + non_snp[key] != overall[key]:
            raise FormatError(f"{key}: SNP {snp[key]} + non-SNP {non_snp[key]} != all {overall[key]}")

    params = key_values(args.param, "--param")
    canonical = json.dumps(params, sort_keys=True, separators=(",", ":"))
    pr_number = or_none(args.pr_number)

    return {
        "schema_version": SCHEMA_VERSION,
        "generated_at": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
        "sample": args.sample,
        "run": {
            "run_type": args.run_type,
            "run_name": or_none(args.run_name),
            "session_id": or_none(args.session_id),
            "started_at": or_none(args.started_at),
            "repository": or_none(args.repository),
            "revision": or_none(args.revision),
            "head_commit": or_none(args.head_commit),
            "base_commit": or_none(args.base_commit),
            "pr_number": int(pr_number) if pr_number else None,
            "nextflow_version": or_none(args.nextflow_version),
        },
        "containers": key_values(args.container, "--container"),
        "benchmark": {
            "tool": "rtg vcfeval",
            "tool_version": snp_version or non_version,
            "score_field": snp_field or non_field,
            "truth_set": or_none(args.truth_set),
            "truth_vcf": args.truth_vcf,
            "truth_bed": args.truth_bed,
            "reference": args.reference,
            "region": or_none(args.region),
        },
        "params": params,
        "params_hash": "sha256:" + hashlib.sha256(canonical.encode()).hexdigest(),
        "metrics": {"snp": snp, "non_snp": non_snp, "all": overall},
    }


def parse_args(argv):
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--vcfeval-dir", required=True)
    p.add_argument("--sample", required=True)
    p.add_argument("--output", required=True)
    p.add_argument("--run-type", choices=RUN_TYPES, default="experiment")
    p.add_argument("--run-name")
    p.add_argument("--session-id")
    p.add_argument("--started-at")
    p.add_argument("--repository")
    p.add_argument("--revision")
    p.add_argument("--head-commit")
    p.add_argument("--base-commit")
    p.add_argument("--pr-number")
    p.add_argument("--nextflow-version")
    p.add_argument("--truth-set", help="label, e.g. 'GIAB HG002 NISTv4.2.1 GRCh38'")
    p.add_argument("--truth-vcf", required=True, help="file name only, no bucket")
    p.add_argument("--truth-bed", required=True, help="file name only, no bucket")
    p.add_argument("--reference", required=True, help="file name only, no bucket")
    p.add_argument("--region")
    p.add_argument("--param", action="append", help="analysis parameter KEY=VALUE (hashed)")
    p.add_argument("--container", action="append", help="PROCESS=IMAGE")
    return p.parse_args(argv)


def main(argv=None):
    args = parse_args(argv)
    try:
        record = build_record(args)
    except (FormatError, OSError, ValueError) as error:
        print(f"benchmark_metrics: {error}", file=sys.stderr)
        return 1
    Path(args.output).write_text(json.dumps(record, indent=2) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
