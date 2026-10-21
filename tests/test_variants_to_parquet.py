"""Tests for bin/variants_to_parquet.py. Skipped when pyarrow is not installed.

Run: python3 -m unittest discover -s tests -v
"""
import gzip
import importlib.util
import tempfile
import unittest
from pathlib import Path

try:
    import pyarrow.parquet as pq
except ImportError:  # pyarrow is installed in CI and in the container that runs the step
    pq = None

ROOT = Path(__file__).resolve().parents[1]
HEADER = ("sample_id\toutcome\tchrom\tpos\tref\talt\tvariant_type\tqual\tfilter_status\tgenotype\t"
          "qd\tfs\tsor\tmq\tmq_rank_sum\tread_pos_rank_sum\tdp")
ROWS = [
    "t1\ttp\tchr22\t3857\tG\tGA\tnon_snp\t745.3\tPASS\t0/1\t15.1\t0.5\t0.7\t60\t\\N\t\\N\t30",
    "t1\tfn\tchr22\t5000\tA\tC\tsnp\t\\N\t\\N\t1/1\t\\N\t\\N\t\\N\t\\N\t\\N\t\\N\t\\N",
    "t1\tfp\tchr22\t6000\tG\tT,A\tnon_snp\t200\tPASS\t0/1\t9.9\t1.1\t1.2\t59\t-0.3\t0.2\t25",
]


def load():
    spec = importlib.util.spec_from_file_location("variants_to_parquet", ROOT / "bin" / "variants_to_parquet.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@unittest.skipIf(pq is None, "pyarrow not installed")
class VariantsToParquetTest(unittest.TestCase):
    def convert(self, lines):
        tmp = Path(tempfile.mkdtemp())
        source, destination = tmp / "v.tsv.gz", tmp / "v.parquet"
        with gzip.open(source, "wt") as handle:
            handle.write("\n".join(lines) + "\n")
        rows = load().convert(str(source), str(destination))
        return rows, pq.read_table(destination)

    def test_types_and_nulls(self):
        rows, table = self.convert([HEADER, *ROWS])
        self.assertEqual(rows, 3)
        self.assertEqual(str(table.schema.field("pos").type), "int64")
        self.assertEqual(str(table.schema.field("qual").type), "double")
        self.assertEqual(str(table.schema.field("dp").type), "int32")
        data = table.to_pydict()
        self.assertEqual(data["outcome"], ["tp", "fn", "fp"])
        self.assertEqual(data["qual"], [745.3, None, 200.0])          # \N becomes a real null
        self.assertEqual(data["filter_status"], ["PASS", None, "PASS"])
        self.assertEqual(data["mq_rank_sum"], [None, None, -0.3])
        self.assertEqual(data["dp"], [30, None, 25])
        self.assertEqual(data["alt"], ["GA", "C", "T,A"])             # multi-allelic stays as written

    def test_rejects_unexpected_header(self):
        with self.assertRaises(SystemExit):
            self.convert([HEADER.replace("outcome", "class"), *ROWS])


if __name__ == "__main__":
    unittest.main()
