import * as cdk from 'aws-cdk-lib/core';
import { Annotations, Match } from 'aws-cdk-lib/assertions';
import { createApp } from '../lib/app';
import * as fs from 'fs';
import * as path from 'path';

const cdkContext = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'cdk.json'), 'utf8')).context;

// Builds the same app the CLI deploys and runs cdk-nag's AWS Solutions checks on it. A new finding fails
// this test until it is fixed or suppressed, with a written reason, in lib/nag-suppressions.ts.
describe('cdk-nag AWS Solutions checks', () => {
  const app = (() => {
    process.env.CDK_DEFAULT_ACCOUNT = '123456789012'; // stack env needs an account; nothing here calls AWS
    const created = createApp({ context: cdkContext }); // what the CLI would read from cdk.json
    created.synth(); // runs the aspects
    return created;
  })();
  const stacks = app.node.children.filter((child): child is cdk.Stack => child instanceof cdk.Stack);

  test('the app has the stacks it should', () => {
    expect(stacks.map((s) => s.node.id).sort()).toEqual(expect.arrayContaining(['GithubIdentityStack', 'InfraStack']));
  });

  test.each(['InfraStack', 'GithubIdentityStack'])('%s has no unsuppressed errors or warnings', (name) => {
    const stack = stacks.find((s) => s.node.id === name)!;
    const annotations = Annotations.fromStack(stack);
    const messages = (items: { id: string; entry: { data?: unknown } }[]) =>
      items.map((i) => `${i.id}: ${String(i.entry.data).slice(0, 160)}`);
    expect(messages(annotations.findError('*', Match.stringLikeRegexp('AwsSolutions-.*')))).toEqual([]);
    expect(messages(annotations.findWarning('*', Match.stringLikeRegexp('AwsSolutions-.*')))).toEqual([]);
  });
});
