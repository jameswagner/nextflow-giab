nextflow.enable.types = true

process SAMTOOLS_FAIDX {
    input:
    fasta: Path

    output:
    file("${fasta}.fai")

    script:
    "samtools faidx ${fasta}"
}

process SAMTOOLS_SORT {
    input:
    tuple(sample: String, sam: Path)

    output:
    tuple(sample, file("${sample}.sorted.bam"), file("${sample}.sorted.bam.bai"))

    script:
    """
    samtools sort -@ ${task.cpus} -o ${sample}.sorted.bam ${sam}
    samtools index ${sample}.sorted.bam
    """
}

process SAMTOOLS_FLAGSTAT {
    input:
    tuple(sample: String, bam: Path, bai: Path)

    output:
    stdout()

    script:
    "samtools flagstat ${bam}"
}
