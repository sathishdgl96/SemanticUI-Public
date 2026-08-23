# Deploying on AWS ECS (Fargate), against your own Postgres

A runbook for putting this app on ECS when the database is **yours** —
an EC2 instance, a machine in another cloud, or a server in your own
data centre. Nothing here creates a database; step 1 is about reaching
the one you already run.

Read [snowflake-sso.md](snowflake-sso.md) first if sign-in is not set up
yet. This document assumes you have a working `SEMANTICUI_OAUTH_*` set
and only need to know where to put it.

Placeholders used throughout: account `111122223333`, region
`ap-south-1`, domain `reporting.example.com`. Substitute your own.

---

## What you end up with

```
        browser (HTTPS)
              │
        ┌─────▼──────┐   ACM certificate, TLS terminated here
        │    ALB     │   :443 → target group :8000
        └─────┬──────┘
              │  HTTP, private subnets only
      ┌───────▼────────┐
      │  ECS service   │   Fargate tasks, N ≥ 1
      │  one container │   FastAPI + the built SPA in one image
      └───┬────────┬───┘
          │        │
   :5432  │        │  :443 via NAT
  ┌───────▼──┐  ┌──▼──────────────────┐
  │ YOUR     │  │ Snowflake + your IdP │
  │ Postgres │  └──────────────────────┘
  └──────────┘
```

**One container, not two.** The image builds the SPA and the backend
serves it: `SEMANTICUI_STATIC_DIR` is baked in at `/app/static`, and
unknown paths fall back to `index.html` so deep links work. There is no
separate nginx task, no S3 bucket, and no CORS configuration — the API
and the app are one origin. The cost is that a frontend change needs a
new image, which is the right trade when the two ship together anyway.

---

## Before you start

| Decision | What to pick |
|---|---|
| Launch type | **Fargate.** Nothing here needs a host, a GPU or a daemon. |
| Subnets for tasks | **Private, with a NAT gateway.** The tasks must reach Snowflake and your IdP outbound; nothing needs to reach them except the ALB. |
| TLS | **Mandatory.** The session cookie is set `Secure` in any non-dev auth mode (`app/auth/sessions.py`). An HTTP-only listener produces a login loop with no error — the browser silently discards the cookie. |
| Image architecture | `linux/amd64` unless you set the task's `runtimePlatform` to ARM64. Building on an Apple Silicon or ARM laptop without `--platform` produces an image Fargate refuses with `exec format error`. |

---

## Step 1 — Make your Postgres reachable, and prepare it

### 1a. The database and role

On your server:

```sql
CREATE ROLE semanticui LOGIN PASSWORD '<a long random password>';
CREATE DATABASE semanticui OWNER semanticui;
```

The app owns its schema and runs its own migrations, so this role needs
no rights beyond its own database. It does **not** need superuser.

### 1b. Network path from the tasks

Three cases. All of them end with "port 5432 open to the tasks and to
nothing else".

**Postgres on EC2 in the same VPC** — the easy one. Add an inbound rule
on the database's security group:

```bash
aws ec2 authorize-security-group-ingress \
  --group-id sg-postgres \
  --protocol tcp --port 5432 \
  --source-group sg-semanticui-app
```

Referencing the task security group rather than a CIDR means the rule
keeps working as task IPs change, which on Fargate they do on every
deployment.

**Postgres in another VPC** — VPC peering or Transit Gateway, then allow
the task subnets' CIDR. Remember the route tables on *both* sides; a
one-way route produces a connection that hangs rather than refuses,
which reads as a slow app rather than a broken one.

**Postgres on-premises or in another cloud** — the tasks leave through
the NAT gateway, so what your firewall sees is the NAT's Elastic IP, not
the task IPs. Allocate a fixed EIP for the NAT gateway and allowlist
that one address:

```bash
aws ec2 describe-nat-gateways --nat-gateway-ids nat-0abc123 \
  --query 'NatGateways[0].NatGatewayAddresses[0].PublicIp' --output text
```

