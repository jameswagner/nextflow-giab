import * as cdk from 'aws-cdk-lib/core';
import * as athena from 'aws-cdk-lib/aws-athena';
import * as glue from 'aws-cdk-lib/aws-glue';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

const DATABASE = 'giab';
const TABLE = 'variants';
const WORKGROUP = 'giab';
const RESULTS_PREFIX = 'athena-results/';

// One row per variant, written by the pipeline's EXPORT_VARIANTS and CONVERT_VARIANTS_PARQUET steps
// (modules/variants.nf, bin/variants_to_parquet.py). Keep this list in step with COLUMNS in that script.
const COLUMNS: { name: string; type: string; comment: string }[] = [
  { name: 'sample_id', type: 'string', comment: 'Sample name from the samplesheet' },
  { name: 'outcome', type: 'string', comment: 'tp (matches the truth set), fp (not in it), fn (truth variant missed) or outside (call outside the scored regions)' },
  { name: 'chrom', type: 'string', comment: 'Chromosome' },
  { name: 'pos', type: 'bigint', comment: '1-based position' },
  { name: 'ref', type: 'string', comment: 'Reference allele' },
  { name: 'alt', type: 'string', comment: 'Alternate allele(s), comma separated' },
  { name: 'variant_type', type: 'string', comment: 'snp, or non_snp for indels and everything else' },
  { name: 'qual', type: 'double', comment: 'Call quality (null for fn)' },
  { name: 'filter_status', type: 'string', comment: 'PASS or the filter that failed (null for fn)' },
  { name: 'genotype', type: 'string', comment: 'Genotype, e.g. 0/1' },
  { name: 'qd', type: 'double', comment: 'GATK QualByDepth' },
  { name: 'fs', type: 'double', comment: 'GATK FisherStrand' },
  { name: 'sor', type: 'double', comment: 'GATK StrandOddsRatio' },
  { name: 'mq', type: 'double', comment: 'GATK RMSMappingQuality' },
  { name: 'mq_rank_sum', type: 'double', comment: 'GATK MappingQualityRankSum' },
  { name: 'read_pos_rank_sum', type: 'double', comment: 'GATK ReadPosRankSum' },
  { name: 'dp', type: 'int', comment: 'Read depth' },
];

export interface VariantAnalyticsProps {
  readonly bucket: s3.IBucket;
}

/**
 * SQL over every variant a run called, in Athena: a Glue database and table over the Parquet files at
 * runs/<run_id>/variants/, a workgroup that caps what a query may scan and keeps results in this bucket, a few
 * saved queries, and a policy that grants exactly what querying needs (attached to nobody; give it to whoever
 * should query, for example an Identity Center permission set).
 *
 * The table reads each run's folder through partition projection on run_id, so there is no crawler and no
 * partition to register. run_id is an "injected" projection: a query has to say which runs it means
 * (WHERE run_id = '...' or run_id IN (...)).
 */
export class VariantAnalytics extends Construct {
  readonly workGroupName = WORKGROUP;
  readonly queryPolicy: iam.ManagedPolicy;

