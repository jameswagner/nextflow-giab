nextflow.enable.types = true

process GATK_DICT {
    input:
    fasta: Path

    output:
    file("${fasta.baseName}.dict")

    script:
    """
    gatk CreateSequenceDictionary -R ${fasta} -O ${fasta.baseName}.dict
    """
}

process GATK_MARKDUPLICATES {
    input:
    tuple(sample: String, bam: Path, bai: Path)

    output:
    bam = record(sample: sample, bam: file("${sample}.md.bam"), bai: file("${sample}.md.bai"))
    metrics = file("${sample}.md.metrics.txt")

    script:
    """
    gatk MarkDuplicates \\
        -I ${bam} \\
        -O ${sample}.md.bam \\
        -M ${sample}.md.metrics.txt \\
        --CREATE_INDEX true
    """
}

process GATK_BASERECALIBRATOR {
    input:
    record(sample: String, bam: Path, bai: Path)
    fasta: Path
    fai: Path
    dict: Path
    dbsnp: Path
    dbsnp_tbi: Path
    mills: Path
    mills_tbi: Path

    output:
    record(sample: sample, table: file("${sample}.recal.table"))

    script:
    """
    gatk BaseRecalibrator \\
        -I ${bam} \\
        -R ${fasta} \\
        --known-sites ${dbsnp} \\
        --known-sites ${mills} \\
        -O ${sample}.recal.table
    """
}

process GATK_APPLYBQSR {
    input:
    record(sample: String, bam: Path, bai: Path, table: Path)
    fasta: Path
    fai: Path
    dict: Path

    output:
    tuple(sample, file("${sample}.recal.bam"), file("${sample}.recal.bai"))

    script:
    """
    gatk ApplyBQSR \\
        -I ${bam} \\
        -R ${fasta} \\
        --bqsr-recal-file ${table} \\
        -O ${sample}.recal.bam
    """
}

process GATK_HAPLOTYPECALLER {
    input:
    tuple(sample: String, bam: Path, bai: Path)
    fasta: Path
    fai: Path
    dict: Path

    output:
    tuple(sample, file("${sample}.g.vcf.gz"), file("${sample}.g.vcf.gz.tbi"))

    script:
    """
    gatk HaplotypeCaller \\
        -R ${fasta} \\
        -I ${bam} \\
        -O ${sample}.g.vcf.gz \\
        -ERC GVCF
    """
}

process GATK_GENOTYPEGVCFS {
    input:
    tuple(sample: String, gvcf: Path, gvcf_tbi: Path)
    fasta: Path
    fai: Path
    dict: Path

    output:
    tuple(sample, file("${sample}.vcf.gz"), file("${sample}.vcf.gz.tbi"))

    script:
    """
    gatk GenotypeGVCFs \\
        -R ${fasta} \\
        -V ${gvcf} \\
        -O ${sample}.vcf.gz
    """
}

process GATK_HARDFILTER {
    input:
    tuple(sample: String, vcf: Path, tbi: Path)
    fasta: Path
    fai: Path
    dict: Path
    snp_filter: String  // GATK filter expressions; validated in main.nf (safe characters only)
    indel_filter: String

    output:
    tuple(sample, file("${sample}.filtered.vcf.gz"), file("${sample}.filtered.vcf.gz.tbi"))

    script:
    """
    gatk SelectVariants -R ${fasta} -V ${vcf} --select-type-to-include SNP -O snps.vcf.gz
    gatk VariantFiltration -R ${fasta} -V snps.vcf.gz -O snps.filtered.vcf.gz \\
        --filter-name "snp_hard" \\
        --filter-expression "${snp_filter}"

    gatk SelectVariants -R ${fasta} -V ${vcf} --select-type-to-include INDEL -O indels.vcf.gz
    gatk VariantFiltration -R ${fasta} -V indels.vcf.gz -O indels.filtered.vcf.gz \\
        --filter-name "indel_hard" \\
        --filter-expression "${indel_filter}"

    gatk MergeVcfs -I snps.filtered.vcf.gz -I indels.filtered.vcf.gz -O ${sample}.filtered.vcf.gz
    """
}
