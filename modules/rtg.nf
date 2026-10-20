process RTG_FORMAT {
    container 'quay.io/biocontainers/rtg-tools:3.13--hdfd78af_0'

    input:
    path fasta

    output:
    path "ref.sdf"

    script:
    "rtg format -o ref.sdf ${fasta}"
}

// Score a filtered VCF against a truth set inside its high-confidence regions.
// Records failing FILTER are excluded by vcfeval by default, which is what we want here.
process RTG_VCFEVAL {
    container 'quay.io/biocontainers/rtg-tools:3.13--hdfd78af_0'

    input:
    tuple val(sample), path(vcf), path(vcf_tbi)
    path sdf
    path truth_vcf
    path truth_vcf_tbi
    path truth_bed
    val region

    output:
    tuple val(sample), path("${sample}.vcfeval")

    script:
    """
    rtg vcfeval \\
        -b ${truth_vcf} -c ${vcf} -t ${sdf} \\
        -e ${truth_bed} --region=${region} \\
        -o ${sample}.vcfeval

    # Roll the summary and the per-type ROC files up into one metrics.json. The last ROC row
    # has every call included, and the last summary row ("None") is the all-calls total.
    d=${sample}.vcfeval
    roc() { gzip -dc "\$1" | grep -v '^#' | tail -1 | awk '{printf "%d %d %d %d %s %s %s", \$2, \$4, \$3, \$5, \$6, \$7, \$8}'; }
    all=\$(grep -v -e '^Threshold' -e '^-' \$d/summary.txt | tail -1 | awk '{printf "%d %d %d %d %s %s %s", \$2, \$3, \$4, \$5, \$6, \$7, \$8}')
    metric() { set -- \$1; printf '{"true_positives_baseline": %s, "true_positives_call": %s, "false_positives": %s, "false_negatives": %s, "precision": %s, "recall": %s, "f1": %s}' "\$1" "\$2" "\$3" "\$4" "\$5" "\$6" "\$7"; }
    {
        printf '{"sample": "%s", "truth_vcf": "%s", "region": "%s", ' "${sample}" "${truth_vcf}" "${region}"
        printf '"snp": %s, "non_snp": %s, "all": %s}' "\$(metric "\$(roc \$d/snp_roc.tsv.gz)")" "\$(metric "\$(roc \$d/non_snp_roc.tsv.gz)")" "\$(metric "\$all")"
        echo
    } > \$d/metrics.json
    """
}
