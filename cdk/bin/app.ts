#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { FlinkDemoStack } from '../lib/flink-demo-stack';

const app = new cdk.App();

new FlinkDemoStack(app, 'KdaFlinkTroubleshootingDemo', {
  // Uses the credentials/region from your default profile (CDK_DEFAULT_*).
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
  description: 'Managed Flink demo app that intentionally restart-loops to generate CloudWatch troubleshooting logs.',
});
