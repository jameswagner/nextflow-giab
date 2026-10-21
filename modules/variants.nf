nextflow.enable.types = true

// One table of every variant, labelled by how it scored, for querying with SQL (Athena).
//   tp       calls that match the truth set          (vcfeval tp.vcf.gz)
//   fp       calls the truth set does not have        (vcfeval fp.vcf.gz)
//   fn       truth variants the calls missed          (vcfeval fn.vcf.gz; only position and alleles are known)
//   outside  calls outside the truth set's high-confidence regions, which vcfeval does not score
// Output is a gzipped TSV with a header row. Missing values are \N, which Athena reads as NULL.
process EXPORT_VARIANTS {
    input:
    record(sample: String, vcfeval: Path, vcf: Path, tbi: Path)
    truth_bed: Path

    output:
    file("${sample}.variants.tsv.gz")

    script:
    // The shell variables are escaped (\$) so Nextflow leaves them for the shell.
    """
    # type: snp when the reference and every alternate allele are one base, otherwise non_snp
    classify='
      BEGIN { FS = OFS = "\\t" }
      {
        n = split(\$4, alt, ",")
        type = (length(\$3) == 1) ? "snp" : "non_snp"
        for (i = 1; i <= n; i++) if (length(alt[i]) != 1) type = "non_snp"
        for (i = 5; i <= NF; i++) if (\$i == ".") \$i = "\\\\N"
        print sample, class, \$1, \$2, \$3, \$4, type, \$5, \$6, \$7, \$8, \$9, \$10, \$11, \$12, \$13, \$14
      }'
    calls='%CHROM\\t%POS\\t%REF\\t%ALT\\t%QUAL\\t%FILTER\\t[%GT]\\t%INFO/QD\\t%INFO/FS\\t%INFO/SOR\\t%INFO/MQ\\t%INFO/MQRankSum\\t%INFO/ReadPosRankSum\\t%INFO/DP\\n'
    truth='%CHROM\\t%POS\\t%REF\\t%ALT\\t.\\t.\\t[%GT]\\t.\\t.\\t.\\t.\\t.\\t.\\t.\\n'

    {
      printf 'sample\\tclass\\tchrom\\tpos\\tref\\talt\\ttype\\tqual\\tfilter\\tgenotype\\tqd\\tfs\\tsor\\tmq\\tmqranksum\\treadposranksum\\tdp\\n'
      bcftools query -f "\$calls" ${vcfeval}/tp.vcf.gz | awk -v sample=${sample} -v class=tp "\$classify"
      bcftools query -f "\$calls" ${vcfeval}/fp.vcf.gz | awk -v sample=${sample} -v class=fp "\$classify"
      bcftools query -f "\$truth" ${vcfeval}/fn.vcf.gz | awk -v sample=${sample} -v class=fn "\$classify"
      bcftools view -f PASS -T ^${truth_bed} ${vcf} | bcftools query -f "\$calls" | awk -v sample=${sample} -v class=outside "\$classify"
    } | gzip > ${sample}.variants.tsv.gz
    """
}