Better, if you have it: Site-to-Site VPN or Direct Connect, and
allowlist the private CIDR instead. Sending database traffic across the
public internet is a decision to make deliberately, not by default.

### 1c. Require TLS on the connection

Whatever the path, put `sslmode=require` in the URL — and `verify-full`
with a CA bundle if the server presents a certificate you can verify:

```
postgresql+psycopg://semanticui:<password>@db.internal.example.com:5432/semanticui?sslmode=require
```

The driver is psycopg 3 (`postgresql+psycopg`), so `sslmode`,
`sslrootcert` and `connect_timeout` are all understood as URL
parameters. Set `connect_timeout=10` if the database is far away — the
default waits far longer than a health check does, which turns an
unreachable database into a task that hangs on start rather than one
that fails fast.

### 1d. Budget the connections

Each task opens **up to 15** connections to Postgres — SQLAlchemy's
default pool of 5 plus 10 overflow, created lazily
(`app/db/base.py`). So:

```
max_connections  ≥  (tasks × 15)  +  (one-off migration task: 1)  +  your own headroom
```

Four tasks is 60. Postgres' default `max_connections` is 100, which is
enough but not by much — check it before scaling out:

```sql
SHOW max_connections;
SELECT count(*) FROM pg_stat_activity;
```

The engine is created with `pool_pre_ping=True`, so a connection that a
NAT gateway or firewall silently dropped while idle is detected and
replaced rather than handed to a request. This matters specifically for
the on-premises case, where a 350-second NAT idle timeout would
otherwise surface as random `server closed the connection unexpectedly`
errors during quiet periods.

---

## Step 2 — Build and push the image

From the **repository root** (the Dockerfile expects `backend/` and
`frontend/` beside it):

```bash
aws ecr create-repository --repository-name semanticui --region ap-south-1

aws ecr get-login-password --region ap-south-1 \
  | docker login --username AWS --password-stdin 111122223333.dkr.ecr.ap-south-1.amazonaws.com

docker build --platform linux/amd64 -t semanticui:1.0.0 .

docker tag semanticui:1.0.0 111122223333.dkr.ecr.ap-south-1.amazonaws.com/semanticui:1.0.0
docker push          111122223333.dkr.ecr.ap-south-1.amazonaws.com/semanticui:1.0.0
```

**Tag with a version, never `latest`.** ECS resolves the tag when it
starts a task, so a service on `latest` can silently run two different
builds at once during a scale-out, and rolling back means rebuilding
rather than pointing at the previous tag.

Enable scan-on-push while you are here — it costs nothing and reads the
base image's CVE list for you:

```bash
aws ecr put-image-scanning-configuration \
  --repository-name semanticui --image-scanning-configuration scanOnPush=true
```

---

## Step 3 — Put the secrets in Secrets Manager

Three values must never appear in a task definition, where anyone with
`ecs:DescribeTaskDefinition` can read them:

```bash
# 32+ bytes of entropy. Production refuses a short or default key --
# and this key also derives the encryption for stored OAuth tokens, so
# changing it later invalidates every one of them.
aws secretsmanager create-secret --name semanticui/secret-key \
  --secret-string "$(python -c 'import secrets; print(secrets.token_urlsafe(48))')"

aws secretsmanager create-secret --name semanticui/database-url \
  --secret-string 'postgresql+psycopg://semanticui:<password>@db.internal.example.com:5432/semanticui?sslmode=require'

aws secretsmanager create-secret --name semanticui/oauth-client-secret \
  --secret-string '<the client secret VALUE from your IdP or security integration>'
```

The database URL goes in whole rather than assembling it from parts,
because it contains the password.

