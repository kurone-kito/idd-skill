<!-- cspell:words BYOC Defang DigitalOcean dotenv Postgres PostgreSQL -->
<!-- cspell:words Pulumi Redis whoami -->

# Bonus: Deploy with Defang

This bonus path shows how to take the workshop app from local Docker
Compose to a Defang deployment. Treat it as optional: the core workshop
is complete once the local app runs and the IDD loop has merged the MVP.

Use this document as a runbook. The agent can prepare commands, inspect
repository files, and record evidence, but the reader must complete the
authentication and account choices that require a browser or production
credentials.

## Human-required steps at a glance

> **Human action required:** Sign in to Defang with `defang login` when
> the CLI opens a browser flow. Use the Defang account you want tied to
> this workshop deployment.
>
> **Human action required:** Decide whether this is a learning
> deployment in Defang Playground or a BYOC deployment in your cloud
> account. Do not let an agent pick a production cloud account on your
> behalf.
>
> **Human action required:** Confirm any real secrets before they are
> stored with `defang config set`. The agent may prepare the command,
> but a human should provide secret values.

## Source references

The command examples below are based on the official Defang docs checked
on 2026-05-16:

- [Getting Started](https://docs.defang.io/docs/intro/getting-started)
- [`defang login`](https://docs.defang.io/docs/cli/defang_login)
- [`defang compose up`](https://docs.defang.io/docs/cli/defang_compose_up)
- [`defang compose ps`](https://docs.defang.io/docs/cli/defang_compose_ps)
- [`defang compose logs`](https://docs.defang.io/docs/cli/defang_compose_logs)
- [`defang config create`](https://docs.defang.io/docs/cli/defang_config_create)
- [`defang tail`](https://docs.defang.io/docs/cli/defang_tail)
- [`defang version`](https://docs.defang.io/docs/cli/defang_version)
- [`defang whoami`](https://docs.defang.io/docs/cli/defang_whoami)
- [Configuration](https://docs.defang.io/docs/concepts/configuration)
- [Observability](https://docs.defang.io/docs/concepts/observability)

## 1. Confirm the app is ready for deployment

Run these commands from the example repository root:

```sh
test -f compose.yaml
docker compose config
docker compose up --build
```

Keep this step local. Defang reads a Compose file, so the app should
already have a valid `compose.yaml` and should boot locally before
cloud deployment begins.

Record the local evidence in the workshop log:

- The commit SHA being deployed
- The Compose services that started locally
- Any environment variables that still need real values

## 2. Install or verify the Defang CLI

Agent-executable command:

```sh
if ! command -v defang >/dev/null 2>&1; then
  eval "$(curl -fsSL s.defang.io/install)"
fi

defang version
```

If the install script asks to update `PATH`, accept only for the current
workshop environment. If the shell cannot find `defang` after
installation, restart the shell or follow the path instruction printed
by the installer.

Alternative installation commands from Defang's getting started docs:

```sh
brew install DefangLabs/defang/defang
winget install defang
nix profile install github:DefangLabs/defang#defang-bin --refresh
```

## 3. Authenticate

Agent-prepared command:

```sh
defang login
```

> **Human action required:** Complete the browser login. Defang's
> authentication docs describe this as opening a browser and signing in
> to a Defang account. The Defang account is separate from any cloud
> provider account used for BYOC deployments.

After login, the agent can verify the session:

```sh
defang whoami
```

If login fails, stop the deployment path and record the failure in the
workshop log. Do not retry with a different account unless the human
explicitly chooses one.

## 4. Configure deployment values

Set the Defang context before storing config values or deploying. Keep
these variables in the shell that will run the remaining commands:

```sh
DEFANG_PROJECT_NAME=vrc-event-calendar

# Choose one provider after the human deployment decision:
# defang, aws, gcp, digitalocean, or azure.
DEFANG_PROVIDER=defang
```

> **Human action required:** Confirm the provider value before the agent
> stores secrets or deploys. Use `defang` for Defang Playground, or the
> exact BYOC provider chosen for the workshop cloud account.

Review `compose.yaml` for environment variable references before
deploying. Do not dump a real `.env` file into the workshop log.

```sh
for file in compose.yaml compose.yml .env.example; do
  if test -f "$file"; then
    grep -nE 'environment:|env_file:|\$\{' "$file" || true
  fi
done
```

If the app uses non-secret values, prefer `.env` or the Compose file.
If the app needs secrets, use Defang config values.

Agent-prepared command for a secret placeholder:

```sh
defang config set DATABASE_URL \
  --provider "$DEFANG_PROVIDER" \
  --project-name "$DEFANG_PROJECT_NAME"
```

`defang config set` is the short alias for `defang config create`.

> **Human action required:** Enter the real secret value when prompted.
> Do not paste secrets into issue comments, PR descriptions, or the
> workshop log.

The deployed service can reference a Defang config value from Compose by
leaving the value blank or null:

```yaml
services:
  web:
    environment:
      DATABASE_URL:
```

## 5. Deploy the Compose project

For a learning deployment in Defang Playground, keep
`DEFANG_PROVIDER=defang` and run:

```sh
defang compose up \
  --provider "$DEFANG_PROVIDER" \
  --project-name "$DEFANG_PROJECT_NAME"
```

For BYOC, first update `DEFANG_PROVIDER` to the selected provider, then
run the same deployment command:

```sh
DEFANG_PROVIDER=aws

defang compose up \
  --provider "$DEFANG_PROVIDER" \
  --project-name "$DEFANG_PROJECT_NAME"
```

Replace `aws` with `gcp`, `digitalocean`, or `azure` when that is the
human-approved BYOC provider.

The `defang compose up` command deploys a new project or updates an
existing one. It tails deployment output by default, so keep the
terminal open until Defang reports the service state and URL.

Record these details in the workshop log:

- The provider and project name
- The deployment ID, if printed
- The public service URL
- Whether the service reached a running or healthy state

## 6. Verify the deployment

Agent-executable commands:

```sh
defang compose ps \
  --provider "$DEFANG_PROVIDER" \
  --project-name "$DEFANG_PROJECT_NAME"

defang compose logs \
  --provider "$DEFANG_PROVIDER" \
  --project-name "$DEFANG_PROJECT_NAME" \
  --since 10m

defang tail \
  --provider "$DEFANG_PROVIDER" \
  --project-name "$DEFANG_PROJECT_NAME" \
  --deployment latest \
  --since 10m
```

Then verify the app URL in a browser or with `curl`:

```sh
curl -fsS "<service-url-from-defang-output>" >/dev/null
```

> **Human action required:** If this deployment exposes real data,
> verify that the published URL and provider choice are acceptable
> before sharing it outside the workshop.

For workshop evidence, capture:

- A screenshot or terminal excerpt showing the service URL
- A successful HTTP response from the app
- A short log excerpt showing the app started cleanly

## 7. Update or redeploy

After code changes, repeat the deployment command:

```sh
defang compose up \
  --provider "$DEFANG_PROVIDER" \
  --project-name "$DEFANG_PROJECT_NAME"
```

Use `--force` only when you intentionally want Defang to rebuild even if
the CLI does not detect a change:

```sh
defang compose up \
  --provider "$DEFANG_PROVIDER" \
  --project-name "$DEFANG_PROJECT_NAME" \
  --force
```

If the command fails, collect logs first:

```sh
defang compose logs \
  --provider "$DEFANG_PROVIDER" \
  --project-name "$DEFANG_PROJECT_NAME" \
  --type ALL \
  --since 30m
```

Then fix the app in a normal IDD issue, open a PR, and redeploy after
the fix merges.

## 8. End the bonus path safely

When the workshop is finished, record whether the Defang deployment is
still needed. If it is only a temporary demo, ask the human before
removing it.

> **Human action required:** Confirm whether the deployed service should
> stay online, be moved to a production account, or be deleted.

If a cleanup issue is created later, include:

- Provider and project name
- Service URL
- Whether secrets were stored with `defang config`
- Any billing or quota notes from the human operator
