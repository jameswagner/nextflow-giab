# nextflow-giab

A germline short-variant pipeline (SNVs and small indels) in Nextflow DSL2, with the AWS Batch infrastructure to run it defined in CDK (TypeScript).

**Pipeline** (`main.nf`, `modules/`): `bwa-mem2` alignment → `samtools` sort and flagstat → GATK MarkDuplicates → BQSR → HaplotypeCaller (GVCF) → GenotypeGVCFs → hard filtering (SNPs and indels separately). Inputs are a samplesheet CSV (`sample_id,fastq_1,fastq_2`) plus a GRCh38 reference and dbSNP and Mills known-sites VCFs. Outputs are a filtered VCF and MarkDuplicates metrics.

**Infrastructure** (`infra/`): an S3 bucket (inputs, work dir, results), a VPC with public subnets and no NAT gateway, a Batch Spot compute environment (scales to zero, capped at 16 vCPUs), and CloudWatch logs with alarms on error lines and failed jobs.

## Run on AWS Batch

```bash
cd infra && npm install
npx cdk bootstrap --qualifier giab --toolkit-stack-name CDKToolkit-giab   # once per account and region; matches infra/cdk.json
npx cdk deploy                     # add -c alertEmail=<address> for alarm emails

# Stack outputs: BucketName, JobQueueName, JobRoleArn
export JAVA_HOME=/opt/homebrew/opt/openjdk@21
export GIAB_BATCH_QUEUE=<JobQueueName> GIAB_JOB_ROLE=<JobRoleArn>

nextflow run main.nf -profile awsbatch \
  -work-dir s3://<BucketName>/work -output-dir s3://<BucketName>/results \
  --samplesheet <samplesheet.csv> --fasta s3://.../genome.fasta \
  --dbsnp ... --dbsnp_tbi ... --mills ... --mills_tbi ...
```

Nothing account-specific is committed; the queue, role and bucket come from the stack outputs. `smoke/faidx.nf` is a one-step Batch smoke test, and `smoke/fail.nf` fails on purpose to check the alarms. `cdk destroy` removes everything, including the bucket contents.

## Toy data caveat

The test data (nf-core/test-datasets, commit `76179c1`, `data/genomics/homo_sapiens`) is a 40 kb slice of chr22, and only about 2% of its reads align to it. The pipeline runs end to end on it, but the final VCF has no records, so it shows the plumbing works, not that the variant calls are good. Accuracy against the GIAB truth set is the next step; see `docs/PLAN.md`.
