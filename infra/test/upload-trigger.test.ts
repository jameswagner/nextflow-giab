import * as cdk from 'aws-cdk-lib/core';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { createApp } from '../lib/app';
import * as fs from 'fs';
import * as path from 'path';

const cdkContext = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'cdk.json'), 'utf8')).context;

// What starts a run from an upload: which events, which objects, and nothing else.
describe('upload trigger', () => {
  const template = (() => {
    process.env.CDK_DEFAULT_ACCOUNT = '123456789012';
    const app = createApp({ context: cdkContext });
    const stack = app.node.children.find((c): c is cdk.Stack => c instanceof cdk.Stack && c.node.id === 'InfraStack')!;
    return Template.fromStack(stack);
  })();

  test('only samplesheets under incoming/ start a run', () => {
    template.hasResourceProperties('AWS::Events::Rule', {
      EventPattern: {
        'source': ['aws.s3'],
        'detail-type': ['Object Created'],
        'detail': { object: { key: [{ wildcard: 'incoming/*/samplesheet.csv' }] } },
      },
    });
  });

  test('the rule can start the run state machine and nothing else', () => {
    const rules = template.findResources('AWS::Events::Rule', { Properties: { EventPattern: { source: ['aws.s3'] } } });
    expect(Object.keys(rules)).toHaveLength(1);
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([Match.objectLike({ Action: 'states:StartExecution', Effect: 'Allow' })]),
      },
    });
  });

  test('S3 sends events to EventBridge', () => {
    template.hasResourceProperties('AWS::S3::Bucket', {
      NotificationConfiguration: { EventBridgeConfiguration: { EventBridgeEnabled: true } },
    });
  });
});
