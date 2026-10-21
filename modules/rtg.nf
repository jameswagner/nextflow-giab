nextflow.enable.types = true

process RTG_FORMAT {
    input:
    fasta: Path

    output:
    file("ref.sdf")

    script:
    "rtg format -o ref.sdf ${fasta}"
}

// Score a filtered VCF against a truth set inside its high-confidence regions.
// Records failing FILTER are excluded by vcfeval by default, which is what we want here.
process RTG_VCFEVAL {
    input:
    tuple(sample: String, vcf: Path, vcf_tbi: Path)
    sdf: Path
    truth_vcf: Path
    truth_vcf_tbi: Path
    truth_bed: Path
    region: String

    output:
    tuple(sample, file("${sample}.vcfeval"))

    script:
    """
    rtg vcfeval \\
        -b ${truth_vcf} -c ${vcf} -t ${sdf} \\
        -e ${truth_bed} --region=${region} \\
        -o ${sample}.vcfeval

    """
}
