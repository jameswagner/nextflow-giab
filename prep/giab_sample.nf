nextflow.enable.types = true

// Prepare one GIAB sample as input for the main pipeline: slice a chromosome from GIAB's public 2x250
// Illumina BAM, downsample to a target depth, convert to FASTQ, fetch the v4.2.1 truth set and write a
// samplesheet. Run it with scripts/prepare-giab-sample.sh, which fills in the paths and the bucket.
include { PREP_SLICE_BAM; PREP_DOWNSAMPLE; PREP_FASTQ; PREP_TRUTH; PREP_SAMPLESHEET } from '../modules/prep.nf'

params {
    sample:       String            // e.g. HG003
    giab_path:    String            // family and folder on the GIAB FTP, e.g. AshkenazimTrio/HG003_NA24149_father
    dest:         String            // where the outputs are published, as a URI; written into the samplesheet
    region:       String  = 'chr20'
    target_depth: Integer = 30
    seed:         Integer = 42
}

workflow {
    main:
    giab = 'https://ftp-trace.ncbi.nlm.nih.gov/ReferenceSamples/giab'
    bam_url = "${giab}/data/${params.giab_path}/NIST_Illumina_2x250bps/novoalign_bams/${params.sample}.GRCh38.2x250.bam"
    truth_url = "${giab}/release/${params.giab_path}/NISTv4.2.1/GRCh38"

    sliced = PREP_SLICE_BAM(params.sample, bam_url, params.region)
    downsampled = PREP_DOWNSAMPLE(sliced, params.region, params.target_depth, params.seed)
    reads = PREP_FASTQ(downsampled, params.region, params.target_depth)
    truth = PREP_TRUTH(params.sample, truth_url)
    samplesheet = PREP_SAMPLESHEET(reads, params.dest)

    publish:
    reads_out       = reads
    truth_out       = truth
    samplesheet_out = samplesheet
}

output {
    reads_out {
        path 'reads'
    }
    truth_out {
        path 'truth'
    }
    samplesheet_out {
        path '.'
    }
}
