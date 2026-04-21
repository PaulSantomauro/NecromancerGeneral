#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { NecromancerFrontendStack } from '../lib/frontend-stack';
import { NecromancerServerStack } from '../lib/server-stack';
import { STACK_ENV } from '../lib/shared';

const app = new cdk.App();

new NecromancerFrontendStack(app, 'NecromancerFrontendStack', {
  env: STACK_ENV,
  description: 'Static site (S3 + CloudFront + Route53) for necromancer.paulsantomauro.com',
});

new NecromancerServerStack(app, 'NecromancerServerStack', {
  env: STACK_ENV,
  description: 'Game server (EC2 + nginx + WSS) for api.necromancer.paulsantomauro.com',
});
