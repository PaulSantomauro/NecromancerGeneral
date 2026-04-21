# Necromancer General — Production Deployment Plan (Path C)

**Goal:** Ship `necromancer-general` as a live, playable, AWS-native multiplayer game at `necromancer.paulsantomauro.com` (client) with Socket.io backend at `api.necromancer.paulsantomauro.com`, in time for Vibe Jam 2026 submission.

**Architecture decision (locked):**
- Client: static Vite build → S3 + CloudFront + Route53, served at `necromancer.paulsantomauro.com`.
- Server: Node/Socket.io on a `t4g.nano` EC2 instance, nginx terminating WSS with Let's Encrypt, served at `api.necromancer.paulsantomauro.com`.
- IaC: AWS CDK (TypeScript), mirroring the paulsantomauro.com pattern, living in `necromancer-general/infra/`.
- CI/CD: GitHub Actions via OIDC, one workflow for client, one for server.
- Hosted zone: existing `paulsantomauro.com` zone (`Z095020638ENRIIFCJLK`) — CDK references by ID, does not own.

**Estimated monthly cost:** ~$3–4 (EC2 t4g.nano on-demand + negligible S3/CloudFront/Route53).

**Executor:** Claude Code, running in the `necromancer-general` repo root. Human (Paul) approves at each phase gate.

---

## Phase 0 — Preflight & decisions (15 min, human + Claude Code)

Before any code is written, confirm:

- [ ] GitHub repo for `necromancer-general` is pushed and accessible.
- [ ] AWS account has an existing OIDC provider for GitHub Actions (from paulsantomauro.com setup). If yes, reuse it; if no, CDK will create one and we note this in Phase 2.
- [ ] Hosted zone `paulsantomauro.com` exists with ID `Z095020638ENRIIFCJLK` — verify via `aws route53 list-hosted-zones`.
- [ ] Decide SSH access model: **AWS Systems Manager Session Manager** (no open port 22, IAM-gated) vs **SSH key on port 22 restricted to Paul's IP**. Recommend SSM — no key management, no open inbound SSH. Plan assumes SSM unless changed here.
- [ ] Confirm region: `us-east-1` (matches portfolio, required for CloudFront ACM cert).

**Gate:** Paul signs off on the above. Claude Code does not proceed to Phase 1 without explicit approval.

---

## Phase 1 — Repository scaffolding (30 min, Claude Code)

Create the infra project structure without deploying anything yet.

**Tasks:**
1. Create `infra/` directory at repo root.
2. `cd infra && cdk init app --language=typescript` (pin CDK version to match portfolio repo).
3. Add dependencies: `aws-cdk-lib`, `constructs`.
4. Create skeleton files:
   - `infra/bin/necromancer.ts` — app entry, instantiates both stacks.
   - `infra/lib/frontend-stack.ts` — S3 + OAC + CloudFront + Route53 A-alias + ACM cert (us-east-1).
   - `infra/lib/server-stack.ts` — VPC lookup (default VPC), EC2 + EIP + SG + IAM role for SSM + Route53 A-record.
   - `infra/lib/shared.ts` — shared constants: domain names, hosted zone ID, region.
5. Add `infra/README.md` documenting deploy commands.
6. Update root `.gitignore` to exclude `infra/cdk.out/`, `infra/node_modules/`, `infra/*.js`, `infra/*.d.ts`.
7. Commit: `chore(infra): scaffold CDK app for necromancer deployment`.

**Acceptance:**
- `cd infra && npx cdk synth` runs without errors (produces CloudFormation to stdout).
- No AWS resources created yet.
- Commit pushed to a feature branch `infra/path-c-deploy`, PR opened (or direct to main if Paul prefers — ask).

**Gate:** Paul reviews PR (or direct commit). Claude Code does not deploy until approved.

---

## Phase 2 — GitHub OIDC + CDK bootstrap (20 min, Claude Code)

Get the account ready to accept deploys from this repo.

**Tasks:**
1. Check if `cdk bootstrap` has been run in the target account/region. If not, run it.
2. Check for existing GitHub OIDC provider (`token.actions.githubusercontent.com`). If missing, add a construct to `frontend-stack.ts` (or a new `github-oidc-stack.ts`) that creates it — **but guard it with a context flag** so we don't try to create it twice if portfolio already made it.
3. Create an IAM role `GitHubActions-NecromancerDeploy` with trust policy scoped to:
   - Repo: `paulsantomauro/necromancer-general` (confirm exact repo path with Paul).
   - Branch: `main` only.
