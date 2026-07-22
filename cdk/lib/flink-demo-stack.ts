import * as path from 'path';
import {
  Stack,
  StackProps,
  RemovalPolicy,
  CfnOutput,
  aws_iam as iam,
  aws_logs as logs,
  aws_kinesisanalyticsv2 as kda,
} from 'aws-cdk-lib';
import { Asset } from 'aws-cdk-lib/aws-s3-assets';
import { Construct } from 'constructs';

const APP_NAME = 'kda-troubleshooting-demo';
const LOG_GROUP_NAME = `/aws/kinesis-analytics/${APP_NAME}`;
const LOG_STREAM_NAME = 'kinesis-analytics-log-stream';

export class FlinkDemoStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // 1) Package the PyFlink code as a zip asset (uploaded to the CDK assets bucket).
    //    The app uses Flink's built-in datagen + blackhole connectors, so no extra
    //    connector jars are needed - just main.py.
    const codeAsset = new Asset(this, 'FlinkCodeAsset', {
      path: path.join(__dirname, '..', 'flink-app'),
    });

    // 2) CloudWatch log group + stream for the application logs.
    const logGroup = new logs.LogGroup(this, 'FlinkLogGroup', {
      logGroupName: LOG_GROUP_NAME,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const logStream = new logs.LogStream(this, 'FlinkLogStream', {
      logGroup,
      logStreamName: LOG_STREAM_NAME,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // 3) IAM service execution role for the Managed Flink application.
    const serviceRole = new iam.Role(this, 'FlinkServiceRole', {
      assumedBy: new iam.ServicePrincipal('kinesisanalytics.amazonaws.com'),
      description: 'Service execution role for the KDA troubleshooting demo app',
    });

    // Read the code zip from the CDK assets bucket.
    codeAsset.grantRead(serviceRole);
    // grantRead adds an IAM DefaultPolicy on the role. Managed Flink validates the
    // S3 code location during app creation, so the app MUST wait until that policy
    // is attached - otherwise creation fails with "unable to get the specified fileKey".
    const roleDefaultPolicy = serviceRole.node.tryFindChild('DefaultPolicy');

    // Write metrics.
    serviceRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['cloudwatch:PutMetricData'],
        resources: ['*'],
      })
    );

    // Write application logs to the log group / stream.
    serviceRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['logs:DescribeLogGroups'],
        resources: [`arn:aws:logs:${this.region}:${this.account}:log-group:*`],
      })
    );
    serviceRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['logs:DescribeLogStreams', 'logs:PutLogEvents', 'logs:CreateLogStream'],
        resources: [logGroup.logGroupArn, `${logGroup.logGroupArn}:log-stream:*`],
      })
    );

    // 4) The Managed Flink (kinesisanalyticsv2) application.
    const flinkApp = new kda.CfnApplication(this, 'FlinkApp', {
      applicationName: APP_NAME,
      runtimeEnvironment: 'FLINK-1_20',
      serviceExecutionRole: serviceRole.roleArn,
      applicationConfiguration: {
        applicationCodeConfiguration: {
          codeContent: {
            s3ContentLocation: {
              bucketArn: `arn:aws:s3:::${codeAsset.s3BucketName}`,
              fileKey: codeAsset.s3ObjectKey,
            },
          },
          codeContentType: 'ZIPFILE',
        },
        environmentProperties: {
          propertyGroups: [
            {
              // Tells Managed Flink which python file is the entrypoint inside the zip.
              propertyGroupId: 'kinesis.analytics.flink.run.options',
              propertyMap: {
                python: 'main.py',
              },
            },
            {
              // Custom app properties. Set fail_mode=false to run the "healthy" version.
              propertyGroupId: 'FlinkAppProperties',
              propertyMap: {
                fail_mode: 'true',
                rows_per_second: '5',
                fail_on_risk: '7',
              },
            },
          ],
        },
        flinkApplicationConfiguration: {
          monitoringConfiguration: {
            configurationType: 'CUSTOM',
            logLevel: 'INFO',
            metricsLevel: 'TASK',
          },
          parallelismConfiguration: {
            configurationType: 'CUSTOM',
            parallelism: 1,
            parallelismPerKpu: 1,
            autoScalingEnabled: false,
          },
        },
      },
    });

    // Ensure the role's inline policy (S3 read grant) exists before the app is created.
    flinkApp.node.addDependency(serviceRole);
    if (roleDefaultPolicy) {
      flinkApp.node.addDependency(roleDefaultPolicy);
    }

    // 5) Attach the CloudWatch logging option to the application.
    const loggingOption = new kda.CfnApplicationCloudWatchLoggingOption(this, 'FlinkLoggingOption', {
      applicationName: APP_NAME,
      cloudWatchLoggingOption: {
        logStreamArn: `arn:aws:logs:${this.region}:${this.account}:log-group:${LOG_GROUP_NAME}:log-stream:${LOG_STREAM_NAME}`,
      },
    });
    loggingOption.addDependency(flinkApp);
    loggingOption.node.addDependency(logStream);

    // 6) Outputs to make the demo easy to run.
    new CfnOutput(this, 'ApplicationName', { value: APP_NAME });
    new CfnOutput(this, 'LogGroupName', { value: LOG_GROUP_NAME });
    new CfnOutput(this, 'StartCommand', {
      value: `aws kinesisanalyticsv2 start-application --application-name ${APP_NAME} --run-configuration '{"FlinkRunConfiguration":{"AllowNonRestoredState":true}}'`,
    });
    new CfnOutput(this, 'StopCommand', {
      value: `aws kinesisanalyticsv2 stop-application --application-name ${APP_NAME}`,
    });
    new CfnOutput(this, 'LogsInsightsHint', {
      value: `Open CloudWatch Logs Insights on log group ${LOG_GROUP_NAME} and run the queries in 04-demo/queries/insights-queries.md`,
    });
  }
}