**Execution role.** The task execution role is what pulls the image and
reads these — not the task role. Attach
`AmazonECSTaskExecutionRolePolicy` plus:

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": ["secretsmanager:GetSecretValue"],
    "Resource": [
      "arn:aws:secretsmanager:ap-south-1:111122223333:secret:semanticui/*"
    ]
  }]
}
```

Add `kms:Decrypt` on the key ARN if you encrypted the secrets with a
customer-managed key.

**The task role can be left unset.** The application makes no AWS API
calls at all — it talks to Postgres, Snowflake and your IdP. Granting it
an AWS identity would be permission it has no use for.

---

## Step 4 — Security groups

Two groups, each allowing exactly one thing in:

```bash
# The load balancer: open to whoever should reach the app.
aws ec2 create-security-group --group-name semanticui-alb \
  --description "SemanticUI ALB" --vpc-id vpc-0abc123
aws ec2 authorize-security-group-ingress --group-id sg-semanticui-alb \
  --protocol tcp --port 443 --cidr 0.0.0.0/0      # or your corporate CIDR

# The tasks: reachable only from the load balancer.
aws ec2 create-security-group --group-name semanticui-app \
  --description "SemanticUI tasks" --vpc-id vpc-0abc123
aws ec2 authorize-security-group-ingress --group-id sg-semanticui-app \
  --protocol tcp --port 8000 --source-group sg-semanticui-alb
```

Egress from `sg-semanticui-app` needs 443 (Snowflake and your IdP) and
5432 (your database). The default all-egress rule covers both; narrow it
if your standards require, but remember Snowflake resolves to a wide
range of addresses and is best allowed by the default rule or a
PrivateLink endpoint.

That "reachable only from the ALB" property is not just hygiene — step 6
depends on it.

---

## Step 5 — The load balancer

```bash
aws elbv2 create-target-group --name semanticui-tg \
  --protocol HTTP --port 8000 --vpc-id vpc-0abc123 --target-type ip \
  --health-check-path /readyz \
  --health-check-interval-seconds 15 \
  --healthy-threshold-count 2 --unhealthy-threshold-count 3 \
  --matcher HttpCode=200
```

**`/readyz`, not `/healthz`.** The two mean different things and the
difference is the point of having both:

- `/readyz` does a real `SELECT 1` against Postgres. It answers "should
  this task receive traffic?" — and if your database is unreachable the
  honest answer is no.
- `/healthz` answers "is the process alive?" and touches nothing. Use
  it for the *container* health check, so a database blip does not
  convince ECS to kill and replace every task in the service at the same
  moment.

Then the listener, and the HTTP → HTTPS redirect:

```bash
aws elbv2 create-load-balancer --name semanticui-alb --type application \
  --subnets subnet-public-a subnet-public-b \
  --security-groups sg-semanticui-alb

aws elbv2 create-listener --load-balancer-arn <alb-arn> \
  --protocol HTTPS --port 443 \
  --certificates CertificateArn=arn:aws:acm:ap-south-1:111122223333:certificate/... \
  --ssl-policy ELBSecurityPolicy-TLS13-1-2-2021-06 \
  --default-actions Type=forward,TargetGroupArn=<tg-arn>

aws elbv2 create-listener --load-balancer-arn <alb-arn> \
  --protocol HTTP --port 80 \
  --default-actions 'Type=redirect,RedirectConfig={Protocol=HTTPS,Port=443,StatusCode=HTTP_301}'
```

### Two attributes that are not optional

```bash
# Reports can run long. The default 60s idle timeout cuts a slow
# Snowflake query off as a 504 that looks like an app bug.
aws elbv2 modify-load-balancer-attributes --load-balancer-arn <alb-arn> \
  --attributes Key=idle_timeout.timeout_seconds,Value=300

# Drain in flight requests, and keep a user on one task for a working
# day -- see step 6 for why stickiness is required, not preferred.
aws elbv2 modify-target-group-attributes --target-group-arn <tg-arn> \
  --attributes \
    Key=deregistration_delay.timeout_seconds,Value=30 \
    Key=stickiness.enabled,Value=true \
    Key=stickiness.type,Value=lb_cookie \
    Key=stickiness.lb_cookie.duration_seconds,Value=28800