4. Attach least-privilege policy: S3 read/write to the game bucket, CloudFront invalidation on the game distribution, EC2 SSM SendCommand on the game instance only.
5. Output the role ARN as a CloudFormation export so the GHA workflow can reference it.
6. Commit: `chore(infra): add GitHub Actions OIDC role`.

**Acceptance:**
- `aws iam get-role --role-name GitHubActions-NecromancerDeploy` succeeds.
- Role's trust policy shows the correct repo + branch condition.

**Gate:** Paul approves the role's permissions before Phase 3 deploys anything real.

---

## Phase 3 — Frontend stack deploy (30 min, Claude Code)

Get the static site live at `necromancer.paulsantomauro.com`, serving a placeholder `index.html` before wiring the real build.

**Tasks:**
1. Flesh out `frontend-stack.ts`:
   - S3 bucket: `necromancer-paulsantomauro-com-site`, versioned, private, OAC-only access.
   - ACM certificate for `necromancer.paulsantomauro.com` in `us-east-1`, DNS-validated against the existing hosted zone.
   - CloudFront distribution: default behavior pointing at S3 via OAC, HTTPS redirect, HTTP/2, compress enabled, price class 100 (NA + EU only — cheaper, fine for a jam).
   - Custom error response: 403/404 → `/index.html` with 200 (SPA-style fallback; Vite doesn't strictly need this but it's cheap insurance).
   - Route53 A-alias record: `necromancer.paulsantomauro.com` → distribution.
2. Deploy: `npx cdk deploy NecromancerFrontendStack`.
3. Upload a placeholder `infra/placeholder/index.html` that says "Necromancer General — deploying soon" so the URL resolves to *something* during the rest of the setup.
4. Invalidate `/*`.
5. Curl `https://necromancer.paulsantomauro.com` and confirm 200 + placeholder content.
6. Commit: `feat(infra): frontend stack live at necromancer.paulsantomauro.com`.

**Acceptance:**
- `curl -I https://necromancer.paulsantomauro.com` returns `200` with a CloudFront header.
- Cert is DNS-validated (no `PENDING_VALIDATION` in ACM console).
- DNS resolves via `dig necromancer.paulsantomauro.com` from Paul's machine.

**Gate:** Paul confirms the URL loads in a browser. Move on.

---

## Phase 4 — Server stack deploy (45 min, Claude Code)

Get a working EC2 box online, reachable at `api.necromancer.paulsantomauro.com`, with the game server running under systemd behind nginx with a valid TLS cert.

