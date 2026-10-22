import * as cdk from 'aws-cdk-lib/core';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import { Construct } from 'constructs';

export interface UploadTriggerProps {
  readonly bucket: s3.IBucket;
  readonly stateMachine: sfn.IStateMachine;
  /** Nextflow profile for triggered runs. */
  readonly profile?: string;
  /** Reference and known-sites inputs, as keys in the bucket, added to every triggered run. */
  readonly referenceArgs?: Record<string, string>;
}

// The chr20 reference and known sites that the HG002 benchmark uses (uploaded once, see benchmarks/hg002-chr20.args).
const CHR20_REFERENCE: Record<string, string> = {
  '--fasta': 'giab-hg002/ref/chr20.fasta',
  '--dbsnp': 'giab-hg002/known/dbsnp138.chr20.vcf.gz',
  '--dbsnp_tbi': 'giab-hg002/known/dbsnp138.chr20.vcf.gz.tbi',
  '--mills': 'giab-hg002/known/mills_1000G.chr20.vcf.gz',
  '--mills_tbi': 'giab-hg002/known/mills_1000G.chr20.vcf.gz.tbi',
};

/**
 * Uploading incoming/<sample>/samplesheet.csv starts a pipeline run for that sample.
 *
 * The samplesheet is the trigger, not the FASTQ files: a genome is many large multipart uploads that each
 * raise events, so the sheet is uploaded last and names the files (the pipeline checks they exist before it
 * starts). EventBridge cannot pick a sample name out of an object key, so the rule passes the key on and the
 * state machine's Start state derives the sample and the --samplesheet argument from it.
 *
 * A triggered run is variant calling only, with fixed pipeline revision, profile and reference files, so the
 * only thing an upload controls is the sheet. Anyone who can write under the prefix can start compute: keep
 * that to trusted principals. The compute environment's vCPU cap bounds what a flood of uploads could cost.
 */
export class UploadTrigger extends Construct {
  constructor(scope: Construct, id: string, props: UploadTriggerProps) {
    super(scope, id);
    const { bucket, stateMachine } = props;
    // The state machine takes the sample from the second part of this key, so the layout is fixed.
    const prefix = 'incoming/';

    // S3 sends its object events to EventBridge once this is on. Set on the L1 resource, because the L2 option
    // adds a Lambda-backed custom resource just to flip one setting.
    (bucket.node.defaultChild as s3.CfnBucket).notificationConfiguration = {
      eventBridgeConfiguration: { eventBridgeEnabled: true },
    };

    const reference = props.referenceArgs ?? CHR20_REFERENCE;
    const referenceArgs = Object.entries(reference).flatMap(([flag, key]) => [flag, `s3://${bucket.bucketName}/${key}`]);

    new events.Rule(this, 'SamplesheetUploaded', {
      description: `A samplesheet uploaded to s3://<bucket>/${prefix}<sample>/samplesheet.csv starts a pipeline run`,
      eventPattern: {
        source: ['aws.s3'],
        detailType: ['Object Created'],
        detail: {
          bucket: { name: [bucket.bucketName] },
          object: { key: [{ wildcard: `${prefix}*/samplesheet.csv` }] },
        },
      },
      targets: [new targets.SfnStateMachine(stateMachine, {
        input: events.RuleTargetInput.fromObject({
          samplesheet_key: events.EventField.fromPath('$.detail.object.key'),
          profile: props.profile ?? 'awsbatch,chr20',
          run_type: 'experiment',
          pipeline_args: referenceArgs,
        }),
      })],
    });

    new cdk.CfnOutput(this, 'UploadPrefix', { value: `s3://${bucket.bucketName}/${prefix}<sample>/samplesheet.csv` });
  }
}
