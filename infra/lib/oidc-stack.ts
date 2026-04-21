import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import {
  AWS_ACCOUNT,
  AWS_REGION,
  GITHUB_DEPLOY_BRANCH,
  GITHUB_OWNER,
  GITHUB_REPO,
  SITE_BUCKET_NAME,
} from './shared';

const APP_TAG = 'necromancer-general';

export class NecromancerOidcStack extends cdk.Stack {
  public readonly deployRole: iam.Role;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const providerArn = `arn:aws:iam::${AWS_ACCOUNT}:oidc-provider/token.actions.githubusercontent.com`;
    const oidcProvider = iam.OpenIdConnectProvider.fromOpenIdConnectProviderArn(
      this,
      'GitHubOidcProvider',
      providerArn,
    );

    const subject = `repo:${GITHUB_OWNER}/${GITHUB_REPO}:ref:refs/heads/${GITHUB_DEPLOY_BRANCH}`;

    this.deployRole = new iam.Role(this, 'DeployRole', {
      roleName: 'GitHubActions-NecromancerDeploy',
      description: 'Assumed by GitHub Actions in PaulSantomauro/NecromancerGeneral on main to deploy Necromancer General.',
      maxSessionDuration: cdk.Duration.hours(1),
      assumedBy: new iam.FederatedPrincipal(
        oidcProvider.openIdConnectProviderArn,
        {
          StringEquals: {
            'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
            'token.actions.githubusercontent.com:sub': subject,
          },
        },
        'sts:AssumeRoleWithWebIdentity',
      ),
    });

    // S3: read/write + delete on the site bucket (for `aws s3 sync --delete`).
    this.deployRole.addToPolicy(new iam.PolicyStatement({
      sid: 'SiteBucketObjects',
      actions: ['s3:PutObject', 's3:GetObject', 's3:DeleteObject'],
      resources: [`arn:aws:s3:::${SITE_BUCKET_NAME}/*`],
    }));
    this.deployRole.addToPolicy(new iam.PolicyStatement({
      sid: 'SiteBucketList',
      actions: ['s3:ListBucket', 's3:GetBucketLocation'],
      resources: [`arn:aws:s3:::${SITE_BUCKET_NAME}`],
    }));

    // CloudFront: invalidate the site distribution. Scoped via tag condition
    // (all distributions owned by this app are tagged app=necromancer-general).
    this.deployRole.addToPolicy(new iam.PolicyStatement({
      sid: 'CloudFrontInvalidate',
      actions: [
        'cloudfront:CreateInvalidation',
        'cloudfront:GetInvalidation',
        'cloudfront:GetDistribution',
        'cloudfront:ListDistributions',
      ],
      resources: ['*'],
      conditions: {
        StringEquals: { 'aws:ResourceTag/app': APP_TAG },
      },
    }));
    // ListDistributions does not support resource-level permissions or tag conditions;
    // allow it unscoped so CI can find the distribution ID at runtime if needed.
    this.deployRole.addToPolicy(new iam.PolicyStatement({
      sid: 'CloudFrontList',
      actions: ['cloudfront:ListDistributions'],
      resources: ['*'],
    }));

    // SSM SendCommand against the game EC2 instance (tag-scoped) using the
    // AWS-RunShellScript document. Plus GetCommandInvocation to poll status.
    this.deployRole.addToPolicy(new iam.PolicyStatement({
      sid: 'SsmSendCommandInstance',
      actions: ['ssm:SendCommand'],
      resources: [`arn:aws:ec2:${AWS_REGION}:${AWS_ACCOUNT}:instance/*`],
      conditions: {
        StringEquals: { 'aws:ResourceTag/app': APP_TAG },
      },
    }));
    this.deployRole.addToPolicy(new iam.PolicyStatement({
      sid: 'SsmSendCommandDocument',
      actions: ['ssm:SendCommand'],
      resources: [`arn:aws:ssm:${AWS_REGION}::document/AWS-RunShellScript`],
    }));
    this.deployRole.addToPolicy(new iam.PolicyStatement({
      sid: 'SsmReadCommand',
      actions: [
        'ssm:GetCommandInvocation',
        'ssm:ListCommandInvocations',
        'ssm:ListCommands',
        'ssm:DescribeInstanceInformation',
      ],
      resources: ['*'],
    }));

    new cdk.CfnOutput(this, 'DeployRoleArn', {
      value: this.deployRole.roleArn,
      exportName: 'NecromancerDeployRoleArn',
      description: 'ARN of the GitHub Actions deploy role — use in workflow role-to-assume.',
    });
  }
}