**Tasks:**
1. Flesh out `server-stack.ts`:
   - Look up default VPC (simpler than creating one for a single box).
   - Security group: inbound 80 (HTTP, for certbot challenges) + 443 (HTTPS/WSS) from anywhere; outbound all. **No port 22.**
   - IAM instance profile with `AmazonSSMManagedInstanceCore` + permission to pull from the public GitHub repo (no secret needed since it's public).
   - EC2: `t4g.nano`, Amazon Linux 2023 ARM AMI (latest via SSM parameter lookup), 8 GB gp3 root volume.
   - Elastic IP, associated to instance.
   - Route53 A-record: `api.necromancer.paulsantomauro.com` → EIP.
   - User-data script (runs once on first boot) that:
     - Installs Node 20 via `dnf` + nodesource, nginx, certbot with nginx plugin, git.
     - Clones the repo to `/opt/necromancer`.
     - `cd /opt/necromancer/server && npm ci --omit=dev`.
     - Writes `/etc/systemd/system/necromancer.service` pointing at `server/index.js`, `Restart=always`, env `PORT=2567`, runs as a dedicated `necromancer` user.
     - Writes `/etc/nginx/conf.d/necromancer.conf` reverse-proxying `api.necromancer.paulsantomauro.com` → `localhost:2567` with WSS upgrade headers (`Upgrade`, `Connection`, `proxy_http_version 1.1`).
     - Runs `certbot --nginx -d api.necromancer.paulsantomauro.com --non-interactive --agree-tos -m paul@paulsantomauro.com` (confirm email with Paul).
     - Enables + starts `necromancer.service`.
2. **Before running user-data with certbot**, the A-record must already resolve publicly — CDK creates it, but DNS propagation can take a few minutes. User-data should retry certbot 3× with 30s sleep between attempts.
3. Deploy: `npx cdk deploy NecromancerServerStack`.
4. Watch user-data logs via SSM Session Manager: `aws ssm start-session --target <instance-id>`, then `sudo tail -f /var/log/cloud-init-output.log`.
5. Verify health:
   - `curl https://api.necromancer.paulsantomauro.com/socket.io/` should return the Socket.io handshake response (not a 404).
   - From Paul's machine: open browser devtools, run `new WebSocket('wss://api.necromancer.paulsantomauro.com/socket.io/?EIO=4&transport=websocket')` and confirm no TLS errors.
6. Commit: `feat(infra): server stack live with WSS + Let's Encrypt`.

**Acceptance:**
- `systemctl status necromancer` on the box shows `active (running)`.
- Certbot auto-renewal timer is enabled (`systemctl list-timers | grep certbot`).
- WSS handshake succeeds from Paul's browser.

**Gate:** Paul confirms WSS connects. Critical — everything downstream assumes this works.

---

## Phase 5 — Wire client to production server (10 min, Claude Code)

Now that `api.necromancer.paulsantomauro.com` is real, point the client at it.

**Tasks:**
1. Update `.env.production`:
   ```
   VITE_WS_URL=wss://api.necromancer.paulsantomauro.com
   ```
2. Run `npm run build` locally and eyeball the bundle — confirm the URL is baked in.
3. Manually `aws s3 sync dist/ s3://necromancer-paulsantomauro-com-site --delete` and invalidate, as a one-time smoke test *before* automating it in Phase 6.
4. Load `https://necromancer.paulsantomauro.com` in a browser, enter a name, confirm the splash dismisses and the game connects (check devtools Network tab for the WSS upgrade).
5. Open a second browser/incognito window, join with a different name, confirm both players see each other.
6. Commit: `chore: point client at production WSS endpoint`.

**Acceptance:**
- Two generals can see each other in the live deployed game.
- Browser console shows no errors related to WSS, CORS, or mixed content.

**Gate:** Paul plays a test round with a second tab. If it works, proceed.

---

## Phase 6 — GitHub Actions workflows (45 min, Claude Code)

Automate future deploys. Two separate workflows because the client and server have different triggers and targets.

**Tasks:**

### 6a. `.github/workflows/frontend-deploy.yml`
- Trigger: push to `main` touching `src/**`, `index.html`, `vite.config.js`, `package.json`, `package-lock.json`, `.env.production`.
- Steps:
  - Checkout.
  - Setup Node 20.
  - `npm ci`.
  - `npm run build`.
  - Configure AWS credentials via OIDC (role from Phase 2).
  - `aws s3 sync dist/ s3://necromancer-paulsantomauro-com-site --delete`.
  - `aws cloudfront create-invalidation --distribution-id <id> --paths '/*'`.

### 6b. `.github/workflows/server-deploy.yml`
- Trigger: push to `main` touching `server/**`.
- Steps:
  - Checkout.
  - Configure AWS credentials via OIDC.
  - Use SSM `SendCommand` to run a shell script on the EC2 instance:
    ```bash
    cd /opt/necromancer && \
    sudo -u necromancer git pull && \
    cd server && \
    sudo -u necromancer npm ci --omit=dev && \
    sudo systemctl restart necromancer
    ```
  - Poll the command status; fail the workflow if the command exits non-zero.
- Post-deploy sanity check: curl `https://api.necromancer.paulsantomauro.com/socket.io/` and assert 200.

### 6c. Test both workflows
- Push a trivial change to `src/style.css` → frontend workflow runs green → live site updates within ~2 min.
- Push a trivial change to `server/index.js` (e.g. a log line) → server workflow runs green → `journalctl -u necromancer` on the box shows the new log.

**Acceptance:**
- Both workflows green on a test commit.
- Invalidation completes and CloudFront serves the new bundle.
- Server process restarts without dropping connected clients for >5s.

**Gate:** Paul pushes a harmless real change and watches it deploy end-to-end.

---

## Phase 7 — Submission polish (30 min, Claude Code + Paul)

Pre-submission checklist; small but matters for how the entry reads to judges.

**Tasks:**
1. **Meta tags** in `index.html`:
   - `<meta name="description" content="Persistent battlefield multiplayer necromancer game. Summon armies, convert enemies, last general standing wins.">`
   - `<meta property="og:title" content="Necromancer General">`
   - `<meta property="og:description" content="...">`
   - `<meta property="og:image" content="https://necromancer.paulsantomauro.com/og.png">` (needs a 1200×630 image — Paul generates or Claude Code can draft with canvas/SVG).
   - `<meta property="og:url" content="https://necromancer.paulsantomauro.com">`
   - Twitter card variants.
2. **Splash screen "connecting…" state** in `src/ui/SplashScreen.js`:
   - After name submit, show "Connecting to server…" until the socket's `connect` event fires.
   - If connection doesn't fire within 8s, show "Server is waking up, hang tight…" (won't apply on EC2 since it's always-on, but useful defensive UX).
3. **Vibe Jam widget verification:** confirm `<script async src="https://vibej.am/2026/widget.js"></script>` renders the submission badge on the live site (per jam rules).
4. **Smoke test** from a phone/tablet and a fresh browser profile — catch any localhost-only assumptions.
5. **README update** at repo root: how to run locally, how the deploy works, link to live game.
6. Commit: `feat: submission polish — meta tags, connecting state, README`.

**Acceptance:**
- `https://necromancer.paulsantomauro.com` has proper social preview when pasted into a Slack/Discord/Twitter.
- Vibe Jam widget visible on live site.
- Mobile browser loads and connects (game may be unplayable without keyboard but shouldn't be broken).

**Gate:** Paul submits to Vibe Jam 2026.

---

## Phase 8 — Post-submission hardening (later, optional)

Not required to ship. Capture for a follow-up session.

- **Persistent disk for SQLite.** EC2 root volume survives reboots but snapshots/AMI rebuilds would wipe it. Attach an EBS data volume mounted at `/var/lib/necromancer` and point `DB_PATH` there.
- **CloudWatch log shipping** for the necromancer service via the CloudWatch agent.
- **Basic alarm:** CloudWatch alarm on instance status check failure → SNS → email.
- **Automated AMI backups** via AWS Backup (weekly).
- **Cost budget alarm:** $10/mo threshold as a canary.
- **Consider Graviton reserved instance** (1-year, no upfront) — drops t4g.nano to ~$2/mo.

---

## Appendix A — File manifest (what Claude Code will create)

```
necromancer-general/
├── infra/
│   ├── bin/necromancer.ts
│   ├── lib/
│   │   ├── shared.ts
│   │   ├── frontend-stack.ts
│   │   └── server-stack.ts
│   ├── placeholder/index.html
│   ├── cdk.json
│   ├── package.json
│   ├── tsconfig.json
│   └── README.md
├── .github/workflows/
│   ├── frontend-deploy.yml
│   └── server-deploy.yml
├── .env.production         (modified)
├── index.html              (modified: meta tags)
├── src/ui/SplashScreen.js  (modified: connecting state)
├── README.md               (modified or created)
└── PLAN.md                 (this file)
```

## Appendix B — Constants Claude Code will need

| Key | Value |
|---|---|
| AWS region | `us-east-1` |
| Hosted zone ID | `Z095020638ENRIIFCJLK` |
| Apex domain | `paulsantomauro.com` |
| Game client domain | `necromancer.paulsantomauro.com` |
| Game API domain | `api.necromancer.paulsantomauro.com` |
| S3 bucket name | `necromancer-paulsantomauro-com-site` |
| EC2 instance type | `t4g.nano` |
| EC2 AMI | Amazon Linux 2023 ARM64 (latest via SSM param) |
| Server port (internal) | `2567` |
| Let's Encrypt email | *(confirm with Paul — default: paul@paulsantomauro.com)* |
| GitHub repo | *(confirm exact `owner/name` with Paul)* |
| Deploy branch | `main` |
| CDK stack names | `NecromancerFrontendStack`, `NecromancerServerStack` |

## Appendix C — Rollback plan

If Phase 4 (server) goes sideways and we can't debug it quickly:
- `npx cdk destroy NecromancerServerStack` — tears down EC2 + EIP + SG + A-record. No orphaned resources.
- Client stack can stay up indefinitely showing the placeholder.
- Fallback: stand up Render free tier as Path A in ~15 min, update `.env.production`, redeploy frontend. Zero infra lost.

If Phase 3 (frontend) goes sideways:
- `npx cdk destroy NecromancerFrontendStack` — removes S3/CloudFront/A-record. ACM cert persists (free, keep it).

---

## Execution notes for Claude Code

- **Pause at every Gate.** Do not proceed past a gate without Paul's explicit approval in chat.
- **Commit frequently.** One commit per logical chunk; never batch Phase 3 + Phase 4 into one commit.
- **Prefer `cdk diff` before every `cdk deploy`.** Paul reviews the diff, then approves the deploy.
- **Never commit secrets.** The `.env.production` file contains only a public WSS URL — that's fine. Anything sensitive (if added later) goes in SSM Parameter Store or Secrets Manager, not the repo.
- **If stuck for >15 min on a single task**, stop and report back. Don't burn time spiraling.
- **Use the existing portfolio-site CDK as a reference** for patterns (OAC, ACM in us-east-1, OIDC trust policy shape) — but copy *patterns*, not file contents; this repo owns its own infra code.
