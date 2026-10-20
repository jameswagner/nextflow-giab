process BWAMEM2_INDEX {
    input:
    path fasta

    output:
    path "bwamem2_index"

    script:
    """
    mkdir -p bwamem2_index
    bwa-mem2 index -p bwamem2_index/ref ${fasta}
    """
}

process BWAMEM2_MEM {
    input:
    tuple val(sample), path(reads)
    path index

    output:
    tuple val(sample), path("${sample}.sam")

    script:
    """
    bwa-mem2 mem -t ${task.cpus} \\
        -R '@RG\\tID:${sample}\\tSM:${sample}\\tPL:ILLUMINA' \\
        ${index}/ref ${reads} > ${sample}.sam
    """
}
