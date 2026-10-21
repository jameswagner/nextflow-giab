nextflow.enable.types = true

// Steps for preparing one GIAB sample as pipeline input (see prep/giab_sample.nf). All run in the
// samtools image; the names start with PREP_ so conf/containers.config picks it.

// Slice one chromosome out of a remote, indexed BAM. samtools finds <url>.bai on its own and fetches
// only the parts of the file that hold that chromosome.
process PREP_SLICE_BAM {
    input:
    sample: String
    bam_url: String
    region: String

    output:
    tuple(sample, file("${sample}.${region}.bam"))

    script:
    """
    samtools view -b -h -o ${sample}.${region}.bam '${bam_url}' ${region}
    """
}

// Keep a random fraction of the read pairs so the mean depth is about target_depth. The seed makes the
// choice repeatable. A BAM already at or below the target is passed through unchanged.
process PREP_DOWNSAMPLE {
    input:
    tuple(sample: String, bam: Path)
    region: String
    target_depth: Integer
    seed: Integer

    output:
    tuple(sample, file("${sample}.${target_depth}x.bam"))

    script:
    """
    samtools index ${bam}
    depth=\$(samtools coverage -r ${region} ${bam} | awk 'NR == 2 { print \$7 }')
    if awk -v d="\$depth" -v t=${target_depth} 'BEGIN { exit !(d > t) }'; then
        frac=\$(awk -v d="\$depth" -v t=${target_depth} 'BEGIN { printf "%.3f", t / d }' | sed 's/^0//')
        echo "mean depth \$depth, keeping fraction \$frac for about ${target_depth}x"
        samtools view -b -s ${seed}\$frac -o ${sample}.${target_depth}x.bam ${bam}
    else
        echo "mean depth \$depth is already at or below ${target_depth}x, keeping every read"
        cp ${bam} ${sample}.${target_depth}x.bam
    fi
    """
}

// Back to raw paired reads: the pipeline does its own alignment, so the original aligner's work is dropped.
process PREP_FASTQ {
    input:
    tuple(sample: String, bam: Path)
    region: String
    target_depth: Integer

    output:
    tuple(sample, file("${sample}.${region}.${target_depth}x_R1.fastq.gz"), file("${sample}.${region}.${target_depth}x_R2.fastq.gz"))

    script:
    """
    samtools collate -u -O ${bam} collate.tmp \\
        | samtools fastq -n \\
            -1 ${sample}.${region}.${target_depth}x_R1.fastq.gz \\
            -2 ${sample}.${region}.${target_depth}x_R2.fastq.gz \\
            -0 /dev/null -s /dev/null -
    """
}

// The sample's GIAB v4.2.1 truth set: variants, their index and the high-confidence regions.
process PREP_TRUTH {
    input:
    sample: String
    truth_url: String

    output:
    record(
        vcf: file("${sample}_GRCh38_1_22_v4.2.1_benchmark.vcf.gz"),
        tbi: file("${sample}_GRCh38_1_22_v4.2.1_benchmark.vcf.gz.tbi"),
        bed: file("${sample}_GRCh38_1_22_v4.2.1_benchmark_noinconsistent.bed")
    )

    script:
    """
    for f in ${sample}_GRCh38_1_22_v4.2.1_benchmark.vcf.gz \\
             ${sample}_GRCh38_1_22_v4.2.1_benchmark.vcf.gz.tbi \\
             ${sample}_GRCh38_1_22_v4.2.1_benchmark_noinconsistent.bed; do
        wget -q -O "\$f" "${truth_url}/\$f"
    done
    """
}

// The samplesheet the main pipeline reads, pointing at where the reads will be published.
process PREP_SAMPLESHEET {
    input:
    tuple(sample: String, r1: Path, r2: Path)
    dest: String

    output:
    file("samplesheet.csv")

    script:
    """
    printf 'sample_id,fastq_1,fastq_2\\n${sample},${dest}/reads/${r1.name},${dest}/reads/${r2.name}\\n' > samplesheet.csv
    """
}
