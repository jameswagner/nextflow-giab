include { SAMTOOLS_FAIDX; SAMTOOLS_SORT; SAMTOOLS_FLAGSTAT } from './modules/samtools.nf'
include { BWAMEM2_INDEX; BWAMEM2_MEM } from './modules/bwamem2.nf'
include { GATK_DICT; GATK_MARKDUPLICATES; GATK_BASERECALIBRATOR; GATK_APPLYBQSR;
          GATK_HAPLOTYPECALLER; GATK_GENOTYPEGVCFS; GATK_HARDFILTER } from './modules/gatk.nf'

workflow {
    main:

    // --- inputs ---
    fasta = channel.fromPath('/home/ec2-user/test-datasets/data/genomics/homo_sapiens/genome/genome.fasta')

    reads = channel.of([
        'test',
        [
            file('/home/ec2-user/test-datasets/data/genomics/homo_sapiens/illumina/fastq/test_1.fastq.gz'),
            file('/home/ec2-user/test-datasets/data/genomics/homo_sapiens/illumina/fastq/test_2.fastq.gz')
        ]
    ])

    vcf_dir = '/home/ec2-user/test-datasets/data/genomics/homo_sapiens/genome/vcf'
    dbsnp   = channel.fromPath("${vcf_dir}/dbsnp_146.hg38.vcf.gz")
    dbsnp_i = channel.fromPath("${vcf_dir}/dbsnp_146.hg38.vcf.gz.tbi")
    mills   = channel.fromPath("${vcf_dir}/mills_and_1000G.indels.vcf.gz")
    mills_i = channel.fromPath("${vcf_dir}/mills_and_1000G.indels.vcf.gz.tbi")

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