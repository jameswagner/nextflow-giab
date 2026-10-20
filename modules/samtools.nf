process SAMTOOLS_FAIDX {
    input:
    path fasta

    output:
    path "${fasta}.fai"

    script:
    "samtools faidx ${fasta}"
}

process SAMTOOLS_SORT {
    input:
    tuple val(sample), path(sam)

    output:
    tuple val(sample), path("${sample}.sorted.bam"), path("${sample}.sorted.bam.bai")

    script:
    """
    samtools sort -@ ${task.cpus} -o ${sample}.sorted.bam ${sam}
    samtools index ${sample}.sorted.bam
    """
}

process SAMTOOLS_FLAGSTAT {
    input:
    tuple val(sample), path(bam), path(bai)

    output:
    stdout

    script:
    "samtools flagstat ${bam}"
}
