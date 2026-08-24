# Deploying to Kubernetes

The image (built by the repository's Dockerfile) carries no configuration
and no secrets; everything arrives at runtime through one Secret. The
manifests here are the whole deployment: Deployment, Service, Ingress.

## First deploy

```bash
# 1. Build and push the image to a registry the cluster can pull from.
docker build -t registry.example.com/semanticui:v1 .
docker push registry.example.com/semanticui:v1

# 2. Create the Secret. Copy the template, fill it in, keep it out of git
#    (k8s/.env is gitignored).
cp k8s/secret.example.env k8s/.env
kubectl create secret generic semanticui-env --from-env-file=k8s/.env

# 3. Set the image and hostname in deployment.yaml / ingress.yaml, then:
kubectl apply -f k8s/
```

## Rolling out a new version

```bash
docker build -t registry.example.com/semanticui:v2 .
docker push registry.example.com/semanticui:v2
kubectl set image deployment/semanticui semanticui=registry.example.com/semanticui:v2
```

The readiness probe gates traffic, so the rollout is zero-downtime. Each
pod runs `alembic upgrade head` before serving; concurrent replicas
serialise on Postgres' own locks, so no separate migration Job is needed.

## Changing configuration

The Secret is read at pod start, so edits need a restart to take effect:

```bash
kubectl create secret generic semanticui-env --from-env-file=k8s/.env \
  --dry-run=client -o yaml | kubectl apply -f -
kubectl rollout restart deployment/semanticui
```

## Notes

- One hostname appears in three places and they must agree: the Ingress
  host, `SEMANTICUI_OAUTH_REDIRECT_URI` in the Secret, and the redirect
  URI the IdP's app registration allows.
- Anyone with `get secrets` RBAC in the namespace can read the values --
  that is how Kubernetes Secrets work. If the manifests are applied by
  GitOps (Argo, Flux), never commit the Secret itself; use Sealed
  Secrets or External Secrets Operator instead.
- Postgres: use a managed database or an operator (e.g. CloudNativePG),
  not a bare Deployment. The app refuses a localhost `database_url` in
  production on purpose.
