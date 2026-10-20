include { SAMTOOLS_FAIDX; SAMTOOLS_SORT; SAMTOOLS_FLAGSTAT } from './modules/samtools.nf'
include { BWAMEM2_INDEX; BWAMEM2_MEM } from './modules/bwamem2.nf'
include { RTG_FORMAT; RTG_VCFEVAL } from './modules/rtg.nf'
include { BENCHMARK_METRICS; BENCHMARK_GATE } from './modules/benchmark.nf'
include { GATK_DICT; GATK_MARKDUPLICATES; GATK_BASERECALIBRATOR; GATK_APPLYBQSR;
          GATK_HAPLOTYPECALLER; GATK_GENOTYPEGVCFS; GATK_HARDFILTER } from './modules/gatk.nf'

params {
    samplesheet: Path   // CSV: sample_id,fastq_1,fastq_2
    fasta:       Path   // GRCh38 reference
    dbsnp:       Path
    dbsnp_tbi:   Path
    mills:       Path
    mills_tbi:   Path

    // Optional: score the calls against a truth set (e.g. GIAB). Give all four to enable.
    truth_vcf:     Path?
    truth_vcf_tbi: Path?
    truth_bed:     Path?   // high-confidence regions
    eval_region:   String? // e.g. chr20
    truth_set:     String? // label for the record, e.g. 'GIAB HG002 NISTv4.2.1 GRCh38'
    baseline:      String? // optional: committed baseline to gate against, e.g. benchmarks/hg002-chr20.json

    // Recorded in the benchmark metrics; set by whatever starts the run (CLI, PR check, merge).
    run_type:      String = 'experiment'  // main | pr | experiment
    pr_number:     Integer?
    base_commit:   String?                // for PR runs, the commit being compared against
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

    // --- score against a truth set, if one was given ---
    benchmark = channel.empty()
    if( params.truth_vcf ) {
        RTG_FORMAT(fasta)
        RTG_VCFEVAL(
            GATK_HARDFILTER.out, RTG_FORMAT.out,
            params.truth_vcf, params.truth_vcf_tbi, params.truth_bed, params.eval_region)

        run_meta = [
            run_type: params.run_type, pr_number: params.pr_number, base_commit: params.base_commit,
            run_name: workflow.runName, session_id: workflow.sessionId, started_at: workflow.start,
            repository: workflow.repository, revision: workflow.revision, head_commit: workflow.commitId,
            nextflow_version: nextflow.version, truth_set: params.truth_set,
            containers: workflow.container instanceof Map ? workflow.container : [:]
        ]
        BENCHMARK_METRICS(
            RTG_VCFEVAL.out, run_meta,
            params.truth_vcf.name, params.truth_bed.name, params.fasta.name, params.eval_region)
        benchmark = RTG_VCFEVAL.out.mix(BENCHMARK_METRICS.out)

        // A relative baseline path is relative to the pipeline's own checkout, not the launch directory.
        if( params.baseline ) {
            baseline_path = params.baseline.contains('://') || params.baseline.startsWith('/')
                ? params.baseline : "${projectDir}/${params.baseline}"
            BENCHMARK_GATE(BENCHMARK_METRICS.out, file(baseline_path, checkIfExists: true))
            benchmark = benchmark.mix(BENCHMARK_GATE.out)
        }
    }

    publish:
    vcf       = GATK_HARDFILTER.out
    metrics   = GATK_MARKDUPLICATES.out.metrics
    benchmark = benchmark
}

output {
    vcf {
        path 'vcf'
    }
    metrics {
        path 'qc'
    }
    benchmark {
        path 'benchmark'
    }
}