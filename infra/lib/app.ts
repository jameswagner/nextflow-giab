import * as cdk from 'aws-cdk-lib/core';
import { AwsSolutionsChecks } from 'cdk-nag';
import { InfraStack } from './infra-stack';
import { GithubIdentityStack } from './github-identity-stack';
import { suppressIdentityStack, suppressInfraStack } from './nag-suppressions';

/**
 * The whole CDK app, built in one place so the CLI (bin/infra.ts) and the cdk-nag test (test/nag.test.ts)
 * synthesize exactly the same thing. cdk-nag's AWS Solutions checks run on everything: a finding is either
 * fixed or suppressed, with a written reason, in nag-suppressions.ts. The CLI reads cdk.json's context (feature
 * flags) itself; a test must pass the same context to get the same resources.
 */
export function createApp(props?: cdk.AppProps): cdk.App {
  const app = new cdk.App(props);
  cdk.Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));
  const env = { account: process.env.CDK_DEFAULT_ACCOUNT, region: 'us-east-1' };

  const infra = new InfraStack(app, 'InfraStack', { env });

  // Roles for GitHub Actions (OIDC, no stored keys). Separate from InfraStack so rebuilding the
  // infrastructure never deletes the roles that deploy it. Deploy by hand: `cdk deploy GithubIdentityStack`.
  const identity = new GithubIdentityStack(app, 'GithubIdentityStack', {
    env,
    // GitHub's immutable subject for this repository (public numeric ids of the owner and the repo).
    repoSubject: app.node.tryGetContext('githubRepoSubject') ?? 'jameswagner@6070584/nextflow-giab@1425026709',
    // An account can have only one GitHub OIDC provider; pass -c createOidcProvider=true if it has none.
    createOidcProvider: app.node.tryGetContext('createOidcProvider') === 'true',
  });

  suppressInfraStack(infra);
  suppressIdentityStack(identity);
  return app;
}
