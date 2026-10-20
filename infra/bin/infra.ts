#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import { InfraStack } from '../lib/infra-stack';
import { GithubIdentityStack } from '../lib/github-identity-stack';

const app = new cdk.App();
new InfraStack(app, 'InfraStack', {
  /* If you don't specify 'env', this stack will be environment-agnostic.
   * Account/Region-dependent features and context lookups will not work,
   * but a single synthesized template can be deployed anywhere. */

  /* Uncomment the next line to specialize this stack for the AWS Account
   * and Region that are implied by the current CLI configuration. */
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: 'us-east-1' },

  /* Uncomment the next line if you know exactly what Account and Region you
   * want to deploy the stack to. */
  // env: { account: '123456789012', region: 'us-east-1' },

  /* For more information, see https://docs.aws.amazon.com/cdk/latest/guide/environments.html */
});

// Roles for GitHub Actions (OIDC, no stored keys). Separate from InfraStack so rebuilding the
// infrastructure never deletes the roles that deploy it. Deploy by hand: `cdk deploy GithubIdentityStack`.
new GithubIdentityStack(app, 'GithubIdentityStack', {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: 'us-east-1' },
  repo: app.node.tryGetContext('githubRepo') ?? 'jameswagner/nextflow-giab',
  // An account can have only one GitHub OIDC provider; pass -c createOidcProvider=true if it has none.
  createOidcProvider: app.node.tryGetContext('createOidcProvider') === 'true',
});
