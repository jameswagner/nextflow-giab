import * as cdk from 'aws-cdk-lib/core';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

export class InfraStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // One bucket for pipeline inputs, results, and the Nextflow work directory.
    // No explicit name: CDK generates a unique one, so redeploys never collide.
    const bucket = new s3.Bucket(this, 'PipelineBucket', {
      versioned: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      // Demo project: `cdk destroy` should leave nothing behind.
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      lifecycleRules: [
        // Nextflow scratch files are disposable once a run is done.
        { prefix: 'work/', expiration: cdk.Duration.days(14) },
        { noncurrentVersionExpiration: cdk.Duration.days(7) },
        { abortIncompleteMultipartUploadAfter: cdk.Duration.days(1) },
      ],
    });

    new cdk.CfnOutput(this, 'BucketName', { value: bucket.bucketName });
  }
}