```

28800 seconds is 8 hours, matching the default
`SEMANTICUI_SESSION_TTL_HOURS`. If you change one, change the other.

---

## Step 6 — The task definition

Save as `task-definition.json`:

```json
{
  "family": "semanticui",
  "networkMode": "awsvpc",
  "requiresCompatibilities": ["FARGATE"],
  "cpu": "1024",
  "memory": "2048",
  "executionRoleArn": "arn:aws:iam::111122223333:role/semanticuiTaskExecutionRole",
  "containerDefinitions": [
    {
      "name": "app",
      "image": "111122223333.dkr.ecr.ap-south-1.amazonaws.com/semanticui:1.0.0",
      "essential": true,
      "portMappings": [{ "containerPort": 8000, "protocol": "tcp" }],

      "command": [
        "python", "-m", "uvicorn", "app.main:app",
        "--host", "0.0.0.0", "--port", "8000",
        "--timeout-keep-alive", "310",
        "--forwarded-allow-ips", "*"
      ],

      "environment": [
        { "name": "SEMANTICUI_ENVIRONMENT",        "value": "production" },
        { "name": "SEMANTICUI_AUTH_MODE",          "value": "oauth" },
        { "name": "SEMANTICUI_APP_NAME",           "value": "Acme Reporting" },
        { "name": "SEMANTICUI_SNOWFLAKE_ACCOUNT",  "value": "myorg-myaccount" },
        { "name": "SEMANTICUI_OAUTH_CLIENT_ID",    "value": "<application (client) id>" },
        { "name": "SEMANTICUI_OAUTH_REDIRECT_URI", "value": "https://reporting.example.com/auth/callback" },
        { "name": "SEMANTICUI_OAUTH_AUTHORIZE_URL","value": "https://login.microsoftonline.com/<tenant>/oauth2/v2.0/authorize" },
        { "name": "SEMANTICUI_OAUTH_TOKEN_URL",    "value": "https://login.microsoftonline.com/<tenant>/oauth2/v2.0/token" },
        { "name": "SEMANTICUI_OAUTH_SCOPE",        "value": "api://<app-id-uri>/session:role:analyst offline_access" },
        { "name": "SEMANTICUI_APP_ADMINS",         "value": "[\"A_SMITH\",\"J_PATEL\"]" }
      ],

      "secrets": [
        { "name": "SEMANTICUI_SECRET_KEY",          "valueFrom": "arn:aws:secretsmanager:ap-south-1:111122223333:secret:semanticui/secret-key" },
        { "name": "SEMANTICUI_DATABASE_URL",        "valueFrom": "arn:aws:secretsmanager:ap-south-1:111122223333:secret:semanticui/database-url" },
        { "name": "SEMANTICUI_OAUTH_CLIENT_SECRET", "valueFrom": "arn:aws:secretsmanager:ap-south-1:111122223333:secret:semanticui/oauth-client-secret" }
      ],

      "healthCheck": {
        "command": ["CMD-SHELL", "curl -fsS http://localhost:8000/healthz || exit 1"],
        "interval": 30, "timeout": 5, "retries": 3, "startPeriod": 30
      },

      "logConfiguration": {
        "logDriver": "awslogs",
        "options": {
          "awslogs-group": "/ecs/semanticui",
          "awslogs-region": "ap-south-1",
          "awslogs-stream-prefix": "app",
          "awslogs-create-group": "true"
        }
      }
    }
  ]
}
```

```bash
aws ecs register-task-definition --cli-input-json file://task-definition.json
```

Three things in that file are load-bearing and easy to get wrong.

### The `command` override, and why it drops the migration

The image's own `CMD` is `alembic upgrade head && uvicorn ...`, which is
right for `docker compose up` and wrong for ECS. A rolling deployment
starts several tasks at once, and a migration that fails takes *every*
task down with it — the service then flaps while ECS retries, and the
version you were replacing is already gone. Overriding `command` to run
only uvicorn moves schema changes to the deliberate, one-shot step 7.

### `--timeout-keep-alive 310` must exceed the ALB idle timeout

If the app closes an idle keep-alive socket first, the ALB can send a
request down a connection that is already going away and answer the user
a **502**. It is intermittent, it correlates with quiet periods, and it
is one of the most-reported ALB-plus-Python symptoms there is. Keeping
the app's timeout above the load balancer's makes the ALB always the one
that closes. 310 > 300 from step 5; if you change the idle timeout,
change this too.

### `--forwarded-allow-ips "*"` restores per-client throttling

The sign-in throttle keys on the client address
(`request.client.host`). Behind a load balancer that address is the
*ALB's* private IP for every user on earth unless uvicorn is told to
trust `X-Forwarded-For` — and uvicorn trusts it from `127.0.0.1` only by
default. Leave this off and the design property in
[../SECURITY.md](../SECURITY.md) — "one person's typo cannot lock out an
office behind a shared NAT" — silently inverts: one person's typos throttle
the whole company.

Trusting `*` is safe **because of step 4**: the task's security group
permits port 8000 from the ALB security group alone, so no client can
present a forged header directly. If you ever open that port more
widely, this value has to be narrowed with it.

---

## Step 7 — Run the migrations, once

Before the first deployment and before every subsequent one, run the
schema forward as a one-off task using the same task definition:

```bash
TASK_ARN=$(aws ecs run-task \
  --cluster semanticui \
  --task-definition semanticui \
  --launch-type FARGATE \
  --network-configuration 'awsvpcConfiguration={subnets=[subnet-private-a,subnet-private-b],securityGroups=[sg-semanticui-app],assignPublicIp=DISABLED}' \
  --overrides '{"containerOverrides":[{"name":"app","command":["python","-m","alembic","upgrade","head"]}]}' \
  --query 'tasks[0].taskArn' --output text)

