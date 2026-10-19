// Smallest possible Batch test: index the reference with samtools faidx and nothing else.
include { SAMTOOLS_FAIDX } from '../modules/samtools.nf'

params {
    fasta: Path
}

workflow {
    main:
    SAMTOOLS_FAIDX(params.fasta)
}
