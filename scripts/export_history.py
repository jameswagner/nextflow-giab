#!/usr/bin/env python3
"""Export the benchmark history for the public dashboard: site/history.json.

Reads the run records (DynamoDB, via the AWS CLI) and writes an allow-listed, sanitized view of the
benchmark runs: when, which pipeline revision, the scores and the gate result. Nothing else leaves AWS:
no bucket names, ARNs, job ids or error text. The export fails, and writes nothing, if any value in the
output looks like an S3 URI, an ARN or an AWS account id.

Usage: scripts/export_history.py --output site/history.json [--table NAME | --items FILE]
  --items reads DynamoDB items (as returned by `aws dynamodb scan`) from a file instead of AWS, for tests.
Standard library only.
"""
import argparse
import datetime
import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BASELINE = ROOT / "benchmarks" / "hg002-chr20.json"

# The only attributes ever requested or published.
STRING_FIELDS = ("run_id", "sample", "started_at", "run_type", "revision", "status", "gate_status",
                 "gate_reasons", "head_commit", "params_hash")
SCORE_FIELDS = ("snp_f1", "non_snp_f1", "all_f1")
ATTRIBUTES = STRING_FIELDS + SCORE_FIELDS
RESERVED = {"sample": "#sample", "status": "#status"}  # DynamoDB reserved words
SAMPLES = ("HG002",)  # runs of other samples (the toy data, tests) are not benchmark history

LEAKS = (re.compile(r"s3://", re.I), re.compile(r"arn:aws", re.I), re.compile(r"(?<![\d.])\d{12}(?!\d)"),
         re.compile(r"amazonaws\.com", re.I))


class LeakError(Exception):
    pass


def plain(item):
    """DynamoDB's typed JSON ({"S": "x"}) to plain values."""
    return {key: next(iter(value.values())) for key, value in item.items()}


def check_clean(value, where):
    if isinstance(value, str):
        for pattern in LEAKS:
            if pattern.search(value):
                raise LeakError(f"{where} contains something that looks like an AWS identifier: {value[:60]!r}")
    elif isinstance(value, dict):
        for key, inner in value.items():
            check_clean(inner, f"{where}.{key}")
    elif isinstance(value, list):
        for index, inner in enumerate(value):
            check_clean(inner, f"{where}[{index}]")


def build(items, baseline, now=None):
    runs = []
    for raw in items:
        record = plain(raw)
        if record.get("sample") not in SAMPLES:
            continue
        try:
            scores = {field: float(record[field]) for field in SCORE_FIELDS}
        except (KeyError, ValueError):
            continue  # a run without scores (failed, stopped, no truth set) has nothing to chart
        runs.append({
            "run_id": record.get("run_id"),
            "started_at": record.get("started_at"),
            "run_type": record.get("run_type"),
            "revision": record.get("revision"),
            "commit": (record.get("head_commit") or "")[:7] or None,
            "status": record.get("status"),
            "gate_status": record.get("gate_status"),
            "gate_reasons": record.get("gate_reasons") if record.get("gate_reasons") not in (None, "none") else None,
            "params_hash": (record.get("params_hash") or "")[:19] or None,
            **scores,
        })
    runs.sort(key=lambda run: run["started_at"] or "")
    scores = baseline["scores"]
    history = {
        "generated_at": (now or datetime.datetime.now(datetime.timezone.utc)).isoformat(timespec="seconds"),
        "truth_set": baseline.get("truth_set"),
        "region": baseline.get("region"),
        "baseline": {
            "snp_f1": scores["snp"]["f1"], "non_snp_f1": scores["non_snp"]["f1"], "all_f1": scores["all"]["f1"],
            "max_drop": baseline["tolerances"]["max_drop"]["f1"],
            "pipeline_commit": (baseline.get("recorded_from", {}).get("pipeline_commit") or "")[:7] or None,
        },
        "runs": runs,
    }
    check_clean(history, "history")
    return history


def scan(table):
    names = {"#sample": "sample", "#status": "status"}
    projection = ",".join(RESERVED.get(field, field) for field in ATTRIBUTES)
    out = subprocess.run(
        ["aws", "dynamodb", "scan", "--table-name", table, "--projection-expression", projection,
         "--expression-attribute-names", json.dumps(names), "--output", "json"],
        check=True, capture_output=True, text=True).stdout
    return json.loads(out)["Items"]


def table_name(stack):
    out = subprocess.run(
        ["aws", "cloudformation", "describe-stacks", "--stack-name", stack, "--query",
         "Stacks[0].Outputs[?OutputKey=='RunsTableName'].OutputValue", "--output", "text"],
        check=True, capture_output=True, text=True).stdout.strip()
    if not out or out == "None":
        raise SystemExit(f"stack {stack} has no RunsTableName output")
    return out


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--output", required=True)
    source = parser.add_mutually_exclusive_group()
    source.add_argument("--table")
    source.add_argument("--items", help="DynamoDB scan output (JSON) to read instead of AWS")
    parser.add_argument("--stack", default="InfraStack")
    args = parser.parse_args(argv)
    try:
        if args.items:
            items = json.loads(Path(args.items).read_text())["Items"]
        else:
            items = scan(args.table or table_name(args.stack))
        history = build(items, json.loads(BASELINE.read_text()))
    except (LeakError, subprocess.CalledProcessError, OSError, ValueError, KeyError) as error:
        print(f"export_history: {error}", file=sys.stderr)
        return 1
    Path(args.output).parent.mkdir(parents=True, exist_ok=True)
    Path(args.output).write_text(json.dumps(history, indent=2) + "\n")
    print(f"wrote {args.output}: {len(history['runs'])} runs")
    return 0


if __name__ == "__main__":
    sys.exit(main())
