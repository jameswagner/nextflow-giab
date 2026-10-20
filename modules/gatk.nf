process GATK_DICT {
    input:
    path fasta

    output:
    path "${fasta.baseName}.dict"

    script:
    """
    gatk CreateSequenceDictionary -R ${fasta} -O ${fasta.baseName}.dict
    """
}

process GATK_MARKDUPLICATES {
    input:
    tuple val(sample), path(bam), path(bai)

    output:
    tuple val(sample), path("${sample}.md.bam"), path("${sample}.md.bai"), emit: bam
    path "${sample}.md.metrics.txt", emit: metrics

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
    tuple val(sample), path(bam), path(bai)
    path fasta
    path fai
    path dict
    path dbsnp
    path dbsnp_tbi
    path mills
    path mills_tbi

    output:
    tuple val(sample), path("${sample}.recal.table")

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
    tuple val(sample), path(bam), path(bai), path(table)
    path fasta
    path fai
    path dict

    output:
    tuple val(sample), path("${sample}.recal.bam"), path("${sample}.recal.bai")

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
    tuple val(sample), path(bam), path(bai)
    path fasta
    path fai
    path dict

    output:
    tuple val(sample), path("${sample}.g.vcf.gz"), path("${sample}.g.vcf.gz.tbi")

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
    tuple val(sample), path(gvcf), path(gvcf_tbi)
    path fasta
    path fai
    path dict

    output:
    tuple val(sample), path("${sample}.vcf.gz"), path("${sample}.vcf.gz.tbi")

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
    tuple val(sample), path(vcf), path(tbi)
    path fasta
    path fai
    path dict

    output:
    tuple val(sample), path("${sample}.filtered.vcf.gz"), path("${sample}.filtered.vcf.gz.tbi")

    script:
    """
    gatk SelectVariants -R ${fasta} -V ${vcf} --select-type-to-include SNP -O snps.vcf.gz
    gatk VariantFiltration -R ${fasta} -V snps.vcf.gz -O snps.filtered.vcf.gz \\
        --filter-name "snp_hard" \\
        --filter-expression "QD < 2.0 || QUAL < 30.0 || SOR > 3.0 || FS > 60.0 || MQ < 40.0 || MQRankSum < -12.5 || ReadPosRankSum < -8.0"

    gatk SelectVariants -R ${fasta} -V ${vcf} --select-type-to-include INDEL -O indels.vcf.gz
    gatk VariantFiltration -R ${fasta} -V indels.vcf.gz -O indels.filtered.vcf.gz \\
        --filter-name "indel_hard" \\
        --filter-expression "QD < 2.0 || QUAL < 30.0 || FS > 200.0 || ReadPosRankSum < -20.0"

    gatk MergeVcfs -I snps.filtered.vcf.gz -I indels.filtered.vcf.gz -O ${sample}.filtered.vcf.gz
    """
}
