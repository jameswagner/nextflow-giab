#!/usr/bin/env python3
"""Convert the variant table written by the EXPORT_VARIANTS step (gzipped TSV, \\N for a missing value)
into one Parquet file, with typed columns so Athena can filter and aggregate without casting.

Usage: variants_to_parquet.py VARIANTS.tsv.gz OUTPUT.parquet
"""
import sys

import pyarrow as pa
import pyarrow.csv as pcsv
import pyarrow.parquet as pq

# Column order and meaning match the header written by modules/variants.nf.
COLUMNS = [
    ("sample_id", pa.string()),
    ("outcome", pa.string()),            # tp, fp, fn or outside
    ("chrom", pa.string()),
    ("pos", pa.int64()),
    ("ref", pa.string()),
    ("alt", pa.string()),
    ("variant_type", pa.string()),       # snp or non_snp
    ("qual", pa.float64()),
    ("filter_status", pa.string()),
    ("genotype", pa.string()),
    ("qd", pa.float64()),
    ("fs", pa.float64()),
    ("sor", pa.float64()),
    ("mq", pa.float64()),
    ("mq_rank_sum", pa.float64()),
    ("read_pos_rank_sum", pa.float64()),
    ("dp", pa.int32()),
]


def convert(source, destination):
    table = pcsv.read_csv(
        source,
        parse_options=pcsv.ParseOptions(delimiter="\t", quote_char=False),
        convert_options=pcsv.ConvertOptions(
            column_types=dict(COLUMNS), null_values=["\\N"], strings_can_be_null=True),
    )
    if table.column_names != [name for name, _ in COLUMNS]:
        raise SystemExit(f"unexpected columns in {source}: {table.column_names}")
    pq.write_table(table, destination, compression="zstd")
    return table.num_rows


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit(__doc__)
    print(f"{convert(sys.argv[1], sys.argv[2])} rows -> {sys.argv[2]}")
