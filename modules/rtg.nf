process RTG_FORMAT {
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

    """
}
