include { SAMTOOLS_FAIDX; SAMTOOLS_SORT; SAMTOOLS_FLAGSTAT } from './modules/samtools.nf'
include { BWAMEM2_INDEX; BWAMEM2_MEM } from './modules/bwamem2.nf'
include { GATK_DICT; GATK_MARKDUPLICATES; GATK_BASERECALIBRATOR; GATK_APPLYBQSR;
          GATK_HAPLOTYPECALLER; GATK_GENOTYPEGVCFS; GATK_HARDFILTER } from './modules/gatk.nf'

params {
    samplesheet: Path   // CSV: sample_id,fastq_1,fastq_2
    fasta:       Path   // GRCh38 reference
    dbsnp:       Path
    dbsnp_tbi:   Path
    mills:       Path
    mills_tbi:   Path
}

workflow {
    main:

    // --- inputs ---
    // One tuple per sample: (sample_id, [fastq_1, fastq_2]). Everything downstream
    // is keyed on sample_id, never on channel order.
    reads = channel.fromPath(params.samplesheet)
        .splitCsv(header: true)
        .map { row ->
            tuple(row.sample_id, [
                file(row.fastq_1, checkIfExists: true),
                file(row.fastq_2, checkIfExists: true)
            ])
        }

    // Reference files are plain values, so they are shared by every sample.
    fasta   = params.fasta
    dbsnp   = params.dbsnp
    dbsnp_i = params.dbsnp_tbi
    mills   = params.mills
    mills_i = params.mills_tbi

    // --- reference prep ---
    SAMTOOLS_FAIDX(fasta)
    GATK_DICT(fasta)
    BWAMEM2_INDEX(fasta)

    // --- align ---
    BWAMEM2_MEM(reads, BWAMEM2_INDEX.out)
    SAMTOOLS_SORT(BWAMEM2_MEM.out)
    SAMTOOLS_FLAGSTAT(SAMTOOLS_SORT.out)

    // --- clean up reads ---
    GATK_MARKDUPLICATES(SAMTOOLS_SORT.out)
    GATK_BASERECALIBRATOR(
        GATK_MARKDUPLICATES.out.bam, fasta, SAMTOOLS_FAIDX.out, GATK_DICT.out,
        dbsnp, dbsnp_i, mills, mills_i)
    GATK_APPLYBQSR(
        GATK_MARKDUPLICATES.out.bam.join(GATK_BASERECALIBRATOR.out),
        fasta, SAMTOOLS_FAIDX.out, GATK_DICT.out)

    // --- call and filter variants ---
    GATK_HAPLOTYPECALLER(GATK_APPLYBQSR.out, fasta, SAMTOOLS_FAIDX.out, GATK_DICT.out)
    GATK_GENOTYPEGVCFS(GATK_HAPLOTYPECALLER.out, fasta, SAMTOOLS_FAIDX.out, GATK_DICT.out)
    GATK_HARDFILTER(GATK_GENOTYPEGVCFS.out, fasta, SAMTOOLS_FAIDX.out, GATK_DICT.out)

    publish:
    vcf     = GATK_HARDFILTER.out
    metrics = GATK_MARKDUPLICATES.out.metrics
}

output {
    vcf {
        path 'vcf'
    }
    metrics {
        path 'qc'
    }
}