aws ecs wait tasks-stopped --cluster semanticui --tasks "$TASK_ARN"

aws ecs describe-tasks --cluster semanticui --tasks "$TASK_ARN" \
  --query 'tasks[0].containers[0].{exit:exitCode,reason:reason}'
```

**Exit code 0 or stop.** A non-zero code means the schema did not move;
deploying the app on top of that is how you get a half-migrated
database. The output lands in the same CloudWatch log group, under a
stream you can read with `aws logs tail /ecs/semanticui --follow`.

The same task definition is used deliberately — it already has the
database URL, the network placement and the log configuration, so the
migration runs against exactly the database the app will use, with no
second copy of the connection string to drift.

Migrations here are additive and reversible, so the ordering that works
is: **migrate first, then deploy the new image.** The running old
version tolerates the new schema.

---

## Step 8 — Create the service

```bash
aws ecs create-cluster --cluster-name semanticui

aws ecs create-service \
  --cluster semanticui \
  --service-name semanticui \
  --task-definition semanticui \
  --desired-count 2 \
  --launch-type FARGATE \
  --network-configuration 'awsvpcConfiguration={subnets=[subnet-private-a,subnet-private-b],securityGroups=[sg-semanticui-app],assignPublicIp=DISABLED}' \
  --load-balancers 'targetGroupArn=<tg-arn>,containerName=app,containerPort=8000' \
  --health-check-grace-period-seconds 60 \
  --deployment-configuration 'minimumHealthyPercent=100,maximumPercent=200'
```

`minimumHealthyPercent=100` with `maximumPercent=200` is a
blue/green-shaped rolling deploy: new tasks must pass the target group's
health check before old ones are drained, so a broken image never
removes capacity.

---

## Step 9 — Point sign-in at the ALB

Create the DNS record — an alias to the ALB — then make three values
agree exactly:

| Where | Value |
|---|---|
| `SEMANTICUI_OAUTH_REDIRECT_URI` | `https://reporting.example.com/auth/callback` |
| Your IdP app registration → Redirect URIs | the same string, character for character |
| Snowflake security integration, if using Snowflake's own OAuth | the same string again |

