import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';

export class NecromancerServerStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Resources defined in Phase 4:
    //   - Default VPC lookup
    //   - Security group: 80/443 in from anywhere, no port 22 (SSM only)
    //   - IAM instance role with AmazonSSMManagedInstanceCore
    //   - t4g.nano EC2 on Amazon Linux 2023 ARM, 8 GB gp3
    //   - Elastic IP
    //   - Route53 A-record api.necromancer.paulsantomauro.com -> EIP
    //   - User-data: Node 20, nginx, certbot, systemd service, WSS reverse proxy
  }
}
