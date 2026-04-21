# Necromancer General — Infra (AWS CDK)

Two stacks deployed in `us-east-1` (account `653719116478`):

- **`NecromancerFrontendStack`** — S3 + CloudFront + Route53 for `necromancer.paulsantomauro.com`
- **`NecromancerServerStack`** — EC2 (`t4g.nano`) + nginx + WSS for `api.necromancer.paulsantomauro.com`

Hosted zone `paulsantomauro.com` (ID `Z095020638ENRIIFCJLK`) is pre-existing and referenced by ID — this repo does not own it.

## Commands

From this directory:

```bash
npm install
npx cdk synth                              # synthesize CloudFormation
npx cdk diff NecromancerFrontendStack      # preview frontend changes
npx cdk diff NecromancerServerStack        # preview server changes
npx cdk deploy NecromancerFrontendStack    # deploy frontend
npx cdk deploy NecromancerServerStack      # deploy server
npx cdk deploy --all                       # deploy everything
npx cdk destroy NecromancerServerStack     # tear down server (rollback)
```

Always run `cdk diff` before `cdk deploy` and eyeball the change.

## Conventions

- Shared constants live in `lib/shared.ts`. Change them there, not inline.
- EC2 access is via **AWS Systems Manager Session Manager** — no port 22, no SSH keys.
  - `aws ssm start-session --target <instance-id>` to shell onto the box.
- Production AWS deploys from CI use OIDC (role `GitHubActions-NecromancerDeploy`, set up in Phase 2).