A mismatch — a trailing slash, `http` instead of `https`, the ALB's
`*.elb.amazonaws.com` name in one place and your domain in another — is
refused by the IdP before the app is ever reached, which is why the
error appears on Microsoft's or Snowflake's page rather than yours.

Leave `SEMANTICUI_POST_LOGIN_REDIRECT_URL` unset. Its default `/` is
correct here: the SPA is served from the same origin, so the callback
lands back on the app with no cross-origin anything.

Then sign in once as a user named in `SEMANTICUI_APP_ADMINS` and open
**Admin → Operations**. It checks the UI, the backend and the database
round trip in one place, which is a faster answer than reading three
CloudWatch streams.

---

## Running more than one task

Sessions are rows in Postgres, so they survive a task being replaced.
Three pieces of state are **per process**, and they decide how you scale:

| State | Where | Consequence of a second task |
|---|---|---|
| **OAuth `state` + PKCE verifier** | `app/auth/oauth.py`, a process-global dict | `/auth/login` on task A, IdP redirect back to `/auth/callback` on task B → the state is unknown and sign-in is refused. Roughly half of all sign-ins fail with two tasks. |
| **Sign-in throttle** | `app/auth/throttle.py`, in-memory sliding window | The limit is per task, so N tasks means N times the attempts before throttling engages. |
| **Snowflake connection cache** | `app/snowflake/provider.py`, keyed by session | A user landing on a task that has not seen them rebuilds their Snowflake connection from the stored token. Correct, but it costs a round trip and holds a second connection open. |

**Stickiness from step 5 addresses all three.** The `AWSALB` cookie is
set on the browser's first request, and the IdP's redirect back is a
top-level navigation that carries it, so the callback returns to the
task that issued the state. It also keeps each user on one connection
cache for their working day.

Stickiness is a deployment workaround, not a fix. The durable answer is
to move the OAuth state into Postgres beside the session rows; until
that exists, do not run multiple tasks without stickiness enabled, and
verify it after any target group change:

```bash
aws elbv2 describe-target-group-attributes --target-group-arn <tg-arn> \
  --query "Attributes[?starts_with(Key,'stickiness')]"
```

### Sizing for 500 users

The app is I/O bound — it waits on Snowflake, it does not compute — so
tasks are sized for concurrency and memory, not CPU.

| Users | Tasks | Task size | Postgres connections |
|---|---|---|---|
| ≤ 100 | 2 | 0.5 vCPU / 1 GB | ≤ 30 |
| ≤ 500 | 3–4 | 1 vCPU / 2 GB | ≤ 60 |

Two tasks is the floor regardless of load: one task means a deployment
is an outage. Memory is the constraint that bites first, because each
task caches up to `SEMANTICUI_CONNECTION_CACHE_MAX` (default 100)
Snowflake connections along with their describe results.

Scale on request count rather than CPU — CPU stays low while every user
waits on a warehouse:

```bash
aws application-autoscaling register-scalable-target \
  --service-namespace ecs --scalable-dimension ecs:service:DesiredCount \
  --resource-id service/semanticui/semanticui --min-capacity 2 --max-capacity 6

aws application-autoscaling put-scaling-policy \
  --service-namespace ecs --scalable-dimension ecs:service:DesiredCount \
  --resource-id service/semanticui/semanticui \
  --policy-name requests-per-target --policy-type TargetTrackingScaling \
  --target-tracking-scaling-policy-configuration '{
    "TargetValue": 600.0,
    "PredefinedMetricSpecification": {
      "PredefinedMetricType": "ALBRequestCountPerTarget",
      "ResourceLabel": "app/semanticui-alb/<alb-id>/targetgroup/semanticui-tg/<tg-id>"
    },
    "ScaleInCooldown": 300, "ScaleOutCooldown": 60
  }'
```

Scale in slowly. Every task removed discards a connection cache and
sends its users through a reconnect.

---

## Updating the app

