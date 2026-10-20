"""Tests for bin/benchmark_metrics.py against real HG002 chr20 vcfeval output (tests/fixtures).

Run: python3 -m unittest discover -s tests -v
Schema validation runs too if the `jsonschema` package is installed; otherwise it is skipped.
"""
import gzip
import importlib.util
import json
import shutil
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FIXTURE = ROOT / "tests" / "fixtures" / "hg002-chr20.vcfeval"
SCHEMA = ROOT / "schemas" / "benchmark-metrics.v1.schema.json"

spec = importlib.util.spec_from_file_location("benchmark_metrics", ROOT / "bin" / "benchmark_metrics.py")
bm = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bm)

BASE_ARGS = ["--sample", "HG002", "--truth-vcf", "HG002_GRCh38_1_22_v4.2.1_benchmark.vcf.gz",
             "--truth-bed", "HG002_GRCh38_1_22_v4.2.1_benchmark_noinconsistent.bed",
             "--reference", "chr20.fasta", "--region", "chr20"]


class BenchmarkMetricsTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.vcfeval = self.tmp / "HG002.vcfeval"
        shutil.copytree(FIXTURE, self.vcfeval)
        self.out = self.tmp / "HG002.metrics.json"

    def tearDown(self):
        shutil.rmtree(self.tmp)

    def run_tool(self, *extra):
        return bm.main(["--vcfeval-dir", str(self.vcfeval), "--output", str(self.out), *BASE_ARGS, *extra])

    def test_hg002_scores_match_vcfeval(self):
        self.assertEqual(self.run_tool(), 0)
        m = json.loads(self.out.read_text())["metrics"]
        self.assertEqual((m["snp"]["true_positives_baseline"], m["snp"]["false_positives"],
                          m["snp"]["false_negatives"]), (70327, 433, 1006))
        self.assertEqual((m["non_snp"]["true_positives_call"], m["non_snp"]["false_negatives"]), (10213, 1044))
        self.assertEqual(m["all"]["false_positives"], 785)
        self.assertAlmostEqual(m["snp"]["f1"], 0.9899, places=4)
        self.assertAlmostEqual(m["non_snp"]["recall"], 0.9072, places=4)
        self.assertAlmostEqual(m["all"]["f1"], 0.9827, places=4)

    def test_provenance_and_params_hash(self):
        self.assertEqual(self.run_tool("--run-type", "pr", "--pr-number", "12", "--head-commit", "abc123",
                                       "--param", "eval_region=chr20", "--container",
                                       "RTG_VCFEVAL=quay.io/biocontainers/rtg-tools:3.13--hdfd78af_0"), 0)
        record = json.loads(self.out.read_text())
        self.assertEqual(record["schema_version"], bm.SCHEMA_VERSION)
        self.assertEqual(record["run"]["run_type"], "pr")
        self.assertEqual(record["run"]["pr_number"], 12)
        self.assertEqual(record["benchmark"]["tool_version"], "3.13")
        self.assertEqual(record["benchmark"]["score_field"], "GQ (FORMAT)")
        self.assertEqual(record["containers"]["RTG_VCFEVAL"], "quay.io/biocontainers/rtg-tools:3.13--hdfd78af_0")
        # Same parameters, same hash, regardless of order.
        first = record["params_hash"]
        self.run_tool("--param", "eval_region=chr20")
        self.assertEqual(json.loads(self.out.read_text())["params_hash"], first)
        self.run_tool("--param", "eval_region=chr21")
        self.assertNotEqual(json.loads(self.out.read_text())["params_hash"], first)

    def test_filter_expressions_are_recorded_and_change_the_hash(self):
        strict = "snp_filter=QD < 25.0 || QUAL < 30.0"
        self.assertEqual(self.run_tool("--param", strict), 0)
        record = json.loads(self.out.read_text())
        self.assertEqual(record["params"]["snp_filter"], "QD < 25.0 || QUAL < 30.0")
        strict_hash = record["params_hash"]
        self.run_tool("--param", "snp_filter=QD < 2.0 || QUAL < 30.0")
        self.assertNotEqual(json.loads(self.out.read_text())["params_hash"], strict_hash)

    def test_fails_when_rows_do_not_add_up(self):
        summary = self.vcfeval / "summary.txt"
        summary.write_text(summary.read_text().replace("80539", "80540", 1))
        self.assertEqual(self.run_tool(), 1)
        self.assertFalse(self.out.exists())

    def test_fails_on_unexpected_format(self):
        roc = self.vcfeval / "snp_roc.tsv.gz"
        with gzip.open(roc, "rt") as handle:
            text = handle.read().replace("false_negatives", "missed")
        with gzip.open(roc, "wt") as handle:
            handle.write(text)
        self.assertEqual(self.run_tool(), 1)

    def test_output_matches_schema(self):
        try:
            import jsonschema
        except ImportError:
            self.skipTest("jsonschema not installed")
        self.assertEqual(self.run_tool("--param", "eval_region=chr20"), 0)
        jsonschema.validate(json.loads(self.out.read_text()), json.loads(SCHEMA.read_text()),
                            format_checker=jsonschema.FormatChecker())


if __name__ == "__main__":
    unittest.main()
