nextflow.enable.types = true

// Turn vcfeval output into a schema-versioned metrics record (schemas/benchmark-metrics.v1.schema.json).
// The logic and its tests live in bin/benchmark_metrics.py; this step only passes in the run details.
// Render an optional command-line flag: omitted entirely when the value is empty.
def opt(flag: String, value: String) -> String {
    return value ? "${flag} '${value}'" : ''
}

process BENCHMARK_METRICS {
    input:
    tuple(sample: String, vcfeval_dir: Path)
    run_meta: Map<String,String>  // keys: run_type, pr_number, base_commit, run_name, session_id, started_at,
                    // repository, revision, head_commit, nextflow_version, truth_set, containers
    containers: Map<String,String>
    truth_vcf: String  // file names only, never S3 URIs (no bucket names in the record)
    truth_bed: String
    reference: String
    region: String
    analysis_params: Map<String,String>  // map of settings that can change the scores; hashed into the record

    output:
    tuple(sample, file("${sample}.metrics.json"))

    script:
    def analysis = analysis_params.keySet().collect { name -> "--param '${name}=${analysis_params[name]}'" }.join(' ')
    def container_args = containers.keySet().collect { name -> "--container '${name}=${containers[name]}'" }.join(' ')
    """
    benchmark_metrics.py \\
        --vcfeval-dir ${vcfeval_dir} --sample ${sample} --output ${sample}.metrics.json \\
        --run-type ${run_meta.run_type} ${opt('--pr-number', run_meta.pr_number)} ${opt('--base-commit', run_meta.base_commit)} \\
        ${opt('--run-name', run_meta.run_name)} ${opt('--session-id', run_meta.session_id)} ${opt('--started-at', run_meta.started_at)} \\
        ${opt('--repository', run_meta.repository)} ${opt('--revision', run_meta.revision)} ${opt('--head-commit', run_meta.head_commit)} \\
        ${opt('--nextflow-version', run_meta.nextflow_version)} ${opt('--truth-set', run_meta.truth_set)} \\
        --truth-vcf ${truth_vcf} --truth-bed ${truth_bed} --reference ${reference} ${opt('--region', region)} \\
        ${analysis} \\
        ${container_args}
    """
}

// Compare the metrics record with a committed baseline (benchmarks/*.json) and write gate.json:
// PASS, REGRESSED (a score fell by more than its tolerance) or INCOMPARABLE (different sample,
// truth set, region or reference). The result is data, so a regression still publishes it.
process BENCHMARK_GATE {
    input:
    tuple(sample: String, metrics_json: Path)
    baseline: Path

    output:
    tuple(sample, file("${sample}.gate.json"))

    script:
    """
    benchmark_gate.py --metrics ${metrics_json} --baseline ${baseline} --output ${sample}.gate.json
    """
}
