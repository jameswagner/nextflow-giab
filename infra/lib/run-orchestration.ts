import * as cdk from 'aws-cdk-lib/core';
import * as batch from 'aws-cdk-lib/aws-batch';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import { Construct } from 'constructs';

const PROJECT_TAG_KEY = 'project';
const PROJECT_TAG_VALUE = 'nextflow-giab';

export interface RunOrchestrationProps {
  readonly bucket: s3.IBucket;
  readonly launcherQueue: batch.IJobQueue;
  readonly launcherJobDefinition: batch.IJobDefinition;
  readonly alertTopic: sns.ITopic;
  /** GitHub owner/name that the launcher pulls the pipeline from. */
  readonly pipelineRepo: string;
}

/**
 * One record per pipeline run, and a state machine that owns the run's lifecycle:
 * record RUNNING -> run the Nextflow launcher job and wait -> read the benchmark metrics
 * (if the run had a truth set) -> record SUCCEEDED or FAILED -> notify.
 * The full metrics stay in S3 (runs/<run_id>/); the table holds status, pointers and headline scores.
 */
export class RunOrchestration extends Construct {
  readonly table: dynamodb.Table;
  readonly stateMachine: sfn.StateMachine;

  constructor(scope: Construct, id: string, props: RunOrchestrationProps) {
    super(scope, id);
    const stack = cdk.Stack.of(this);
    const { bucket } = props;
    const S = tasks.DynamoAttributeValue;

    // Runs of a sample are grouped together, newest last; the index compares pipeline versions.
    this.table = new dynamodb.Table(this, 'Runs', {
      partitionKey: { name: 'sample', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'run_key', type: dynamodb.AttributeType.STRING }, // <started_at>#<run_id>
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      // Demo project: `cdk destroy` should leave nothing behind. A production table would RETAIN.
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    this.table.addGlobalSecondaryIndex({
      indexName: 'by_commit',
      partitionKey: { name: 'head_commit', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'started_at', type: dynamodb.AttributeType.STRING },
    });

    const key = {
      sample: S.fromString('{% $input.sample %}'),
      run_key: S.fromString('{% $startedAt & "#" & $runId %}'),
    };

    // Defaults for optional input fields, plus the run id (the execution name) and start time.
    const start = sfn.Pass.jsonata(this, 'Start', {
      assign: {
        runId: '{% $states.context.Execution.Name %}',
        startedAt: '{% $states.context.Execution.StartTime %}',
        input: '{% $merge([{"revision": "main", "profile": "awsbatch", "run_type": "experiment", "pipeline_args": []}, $states.input]) %}',
      },
    });

    const recordStart = tasks.DynamoPutItem.jsonata(this, 'RecordStart', {
      table: this.table,
      item: {
        ...key,
        run_id: S.fromString('{% $runId %}'),
        started_at: S.fromString('{% $startedAt %}'),
        status: S.fromString('RUNNING'),
        run_type: S.fromString('{% $input.run_type %}'),
        revision: S.fromString('{% $input.revision %}'),
        profile: S.fromString('{% $input.profile %}'),
        results_prefix: S.fromString(`{% "s3://${bucket.bucketName}/runs/" & $runId & "/" %}`),
      },
    });

    // Written as raw state JSON: the CDK Batch task only takes a fixed list of command words,
    // and each run passes a different number of pipeline arguments.
    const command = [
      `["nextflow", "run", "${props.pipelineRepo}", "-r", $input.revision, "-profile", $input.profile,`,
      ` "-work-dir", "s3://${bucket.bucketName}/work", "-output-dir", "s3://${bucket.bucketName}/runs/" & $runId,`,
      ' "--run_type", $input.run_type]',
      ' ~> $append($exists($input.pr_number) ? ["--pr_number", $string($input.pr_number)] : [])',
      ' ~> $append($exists($input.base_commit) ? ["--base_commit", $input.base_commit] : [])',
      ' ~> $append($input.pipeline_args)',
    ].join('');
    const runPipeline = new sfn.CustomState(this, 'RunPipeline', {
      stateJson: {
        Type: 'Task',
        Resource: `arn:${stack.partition}:states:::batch:submitJob.sync`,
        Arguments: {
          JobName: '{% $runId %}',
          JobQueue: props.launcherQueue.jobQueueArn,
          JobDefinition: props.launcherJobDefinition.jobDefinitionArn,
          ContainerOverrides: { Command: `{% ${command} %}` },
          // Lets TerminateJob below be limited to jobs this state machine started.
          Tags: { [PROJECT_TAG_KEY]: PROJECT_TAG_VALUE },
        },
      },
    });

    const readMetrics = tasks.CallAwsService.jsonata(this, 'ReadMetrics', {
      service: 's3',
      action: 'getObject',
      parameters: {
        Bucket: bucket.bucketName,
        Key: '{% "runs/" & $runId & "/benchmark/" & $input.sample & ".metrics.json" %}',
      },
      iamResources: [bucket.arnForObjects('runs/*')],
      outputs: '{% $parse($states.result.Body) %}',
    });

    const recordSucceeded = tasks.DynamoUpdateItem.jsonata(this, 'RecordSucceeded', {
      table: this.table,
      key,
      updateExpression: 'SET #status = :status, finished_at = :finished, head_commit = :commit, ' +
        'params_hash = :params, snp_f1 = :snp, non_snp_f1 = :non_snp, all_f1 = :all, metrics_uri = :uri',
      expressionAttributeNames: { '#status': 'status' },
      expressionAttributeValues: {
        ':status': S.fromString('SUCCEEDED'),
        ':finished': S.fromString('{% $now() %}'),
        ':commit': S.fromString('{% $states.input.run.head_commit ? $states.input.run.head_commit : "unknown" %}'),
        ':params': S.fromString('{% $states.input.params_hash %}'),
        ':snp': S.numberFromString('{% $string($states.input.metrics.snp.f1) %}'),
        ':non_snp': S.numberFromString('{% $string($states.input.metrics.non_snp.f1) %}'),
        ':all': S.numberFromString('{% $string($states.input.metrics.all.f1) %}'),
        ':uri': S.fromString(`{% "s3://${bucket.bucketName}/runs/" & $runId & "/benchmark/" & $input.sample & ".metrics.json" %}`),
      },
      assign: { status: 'SUCCEEDED' },
    });

    // A run without a truth set has no metrics file; that is still a successful run.
    const recordSucceededNoMetrics = tasks.DynamoUpdateItem.jsonata(this, 'RecordSucceededNoMetrics', {
      table: this.table,
      key,
      updateExpression: 'SET #status = :status, finished_at = :finished, metrics_note = :note',
      expressionAttributeNames: { '#status': 'status' },
      expressionAttributeValues: {
        ':status': S.fromString('SUCCEEDED'),
        ':finished': S.fromString('{% $now() %}'),
        ':note': S.fromString('{% "no metrics: " & $string($states.input.Error) %}'),
      },
      assign: { status: 'SUCCEEDED' },
    });

    const recordFailed = tasks.DynamoUpdateItem.jsonata(this, 'RecordFailed', {
      table: this.table,
      key,
      updateExpression: 'SET #status = :status, finished_at = :finished, #error = :error, error_cause = :cause',
      expressionAttributeNames: { '#status': 'status', '#error': 'error' },
      expressionAttributeValues: {
        ':status': S.fromString('FAILED'),
        ':finished': S.fromString('{% $now() %}'),
        ':error': S.fromString('{% $string($states.input.Error) %}'),
        ':cause': S.fromString('{% $substring($string($states.input.Cause), 0, 1000) %}'),
      },
      assign: { status: 'FAILED' },
    });

    const notify = tasks.SnsPublish.jsonata(this, 'Notify', {
      topic: props.alertTopic,
      subject: '{% "nextflow-giab run " & $status %}',
      message: sfn.TaskInput.fromText(
        '{% "Run " & $runId & " (sample " & $input.sample & ", revision " & $input.revision & ", " & ' +
        '$input.run_type & "): " & $status & ". Results: s3://.../runs/" & $runId & "/" %}'),
    });

    const done = sfn.Choice.jsonata(this, 'Done')
      .when(sfn.Condition.jsonata('{% $status = "FAILED" %}'), new sfn.Fail(this, 'RunFailed'))
      .otherwise(new sfn.Succeed(this, 'RunSucceeded'));

    runPipeline.addCatch(recordFailed, { errors: ['States.ALL'] });
    readMetrics.addCatch(recordSucceededNoMetrics, { errors: ['States.ALL'] });
    recordFailed.next(notify);
    recordSucceededNoMetrics.next(notify);
    recordSucceeded.next(notify);
    notify.next(done);

    const definition = start.next(recordStart).next(runPipeline).next(readMetrics).next(recordSucceeded);

    this.stateMachine = new sfn.StateMachine(this, 'RunStateMachine', {
      definitionBody: sfn.DefinitionBody.fromChainable(definition),
      queryLanguage: sfn.QueryLanguage.JSONATA,
      timeout: cdk.Duration.hours(26), // the launcher job itself times out at 24 h
      // CDK grants the logs:*LogDelivery actions on '*' for this; AWS requires '*' for log delivery.
      logs: {
        destination: new logs.LogGroup(this, 'StateMachineLogs', {
          retention: logs.RetentionDays.ONE_MONTH,
          removalPolicy: cdk.RemovalPolicy.DESTROY,
        }),
        level: sfn.LogLevel.ERROR,
      },
    });

    // Permissions for the raw RunPipeline state (submitJob.sync), matching what the CDK Batch task grants.
    this.stateMachine.addToRolePolicy(new iam.PolicyStatement({
      actions: ['batch:SubmitJob'],
      resources: [
        props.launcherQueue.jobQueueArn,
        `arn:${stack.partition}:batch:${stack.region}:${stack.account}:job-definition/${props.launcherJobDefinition.jobDefinitionName}*`,
      ],
    }));
    // DescribeJobs has no resource-level permissions in IAM, so it must be '*'. It is read-only.
    this.stateMachine.addToRolePolicy(new iam.PolicyStatement({
      actions: ['batch:DescribeJobs'],
      resources: ['*'],
    }));
    // Stopping an execution terminates its launcher job. Only jobs carrying our tag can be terminated,
    // so the state machine cannot cancel other Batch jobs in the account.
    const anyJob = `arn:${stack.partition}:batch:${stack.region}:${stack.account}:job/*`;
    this.stateMachine.addToRolePolicy(new iam.PolicyStatement({
      actions: ['batch:TerminateJob'],
      resources: [anyJob],
      conditions: { StringEquals: { [`aws:ResourceTag/${PROJECT_TAG_KEY}`]: PROJECT_TAG_VALUE } },
    }));
    // Tag-on-submit needs TagResource, limited to setting exactly that one tag. Batch checks it on
    // the new job and also on the job definition (and queue) named in the SubmitJob request.
    this.stateMachine.addToRolePolicy(new iam.PolicyStatement({
      actions: ['batch:TagResource'],
      resources: [
        anyJob,
        `arn:${stack.partition}:batch:${stack.region}:${stack.account}:job-definition/${props.launcherJobDefinition.jobDefinitionName}:*`,
        props.launcherQueue.jobQueueArn,
      ],
      conditions: {
        'StringEquals': { [`aws:RequestTag/${PROJECT_TAG_KEY}`]: PROJECT_TAG_VALUE },
        'ForAllValues:StringEquals': { 'aws:TagKeys': [PROJECT_TAG_KEY] },
      },
    }));
    this.stateMachine.addToRolePolicy(new iam.PolicyStatement({
      actions: ['events:PutTargets', 'events:PutRule', 'events:DescribeRule'],
      resources: [`arn:${stack.partition}:events:${stack.region}:${stack.account}:rule/StepFunctionsGetEventsForBatchJobsRule`],
    }));
  }
}
