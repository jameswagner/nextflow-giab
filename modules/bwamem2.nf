nextflow.enable.types = true

process BWAMEM2_INDEX {
    input:
    fasta: Path

    output:
    file("bwamem2_index")

    script:
    """
    mkdir -p bwamem2_index
    bwa-mem2 index -p bwamem2_index/ref ${fasta}
    """
}

process BWAMEM2_MEM {
    input:
    tuple(sample: String, reads: List<Path>)
    index: Path

    output:
    tuple(sample, file("${sample}.sam"))

    script:
    """
    bwa-mem2 mem -t ${task.cpus} \\
        -R '@RG\\tID:${sample}\\tSM:${sample}\\tPL:ILLUMINA' \\
        ${index}/ref ${reads.join(" ")} > ${sample}.sam
    """
}
