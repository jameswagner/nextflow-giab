nextflow.enable.types = true

// One table of every variant, for querying with SQL (Athena). Each row has an outcome:
//   tp       calls that match the truth set          (vcfeval tp.vcf.gz)
//   fp       calls the truth set does not have        (vcfeval fp.vcf.gz)
//   fn       truth variants the calls missed          (vcfeval fn.vcf.gz; only position and alleles are known)
//   outside  calls outside the truth set's high-confidence regions, which vcfeval does not score
//   called   a call from a sample with no truth set, so nothing to score it against
// Output is a gzipped TSV with a header row; missing values are \N. CONVERT_VARIANTS_PARQUET turns it into Parquet.

// The columns, shared by both exports. Keep in step with COLUMNS in bin/variants_to_parquet.py.
def tableHeader() -> String {
    return 'sample_id\\toutcome\\tchrom\\tpos\\tref\\talt\\tvariant_type\\tqual\\tfilter_status\\tgenotype\\tqd\\tfs\\tsor\\tmq\\tmq_rank_sum\\tread_pos_rank_sum\\tdp\\n'
}

// bcftools query format for a call: position, alleles, quality, filter, genotype and the GATK annotations.
def callsFormat() -> String {
    return '%CHROM\\t%POS\\t%REF\\t%ALT\\t%QUAL\\t%FILTER\\t[%GT]\\t%INFO/QD\\t%INFO/FS\\t%INFO/SOR\\t%INFO/MQ\\t%INFO/MQRankSum\\t%INFO/ReadPosRankSum\\t%INFO/DP\\n'
}

// The awk program that turns a query line into a table row. variant_type is snp when the reference is one base
// and every alternate allele is a single A, C, G or T; anything else (indels, MNPs, the * spanning-deletion
// allele) is non_snp, which is how vcfeval splits its scores.
def classifyAwk() -> String {
    return '''
      BEGIN { FS = OFS = "\\t" }
      {
        n = split($4, alt, ",")
        type = (length($3) == 1) ? "snp" : "non_snp"
        for (i = 1; i <= n; i++) if (alt[i] !~ /^[ACGTacgt]$/) type = "non_snp"
        for (i = 5; i <= NF; i++) if ($i == ".") $i = "\\\\N"
        print sample, class, $1, $2, $3, $4, type, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14
      }'''
}

process EXPORT_VARIANTS {
    input:
    record(sample: String, vcfeval: Path, vcf: Path, tbi: Path)
    truth_bed: Path

    output:
    tuple(sample, file("${sample}.variants.tsv.gz"))

    script:
    """
    classify='${classifyAwk()}'
    truth='%CHROM\\t%POS\\t%REF\\t%ALT\\t.\\t.\\t[%GT]\\t.\\t.\\t.\\t.\\t.\\t.\\t.\\n'

    {
      printf '${tableHeader()}'
      bcftools query -f '${callsFormat()}' ${vcfeval}/tp.vcf.gz | awk -v sample=${sample} -v class=tp "\$classify"
      bcftools query -f '${callsFormat()}' ${vcfeval}/fp.vcf.gz | awk -v sample=${sample} -v class=fp "\$classify"
      bcftools query -f "\$truth" ${vcfeval}/fn.vcf.gz | awk -v sample=${sample} -v class=fn "\$classify"
      bcftools view -f PASS -T ^${truth_bed} ${vcf} | bcftools query -f '${callsFormat()}' | awk -v sample=${sample} -v class=outside "\$classify"
    } | gzip > ${sample}.variants.tsv.gz
    """
}

// The same table for a sample with no truth set: every PASS call, labelled "called".
process EXPORT_CALLED_VARIANTS {
    input:
    tuple(sample: String, vcf: Path, tbi: Path)

    output:
    tuple(sample, file("${sample}.variants.tsv.gz"))

    script:
    """
    classify='${classifyAwk()}'

    {
      printf '${tableHeader()}'
      bcftools view -f PASS ${vcf} | bcftools query -f '${callsFormat()}' | awk -v sample=${sample} -v class=called "\$classify"
    } | gzip > ${sample}.variants.tsv.gz
    """
}

// The table as Parquet: typed columns and real nulls, which is what Athena reads.
process CONVERT_VARIANTS_PARQUET {
    input:
    tuple(sample: String, table: Path)

    output:
    file("${sample}.variants.parquet")

    script:
    "variants_to_parquet.py ${table} ${sample}.variants.parquet"
}
