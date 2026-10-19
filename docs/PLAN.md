# Plan

Tick items off as they finish. Record decisions and surprises in the Notes section at the bottom.

- [x] Write docs/PLAN.md (CLAUDE.md dropped by choice)
- [ ] v0.1 housekeeping
  - [x] Move hardcoded paths to params; samplesheet CSV; `-profile test` (lint only, not run)
  - [x] Tidy the repo layout
  - [ ] README (what it does, how to run, toy-data caveat)
  - [x] .gitignore: work/, results/, .nextflow*, cdk.out, node_modules
  - [ ] Create public GitHub repo, push, tag v0.1 (user handles GitHub auth)
- [ ] CDK TypeScript, first slice
  - [x] `cdk init`, `cdk bootstrap`, S3 bucket (versioned, encrypted, blocked public access)
  - [x] Deploy and confirm the bucket exists
- [ ] Get the toy data into S3 (reference, FASTQs, dbSNP and Mills VCFs with .tbi).
      Either re-clone nf-core/test-datasets at commit 76179c1c8765b0233ba72d3fb82bc142f1d92b13
      (data/genomics/homo_sapiens only, via sparse checkout) or copy from the EC2 box.
- [ ] CDK, Batch slice
  - [ ] VPC choice: public subnets with public IPs for compute, to avoid the NAT gateway cost (decide and record below)
  - [ ] Batch Spot compute environment (x86), job queue, job role, instance role
  - [ ] S3 permissions for the job role
- [ ] Nextflow `awsbatch` profile (work dir in S3)
  - [ ] Smoke test one tiny step (faidx) on Batch first
  - [ ] Likely stretch point: Nextflow needs an AWS CLI on the compute host, and biocontainers images don't ship one (`aws.batch.cliPath` or a custom AMI). Find out on the smoke test and record the finding.
  - [ ] Full pipeline on Batch with the toy data
- [ ] CloudWatch: log retention, metric filter for GATK ERROR lines, alarm on failed jobs
- [ ] `cdk destroy` and redeploy test (proves the infra is reproducible)
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
