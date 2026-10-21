import * as cdk from 'aws-cdk-lib/core';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

export interface GithubIdentityStackProps extends cdk.StackProps {
  /**
   * How GitHub names this repository in the tokens' `sub` claim. New repositories use immutable subjects,
   * `owner@<owner id>/repo@<repo id>`, so a deleted and recreated repository with the same name cannot
   * assume these roles. Read it from `gh api repos/<owner>/<repo>/actions/oidc/customization/sub`
   * (`sub_claim_prefix`, without the leading `repo:`). Older repositories use plain `owner/repo`.
   */
  readonly repoSubject: string;
  /** Create the account's GitHub OIDC provider instead of using the existing one (there can be only one). */
  readonly createOidcProvider?: boolean;
}

const OIDC_HOST = 'token.actions.githubusercontent.com';

/**
 * Lets GitHub Actions in this repository reach AWS without any stored keys: the workflow presents a
 * short-lived GitHub token, and AWS exchanges it for a role session. A separate stack from InfraStack
 * on purpose: destroying and rebuilding the infrastructure must never delete the roles that deploy it,
 * and the deploy workflow never deploys this stack, so a pull request cannot widen its own permissions.
 * Deploy it by hand, with an administrator login, whenever it changes.
 *
 * A role is trusted per GitHub *environment* (the token's `sub` claim names it). A workflow that does
 * not declare the environment cannot assume the role, and the environment itself restricts which
 * branch's workflow files may use it and whether a person must approve each run.
 */
export class GithubIdentityStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: GithubIdentityStackProps) {
    super(scope, id, props);
    const { repoSubject } = props;

    const providerArn = props.createOidcProvider
      ? new iam.OpenIdConnectProvider(this, 'GithubOidc', {
          url: `https://${OIDC_HOST}`,
          clientIds: ['sts.amazonaws.com'],
        }).openIdConnectProviderArn
      : `arn:${this.partition}:iam::${this.account}:oidc-provider/${OIDC_HOST}`;

    const roleFor = (roleId: string, environment: string, description: string, maxHours: number) =>
      new iam.Role(this, roleId, {
        description,
        maxSessionDuration: cdk.Duration.hours(maxHours),
        assumedBy: new iam.WebIdentityPrincipal(providerArn, {
          StringEquals: {
            [`${OIDC_HOST}:aud`]: 'sts.amazonaws.com',
            [`${OIDC_HOST}:sub`]: `repo:${repoSubject}:environment:${environment}`,
          },
        }),
      });

    // --- Benchmark runs: start the run state machine, watch it, read its record ---
    // Resources are matched by name prefix, not by ARN, so rebuilding InfraStack (which regenerates the
    // names' suffixes) never requires touching this stack.
    const benchmarkRole = roleFor('BenchmarkRole', 'benchmark',
      'GitHub Actions benchmark runs: start the run state machine and read run records', 4);
    const arn = (service: string, resource: string) =>
      `arn:${this.partition}:${service}:${this.region}:${this.account}:${resource}`;
    benchmarkRole.addToPolicy(new iam.PolicyStatement({
      actions: ['states:StartExecution'],
      resources: [arn('states', 'stateMachine:OrchestrationRunStateMachine*')],
    }));
    benchmarkRole.addToPolicy(new iam.PolicyStatement({
      actions: ['states:DescribeExecution', 'states:StopExecution'],
      resources: [arn('states', 'execution:OrchestrationRunStateMachine*:*')],
    }));
    benchmarkRole.addToPolicy(new iam.PolicyStatement({
      actions: ['dynamodb:Query', 'dynamodb:GetItem'],
      resources: [arn('dynamodb', 'table/InfraStack-OrchestrationRuns*'), arn('dynamodb', 'table/InfraStack-OrchestrationRuns*/index/*')],
    }));
    benchmarkRole.addToPolicy(new iam.PolicyStatement({
      // Reads the stack outputs (state machine, table and bucket names); nothing else about the stack.
      actions: ['cloudformation:DescribeStacks'],
      resources: [arn('cloudformation', 'stack/InfraStack/*')],
    }));

    // --- Deploys: only the CDK bootstrap roles of this project, and only after a person approves ---
    // Those roles trust the account, and CloudFormation then deploys with the bootstrap's execution role,
    // so this is effectively administrator access. What guards it is who can reach it: only a workflow
    // from the main branch, in an environment that requires approval.
    const deployRole = roleFor('DeployRole', 'production',
      'GitHub Actions deploys of InfraStack, via the CDK bootstrap roles', 2);
    deployRole.addToPolicy(new iam.PolicyStatement({
      actions: ['sts:AssumeRole'],
      resources: [`arn:${this.partition}:iam::${this.account}:role/cdk-giab-*-${this.account}-${this.region}`],
    }));

    new cdk.CfnOutput(this, 'BenchmarkRoleArn', { value: benchmarkRole.roleArn });
    new cdk.CfnOutput(this, 'DeployRoleArn', { value: deployRole.roleArn });
  }
}
