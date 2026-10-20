import * as cdk from 'aws-cdk-lib/core';
import * as batch from 'aws-cdk-lib/aws-batch';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
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
  readonly recordCloser: sfn.StateMachine;

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
    // Finds a run's record from its execution name alone (used when an execution ends without
    // updating its own record); the table keys are projected automatically.
    this.table.addGlobalSecondaryIndex({
      indexName: 'by_run_id',
      partitionKey: { name: 'run_id', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.KEYS_ONLY,
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
        metrics: '{% {} %}',
        gate: '{% {} %}',
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
      assign: { metrics: '{% $parse($states.result.Body) %}' },
      outputs: '{% {} %}',
    });

    // gate.json exists only when the run was given a baseline (--baseline); without one this read
    // fails and the run is recorded as a plain success.
    const readGate = tasks.CallAwsService.jsonata(this, 'ReadGate', {
      service: 's3',
      action: 'getObject',
      parameters: {
        Bucket: bucket.bucketName,
        Key: '{% "runs/" & $runId & "/benchmark/" & $input.sample & ".gate.json" %}',
      },
      iamResources: [bucket.arnForObjects('runs/*')],
      assign: { gate: '{% $parse($states.result.Body) %}' },
      outputs: '{% {} %}',
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
        ':commit': S.fromString('{% $metrics.run.head_commit ? $metrics.run.head_commit : "unknown" %}'),
        ':params': S.fromString('{% $metrics.params_hash %}'),
        ':snp': S.numberFromString('{% $string($metrics.metrics.snp.f1) %}'),
        ':non_snp': S.numberFromString('{% $string($metrics.metrics.non_snp.f1) %}'),
        ':all': S.numberFromString('{% $string($metrics.metrics.all.f1) %}'),
        ':uri': S.fromString(`{% "s3://${bucket.bucketName}/runs/" & $runId & "/benchmark/" & $input.sample & ".metrics.json" %}`),
      },
      assign: { status: 'SUCCEEDED' },
    });

    // A gated run: PASS records SUCCEEDED; a regression or an incomparable run records that status.
    const recordGated = tasks.DynamoUpdateItem.jsonata(this, 'RecordGated', {
      table: this.table,
      key,
      updateExpression: 'SET #status = :status, finished_at = :finished, head_commit = :commit, ' +
        'params_hash = :params, snp_f1 = :snp, non_snp_f1 = :non_snp, all_f1 = :all, metrics_uri = :uri, ' +
        'gate_status = :gate, gate_reasons = :reasons',
      expressionAttributeNames: { '#status': 'status' },
      expressionAttributeValues: {
        ':status': S.fromString('{% $gate.status = "PASS" ? "SUCCEEDED" : $gate.status %}'),
        ':finished': S.fromString('{% $now() %}'),
        ':commit': S.fromString('{% $metrics.run.head_commit ? $metrics.run.head_commit : "unknown" %}'),
        ':params': S.fromString('{% $metrics.params_hash %}'),
        ':snp': S.numberFromString('{% $string($metrics.metrics.snp.f1) %}'),
        ':non_snp': S.numberFromString('{% $string($metrics.metrics.non_snp.f1) %}'),
        ':all': S.numberFromString('{% $string($metrics.metrics.all.f1) %}'),
        ':uri': S.fromString(`{% "s3://${bucket.bucketName}/runs/" & $runId & "/benchmark/" & $input.sample & ".metrics.json" %}`),
        ':gate': S.fromString('{% $gate.status %}'),
        ':reasons': S.fromString('{% $count($gate.reasons) > 0 ? $substring($join($gate.reasons, "; "), 0, 1000) : "none" %}'),
      },
      assign: { status: '{% $gate.status = "PASS" ? "SUCCEEDED" : $gate.status %}' },
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
        '$input.run_type & "): " & $status & ($count($gate.reasons) > 0 ? " - " & $join($gate.reasons, "; ") : "") & ' +
        '". Results: s3://.../runs/" & $runId & "/" %}'),
    });

    // A regression or an incomparable run is recorded as such, and also ends the execution as failed
    // so a CI check (or anyone reading the execution status) sees it without opening the record.
    const done = sfn.Choice.jsonata(this, 'Done')
      .when(sfn.Condition.jsonata('{% $status = "FAILED" %}'), new sfn.Fail(this, 'RunFailed'))
      .when(sfn.Condition.jsonata('{% $status = "REGRESSED" %}'), new sfn.Fail(this, 'RunRegressed', {
        error: 'BenchmarkRegressed', cause: 'A score fell by more than its tolerance; see the run record.' }))
      .when(sfn.Condition.jsonata('{% $status = "INCOMPARABLE" %}'), new sfn.Fail(this, 'RunIncomparable', {
        error: 'BenchmarkIncomparable', cause: 'The run does not match the baseline sample, truth set, region or reference.' }))
      .otherwise(new sfn.Succeed(this, 'RunSucceeded'));

    runPipeline.addCatch(recordFailed, { errors: ['States.ALL'] });
    readMetrics.addCatch(recordSucceededNoMetrics, { errors: ['States.ALL'] });
    readGate.addCatch(recordSucceeded, { errors: ['States.ALL'] });
    recordGated.next(notify);
    recordFailed.next(notify);
    recordSucceededNoMetrics.next(notify);
    recordSucceeded.next(notify);
    notify.next(done);

    const logGroup = new logs.LogGroup(this, 'StateMachineLogs', {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const definition = start.next(recordStart).next(runPipeline).next(readMetrics).next(readGate).next(recordGated);

    this.stateMachine = new sfn.StateMachine(this, 'RunStateMachine', {
      definitionBody: sfn.DefinitionBody.fromChainable(definition),
      queryLanguage: sfn.QueryLanguage.JSONATA,
      timeout: cdk.Duration.hours(26), // the launcher job itself times out at 24 h
      // CDK grants the logs:*LogDelivery actions on '*' for this; AWS requires '*' for log delivery.
      logs: { destination: logGroup, level: sfn.LogLevel.ERROR },
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
    // --- Executions that end without updating their own record ---
    // Stopping an execution or hitting its timeout ends it on the spot: no later state runs and no
    // error handler fires, so the record would stay RUNNING. Step Functions publishes an event for
    // every status change; this small state machine reacts to it and closes the record. It only
    // changes records that are still RUNNING, so a normal failure (already recorded) is left alone.
    const indexArn = `${this.table.tableArn}/index/by_run_id`;
    const findRecord = tasks.CallAwsService.jsonata(this, 'FindRecord', {
      service: 'dynamodb',
      action: 'query',
      parameters: {
        TableName: this.table.tableName,
        IndexName: 'by_run_id',
        KeyConditionExpression: 'run_id = :r',
        ExpressionAttributeValues: { ':r': { S: '{% $states.input.detail.name %}' } },
      },
      iamResources: [indexArn],
      iamAction: 'dynamodb:Query',
      outputs: '{% $merge([$states.input, {"record": $states.result.Items[0]}]) %}',
    });
    const closeRecord = tasks.DynamoUpdateItem.jsonata(this, 'CloseRecord', {
      table: this.table,
      key: {
        sample: S.fromString('{% $states.input.record.sample.S %}'),
        run_key: S.fromString('{% $states.input.record.run_key.S %}'),
      },
      updateExpression: 'SET #status = :status, finished_at = :finished, ended_by = :by',
      conditionExpression: '#status = :running',
      expressionAttributeNames: { '#status': 'status' },
      expressionAttributeValues: {
        ':status': S.fromString('{% $states.input.detail.status %}'),
        ':running': S.fromString('RUNNING'),
        ':finished': S.fromString(
          '{% $exists($states.input.detail.stopDate) ? $fromMillis($states.input.detail.stopDate) : $now() %}'),
        ':by': S.fromString('execution status event'),
      },
    });
    const nothingToClose = new sfn.Succeed(this, 'NothingToClose');
    const closeOrSkip = sfn.Choice.jsonata(this, 'RecordFound')
      .when(sfn.Condition.jsonata('{% $exists($states.input.record) %}'), closeRecord)
      .otherwise(nothingToClose);
    // A record that is no longer RUNNING (or another race) is fine: nothing to close.
    closeRecord.addCatch(nothingToClose, { errors: ['DynamoDB.ConditionalCheckFailedException'] });
    closeRecord.next(nothingToClose);
    const recordCloser = this.recordCloser = new sfn.StateMachine(this, 'RecordCloser', {
      definitionBody: sfn.DefinitionBody.fromChainable(findRecord.next(closeOrSkip)),
      queryLanguage: sfn.QueryLanguage.JSONATA,
      timeout: cdk.Duration.minutes(5),
      logs: { destination: logGroup, level: sfn.LogLevel.ERROR },
    });
    new events.Rule(this, 'RunEndedRule', {
      description: 'A run execution ended; close its record if it is still RUNNING',
      eventPattern: {
        source: ['aws.states'],
        detailType: ['Step Functions Execution Status Change'],
        detail: {
          stateMachineArn: [this.stateMachine.stateMachineArn],
          status: ['ABORTED', 'TIMED_OUT', 'FAILED'],
        },
      },
      targets: [new targets.SfnStateMachine(recordCloser)],
    });

    this.stateMachine.addToRolePolicy(new iam.PolicyStatement({
      actions: ['events:PutTargets', 'events:PutRule', 'events:DescribeRule'],
      resources: [`arn:${stack.partition}:events:${stack.region}:${stack.account}:rule/StepFunctionsGetEventsForBatchJobsRule`],
    }));
  }
}
