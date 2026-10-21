import * as cdk from 'aws-cdk-lib/core';
import { NagSuppressions } from 'cdk-nag';

/**
 * Every cdk-nag finding that is deliberately not fixed, each with the reason. Findings are matched by rule
 * and, for the IAM wildcard rule, by the exact action or resource pattern, so a new wildcard is a new
 * finding that has to be justified here, not silently covered. Patterns are regexes so that no account id
 * or generated name appears in the repository.
 */

const S3_GRANT_ACTIONS = ['Action::s3:Abort*', 'Action::s3:DeleteObject*', 'Action::s3:GetBucket*',
  'Action::s3:GetObject*', 'Action::s3:List*'];

export function suppressInfraStack(stack: cdk.Stack): void {
  const at = (path: string) => `/${stack.node.id}/${path}`;

  NagSuppressions.addResourceSuppressionsByPath(stack, at('PipelineBucket/Resource'), [{
    id: 'AwsSolutions-S1',
    reason: 'Server access logs need a second bucket to store them. The bucket holds public reference data ' +
      '(GIAB HG002) and pipeline outputs, is private, TLS-only and versioned, and every pipeline action is ' +
      'already recorded in run records and CloudWatch logs. Access logging (and CloudTrail data events) ' +
      'would be required before handling non-public data.',
  }]);

  NagSuppressions.addResourceSuppressionsByPath(stack, at('ComputeEnv/InstanceProfileRole/Resource'), [{
    id: 'AwsSolutions-IAM4',
    reason: 'AmazonEC2ContainerServiceforEC2Role is the AWS-managed policy that ECS container instances ' +
      'need to register with the cluster, pull images and write logs. AWS maintains it, and Batch workers ' +
      'cannot run without these permissions; a copy would have to track every change AWS makes to it.',
    appliesTo: [{ regex: '/^Policy::arn:.*:iam::aws:policy\\/service-role\\/AmazonEC2ContainerServiceforEC2Role$/' }],
  }]);

  const bucketObjects = { regex: '/^Resource::<PipelineBucket[A-Z0-9]+\\.Arn>\\/.*\\*$/' };

  NagSuppressions.addResourceSuppressionsByPath(stack, at('JobRole/DefaultPolicy/Resource'), [{
    id: 'AwsSolutions-IAM5',
    reason: 'Pipeline task containers: the Action wildcards are the standard S3 read grant (Get*/List*) and the ' +
      'put/delete grant that CDK generates for a bucket. Scope is one bucket: read everywhere in it, ' +
      'write and delete only under the work/ prefix (so a task cannot overwrite the reference, the truth set or ' +
      'published results). Object keys are not known in advance, so the resource has to be a prefix wildcard.',
    appliesTo: [...S3_GRANT_ACTIONS, bucketObjects],
  }]);

  NagSuppressions.addResourceSuppressionsByPath(stack, at('LauncherRole/DefaultPolicy/Resource'), [
    {
      id: 'AwsSolutions-IAM5',
      reason: 'Nextflow launcher, S3: the standard CDK read grant on the pipeline bucket, plus write under ' +
        'work/, runs/ and results/ and delete under work/ only. Object keys are not known in advance.',
      appliesTo: [...S3_GRANT_ACTIONS, bucketObjects],
    },
    {
      id: 'AwsSolutions-IAM5',
      reason: 'Nextflow registers one Batch job definition per container image under names starting "nf-", ' +
        'so submitting, tagging, registering (limited to allowed images) and deregistering are scoped to ' +
        'that name prefix. The revision number is part of the ARN and changes on every registration.',
      appliesTo: [{ regex: '/^Resource::arn:.*:job-definition\\/nf-\\*$/' }],
    },
    {
      id: 'AwsSolutions-IAM5',
      reason: 'DescribeJobs, ListJobs, DescribeJobDefinitions, DescribeJobQueues and DescribeComputeEnvironments ' +
        'are read-only and IAM does not support resource-level permissions for them. KNOWN GAP: the same ' +
        'statement allows TerminateJob on any job in the account, which Nextflow needs to stop its own ' +
        'worker jobs when a run is cancelled; narrowing it needs the worker jobs to be tagged and a cancel ' +
        'test, and is tracked as a follow-up.',
      appliesTo: ['Resource::*'],
    },
  ]);

  NagSuppressions.addResourceSuppressionsByPath(stack, at('Orchestration/RunStateMachine/Role/DefaultPolicy/Resource'), [
    {
      id: 'AwsSolutions-IAM5',
      reason: 'The state machine reads only the benchmark outputs of runs (runs/<id>/benchmark/...), whose ' +
        'run ids are not known in advance, so the resource is the runs/ prefix.',
      appliesTo: [{ regex: '/^Resource::<PipelineBucket[A-Z0-9]+\\.Arn>\\/runs\\/\\*$/' }],
    },
    {
      id: 'AwsSolutions-IAM5',
      reason: 'TerminateJob and TagResource on Batch jobs are limited by a condition to jobs carrying the tag ' +
        'project=nextflow-giab, so the state machine cannot touch other Batch jobs. Job ids are generated ' +
        'at submission, hence the job/* resource.',
      appliesTo: [{ regex: '/^Resource::arn:.*:batch:.*:job\\/\\*$/' }],
    },
    {
      id: 'AwsSolutions-IAM5',
      reason: 'SubmitJob and the tag-on-submit check name the launcher job definition without a revision, ' +
        'because the revision number is part of the ARN and changes each time the definition is updated. ' +
        'The wildcard is only that revision suffix of one specific job definition.',
      appliesTo: [{ regex: '/^Resource::arn:.*:batch:.*:job-definition\\/.*\\*$/' }],
    },
    {
      id: 'AwsSolutions-IAM5',
      reason: 'batch:DescribeJobs, CloudWatch Logs log delivery and X-Ray tracing do not support resource-level ' +
        'permissions in IAM, so AWS requires "*". All are read-only or write-only telemetry.',
      appliesTo: ['Resource::*'],
    },
  ]);

  NagSuppressions.addResourceSuppressionsByPath(stack, at('Orchestration/RecordCloser/Role/DefaultPolicy/Resource'), [{
    id: 'AwsSolutions-IAM5',
    reason: 'CloudWatch Logs log delivery and X-Ray tracing do not support resource-level permissions in IAM, so ' +
      'AWS requires "*"; the role is otherwise limited to one table and its run-id index.',
    appliesTo: ['Resource::*'],
  }]);
}

