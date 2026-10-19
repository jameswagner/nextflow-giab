import * as cdk from 'aws-cdk-lib/core';
import * as batch from 'aws-cdk-lib/aws-batch';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
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

    // Public subnets only, no NAT gateway (saves ~$32/month). Compute gets public IPs
    // so it can reach the internet; the security group below blocks all inbound traffic.
    const vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [
        { name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24, mapPublicIpOnLaunch: true },
      ],
    });

    // No inbound rules; outbound is open (image pulls, S3).
    const computeSg = new ec2.SecurityGroup(this, 'ComputeSecurityGroup', {
      vpc,
      description: 'Batch compute: no inbound, all outbound',
      allowAllOutbound: true,
    });

    // Nextflow stages files with the AWS CLI, and biocontainers images don't ship one, so
    // install the CLI into a self-contained Miniconda on each instance. Nextflow mounts /opt/miniconda into every
    // task container (aws.batch.cliPath = /opt/miniconda/bin/aws). Conda carries its own
    // libraries (the standalone CLI v2 binary failed in containers: no libz.so.1).
    const cliUserData = ec2.UserData.forLinux();
    cliUserData.addCommands(
      'set -euo pipefail',
      'cd /tmp',
      'curl -sSfL https://repo.anaconda.com/miniconda/Miniconda3-latest-Linux-x86_64.sh -o miniconda.sh',
      'bash miniconda.sh -b -f -p /opt/miniconda',
      // pip, not conda install: conda's solver needs >3GB and was OOM-killed on a c5.large.
      '/opt/miniconda/bin/pip install --no-cache-dir awscli',
      '/opt/miniconda/bin/aws --version',
    );
    // Batch only accepts launch-template user data in MIME multipart format.
    const multipartUserData = new ec2.MultipartUserData();
    multipartUserData.addPart(ec2.MultipartBody.fromUserData(cliUserData));
    const launchTemplate = new ec2.LaunchTemplate(this, 'ComputeLaunchTemplate', {
      userData: multipartUserData,
    });

    // Spot (cheap, interruptible) x86 instances. Scales to zero when idle;
    // maxvCpus caps the worst-case bill.
    const computeEnv = new batch.ManagedEc2EcsComputeEnvironment(this, 'ComputeEnv', {
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      securityGroups: [computeSg],
      launchTemplate,
      spot: true,
      allocationStrategy: batch.AllocationStrategy.SPOT_PRICE_CAPACITY_OPTIMIZED,
      instanceClasses: [ec2.InstanceClass.M5, ec2.InstanceClass.C5, ec2.InstanceClass.R5],
      useOptimalInstanceClasses: false,
      minvCpus: 0,
      maxvCpus: 16,
    });

    // CDK points Batch at the template's $Default version, and CloudFormation adds new
    // versions without moving the default, so edits to the template would silently never
    // take effect. Pin to the latest version number instead.
    (computeEnv.node.defaultChild as batch.CfnComputeEnvironment).addPropertyOverride(
      'ComputeResources.LaunchTemplate.Version',
      launchTemplate.versionNumber,
    );

    const jobQueue = new batch.JobQueue(this, 'JobQueue', {
      computeEnvironments: [{ computeEnvironment: computeEnv, order: 1 }],
    });

    // Role the pipeline's containers run as. Nextflow's job definitions point at it
    // (aws.batch.jobRole), and it is what lets tasks read and write the bucket.
    const jobRole = new iam.Role(this, 'JobRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      description: 'Nextflow task containers: read/write the pipeline bucket',
    });
    bucket.grantReadWrite(jobRole);

    new cdk.CfnOutput(this, 'BucketName', { value: bucket.bucketName });
    new cdk.CfnOutput(this, 'JobQueueName', { value: jobQueue.jobQueueName });
    new cdk.CfnOutput(this, 'JobRoleArn', { value: jobRole.roleArn });
  }
}
