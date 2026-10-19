# Plan

Tick items off as they finish. Record decisions and surprises in the Notes section at the bottom.

- [x] Write docs/PLAN.md (CLAUDE.md dropped by choice)
- [ ] v0.1 housekeeping
  - [x] Move hardcoded paths to params; samplesheet CSV; `-profile test` (lint only, not run)
  - [x] Tidy the repo layout
  - [x] README (what it does, how to run, toy-data caveat)
  - [x] .gitignore: work/, results/, .nextflow*, cdk.out, node_modules
  - [ ] Create public GitHub repo, push, tag v0.1 (user handles GitHub auth)
- [ ] CDK TypeScript, first slice
  - [x] `cdk init`, `cdk bootstrap`, S3 bucket (versioned, encrypted, blocked public access)
  - [x] Deploy and confirm the bucket exists
- [x] Get the toy data into S3 (reference, FASTQs, dbSNP and Mills VCFs with .tbi).
      Either re-clone nf-core/test-datasets at commit 76179c1c8765b0233ba72d3fb82bc142f1d92b13
      (data/genomics/homo_sapiens only, via sparse checkout) or copy from the EC2 box.
- [ ] CDK, Batch slice
  - [x] VPC choice: public subnets with public IPs for compute, to avoid the NAT gateway cost (decide and record below)
  - [x] Batch Spot compute environment (x86), job queue, job role, instance role
  - [x] S3 permissions for the job role
- [x] Nextflow `awsbatch` profile (work dir in S3)
  - [x] Smoke test one tiny step (faidx) on Batch first
  - [x] Likely stretch point: Nextflow needs an AWS CLI on the compute host, and biocontainers images don't ship one (`aws.batch.cliPath` or a custom AMI). Find out on the smoke test and record the finding.
  - [x] Full pipeline on Batch with the toy data
- [x] CloudWatch: log retention, metric filter for GATK ERROR lines, alarm on failed jobs
- [x] `cdk destroy` and redeploy test (proves the infra is reproducible)
- [ ] Validation on real data
  - [ ] chr20 reference and reads, GIAB truth VCF + high-confidence BED
  - [ ] hap.py precision/recall, metrics.json
  - [ ] Optional: VEP/ClinVar/gnomAD annotation, labeled a research demo
- [ ] README final pass, architecture diagram, demo video (3-5 min)

## Parking lot (not now)

S3 Files vs EBS comparison, Athena over results, a small web UI, Firehose, HealthOmics as a managed alternative.

## Notes (decisions and surprises)

- Repo lives at `~/Projects/nextflow-giab` (renamed from `variant-pipeline`). Git history was reset to a clean initial commit. Layout: `main.nf`, `modules/` (by tool), `conf/`, `assets/`, later `infra/` for CDK.
- Toy-data work is done as far as local effort goes: params, samplesheet and `-profile test` are written and lint-clean, but not yet run end to end after the refactor. Verify on the first Batch run.
- CDK bootstrap: us-east-1 already had a shared `CDKToolkit` stack from older projects (qualifier `newstack`), so this project has its own: qualifier `giab`, stack `CDKToolkit-giab`, both set in `infra/cdk.json`. Do not re-bootstrap with the default qualifier. S3 bucket deployed (InfraStack); name is a stack output, not recorded here.
- Toy data is in the bucket under `test-data/` (7 files, ~33 MB: genome.fasta, dbsnp and Mills VCFs + .tbi, test_1/test_2 FASTQ), same layout as `params.test_data` expects. Source: sparse checkout of nf-core/test-datasets at 76179c1; the EC2 box is deleted, so re-clone if needed (the full homo_sapiens dir is 2.5 GB, only these files are needed).
- VPC decision: public subnets with public IPs for Batch compute, no NAT gateway (saves ~$32/month plus data fees). Security groups allow no inbound traffic; outbound only.
- Batch deployed: Spot x86 (m5/c5/r5), 0 to 16 vCPUs, public subnets, no NAT. Job role is read/write on the pipeline bucket only. Queue name, job role ARN and bucket come from the stack outputs (`aws cloudformation describe-stacks --stack-name InfraStack`) and are passed to Nextflow via `GIAB_BATCH_QUEUE`, `GIAB_JOB_ROLE` and `-work-dir`, never committed. `infra/cdk.context.json` is gitignored because its keys contain the account ID.
- Smoke test finding (faidx on Batch) PASSED after 4 launch-template cycles; chr22 .fai landed in the S3 work dir. What it took, in order:
  1. Biocontainers have no AWS CLI and the ECS host has none where Nextflow looks (`aws: command not found`).
  2. Standalone AWS CLI v2 on the host failed inside the container: `libz.so.1` missing. Use a conda/pip CLI inside a self-contained Miniconda instead.
  3. CDK points Batch at the launch template's `$Default` version, and CloudFormation adds new versions without moving the default, so edits silently never applied. Fixed by pinning the compute environment to `launchTemplate.versionNumber` (property override in `infra/lib/infra-stack.ts`).
  4. `conda install awscli` was OOM-killed on a c5.large (4 GB RAM) during boot. Use `pip install awscli` into Miniconda at `/opt/miniconda`; `aws.batch.cliPath = '/opt/miniconda/bin/aws'`.
  Debugging tip: `aws ec2 get-console-output --instance-id <id> --latest` shows the user-data/cloud-init log, even after the instance is gone. Nextflow docs now recommend Wave + Fusion instead of the CLI; not adopted, a possible later comparison.
- To consider after full-pipeline run: `aws.batch.maxTransferAttempts = 3`, `maxParallelTransfers`, `aws.client.maxConnections`, and `volumes = ['/var/lib/docker:/tmp:rw']` for GATK temp space (Fred Hutch config).
- Full toy pipeline PASSED on Batch first try (12/12 steps, ~3 min compute, pennies). Outputs in `s3://<bucket>/results/` (filtered VCF + .tbi, MarkDuplicates metrics). Modules declare no resources, so `conf/awsbatch.config` sets `process.cpus = 2`, `process.memory = '6 GB'` for the toy run; revisit for real data.
- Toy-data caveat: the final VCF has 0 records. Only 1.9% of reads (10,125 of 533,554) align to the 40 kb chr22 toy reference; HaplotypeCaller wrote a GVCF (4,477 records) but GenotypeGVCFs found no variant sites. Consistent with thin data, not a bug. Unknown whether the old EC2 run produced variants. Variant-calling quality is for the chr20 + GIAB validation stage. Put this caveat in the README.
- CloudWatch deployed and tested: CDK-owned log group `/giab/batch-jobs` (30-day retention; Nextflow uses it via `aws.batch.logsGroup`) instead of Batch's auto-created, never-expiring `/aws/batch/job`, which CDK can't own and which is shared with any other Batch project in the account. Metric filter counts `ERROR`/`Exception` lines (`GiabPipeline/ErrorLines`); `FailedJobAlarm` watches Batch's native `AWS/Batch` `JobsMovedToFailed` metric for this queue (no charge). Healthy toy run: 0 matching lines, both alarms OK. `smoke/fail.nf` (always-failing job) tripped both alarms in about 4 minutes. SNS topic has no subscribers; add email with `cdk deploy -c alertEmail=<address>` (never in the repo).
- `cdk destroy` and redeploy test passed: destroy took ~2.5 min (bucket and its 283 objects included, nothing left behind), redeploy ~3 min (34 resources), toy data re-uploaded, then the full toy pipeline passed 12/12 with logs in the new log group and both alarms OK. No manual fixes needed. Resource names change on every rebuild, so always read them from the stack outputs.
