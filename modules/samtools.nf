process SAMTOOLS_FAIDX {
    container 'quay.io/biocontainers/samtools:1.24--h9dcdb79_1'

    input:
    path fasta

    output:
    path "${fasta}.fai"

    script:
    "samtools faidx ${fasta}"
}

process SAMTOOLS_SORT {
    container 'quay.io/biocontainers/samtools:1.24--h9dcdb79_1'

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
    container 'quay.io/biocontainers/samtools:1.24--h9dcdb79_1'

    input:
    tuple val(sample), path(bam), path(bai)

    output:
    stdout

    script:
    "samtools flagstat ${bam}"
}
