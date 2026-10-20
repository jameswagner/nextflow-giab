#!/usr/bin/env python3
"""Compare a benchmark metrics record with a committed baseline and write a gate result.

The result (schemas/benchmark-gate.v1.schema.json) says PASS, REGRESSED or INCOMPARABLE, with the
per-score deltas and the reasons. A score may rise freely; it may fall by at most the baseline's
tolerance. A record from a different sample, truth set, region or reference is INCOMPARABLE, because
comparing it would say nothing about the pipeline. The gate result is data, so a regression still
exits 0 and the result is published; only unreadable or malformed input exits non-zero.
Standard library only.
"""
import argparse
import json
import sys
from pathlib import Path

GATE_SCHEMA_VERSION = "1.0.0"
SUPPORTED_MAJOR = "1"
GROUPS = ("snp", "non_snp", "all")
SCORES = ("precision", "recall", "f1")
IDENTITY = (("sample", "sample", "sample"), ("truth_set", "benchmark", "truth_set"),
            ("region", "benchmark", "region"), ("reference", "benchmark", "reference"))
# A drop smaller than this is rounding noise in floats, not a real change.
EPSILON = 1e-12


class InputError(Exception):
    pass


def load(path, what):
    try:
        return json.loads(Path(path).read_text())
    except (OSError, ValueError) as error:
        raise InputError(f"cannot read {what} {path}: {error}")


def major(version):
    return str(version).split(".")[0]


def evaluate(record, baseline):
    if major(record.get("schema_version")) != SUPPORTED_MAJOR:
        raise InputError(f"metrics schema_version {record.get('schema_version')!r}, supported major is {SUPPORTED_MAJOR}")
    if major(baseline.get("schema_version")) != SUPPORTED_MAJOR:
        raise InputError(f"baseline schema_version {baseline.get('schema_version')!r}, supported major is {SUPPORTED_MAJOR}")
    try:
        max_drop = baseline["tolerances"]["max_drop"]
        expected = baseline["scores"]
        current = record["metrics"]
    except KeyError as error:
        raise InputError(f"missing field {error}")

    differences = []
    for name, record_section, record_key in IDENTITY:
        have = record[name] if record_section == "sample" else record[record_section][record_key]
        want = baseline.get(name)
        if have != want:
            differences.append(f"{name}: record has {have!r}, baseline is for {want!r}")

    checks = []
    for group in GROUPS:
        for score in SCORES:
            try:
                base, now, tolerance = expected[group][score], current[group][score], max_drop[score]
            except KeyError as error:
                raise InputError(f"missing {group}.{score} or its tolerance: {error}")
            delta = now - base
            checks.append({
                "group": group, "score": score, "baseline": base, "current": now,
                "delta": delta, "max_drop": tolerance, "ok": delta >= -tolerance - EPSILON,
            })

    failed = [c for c in checks if not c["ok"]]
    reasons = list(differences)
    reasons += [f"{c['group']} {c['score']} fell {-c['delta']:.4f} (baseline {c['baseline']:.4f}, now {c['current']:.4f}, "
                f"allowed drop {c['max_drop']})" for c in failed]
    status = "INCOMPARABLE" if differences else ("REGRESSED" if failed else "PASS")
    run = record.get("run", {})
    return {
        "schema_version": GATE_SCHEMA_VERSION,
        "status": status,
        "reasons": reasons,
        "checks": checks,
        "sample": record["sample"],
        "run": {k: run.get(k) for k in ("run_type", "revision", "head_commit", "base_commit", "pr_number")},
        "baseline": baseline.get("recorded_from", {}),
    }


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--metrics", required=True, help="benchmark metrics record (from benchmark_metrics.py)")
    parser.add_argument("--baseline", required=True, help="committed baseline, e.g. benchmarks/hg002-chr20.json")
    parser.add_argument("--output", required=True)
    args = parser.parse_args(argv)
    try:
        result = evaluate(load(args.metrics, "metrics"), load(args.baseline, "baseline"))
    except InputError as error:
        print(f"benchmark_gate: {error}", file=sys.stderr)
        return 1
    Path(args.output).write_text(json.dumps(result, indent=2) + "\n")
    print(f"GATE {result['status']}" + "".join(f"\n  {r}" for r in result["reasons"]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
