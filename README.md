# nextflow-giab

A germline short-variant pipeline (SNVs and small indels) in Nextflow DSL2, with the AWS Batch infrastructure to run it defined in CDK (TypeScript).

**Pipeline** (`main.nf`, `modules/`): `bwa-mem2` alignment → `samtools` sort and flagstat → GATK MarkDuplicates → BQSR → HaplotypeCaller (GVCF) → GenotypeGVCFs → hard filtering (SNPs and indels separately). Inputs are a samplesheet CSV (`sample_id,fastq_1,fastq_2`) plus a GRCh38 reference and dbSNP and Mills known-sites VCFs. Outputs are a filtered VCF and MarkDuplicates metrics, plus a vcfeval score if a truth set is given.

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

### Or start it from the CLI, with Nextflow running on AWS too

`scripts/run-on-aws.sh` submits a Batch (Fargate) job that runs Nextflow itself, so your machine is not involved once it is submitted:

```bash
scripts/run-on-aws.sh -n my-run -p awsbatch -- --samplesheet s3://<BucketName>/samplesheet.csv --fasta s3://... --dbsnp ...
```

Inputs must be S3 paths. `-r` picks the branch or tag of this repo to run, and the log goes to the `/giab/batch-jobs` log group.

### Recorded runs

`scripts/start-run.sh` starts the same thing through a Step Functions state machine that also keeps a run record in DynamoDB: it records the run as `RUNNING`, runs the launcher job and waits, reads the benchmark metrics if the run had a truth set, records `SUCCEEDED` or `FAILED` with the headline scores, and publishes to the alert topic. Results go to `s3://<BucketName>/runs/<run id>/`.

```bash
scripts/start-run.sh -s HG002 -r main -p awsbatch,chr20 -- --samplesheet s3://... --truth_vcf s3://... ...
```

### From GitHub

GitHub Actions reach AWS through OIDC roles (no stored keys), each trusted only for one GitHub environment of this repository:

- **Benchmark a pull request** (`benchmark-pr.yml`, started by hand with the PR number): runs the PR's head commit through the HG002 chr20 benchmark and posts the scores and gate result on the PR. Pull requests from forks are refused.
- **Benchmark (main)**: records an official benchmark for each pipeline change merged to `main`.
- **Deploy infrastructure**: deploys `InfraStack` when `infra/` changes on `main`, after a person approves it in the `production` environment.

The roles live in a separate `GithubIdentityStack`, deployed by hand, so a workflow can never change its own permissions. `scripts/run-benchmark.sh` runs the same benchmark from a terminal (`-r <revision> -w`), or reports on a past run (`-R <run id>`).

Nothing account-specific is committed; the queue, role and bucket come from the stack outputs. `smoke/faidx.nf` is a one-step Batch smoke test, and `smoke/fail.nf` fails on purpose to check the alarms. `cdk destroy` removes everything, including the bucket contents.

## Validation: GIAB HG002, chr20

Scored with RTG `vcfeval` against the GIAB v4.2.1 truth set for HG002 (GRCh38), inside its high-confidence regions. The reads are chr20 only, downsampled to about 30x from GIAB's 2x250 Illumina data, and the whole run took 57 minutes on Batch.

| | Precision | Recall | F1 |
|---|---|---|---|
| SNPs | 0.994 | 0.986 | 0.990 |
| Indels and other non-SNPs | 0.967 | 0.907 | 0.936 |
| All | 0.990 | 0.975 | 0.983 |

This is one sample and one chromosome, scored with the conservative `_noinconsistent` BED, so it is a sanity check and not a validation. The library was designed for assembly (overlapping 2x250 reads), vcfeval skipped at least one region as too complex, and about 27% of calls fall outside the high-confidence regions and are not scored. The hard filters are parameters (`--snp_filter` and `--indel_filter`, GATK filter expressions; a record is filtered if the expression is true), defaulting to the standard thresholds in `main.nf`. Changing them is an experiment: the values are recorded in the benchmark's `params` and change its `params_hash`. Only letters, digits, spaces and `. < > = ! & | ( ) + - _` are accepted, because the expressions end up in a shell command. To score a run, pass `--truth_vcf`, `--truth_vcf_tbi`, `--truth_bed` and `--eval_region` (optionally `--truth_set` as a label). vcfeval's own files land in `benchmark/<sample>.vcfeval/`, and `benchmark/<sample>.metrics.json` holds the scores plus provenance (pipeline commit, run type, containers, truth set, parameters and their hash) in the format defined by `schemas/benchmark-metrics.v1.schema.json`. The generator is `bin/benchmark_metrics.py`; its tests run with `python3 -m unittest discover -s tests`. To also check a run against expected scores, pass `--baseline benchmarks/hg002-chr20.json`: `benchmark/<sample>.gate.json` then says `PASS`, `REGRESSED` (a score fell by more than the baseline's tolerance, currently 0.002) or `INCOMPARABLE` (different sample, truth set, region or reference). Scores may rise freely, and a run never changes the baseline; updating it is a reviewed edit to that file. All container images are pinned in `conf/containers.config`.

The default test data (nf-core/test-datasets, commit `76179c1`) is a 40 kb slice of chr22 and only about 2% of its reads align, so it gives an empty VCF; it checks the plumbing, not accuracy.
