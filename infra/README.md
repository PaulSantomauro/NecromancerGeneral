# Necromancer General — Infra (AWS CDK)

> **Nothing here is currently deployed.** All three stacks were destroyed on 2026-07-31 when the
> jam wrapped — no EC2, no Elastic IP, no CloudFront, no DNS records, and the site bucket was
> emptied and deleted. What follows describes the deployment as it stood, and is what
> `npx cdk deploy --all` would recreate.

Stacks (region `us-east-1`, account `653719116478`):

- **`NecromancerFrontendStack`** — S3 + CloudFront + Route53 for `necromancer.paulsantomauro.com`
- **`NecromancerServerStack`** — EC2 (`t4g.nano`) + nginx + WSS for `api.necromancer.paulsantomauro.com`
- **`NecromancerOidcStack`** — the `GitHubActions-NecromancerDeploy` role assumed by CI

Hosted zone `paulsantomauro.com` (ID `Z095020638ENRIIFCJLK`) is pre-existing and referenced by ID — this repo does not own it.

The account is shared with other projects (`PortfolioStack`, `CDKToolkit`, and the
`battlearena` / `chronobench` records in the same zone). Scope every teardown to the
`Necromancer*` stacks; never delete the bootstrap stack or the hosted zone.

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

### Teardown

Destroy in this order: server, frontend, then OIDC (so the deploy role outlives any step that
needs re-running). Two things `cdk destroy` will not do for you:

- The site bucket is `RETAIN` + versioned (`lib/frontend-stack.ts`), so destroying the frontend
  stack **orphans** it. Empty every object version and delete marker, then `delete-bucket` — and
  only after the CloudFront distribution is gone, since its origin access control points at it.
- The frontend destroy takes 15–30 minutes; CloudFormation disables the distribution, waits for
  propagation, then deletes it.

`NecromancerOidcStack` imports the `token.actions.githubusercontent.com` provider by ARN rather
than creating it, so destroying it drops only the role — other repos keep working.

## Conventions

- Shared constants live in `lib/shared.ts`. Change them there, not inline.
- EC2 access is via **AWS Systems Manager Session Manager** — no port 22, no SSH keys.
  - `aws ssm start-session --target <instance-id>` to shell onto the box.
- Production AWS deploys from CI use OIDC (role `GitHubActions-NecromancerDeploy`, set up in Phase 2).
