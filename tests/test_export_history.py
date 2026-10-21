"""Tests for scripts/export_history.py: what is published, and that nothing identifying can leak.

Run: python3 -m unittest discover -s tests -v
"""
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("export_history", ROOT / "scripts" / "export_history.py")
export_history = importlib.util.module_from_spec(spec)
spec.loader.exec_module(export_history)
BASELINE = json.loads((ROOT / "benchmarks" / "hg002-chr20.json").read_text())


def item(**fields):
    """A DynamoDB-typed item; numbers are strings in DynamoDB's JSON, as the real ones are."""
    return {key: {"S": str(value)} for key, value in fields.items()}


GOOD = dict(run_id="demo-default-1020-1606", sample="HG002", started_at="2026-10-20T23:06:29Z",
            run_type="experiment", revision="filter-params", status="SUCCEEDED", gate_status="PASS",
            head_commit="cd365b4ef1513e2713740baa32b92799248618f9", params_hash="sha256:" + "ab" * 32,
            snp_f1="0.9898", non_snp_f1="0.9360", all_f1="0.9827")


class ExportHistoryTest(unittest.TestCase):
    def test_publishes_only_allow_listed_fields(self):
        extra = dict(GOOD, results_prefix="s3://bucket/runs/x/", metrics_uri="s3://bucket/x.json",
                     run_key="k", error="Batch.AWSBatchException", error_cause="arn:aws:batch:...")
        history = export_history.build([item(**extra)], BASELINE)
        run = history["runs"][0]
        self.assertEqual(set(run), {"run_id", "started_at", "run_type", "revision", "commit", "status", "gate_status",
                                    "gate_reasons", "params_hash", "snp_f1", "non_snp_f1", "all_f1"})
        self.assertEqual(run["commit"], "cd365b4")
        self.assertEqual(run["snp_f1"], 0.9898)
        self.assertNotIn("s3://", json.dumps(history))

    def test_only_scored_runs_of_the_benchmark_sample_appear_in_time_order(self):
        items = [item(**dict(GOOD, run_id="late", started_at="2026-10-21T01:00:00Z")),
                 item(**dict(GOOD, run_id="toy-run", sample="toy")),
                 item(run_id="failed", sample="HG002", started_at="2026-10-20T20:00:00Z", status="FAILED"),
                 item(**dict(GOOD, run_id="early", started_at="2026-10-20T10:00:00Z"))]
        runs = export_history.build(items, BASELINE)["runs"]
        self.assertEqual([r["run_id"] for r in runs], ["early", "late"])

    def test_baseline_and_tolerance_come_from_the_committed_baseline(self):
        history = export_history.build([], BASELINE)
        self.assertEqual(history["baseline"]["max_drop"], 0.002)
        self.assertAlmostEqual(history["baseline"]["snp_f1"], BASELINE["scores"]["snp"]["f1"])
        self.assertEqual(history["runs"], [])

    def test_fails_closed_on_anything_that_looks_like_an_aws_identifier(self):
        for field, value in (("revision", "s3://my-bucket/x"), ("run_id", "arn:aws:states:us-east-1:1:x"),
                             ("gate_reasons", "see 123456789012 for details"), ("revision", "x.amazonaws.com")):
            with self.assertRaises(export_history.LeakError, msg=f"{field}={value}"):
                export_history.build([item(**dict(GOOD, **{field: value}))], BASELINE)

    def test_long_numbers_inside_scores_are_not_mistaken_for_account_ids(self):
        run = export_history.build([item(**dict(GOOD, snp_f1="0.9898728297664207"))], BASELINE)["runs"][0]
        self.assertAlmostEqual(run["snp_f1"], 0.9898728297664207)

    def test_command_line_writes_nothing_when_it_refuses(self):
        with tempfile.TemporaryDirectory() as tmp:
            items_file, out = Path(tmp) / "items.json", Path(tmp) / "site" / "history.json"
            items_file.write_text(json.dumps({"Items": [item(**dict(GOOD, revision="s3://b/x"))]}))
            self.assertEqual(export_history.main(["--items", str(items_file), "--output", str(out)]), 1)
            self.assertFalse(out.exists())
            items_file.write_text(json.dumps({"Items": [item(**GOOD)]}))
            self.assertEqual(export_history.main(["--items", str(items_file), "--output", str(out)]), 0)
            self.assertEqual(len(json.loads(out.read_text())["runs"]), 1)


if __name__ == "__main__":
    unittest.main()
