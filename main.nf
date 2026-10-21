nextflow.enable.types = true

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

    // GATK hard filters (a record is filtered if the expression is true). Defaults are the
    // pipeline's standard thresholds; changing them is an experiment and is recorded in the benchmark.
    snp_filter:    String = 'QD < 2.0 || QUAL < 30.0 || SOR > 3.0 || FS > 60.0 || MQ < 40.0 || MQRankSum < -12.5 || ReadPosRankSum < -8.0'
    indel_filter:  String = 'QD < 2.0 || QUAL < 30.0 || FS > 200.0 || ReadPosRankSum < -20.0'

    // Recorded in the benchmark metrics; set by whatever starts the run (CLI, PR check, merge).
    run_type:      String = 'experiment'  // main | pr | experiment
    pr_number:     Integer?
    base_commit:   String?                // for PR runs, the commit being compared against
}

// The filter expressions end up inside a shell command, so allow only what a filter needs.
def checkFilter(name: String, expression: String) {
    if( !(expression ==~ /[A-Za-z0-9_ .<>=!&|()+\-]+/) )
        error "--${name} may only contain letters, digits, spaces and . < > = ! & | ( ) + - _ : got '${expression}'"
}

workflow {
    main:
    checkFilter('snp_filter', params.snp_filter)
    checkFilter('indel_filter', params.indel_filter)

    // --- inputs ---
    // One tuple per sample: (sample_id, [fastq_1, fastq_2]). Everything downstream
    // is keyed on sample_id, never on channel order.
    reads = channel.of(params.samplesheet)
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
    fai = SAMTOOLS_FAIDX(fasta)
    dict = GATK_DICT(fasta)

    // --- align ---
    bwa_index = BWAMEM2_INDEX(fasta)
    aligned = BWAMEM2_MEM(reads, bwa_index)
    sorted = SAMTOOLS_SORT(aligned)
    SAMTOOLS_FLAGSTAT(sorted)

    // --- clean up reads ---
    dedup = GATK_MARKDUPLICATES(sorted)
    recal = GATK_BASERECALIBRATOR(
        dedup.bam, fasta, fai, dict,
        dbsnp, dbsnp_i, mills, mills_i)
    recalibrated = GATK_APPLYBQSR(
        dedup.bam.join(recal, by: 'sample'),
        fasta, fai, dict)

    // --- call and filter variants ---
    gvcf = GATK_HAPLOTYPECALLER(recalibrated, fasta, fai, dict)
    raw = GATK_GENOTYPEGVCFS(gvcf, fasta, fai, dict)
    filtered = GATK_HARDFILTER(raw, fasta, fai, dict,
                    params.snp_filter, params.indel_filter)

    // --- score against a truth set, if one was given ---
    benchmark = channel.empty()
    if( params.truth_vcf ) {
        rtg_ref = RTG_FORMAT(fasta)
        evaluated = RTG_VCFEVAL(
            filtered, rtg_ref,
            params.truth_vcf, params.truth_vcf_tbi, params.truth_bed, params.eval_region)

        // Everything in the record's run details is passed as text.
        run_meta = [
            run_type: params.run_type,
            pr_number: params.pr_number ? "${params.pr_number}" : '',
            base_commit: params.base_commit ?: '',
            run_name: "${workflow.runName}", session_id: "${workflow.sessionId}", started_at: "${workflow.start}",
            repository: workflow.repository ?: '', revision: workflow.revision ?: '', head_commit: workflow.commitId ?: '',
            nextflow_version: "${nextflow.version}", truth_set: params.truth_set ?: ''
        ]
        container_map = workflow.container instanceof Map ? workflow.container : [:]
        metrics_json = BENCHMARK_METRICS(
            evaluated, run_meta, container_map,
            params.truth_vcf.name, params.truth_bed.name, params.fasta.name, params.eval_region,
            [eval_region: params.eval_region ?: '', snp_filter: params.snp_filter, indel_filter: params.indel_filter])
        benchmark = evaluated.mix(metrics_json)

        // A relative baseline path is relative to the pipeline's own checkout, not the launch directory.
        if( params.baseline ) {
            baseline_path = params.baseline.contains('://') || params.baseline.startsWith('/')
                ? params.baseline : "${projectDir}/${params.baseline}"
            gate = BENCHMARK_GATE(metrics_json, file(baseline_path, checkIfExists: true))
            benchmark = benchmark.mix(gate)
        }
    }

    publish:
    vcf       = filtered
    metrics   = dedup.metrics
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