  constructor(scope: Construct, id: string, props: VariantAnalyticsProps) {
    super(scope, id);
    const stack = cdk.Stack.of(this);
    const bucket = props.bucket;
    const catalogId = stack.account;

    const database = new glue.CfnDatabase(this, 'Database', {
      catalogId,
      databaseInput: { name: DATABASE, description: 'nextflow-giab benchmark data' },
    });

    const table = new glue.CfnTable(this, 'VariantsTable', {
      catalogId,
      databaseName: DATABASE,
      tableInput: {
        name: TABLE,
        description: 'Every call and every missed truth variant of a run, labelled by how it scored',
        tableType: 'EXTERNAL_TABLE',
        parameters: {
          'EXTERNAL': 'TRUE',
          'classification': 'parquet',
          'projection.enabled': 'true',
          'projection.run_id.type': 'injected',
          'storage.location.template': `s3://${bucket.bucketName}/runs/\${run_id}/variants`,
        },
        partitionKeys: [{ name: 'run_id', type: 'string', comment: 'The run that produced these rows' }],
        storageDescriptor: {
          columns: COLUMNS,
          location: `s3://${bucket.bucketName}/runs/`,
          inputFormat: 'org.apache.hadoop.hive.ql.io.parquet.MapredParquetInputFormat',
          outputFormat: 'org.apache.hadoop.hive.ql.io.parquet.MapredParquetOutputFormat',
          serdeInfo: { serializationLibrary: 'org.apache.hadoop.hive.ql.io.parquet.serde.ParquetHiveSerDe' },
        },
      },
    });
    table.addDependency(database);

    const workGroup = new athena.CfnWorkGroup(this, 'WorkGroup', {
      name: WORKGROUP,
      description: 'Queries over nextflow-giab results; each query may scan at most 1 GiB',
      state: 'ENABLED',
      recursiveDeleteOption: true, // demo project: `cdk destroy` removes it with its query history
      workGroupConfiguration: {
        enforceWorkGroupConfiguration: true, // a query cannot choose its own result location or settings
        publishCloudWatchMetricsEnabled: true,
        bytesScannedCutoffPerQuery: 1024 * 1024 * 1024,
        engineVersion: { selectedEngineVersion: 'Athena engine version 3' },
        resultConfiguration: {
          outputLocation: `s3://${bucket.bucketName}/${RESULTS_PREFIX}`,
          encryptionConfiguration: { encryptionOption: 'SSE_S3' },
        },
      },
    });

    // Saved queries. Replace RUN_ID with a run id from the dashboard or the run records.
    const saved: { id: string; name: string; description: string; sql: string }[] = [
      {
        id: 'OutcomeCounts',
        name: 'giab: outcome counts for a run',
        description: 'True positives, false positives and missed variants by SNP / non-SNP. These must equal the counts in the run\'s metrics.json.',
        sql: `SELECT outcome, variant_type, count(*) AS variants\nFROM ${DATABASE}.${TABLE}\nWHERE run_id = 'RUN_ID'\nGROUP BY outcome, variant_type\nORDER BY outcome, variant_type;`,
      },
      {
        id: 'MissedByRegion',
        name: 'giab: where a run misses variants',
        description: 'False negatives per megabase, worst first.',
        sql: `SELECT chrom, pos / 1000000 AS megabase, variant_type, count(*) AS missed\nFROM ${DATABASE}.${TABLE}\nWHERE run_id = 'RUN_ID' AND outcome = 'fn'\nGROUP BY chrom, pos / 1000000, variant_type\nORDER BY missed DESC\nLIMIT 25;`,
      },
      {
        id: 'FilterTradeoff',
        name: 'giab: what a stricter QD cutoff would do',
        description: 'False positives a cutoff on QD would remove and true calls it would lose, per variant type. Change 4.0 to try another cutoff.',
        sql: `SELECT variant_type,\n  count_if(outcome = 'fp' AND qd < 4.0) AS false_positives_removed,\n  count_if(outcome = 'tp' AND qd < 4.0) AS true_calls_lost\nFROM ${DATABASE}.${TABLE}\nWHERE run_id = 'RUN_ID' AND outcome IN ('tp', 'fp')\nGROUP BY variant_type;`,
      },
    ];
    for (const query of saved) {
      const named = new athena.CfnNamedQuery(this, query.id, {
        name: query.name,
        description: query.description,
        database: DATABASE,
        workGroup: WORKGROUP,
        queryString: query.sql,
      });
      named.addDependency(workGroup);
      named.addDependency(table);
    }

    // What a person needs to run those queries and nothing more. Not attached to any principal.
    const workGroupArn = `arn:${stack.partition}:athena:${stack.region}:${stack.account}:workgroup/${WORKGROUP}`;
    const glueArn = (resource: string) => `arn:${stack.partition}:glue:${stack.region}:${stack.account}:${resource}`;
    this.queryPolicy = new iam.ManagedPolicy(this, 'QueryPolicy', {
      description: 'Run saved or ad hoc queries in the giab Athena workgroup over the variants table',
      statements: [
        new iam.PolicyStatement({
          actions: ['athena:StartQueryExecution', 'athena:StopQueryExecution', 'athena:GetQueryExecution',
            'athena:GetQueryResults', 'athena:GetWorkGroup', 'athena:GetNamedQuery', 'athena:ListNamedQueries'],
          resources: [workGroupArn],
        }),
        new iam.PolicyStatement({
          actions: ['glue:GetDatabase', 'glue:GetTable', 'glue:GetPartition', 'glue:GetPartitions'],
          resources: [glueArn('catalog'), glueArn(`database/${DATABASE}`), glueArn(`table/${DATABASE}/${TABLE}`)],
        }),
        new iam.PolicyStatement({
          actions: ['s3:GetObject'],
          resources: [bucket.arnForObjects('runs/*/variants/*')],
        }),
        new iam.PolicyStatement({
          actions: ['s3:GetObject', 's3:PutObject', 's3:AbortMultipartUpload'],
          resources: [bucket.arnForObjects(`${RESULTS_PREFIX}*`)],
        }),
        new iam.PolicyStatement({
          actions: ['s3:ListBucket', 's3:GetBucketLocation'],
          resources: [bucket.bucketArn],
        }),
      ],
    });

    new cdk.CfnOutput(this, 'AthenaWorkGroup', { value: WORKGROUP });
    new cdk.CfnOutput(this, 'VariantQueryPolicyArn', { value: this.queryPolicy.managedPolicyArn });
  }
}