export function suppressIdentityStack(stack: cdk.Stack): void {
  const at = (path: string) => `/${stack.node.id}/${path}`;

  NagSuppressions.addResourceSuppressionsByPath(stack, at('BenchmarkRole/DefaultPolicy/Resource'), [{
    id: 'AwsSolutions-IAM5',
    reason: 'Resources are matched by name prefix on purpose: rebuilding InfraStack regenerates the suffix of ' +
      'the state machine and table names, and this stack is deployed by hand and must not need to change. ' +
      'The prefixes are specific to this project, and the actions are limited to starting and reading ' +
      'benchmark runs.',
    appliesTo: [{ regex: '/^Resource::arn:.*:(states|dynamodb|cloudformation):.*\\*.*$/' }],
  }]);

  // Present once the benchmark history dashboard is merged; applied only if the role exists so the order
  // in which the two changes land does not matter.
  if (stack.node.tryFindChild('HistoryRole')) {
    NagSuppressions.addResourceSuppressionsByPath(stack, at('HistoryRole/DefaultPolicy/Resource'), [{
      id: 'AwsSolutions-IAM5',
      reason: 'Name-prefix match on the run table, for the same reason as the benchmark role. Read-only: one ' +
        'Scan action on that table, and the export script requests only an allow-listed set of attributes.',
      appliesTo: [{ regex: '/^Resource::arn:.*:(dynamodb|cloudformation):.*\\*.*$/' }],
    }]);
  }

  NagSuppressions.addResourceSuppressionsByPath(stack, at('DeployRole/DefaultPolicy/Resource'), [{
    id: 'AwsSolutions-IAM5',
    reason: 'The role may only assume this project\'s CDK bootstrap roles (cdk-giab-*), which are named by ' +
      'qualifier, account and region. Deploys then run with the bootstrap execution role, so this is effectively ' +
      'administrator access: what guards it is the trust policy (one repository, the production environment, ' +
      'main branch only) and the environment\'s required approval.',
    appliesTo: [{ regex: '/^Resource::arn:.*:iam::.*:role\\/cdk-giab-\\*-.*$/' }],
  }]);
}
