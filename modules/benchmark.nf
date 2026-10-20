// Turn vcfeval output into a schema-versioned metrics record (schemas/benchmark-metrics.v1.schema.json).
// The logic and its tests live in bin/benchmark_metrics.py; this step only passes in the run details.
// Render an optional command-line flag: omitted entirely when the value is empty.
def opt(String flag, value) {
    return value ? "${flag} '${value}'" : ''
}

process BENCHMARK_METRICS {
    input:
    tuple val(sample), path(vcfeval_dir)
    val run_meta    // map: run_type, pr_number, base_commit, run_name, session_id, started_at,
                    // repository, revision, head_commit, nextflow_version, truth_set, containers
    val truth_vcf   // file names only, never S3 URIs (no bucket names in the record)
    val truth_bed
    val reference
    val region

    output:
    tuple val(sample), path("${sample}.metrics.json")

    script:
    def containers = run_meta.containers.collect { name, image -> "--container '${name}=${image}'" }.join(' ')
    """
    benchmark_metrics.py \\
        --vcfeval-dir ${vcfeval_dir} --sample ${sample} --output ${sample}.metrics.json \\
        --run-type ${run_meta.run_type} ${opt('--pr-number', run_meta.pr_number)} ${opt('--base-commit', run_meta.base_commit)} \\
        ${opt('--run-name', run_meta.run_name)} ${opt('--session-id', run_meta.session_id)} ${opt('--started-at', run_meta.started_at)} \\
        ${opt('--repository', run_meta.repository)} ${opt('--revision', run_meta.revision)} ${opt('--head-commit', run_meta.head_commit)} \\
        ${opt('--nextflow-version', run_meta.nextflow_version)} ${opt('--truth-set', run_meta.truth_set)} \\
        --truth-vcf ${truth_vcf} --truth-bed ${truth_bed} --reference ${reference} ${opt('--region', region)} \\
        --param eval_region=${region ?: ''} \\
        ${containers}
    """
}

// Compare the metrics record with a committed baseline (benchmarks/*.json) and write gate.json:
// PASS, REGRESSED (a score fell by more than its tolerance) or INCOMPARABLE (different sample,
// truth set, region or reference). The result is data, so a regression still publishes it.
process BENCHMARK_GATE {
    input:
    tuple val(sample), path(metrics_json)
    path baseline

    output:
    tuple val(sample), path("${sample}.gate.json")

    script:
    """
    benchmark_gate.py --metrics ${metrics_json} --baseline ${baseline} --output ${sample}.gate.json
    """
}
