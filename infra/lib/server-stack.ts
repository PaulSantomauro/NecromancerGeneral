import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as route53 from 'aws-cdk-lib/aws-route53';
import { Construct } from 'constructs';
import {
  API_DOMAIN,
  APEX_DOMAIN,
  GITHUB_OWNER,
  GITHUB_REPO,
  HOSTED_ZONE_ID,
  LETSENCRYPT_EMAIL,
  SERVER_PORT,
} from './shared';

export class NecromancerServerStack extends cdk.Stack {
  public readonly instance: ec2.Instance;
  public readonly eip: ec2.CfnEIP;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const vpc = ec2.Vpc.fromLookup(this, 'DefaultVpc', { isDefault: true });

    const hostedZone = route53.HostedZone.fromHostedZoneAttributes(this, 'HostedZone', {
      hostedZoneId: HOSTED_ZONE_ID,
      zoneName: APEX_DOMAIN,
    });

    const securityGroup = new ec2.SecurityGroup(this, 'ServerSG', {
      vpc,
      description: 'Necromancer game server - HTTP/HTTPS in from anywhere, no SSH.',
      allowAllOutbound: true,
    });
    securityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), 'HTTP (certbot challenge + redirect)');
    securityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'HTTPS / WSS');

    const role = new iam.Role(this, 'ServerInstanceRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      description: 'Necromancer EC2 role - SSM Session Manager access only.',
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
      ],
    });

    const repoUrl = `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}.git`;

    const userData = ec2.UserData.custom(`#!/bin/bash
set -euxo pipefail
exec > >(tee -a /var/log/necromancer-userdata.log) 2>&1

echo "[userdata] starting at $(date -Iseconds)"

# --- Swap (t4g.nano only has 512 MB RAM; npm install can OOM without it) ---
if [ ! -f /swapfile ]; then
  dd if=/dev/zero of=/swapfile bs=1M count=1024
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

# --- Packages ---
dnf update -y
dnf install -y git nginx tar gzip make gcc gcc-c++ python3 python3-pip augeas-libs

# Node.js 20 via NodeSource
curl -fsSL https://rpm.nodesource.com/setup_20.x | bash -
dnf install -y nodejs

# Certbot (AL2023 has no EPEL; install via pip into a venv)
python3 -m venv /opt/certbot
/opt/certbot/bin/pip install --upgrade pip
/opt/certbot/bin/pip install certbot certbot-nginx
ln -sf /opt/certbot/bin/certbot /usr/bin/certbot

# --- App user + clone ---
if ! id necromancer >/dev/null 2>&1; then
  useradd --system --create-home --home-dir /opt/necromancer-home --shell /bin/bash necromancer
fi

if [ ! -d /opt/necromancer/.git ]; then
  git clone --depth=1 ${repoUrl} /opt/necromancer
fi
chown -R necromancer:necromancer /opt/necromancer

# --- Install server deps ---
cd /opt/necromancer/server
sudo -u necromancer npm ci --omit=dev

# --- systemd service ---
cat > /etc/systemd/system/necromancer.service <<'UNIT'
[Unit]
Description=Necromancer General game server
After=network-online.target
Wants=network-online.target

[Service]
User=necromancer
Group=necromancer
WorkingDirectory=/opt/necromancer/server
ExecStart=/usr/bin/node index.js
Environment=NODE_ENV=production
Environment=PORT=${SERVER_PORT}
Restart=always
RestartSec=3
# Allow fast graceful shutdown so deploys don't stall
TimeoutStopSec=10

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable --now necromancer.service

# --- nginx reverse proxy (HTTP only for now; certbot will add HTTPS) ---
cat > /etc/nginx/conf.d/necromancer.conf <<'NGINX'
server {
  listen 80;
  server_name ${API_DOMAIN};

  # ACME HTTP-01 challenge is handled by certbot's nginx plugin.

  location / {
    proxy_pass http://127.0.0.1:${SERVER_PORT};
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 86400;
    proxy_send_timeout 86400;
  }
}
NGINX

# Remove AL2023 default server block so our config owns port 80 cleanly
if grep -q 'default_server' /etc/nginx/nginx.conf; then
  sed -i 's/listen       80 default_server;/# disabled by necromancer bootstrap/' /etc/nginx/nginx.conf || true
  sed -i 's/listen       \\[::\\]:80 default_server;/# disabled by necromancer bootstrap/' /etc/nginx/nginx.conf || true
fi

nginx -t
systemctl enable --now nginx
systemctl reload nginx || systemctl restart nginx

# --- Let's Encrypt (retry; A-record + EIP association may need a moment) ---
CERT_OK=0
for i in 1 2 3 4 5 6; do
  if certbot --nginx -d ${API_DOMAIN} \
      --non-interactive --agree-tos -m ${LETSENCRYPT_EMAIL} \
      --redirect --no-eff-email; then
    CERT_OK=1
    echo "[userdata] certbot attempt $i succeeded"
    break
  fi
  echo "[userdata] certbot attempt $i failed, sleeping 30s"
  sleep 30
done

if [ "$CERT_OK" != "1" ]; then
  echo "[userdata] WARNING: certbot failed after 6 attempts — continuing; fix manually via SSM."
fi

# --- certbot renewal timer (AL2023 venv install has no default timer) ---
cat > /etc/systemd/system/certbot-renew.service <<'SVC'
[Unit]
Description=Let's Encrypt certificate renewal

[Service]
Type=oneshot
ExecStart=/usr/bin/certbot renew --quiet --deploy-hook "systemctl reload nginx"
SVC

cat > /etc/systemd/system/certbot-renew.timer <<'TMR'
[Unit]
Description=Run certbot renew twice daily with jitter

[Timer]
OnCalendar=*-*-* 00,12:00:00
RandomizedDelaySec=3600
Persistent=true

[Install]
WantedBy=timers.target
TMR

systemctl daemon-reload
systemctl enable --now certbot-renew.timer

echo "[userdata] done at $(date -Iseconds)"
`);

    this.instance = new ec2.Instance(this, 'ServerInstance', {
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.NANO),
      machineImage: ec2.MachineImage.latestAmazonLinux2023({
        cpuType: ec2.AmazonLinuxCpuType.ARM_64,
      }),
      blockDevices: [{
        deviceName: '/dev/xvda',
        volume: ec2.BlockDeviceVolume.ebs(8, {
          volumeType: ec2.EbsDeviceVolumeType.GP3,
          encrypted: true,
          deleteOnTermination: true,
        }),
      }],
      securityGroup,
      role,
      userData,
      requireImdsv2: true,
    });

    // Elastic IP, associated via CfnEIPAssociation (separate resource so the
    // Route53 A-record below can depend only on the allocation — not on the
    // instance — and resolve correctly the moment user-data starts.)
    this.eip = new ec2.CfnEIP(this, 'ServerEip', {
      domain: 'vpc',
      tags: [{ key: 'Name', value: 'necromancer-api' }],
    });

    new ec2.CfnEIPAssociation(this, 'ServerEipAssoc', {
      eip: this.eip.ref,
      instanceId: this.instance.instanceId,
    });

    const apiARecord = new route53.ARecord(this, 'ApiAliasRecord', {
      zone: hostedZone,
      recordName: API_DOMAIN,
      target: route53.RecordTarget.fromIpAddresses(this.eip.ref),
      ttl: cdk.Duration.minutes(5),
    });
    // Ensure DNS exists before the instance's user-data starts calling certbot.
    this.instance.node.addDependency(apiARecord);

    new cdk.CfnOutput(this, 'InstanceId', {
      value: this.instance.instanceId,
      exportName: 'NecromancerInstanceId',
    });
    new cdk.CfnOutput(this, 'ElasticIp', {
      value: this.eip.ref,
      exportName: 'NecromancerElasticIp',
    });
    new cdk.CfnOutput(this, 'ApiUrl', {
      value: `https://${API_DOMAIN}`,
    });
    new cdk.CfnOutput(this, 'SsmShell', {
      value: `aws ssm start-session --target ${this.instance.instanceId}`,
      description: 'Shell onto the instance via SSM Session Manager.',
    });
  }
}
