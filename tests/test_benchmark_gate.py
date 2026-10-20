"""Tests for bin/benchmark_gate.py: real HG002 metrics (via benchmark_metrics.py) against the committed baseline.

Run: python3 -m unittest discover -s tests -v
"""
import copy
import importlib.util
import json
import shutil
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FIXTURE = ROOT / "tests" / "fixtures" / "hg002-chr20.vcfeval"
BASELINE = ROOT / "benchmarks" / "hg002-chr20.json"
GATE_SCHEMA = ROOT / "schemas" / "benchmark-gate.v1.schema.json"


def load_module(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / "bin" / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


metrics_tool = load_module("benchmark_metrics")
gate_tool = load_module("benchmark_gate")


class BenchmarkGateTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        vcfeval = self.tmp / "HG002.vcfeval"
        shutil.copytree(FIXTURE, vcfeval)
        self.metrics_path = self.tmp / "HG002.metrics.json"
        # Same identity the baseline was recorded with; the fixture's counts are what vcfeval reported.
        metrics_tool.main(["--vcfeval-dir", str(vcfeval), "--sample", "HG002", "--output", str(self.metrics_path),
                           "--truth-set", "GIAB HG002 NISTv4.2.1 GRCh38", "--run-type", "pr", "--pr-number", "7",
                           "--head-commit", "abc123",
                           "--truth-vcf", "HG002_GRCh38_1_22_v4.2.1_benchmark.vcf.gz",
                           "--truth-bed", "HG002_GRCh38_1_22_v4.2.1_benchmark_noinconsistent.bed",
                           "--reference", "chr20.fasta", "--region", "chr20"])
        self.metrics = json.loads(self.metrics_path.read_text())
        self.baseline = json.loads(BASELINE.read_text())
        self.out = self.tmp / "gate.json"

    def tearDown(self):
        shutil.rmtree(self.tmp)

    def gate(self, metrics=None, baseline=None):
        metrics_path, baseline_path = self.tmp / "m.json", self.tmp / "b.json"
        metrics_path.write_text(json.dumps(metrics if metrics is not None else self.metrics))
        baseline_path.write_text(json.dumps(baseline if baseline is not None else self.baseline))
        code = gate_tool.main(["--metrics", str(metrics_path), "--baseline", str(baseline_path), "--output", str(self.out)])
        return code, (json.loads(self.out.read_text()) if self.out.exists() else None)

    def test_committed_baseline_passes_the_run_it_was_recorded_from(self):
        code, result = self.gate()
        self.assertEqual(code, 0)
        self.assertEqual(result["status"], "PASS", result["reasons"])
        self.assertEqual(len(result["checks"]), 9)
        self.assertEqual(result["run"]["pr_number"], 7)

    def test_drop_beyond_tolerance_is_a_regression(self):
        worse = copy.deepcopy(self.metrics)
        worse["metrics"]["snp"]["f1"] -= 0.003
        code, result = self.gate(worse)
        self.assertEqual((code, result["status"]), (0, "REGRESSED"))
        self.assertEqual([c["group"] + "." + c["score"] for c in result["checks"] if not c["ok"]], ["snp.f1"])
        self.assertIn("snp f1 fell 0.0030", result["reasons"][0])

    def test_small_drop_within_tolerance_and_any_improvement_pass(self):
        changed = copy.deepcopy(self.metrics)
        changed["metrics"]["non_snp"]["recall"] -= 0.0015   # within the 0.002 allowance
        changed["metrics"]["snp"]["precision"] += 0.004     # improvements are never a regression
        code, result = self.gate(changed)
        self.assertEqual((code, result["status"]), (0, "PASS"))

    def test_different_region_or_truth_set_is_incomparable_not_pass(self):
        other = copy.deepcopy(self.metrics)
        other["benchmark"]["region"] = "chr21"
        code, result = self.gate(other)
        self.assertEqual((code, result["status"]), (0, "INCOMPARABLE"))
        self.assertIn("region", result["reasons"][0])
        other = copy.deepcopy(self.metrics)
        other["benchmark"]["truth_set"] = "something else"
        self.assertEqual(self.gate(other)[1]["status"], "INCOMPARABLE")

    def test_unreadable_or_wrong_version_input_fails(self):
        bad = copy.deepcopy(self.metrics)
        bad["schema_version"] = "2.0.0"
        self.assertEqual(self.gate(bad)[0], 1)
        self.out.unlink(missing_ok=True)
        broken = copy.deepcopy(self.baseline)
        del broken["tolerances"]
        self.assertEqual(self.gate(baseline=broken)[0], 1)
        self.assertFalse(self.out.exists())

    def test_result_matches_schema(self):
        try:
            import jsonschema
        except ImportError:
            self.skipTest("jsonschema not installed")
        schema = json.loads(GATE_SCHEMA.read_text())
        for metrics in (self.metrics, self._worse()):
            _, result = self.gate(metrics)
            jsonschema.validate(result, schema)

    def _worse(self):
        worse = copy.deepcopy(self.metrics)
        worse["metrics"]["all"]["f1"] -= 0.01
        return worse


if __name__ == "__main__":
    unittest.main()
