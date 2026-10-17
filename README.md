<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="./deploy/layers/qm-cn/deploy/brand/moqi-lockup-dark.svg">
  <img src="./deploy/layers/qm-cn/deploy/brand/moqi-lockup.svg" alt="默契 Moqi" height="72">
</picture>

# Moqi · 默契

### A self-hosted AI coworker for teams that work in Chinese

[简体中文](./README.zh-CN.md) · English

</div>

Moqi is a distribution of [QM](https://github.com/yc-software/qm), the multiplayer agent harness for work. It keeps QM's core (scoped memory, files, sandboxes, projects and the web UI) and adapts it for organisations in mainland China that run their own models and sign in with their own accounts.

## What it adds to QM

- A Chinese interface, applied at build time from a line catalog, with English kept as the source.
- Provider templates for DeepSeek, Qwen, Zhipu GLM, Moonshot Kimi and Volcengine Ark, so the agent can run on providers reachable from the mainland.
- Work features for a whole team: a people directory with contact details, department documents, project boards, a Files recycle bin, palettes for each person, a growth handbook for new users, and adoption reports for administrators.
- Release notes in the product, under Settings → Version.

## Deploy Moqi

Moqi is deployed from this source tree. The `@yc-software/qm` package and the images it pulls are QM's own releases, so deploying the package deploys QM, not Moqi.

You need Linux with Docker, Node.js 24.15.0 or later with npm 11.10.0 or later on the machine you deploy from, and credentials for at least one model provider.

1. Complete the provider setup in [deployment.md](./deployment.md), then follow [Customize and run your source](#customize-and-run-your-source) below, always with `--build-from .` so every image is built from this tree. [`deploy/layers/qm-cn/deploy/qm.config.jsonc.example`](./deploy/layers/qm-cn/deploy/qm.config.jsonc.example) is a single-host Docker configuration to start from, and [`deploy/layers/qm-cn/providers/`](./deploy/layers/qm-cn/providers/) holds the provider templates.
2. Before the web UI image is built, stamp the version, its release notes and the palettes into the page:

   ```bash
   python3 deploy/layers/qm-cn/scripts/stamp-product-version.py plugins/web-ui/index.html
   ```

3. Copy the layer's [`skills/`](./deploy/layers/qm-cn/skills/) into `<deployment-dir>/sandbox/skills`. The docker target mounts that directory at `/layer` and sets `DEPLOYMENT_LAYER` for you, and the core installs the skills at start. On other targets, set `DEPLOYMENT_LAYER` to a directory that holds `skills/`. See [`deploy/layers/README.md`](./deploy/layers/README.md) for the layout.
4. The office and slide skills need the sandbox image described in [`deploy/layers/qm-cn/sandbox/README.md`](./deploy/layers/qm-cn/sandbox/README.md).
5. Optional:
   - Set the home page's scenes with `node deploy/layers/qm-cn/scripts/apply-webui-home.mjs <deployment-dir>` once the core is running. It reads `CORE_SIGNING_SECRET` from that directory's `.env`.
   - Start the organisation's soul from [`deploy/layers/qm-cn/soul/org-soul.zh.md`](./deploy/layers/qm-cn/soul/org-soul.zh.md) in the admin console.

Keep your own configuration, runbooks and anything private in `deploy/layers/qm-cn/private/`, which is ignored, or in a separate private repository.

## How this repository works

Each Moqi release is published here as one commit on top of QM's history, so `git log` shows upstream's work and one entry per Moqi release. Development happens elsewhere.

Issues and pull requests are welcome; see [CONTRIBUTING.md](./CONTRIBUTING.md). It governs contributions to Moqi; the contributing section in QM's README below applies to QM itself. Report security problems privately, as described in [SECURITY.md](./SECURITY.md).

## Licence

MIT. See [LICENSE](./LICENSE) and [NOTICE](./NOTICE). Thanks to QM and its contributors.

The rest of this page is QM's own README. It describes the core Moqi is built on; where it says QM, Moqi behaves the same way.

---

<p align="center">
  <img src="docs/images/qm-logo.png" alt="QM" width="120">
</p>

<div align="center">

English · [简体中文](./README.zh-CN.md)

**A multiplayer agent harness for work. In Slack and on the web.**<br>
Run it in your own cloud, with your own models and keys.

[![CI](https://img.shields.io/github/actions/workflow/status/yc-software/qm/cicd.yml?branch=main&label=CI&style=flat-square)](https://github.com/yc-software/qm/actions/workflows/cicd.yml)
[![license](https://img.shields.io/badge/license-MIT-4c1?style=flat-square)](./LICENSE)
[![node](https://img.shields.io/badge/node-24.15%2B-3178c6?style=flat-square)](./package.json)
[![npm](https://img.shields.io/npm/v/@yc-software/qm?label=npm&color=000&style=flat-square)](https://www.npmjs.com/package/@yc-software/qm)

[Deploy](#deploy-it-for-your-org) · [How it works](#how-it-works) · [Security model](#security-and-secrets) · [Customize](#customize-your-instance) · [Contribute](#contributing) · [Documentation](#going-deeper)

</div>

## Overview

Most agents are designed like personal assistants. You can make one work for a whole
company, but it quickly gets complex. QM is designed for startups. Employees each get
their own isolated workspace, and can also collaborate with the agent in channels, group messages, and projects.

Each person and each room has its own scoped memory, files, keychain view, permissions,
crons, web apps, and durable sandbox.

It's built with open source in mind. Pick your own harness and model and switch between
them. Pi, OpenCode, Codex, and Claude Code all drive the same core, so a deployment
isn't tied to any single vendor.

## Setup

Tell your coding agent of choice `Let's deploy https://github.com/yc-software/qm`. From here, it should follow the deployment guide in this repo.

You can also try out a 3rd-party hosted version of QM [here](https://www.agent37.com/qm).

If you're an infra provider interested in offering a hosted version of QM, feel free to reach out.

## Features

- **Personal and shared scopes.** People customize the agent to be _theirs_, and still
  work with it collaboratively in Slack channels and projects.
- **Slack and web.** The same identity and configuration carries between Slack and the
  web app.
- **Admin control.** Set org-level configuration, security and sharing postures. Choose which
  harnesses and models are available.
- **Web apps.** Spin up custom internal apps and publish them to the right people.
- **Shared skills.** Skills are scope-owned and shareable by grant, with admin-gated
  promotion to the whole org and skill packs imported from git repositories.
- **Background work.** Crons, watches, and inbound webhooks work while you're away.

## What you can do with it

- Search internal notes, email, documents, databases, and the web together
- Build internal apps, publish them to the right people, and keep their data current
- Learn your writing voice from past sends, then triage your inbox on a schedule —
  labels and reply drafts included
- Work in an existing repository: run tests, open PRs, monitor CI, check system logs
- Track a project in a shared channel and post updates and follow-ups

## Architecture

```mermaid
flowchart LR
  DB[("Postgres<br/>sessions · memory · queue")]

  subgraph CORE["Headless core"]
    API["API · identity · policy · scheduler"]
    LOOP["Agent loop<br/>(Pi, OpenCode, Claude Code)"]
    API <--> LOOP
  end

  SBX["Per-scope sandbox<br/>files · tools · logged-in services"]

  DB <--> API
  LOOP <--> SBX
```

For durability, set `DATABASE_URL` and `SESSION_STORE=postgres` — without it, sessions
live in process memory and vanish on restart. To exercise a branch against a real model and real Postgres, run
`npm run dev-instance:web` for web/admin or `npm run dev-instance:slack` for Slack.
Use `npm run dev-instance:both` when testing both surfaces together. Bare
`npm run dev-instance` defaults to web for new instances and preserves the surface
on reload. Switch an existing instance with an explicit surface command.

## How it works

Every turn runs through a central core, which can use a variety of models and harnesses
to generate the response. A Postgres persistence layer holds user data, session history,
and other durable state. The agent has a small, fixed tool surface; one of those tools is
`execute`, which runs commands in the scope's own isolated sandbox — its durable computer,
where installed tools stay installed. The web UI and admin panel share one service; the portal and optional built-in
auth broker share another. These modules communicate with core over its HTTP API.
See [combined services](docs/combined-services.md) for configuration and migration;
Slack is an optional in-process plugin that core starts
and supervises through a direct service client.

The core runs TypeScript directly on Node and uses Fastify for HTTP. The Slack plugin
uses Bolt; the web UI builds with Vite and renders with Lit.

The core itself is generic. Everything specific to one company — org config, custom tools
and skills, sandbox image, infrastructure — lives in a **deployment directory** that the
[`qm` CLI](./cli/README.md) validates and deploys. Every substrate (harness, session
store, sandbox, memory) sits behind an interface. Memory can also be routed by scope to
[external providers](./docs/memory-providers.md) while retaining the built-in notebook.

## Security and secrets

QM's approach follows local coding agents like OpenCode, Codex, and Claude Code: the
agent acts as the person it's working for, with their credentials and permissions, and
everything it does is audited. An org picks one security posture, which narrower scopes
can only tighten:

- **Strict** — every harness tool call pauses for human approval, except the two
  no-effect turn enders.
- **Auto** (default) — blocks private-network access.
- **Dangerous** — no tool approval gates, and content screening only observes.

Content screening is a deployment setting, `securityScreen.mode`: `off` (default),
`observe`, or `enforce`, with `securityScreen.classifier` choosing the built-in
`model` or an external `proxy`. When on, it classifies external content under every
posture. `observe` only records verdicts in the audit log. `enforce` quarantines
flagged content pending release approval, except under Dangerous, which caps
screening at `observe`.

The predeclared command policy — approval rules and hard denials for things like
recursive deletes or destructive SQL — applies in every posture, Dangerous included.

Sharing posture is independent:

- **Isolated** (default) — resources stay in their scope unless explicitly shared.
- **Open** — on a live authenticated internal human turn, the speaker's opted-in personal
  files, artifacts, skills, and memory may be read in an opted-in shared room.

[`SECURITY.md`](./SECURITY.md) has the threat model, the operator assumptions, and the
known limitations.

## Deploy it for your org

Create an organization-owned deployment repository that depends on `@yc-software/qm`:

```bash
npm exec --yes --package=@yc-software/qm@latest -- \
  qm init . --org <slug> --target <fly-or-aws>
npm install
```

Initialization materializes a deployment skill for an agent and walks through
infrastructure, web sign-in, connector credentials, optional Slack access, deployment,
and live verification — no source checkout required. Each deployment runs in the
operator's own cloud account; initialization does not generate or enable deployment CI,
and this repository has no production deployment workflow. See
[`deployment.md`](./deployment.md) for the details.

## Contributing

We take contributions as _human-written_ text, not code — see
[`CONTRIBUTING.md`](./CONTRIBUTING.md). Describe the change you'd like informally in a
`.txt` or `.md` file in [`adrs/`](./adrs/), and if we're aligned we'll handle the
implementation. Report vulnerabilities privately — see [`SECURITY.md`](./SECURITY.md),
not a public issue.

## Customize your instance

Choose how you want to customize QM:

- **Config, tools, skills, and services:** use the deployment repository above. It
  pins `@yc-software/qm` and uses that release's runtime images; no source copy is needed.
- **Changes to QM itself:** keep your own source fork, public or private. You may
  modify any part of core, including the runtime, plugins, CLI, docs, and CI.
  Contributing those changes upstream is optional.

### Create a source fork

For a private source fork, create a standalone private repository, outside GitHub's
fork network. Seed only `main` and explicitly set it as the default branch:

```bash
gh repo create <org>/qm-private --private
git clone --single-branch --branch main --no-tags git@github.com:yc-software/qm qm-private
git -C qm-private remote rename origin upstream
git -C qm-private remote add origin git@github.com:<org>/qm-private
git -C qm-private push -u origin main
gh repo edit <org>/qm-private --default-branch main
```

Do not seed with `git push --mirror`: it copies unrelated upstream branches and tags,
leaves default-branch selection implicit, and can delete destination-only refs on later
pushes. The `upstream` remote supplies source updates without copying those refs to your
repository. For a public source fork, GitHub's Fork button is also an option. A GitHub
fork of a public repository cannot be private; keep private work outside that network.

Review inherited workflows before enabling Actions or adding credentials. Choose the CI
checks you want, and disable or adapt upstream release and publishing workflows for your
own package and image registries. Copying the source does not configure production
deployment CI.

### Customize and run your source

Keep deployment configuration, tools, skills, plugin images, and infrastructure in
`deploy/layers/<org>/` in a private source fork, or in a separate private deployment
repository when your source is public. Never commit secrets. See
[`deploy/layers/README.md`](./deploy/layers/README.md) for initialization and layout.
Keep deployment data separate from core code, but change core wherever your desired
behavior requires it.

From the source checkout, install dependencies with `npm ci` and use the in-tree CLI.
After completing the provider setup in [`deployment.md`](./deployment.md), build and
deploy your modified services explicitly:

```bash
node cli/bin/qm.ts check --config <deployment-dir>/qm.config.jsonc
node cli/bin/qm.ts plan --config <deployment-dir>/qm.config.jsonc --build-from .
node cli/bin/qm.ts up --config <deployment-dir>/qm.config.jsonc --build-from .
node cli/bin/qm.ts check --config <deployment-dir>/qm.config.jsonc --live
```

Use this checkout's CLI when changing the CLI itself. Without `--build-from`, the
normal deployment path selects published images, so editing source alone does not
change the deployed runtime. If you publish custom images instead, configure their
immutable references through `imageOverrides`. Follow the provider guide for sandbox
image builds; service builds do not replace that step.

### Keep it current

For a source fork, `update-qm` merges upstream changes while preserving intentional
local behavior. Land sync PRs with their merge ancestry intact, never squash or rebase
them. Conflicts are expected maintenance work, not a requirement to discard
customizations. Use `upstream-pr` only when you want to contribute a generic change;
it prepares a clean upstream branch without private deployment data or history.

For a package deployment, upgrade the exact `@yc-software/qm` dependency and lockfile,
review contract changes and generated assets, then validate and deploy. There is no
upstream source history to merge.

## Going deeper

- [`docs/getting-started.md`](./docs/getting-started.md) — first run, end to end
- [`cli/README.md`](./cli/README.md) — the `qm` CLI and the deployment directory contract
- [`docs/deploy-directory.md`](./docs/deploy-directory.md) — the deployment directory in full
- [`docs/principal-links.md`](./docs/principal-links.md) — one person, several sign-ins: linking principals
- [`docs/porter.md`](./docs/porter.md) — running qm on Porter
- [`docs/superserve.md`](./docs/superserve.md) — using Superserve for agent sandboxes
- [`.env.example`](./.env.example) — every knob, documented in place
- [`docs/swarms.md`](./docs/swarms.md) — durable agent pools, scoped messages, and blank Modal workers
- [`docs/model-gateway.md`](./docs/model-gateway.md) — discover and route models through a gateway
- [`plugins/`](./plugins) — the surfaces (Slack, web UI, admin, portal)

## License

Except where otherwise noted, QM is available under the [MIT License](./LICENSE).