```bash
docker build --platform linux/amd64 -t semanticui:1.1.0 .
docker tag semanticui:1.1.0 111122223333.dkr.ecr.ap-south-1.amazonaws.com/semanticui:1.1.0
docker push 111122223333.dkr.ecr.ap-south-1.amazonaws.com/semanticui:1.1.0

# 1. Register the new revision (edit the image tag in task-definition.json).
aws ecs register-task-definition --cli-input-json file://task-definition.json

# 2. Migrate, using the NEW revision. Stop here on a non-zero exit code.
#    (step 7, with --task-definition semanticui:<new revision>)

# 3. Roll it out.
aws ecs update-service --cluster semanticui --service semanticui \
  --task-definition semanticui:<new revision>

aws ecs wait services-stable --cluster semanticui --services semanticui
```

Rolling back is `update-service` pointed at the previous revision — which
works because you tagged the image with a version in step 2. If the bad
release included a migration, roll the schema back first with
`alembic downgrade -1` through the same one-off task; the migrations are
written reversible for exactly this.

---

## Logs, and what to look at when

| Question | Where |
|---|---|
| Is the app up, and how fast is each layer? | **Admin → Operations** in the app |
| Who did what? | **Admin → Activity** — the audit trail, filterable, value-free by contract |
| Failed sign-ins, throttling, refusals | **Admin → Security** |
| Why did a task not start? | `aws ecs describe-tasks ... --query 'tasks[0].stoppedReason'` |
| Application logs | `aws logs tail /ecs/semanticui --follow` |
| A specific request | Search the log group for the request id from the response; it also appears on the audit row, and joins to Snowflake's `QUERY_HISTORY` through the logged query id |

Set a retention policy — CloudWatch keeps logs forever and bills for it:

```bash
aws logs put-retention-policy --log-group-name /ecs/semanticui --retention-in-days 90
```

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Task starts, then stops; `ResourceInitializationError` on a secret | Execution role cannot read Secrets Manager, or the task is in a private subnet with no NAT and no VPC endpoint | Attach the policy from step 3; add a NAT gateway or a `secretsmanager` interface endpoint |
| `exec format error` | Image built for ARM on an Apple Silicon machine | Rebuild with `--platform linux/amd64` |
| Target group never becomes healthy | `/readyz` cannot reach your Postgres | Check the database security group (step 1b), then run the migration task — its logs show the real connection error |
| Sign-in bounces back to the login page, no error | The session cookie is `Secure` and the listener is plain HTTP | Terminate TLS at the ALB; use the HTTPS listener |
| Sign-in fails intermittently, "invalid state" | Multiple tasks without stickiness | Enable `lb_cookie` stickiness (step 5) |
| One user's failed sign-ins throttle everyone | `--forwarded-allow-ips` not set; every request looks like it came from the ALB | Add it to `command` (step 6) |
| Random 502s during quiet periods | Keep-alive race with the ALB | `--timeout-keep-alive` must exceed the ALB idle timeout |
| Long reports die at ~60 seconds with a 504 | Default ALB idle timeout | Raise `idle_timeout.timeout_seconds` (step 5) |
| `server closed the connection unexpectedly` after idle | NAT or firewall dropped an idle database connection | Already mitigated by `pool_pre_ping`; if it persists, lower the NAT idle timeout expectation with `keepalives_idle=60` in the database URL |
| `AUTH_MODE=dev is not allowed in production` at start | Exactly what it says; the guard is deliberate | Set `SEMANTICUI_AUTH_MODE=oauth` |
| `redirect_uri_mismatch` on the IdP's page | The three values in step 9 disagree | Make them identical, including scheme and trailing slash |

---

## See also

- [snowflake-sso.md](snowflake-sso.md) — app registration and the
  Snowflake security integration, which step 9 assumes
- [../SECURITY.md](../SECURITY.md) — the threat model, and the known
  weaknesses an operator should read before deploying
- [../FEATURES.md](../FEATURES.md) — what the deployment offers
- [xmla-reliability.md](xmla-reliability.md) — Excel live connections
