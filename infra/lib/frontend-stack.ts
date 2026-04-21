import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';

export class NecromancerFrontendStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Resources defined in Phase 3:
    //   - S3 site bucket (private, OAC-only)
    //   - ACM certificate in us-east-1 for necromancer.paulsantomauro.com
    //   - CloudFront distribution with OAC origin to S3
    //   - Route53 A-alias from necromancer.paulsantomauro.com -> distribution
  }
}
