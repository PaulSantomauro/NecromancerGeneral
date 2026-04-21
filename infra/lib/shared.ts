import * as cdk from 'aws-cdk-lib';

export const AWS_REGION = 'us-east-1';
export const AWS_ACCOUNT = '653719116478';

export const APEX_DOMAIN = 'paulsantomauro.com';
export const HOSTED_ZONE_ID = 'Z095020638ENRIIFCJLK';

export const CLIENT_DOMAIN = 'necromancer.paulsantomauro.com';
export const API_DOMAIN = 'api.necromancer.paulsantomauro.com';

export const SITE_BUCKET_NAME = 'necromancer-paulsantomauro-com-site';

export const GITHUB_OWNER = 'PaulSantomauro';
export const GITHUB_REPO = 'NecromancerGeneral';
export const GITHUB_DEPLOY_BRANCH = 'main';

export const SERVER_PORT = 2567;
export const LETSENCRYPT_EMAIL = 'paul.santomauro@gmail.com';

export const STACK_ENV: cdk.Environment = {
  account: AWS_ACCOUNT,
  region: AWS_REGION,
};
