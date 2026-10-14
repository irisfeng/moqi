import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../deploy/layers/qm-cn/scripts/publish-snapshot.py", import.meta.url));
const privateRepository = "https://github.com/acme-corp/quiet-harbor.git";
const noreply = "1+maintainer@users.noreply.github.com";
const identity = (name: string, email: string) => ({
  GIT_AUTHOR_NAME: name,
  GIT_AUTHOR_EMAIL: email,
  GIT_COMMITTER_NAME: name,
  GIT_COMMITTER_EMAIL: email,
});
const baseEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  ...identity("Maintainer", noreply),
};
const upstreamEnv = identity("Upstream", "dev@example.com");

type Files = Record<string, string | Buffer>;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: baseEnv }).trim();
}

function commit(repo: string, message: string, files: Files, env: Record<string, string> = {}): string {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), content);
  }
  execFileSync("git", ["add", "-A", "-f"], { cwd: repo, env: baseEnv });
  execFileSync("git", ["commit", "-q", "-m", message], { cwd: repo, env: { ...baseEnv, ...env } });
  return git(repo, "rev-parse", "HEAD");
}

function release(repo: string, version: string, files: Files = {}): string {
  return commit(repo, `Release ${version}`, {
    "deploy/layers/qm-cn/VERSION": `${version}\n`,
    "deploy/layers/qm-cn/deploy/CHANGELOG.md": `# Log\n\n## ${version}\n\n- notes for ${version}\n`,
    ...files,
  });
}

function setup(t: { after: (fn: () => void) => void }) {
  const dir = mkdtempSync(join(tmpdir(), "publish-snapshot-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const upstream = join(dir, "upstream");
  const staging = join(dir, "staging");
  const pub = join(dir, "public.git");
  mkdirSync(upstream);
  git(upstream, "init", "-q", "-b", "main");
  const base = commit(
    upstream,
    "Upstream",
    { "README.md": "qm\n", ".github/workflows/cicd.yml": "on: push\n" },
    upstreamEnv,
  );
  git(dir, "clone", "-q", upstream, staging);
  git(dir, "init", "-q", "--bare", pub);
  const denylist = join(dir, "denylist.txt");
  writeFileSync(
    denylist,
    "\uFEFFProject Nightjar\n# names that never go public\nosprey-internal\n内部代号\n金鱼·计划\nquiet-harbor\n",
  );
  return { dir, upstream, staging, pub, base, push: ["--push", "--denylist", denylist] };
}

function publish(
  repo: string,
  rev: string,
  to: string,
  upstream: string,
  extra: string[] = [],
  env: Record<string, string> = {},
  cwd = repo,
): { status: number | null; out: string } {
  const run = spawnSync("python3", ["-I", script, "--release", rev, "--upstream", upstream, "--to", to, ...extra], {
    cwd,
    encoding: "utf8",
    env: { ...baseEnv, ...env },
  });
  return { status: run.status, out: `${run.stdout}${run.stderr}` };
}

const escaped = (value: string) =>
  [...value].map((c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`).join("");
const entities = (value: string) => [...value].map((c) => `&#x${c.codePointAt(0)!.toString(16)};`).join("");
const refs = (pub: string) => git(pub, "for-each-ref", "--format=%(refname) %(objectname)");
const state = (repo: string) =>
  `${git(repo, "status", "--porcelain")}\n${readFileSync(join(repo, ".git/index"), "hex")}`;

test("a release is published once, as one snapshot on upstream's commit, with the public files on top and no private workflow", (t) => {
  const { upstream, staging, pub, base, push } = setup(t);
  const rel = release(staging, "0.1.0", {
    ".github/workflows/images.yml": "on: workflow_dispatch\n",
    ".github/workflows/private-boundary.yml": "on: pull_request\n",
    "deploy/layers/qm-cn/deploy/public-root/README.md": "public readme\n",
    "deploy/layers/qm-cn/deploy/public-root/.github/ISSUE_TEMPLATE/bug.yml": "name: Bug\n",
    "deploy/layers/qm-cn/seed/webui-home.json": "private seed\n",
    "deploy/layers/qm-cn/deploy/public-root/deploy/layers/qm-cn/seed/webui-home.json": "public seed\n",
    "src/app.ts": "export const app = 1;\n",
    "docs/说明.md": "说明\n",
    "test/public-seed-shape.test.ts": "reads the overlay\n",
  });
  writeFileSync(join(staging, ".github/workflows/images.yml"), "on: push\n");
  writeFileSync(join(staging, "deploy/layers/qm-cn/deploy/public-root/README.md"), "edited after the release\n");
  const before = state(staging);
  const dry = publish(staging, rel, pub, upstream);
  assert.equal(dry.status, 0, dry.out);
  assert.match(dry.out, /dry run: nothing pushed/);
  assert.match(publish(staging, rel, pub, upstream, push.slice(1)).out, /denylist {2}5 entries/);
  assert.equal(refs(pub), "");
  const bare = publish(staging, rel, pub, upstream, ["--push"]);
  assert.notEqual(bare.status, 0);
  assert.match(bare.out, /a push needs --denylist/);
  assert.equal(refs(pub), "");
  const inside = join(staging, "deploy/layers/qm-cn");
  const pushed = publish(staging, rel, relative(inside, pub), relative(inside, upstream), push, {}, inside);
  assert.equal(pushed.status, 0, pushed.out);
  assert.equal(state(staging), before, "the operator's index and working tree are left alone");
  const main = git(pub, "rev-parse", "main");
  assert.equal(git(pub, "rev-parse", "v0.1.0"), main);
  assert.equal(git(pub, "log", "-1", "--format=%P", main), base);
  assert.equal(git(pub, "log", "-1", "--format=%ae %ce", main), `${noreply} ${noreply}`);
  assert.match(git(pub, "log", "-1", "--format=%B", main), /^Release 0\.1\.0\n\n- notes for 0\.1\.0/);
  assert.deepEqual(git(pub, "-c", "core.quotePath=false", "ls-tree", "-r", "--name-only", main).split("\n"), [
    ".github/ISSUE_TEMPLATE/bug.yml",
    ".github/workflows/cicd.yml",
    ".github/workflows/private-boundary.yml",
    "README.md",
    "deploy/layers/qm-cn/VERSION",
    "deploy/layers/qm-cn/deploy/CHANGELOG.md",
    "deploy/layers/qm-cn/seed/webui-home.json",
    "docs/说明.md",
    "src/app.ts",
  ]);
  assert.equal(git(pub, "show", `${main}:README.md`), "public readme\n\n---\n\nqm");
  assert.equal(git(pub, "show", `${main}:deploy/layers/qm-cn/seed/webui-home.json`), "public seed");
  const published = refs(pub);
  const again = publish(staging, rel, pub, upstream, push);
  assert.equal(again.status, 0, again.out);
  assert.match(again.out, /v0\.1\.0 is already published/);
  assert.equal(refs(pub), published);
  git(pub, "update-ref", "-d", "refs/tags/v0.1.0");
  const retag = publish(staging, rel, pub, upstream, push);
  assert.equal(retag.status, 0, retag.out);
  assert.match(retag.out, /only the tag is missing/);
  assert.equal(refs(pub), published, "a missing tag is restored on the commit main already holds");
});

test("later snapshots follow the previous one and take a newly synced upstream commit as a second parent", (t) => {
  const { upstream, staging, pub, push } = setup(t);
  assert.equal(publish(staging, release(staging, "0.1.0"), pub, upstream, push).status, 0);
  const first = git(pub, "rev-parse", "main");
  const next = release(staging, "0.1.1", { "src/app.ts": "1\n" });
  assert.equal(publish(staging, next, pub, upstream, push).status, 0);
  const second = git(pub, "rev-parse", "main");
  assert.equal(git(pub, "log", "-1", "--format=%P", second), first);
  const synced = commit(upstream, "Upstream change", { "README.md": "qm, newer\n" }, upstreamEnv);
  git(staging, "fetch", "-q", "origin");
  git(staging, "merge", "-q", "--no-edit", "origin/main");
  const third = publish(staging, release(staging, "0.1.2"), pub, upstream, push);
  assert.equal(third.status, 0, third.out);
  assert.equal(git(pub, "log", "-1", "--format=%P", "main"), `${second} ${synced}`);
  assert.equal(git(pub, "show", "main:README.md"), "qm, newer");
  const published = refs(pub);
  const older = publish(staging, release(staging, "0.1.1", { "src/app.ts": "2\n" }), pub, upstream, push);
  assert.notEqual(older.status, 0);
  assert.match(older.out, /v0\.1\.1 is already published with a different tree/);
  const downgrade = publish(staging, release(staging, "0.0.9"), pub, upstream, push);
  assert.notEqual(downgrade.status, 0);
  assert.match(downgrade.out, /v0\.0\.9 is not newer than the published v0\.1\.2/);
  assert.equal(refs(pub), published);
});

test("history that is not upstream's is never taken as the parent", (t) => {
  const { dir, upstream, staging, pub, push } = setup(t);
  const rel = release(staging, "0.1.0");
  const own = publish(staging, rel, pub, staging, push);
  assert.notEqual(own.status, 0);
  assert.match(own.out, /is not an upstream commit/);
  const mirror = join(dir, "mirror");
  git(dir, "clone", "-q", upstream, mirror);
  commit(mirror, "Private work kept outside the layer", { "src/private.ts": "1\n" });
  git(staging, "pull", "-q", "--no-rebase", "--no-edit", mirror, "main");
  const mixed = publish(staging, release(staging, "0.1.1"), pub, mirror, push);
  assert.notEqual(mixed.status, 0);
  assert.match(mixed.out, /is not upstream history/);
  const named = publish(staging, rel, pub, privateRepository, push);
  assert.notEqual(named.status, 0);
  assert.match(named.out, /is one of our repositories, not upstream/);
  assert.equal(refs(pub), "");
});

test("a public repository in an unexpected state is left as it is", (t) => {
  const { dir, upstream, staging, pub, push } = setup(t);
  const rel = release(staging, "0.1.0");
  const guarded = join(dir, "guarded.git");
  git(dir, "init", "-q", "--bare", guarded);
  mkdirSync(join(guarded, "hooks"), { recursive: true });
  writeFileSync(join(guarded, "hooks/update"), '#!/bin/sh\ncase "$1" in refs/tags/*) exit 1 ;; esac\n');
  chmodSync(join(guarded, "hooks/update"), 0o755);
  const half = publish(staging, rel, guarded, upstream, push);
  assert.notEqual(half.status, 0);
  assert.equal(refs(guarded), "", "main does not move when the tag is rejected");
  git(pub, "fetch", "-q", upstream, "main:main");
  const foreign = publish(staging, rel, pub, upstream, push);
  assert.notEqual(foreign.status, 0);
  assert.match(foreign.out, /is not a snapshot made by this script/);
});

test("private files, scan hits, private targets, missing notes and a personal identity are refused before any push", (t) => {
  const { dir, upstream, staging, pub, push } = setup(t);
  const good = release(staging, "0.1.0", {
    "docs/guide.md": "++ a list item\nplain\n",
    "docs/names.md": "ALTAIRSTATIONNAME1 loadBalancerALTAIinternalService\n",
  });
  const token = "sk-" + "a".repeat(24);
  const address = ["192", "168", "1", "20"].join(".");
  const mail = (at: string) => ["ops", "corp-mail.cn"].join(at);
  const cases: { files: Files; reason: RegExp }[] = [
    { files: { "deploy/layers/qm-cn/private/runbook.md": "steps\n" }, reason: /private path/ },
    { files: { "deploy/layers/QM-CN/private/runbook.md": "steps\n" }, reason: /private path/ },
    { files: { "deploy/layers/qm-cn/roster.csv": "a,b\n" }, reason: /outside the public layer directories/ },
    { files: { "deploy/layers/qm-cn/笔记/名单.csv": "a,b\n" }, reason: /outside the public layer directories/ },
    { files: { "deploy/layers/qm-cn-extra/notes.md": "x\n" }, reason: /outside the public layer directories/ },
    { files: { "deploy/.env": "KEY=1\n" }, reason: /env file/ },
    { files: { "src/配置/.env": "KEY=1\n" }, reason: /env file/ },
    { files: { "deploy/prod.env": "KEY=1\n" }, reason: /env file/ },
    { files: { "deploy/.ENV": "KEY=1\n" }, reason: /env file/ },
    { files: { "deploy/.envrc": "export KEY=1\n" }, reason: /env file/ },
    {
      files: { "deploy/layers/qm-cn/deploy/public-root/src/app.ts": "2\n" },
      reason: /not a file the public root may take/,
    },
    {
      files: { "deploy/layers/qm-cn/deploy/public-root/NOTICE": "notice\n", "NOTICE/inner": "x\n" },
      reason: /also a file in the snapshot/,
    },
    { files: { "src/key.ts": `export const key = "${token}";\n` }, reason: /src\/key\.ts: token sk-/ },
    { files: { "src/密钥.ts": `export const key = "${token}";\n` }, reason: /token sk-/ },
    { files: { "docs/guide.md": `++ a list item\nplain\n++ ${token}\n` }, reason: /docs\/guide\.md: token sk-/ },
    { files: { "docs/page.md": `first\f${token}\rlast\n` }, reason: /token sk-/ },
    { files: { "docs/blob.bin": `\0\0${token}\0` }, reason: /docs\/blob\.bin: token sk-/ },
    { files: { "docs/wide.txt": Buffer.from(`key ${token}\n`, "utf16le") }, reason: /docs\/wide\.txt: token sk-/ },
    { files: { ".gitattributes": "*.txt -diff\n", "docs/notes.txt": `${token}\n` }, reason: /token sk-/ },
    {
      files: { "docs/tool.bin": Buffer.concat([Buffer.alloc(600, 1), Buffer.from(token, "utf16le")]) },
      reason: /docs\/tool\.bin: token sk-/,
    },
    { files: { "src/lab.ts": `const t = "${"glpat-" + "b".repeat(24)}";\n` }, reason: /token glpat-/ },
    { files: { "src/cloud.ts": `const k = "${"LTAI" + "c".repeat(16)}";\n` }, reason: /token LTAI/ },
    {
      files: { "docs/hook.md": `${["https://hooks", "slack", "com/services/T0/B0/x"].join(".")}\n` },
      reason: /token hooks\.s/,
    },
    {
      files: { "docs/wide.txt": Buffer.from(`中文说明，没有字节序标记 ${token}\n`, "utf16le") },
      reason: /docs\/wide\.txt: token sk-/,
    },
    { files: { "src/host.ts": `export const host = "${address}";\n` }, reason: /private address/ },
    { files: { "docs/host.md": `The server is at ${address}.\n` }, reason: /private address/ },
    { files: { "src/mail.ts": `export const to = "${mail("@")}";\n` }, reason: /email/ },
    { files: { "docs/mail.md": `${mail("%40")}\n` }, reason: /email/ },
    { files: { "docs/mail.md": `${mail("＠")}\n` }, reason: /email/ },
    { files: { "docs/links.md": `${["https://acme", "feishu", "cn/docx/1"].join(".")}\n` }, reason: /document link/ },
    {
      files: { "docs/links.md": `${["https://acme", "larkoffice", "com/wiki/1"].join(".")}\n` },
      reason: /document link/,
    },
    { files: { "docs/about.md": "Built for project nightjar.\n" }, reason: /denylisted text/ },
    { files: { "docs/about.md": "Built for Project-Nightjar.\n" }, reason: /denylisted text/ },
    { files: { "docs/about.md": "Built for Project\nNightjar.\n" }, reason: /denylisted text/ },
    { files: { "docs/about.md": "Ｐｒｏｊｅｃｔ Ｎｉｇｈｔｊａｒ\n" }, reason: /denylisted text/ },
    { files: { "src/names.ts": "export const projectNightjar = 1;\n" }, reason: /denylisted text/ },
    { files: { "docs/about.md": Buffer.from("内部代号 的说明\n", "utf16le") }, reason: /denylisted text/ },
    { files: { "docs/about.md": Buffer.from("内部代号 的说明\n", "utf16le").swap16() }, reason: /denylisted text/ },
    { files: { "docs/about.md": Buffer.from("Built for Project Nightjar.\n", "utf16le") }, reason: /denylisted text/ },
    {
      files: { "docs/about.md": Buffer.concat([Buffer.from("内部代号 的说明\n"), Buffer.from([0])]) },
      reason: /denylisted text/,
    },
    { files: { "docs/about.md": Buffer.from("c4dab2bfb4fabac50a", "hex") }, reason: /denylisted text/ },
    { files: { "docs/about.md": "Built for Project/Nightjar.\n" }, reason: /denylisted text/ },
    { files: { "docs/about.md": "Built for Project·Nightjar.\n" }, reason: /denylisted text/ },
    { files: { "docs/about.md": "Built for Project、Nightjar.\n" }, reason: /denylisted text/ },
    { files: { "docs/about.md": "Built for **Project** __Nightjar__.\n" }, reason: /denylisted text/ },
    { files: { "docs/about.md": "Built for Project\u200bNightjar.\n" }, reason: /denylisted text/ },
    { files: { "docs/about.md": "Built for Pro\u00adject Nightjar.\n" }, reason: /denylisted text/ },
    { files: { "docs/about.md": "我们的金鱼计划\n" }, reason: /denylisted text/ },
    { files: { "docs/about.md": `{"name": "${escaped("内部代号")}"}\n` }, reason: /denylisted text/ },
    {
      files: { "docs/about.md": `https://example.com/?q=${encodeURIComponent("内部代号")}\n` },
      reason: /denylisted text/,
    },
    { files: { "docs/about.md": `${entities("内部代号")}\n` }, reason: /denylisted text/ },
    { files: { "docs/about.md": "Built for Project&nbsp;Nightjar.\n" }, reason: /denylisted text/ },
    { files: { "docs/about.md": Buffer.from("内部代号的说明", "utf16le") }, reason: /denylisted text/ },
    {
      files: { "docs/about.md": Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("内部代号的说明", "utf16le")]) },
      reason: /denylisted text/,
    },
    {
      files: { "docs/data.bin": Buffer.from([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 3]) },
      reason: /docs\/data\.bin: archive/,
    },
    {
      files: { "docs/plan.docx": "plain text\n" },
      reason: /docs\/plan\.docx: archive.*keep it out of the public tree/,
    },
    { files: { [`docs/${mail("@")}.md`]: "x\n" }, reason: /email/ },
    { files: { [`docs/${address}.md`]: "x\n" }, reason: /private address/ },
    { files: { "docs/Osprey-Internal/plan.md": "plan\n" }, reason: /denylisted path/ },
    {
      files: { "deploy/layers/qm-cn/deploy/CHANGELOG.md": "# Log\n\n## 0.1.0\n\n- for Project Nightjar\n" },
      reason: /release notes: denylisted text/,
    },
    {
      files: { "deploy/layers/qm-cn/deploy/CHANGELOG.md": "# Log\n\n## 0.0.1\n\n- old\n" },
      reason: /no release notes for 0\.1\.0/,
    },
  ];
  for (const { files, reason } of cases) {
    git(staging, "checkout", "-q", "--detach", good);
    git(staging, "clean", "-q", "-fdx");
    const bad = commit(staging, "Bad", files);
    const run = publish(staging, bad, pub, upstream, push);
    assert.notEqual(run.status, 0, Object.keys(files).join());
    assert.match(run.out, reason);
  }
  git(staging, "checkout", "-q", "--detach", good);
  git(staging, "clean", "-q", "-fdx");
  git(staging, "update-index", "--add", "--cacheinfo", `160000,${good},vendor/lib`);
  git(staging, "commit", "-q", "-m", "Submodule");
  const hidden = { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "diff.ignoreSubmodules", GIT_CONFIG_VALUE_0: "all" };
  const submodule = publish(staging, "HEAD", pub, upstream, push, hidden);
  assert.notEqual(submodule.status, 0);
  assert.match(submodule.out, /vendor\/lib: submodule/);
  const target = publish(staging, good, privateRepository, upstream, push);
  assert.notEqual(target.status, 0);
  assert.match(target.out, /is a private or upstream repository/);
  const unnamed = join(dir, "unnamed.git");
  git(dir, "init", "-q", "--bare", unnamed);
  const privateTip = commit(staging, "Private", { ".github/workflows/images.yml": "on: push\n" });
  git(staging, "push", "-q", unnamed, `${privateTip}:refs/heads/main`);
  const holdsPrivate = publish(staging, good, unnamed, upstream, push);
  assert.notEqual(holdsPrivate.status, 0);
  assert.match(holdsPrivate.out, /holds private files, so it is not the public repository/);
  git(staging, "remote", "add", "elsewhere", privateRepository);
  git(staging, "remote", "add", "split", pub);
  git(staging, "remote", "set-url", "--push", "split", privateRepository);
  const split = publish(staging, good, "split", upstream, push);
  assert.notEqual(split.status, 0);
  assert.match(split.out, /is a private or upstream repository/);
  git(staging, "config", `url.${privateRepository}.pushInsteadOf`, pub);
  const rewritten = publish(staging, good, pub, upstream, push);
  assert.notEqual(rewritten.status, 0);
  assert.match(rewritten.out, /url rewrite rules are not allowed/);
  git(staging, "config", "--remove-section", `url.${privateRepository}`);
  const canonical = publish(staging, good, "https://github.com/yc-software/qm.git", upstream);
  assert.notEqual(canonical.status, 0);
  assert.match(canonical.out, /is a private or upstream repository/);
  const remote = publish(staging, good, "elsewhere", upstream, push);
  assert.notEqual(remote.status, 0);
  assert.match(remote.out, /is a private or upstream repository/);
  const withCredentials = ["https://user:s3cret", privateRepository.slice(8)].join("@");
  const secret = publish(staging, good, withCredentials, upstream, push);
  assert.notEqual(secret.status, 0);
  assert.doesNotMatch(secret.out, /s3cret/);
  git(staging, "checkout", "-q", "--detach", good);
  mkdirSync(join(staging, "deploy/layers/qm-cn/deploy/public-root"), { recursive: true });
  symlinkSync("../../VERSION", join(staging, "deploy/layers/qm-cn/deploy/public-root/NOTICE"));
  const linked = publish(staging, commit(staging, "Linked notice", {}), pub, upstream, push);
  assert.notEqual(linked.status, 0);
  assert.match(linked.out, /is not a regular file/);
  for (const [content, reason] of [
    ["# nothing listed\n", /has no entries/],
    ["Project Nightjar\n-\n", /shorter than two characters/],
    [Buffer.from("c4dab2bfb4fabac50a", "hex"), /is not UTF-8 text/],
  ] as const) {
    const list = join(dir, "broken-denylist.txt");
    writeFileSync(list, content);
    const broken = publish(staging, good, pub, upstream, ["--push", "--denylist", list]);
    assert.notEqual(broken.status, 0);
    assert.match(broken.out, reason);
  }
  const personal = publish(staging, good, pub, upstream, push, { GIT_COMMITTER_EMAIL: "someone@example.com" });
  assert.notEqual(personal.status, 0);
  assert.match(personal.out, /is not a GitHub noreply address/);
  const named = publish(staging, good, pub, upstream, push, { GIT_COMMITTER_NAME: "Project Nightjar" });
  assert.notEqual(named.status, 0);
  assert.match(named.out, /commit identity: denylisted text/);
  assert.equal(refs(pub), "");
  const clean = publish(staging, good, pub, upstream, push);
  assert.equal(clean.status, 0, clean.out);
});

test("an ordinary image is listed for a look and not refused", (t) => {
  const { upstream, staging, pub } = setup(t);
  const image = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBPVP8 ")]);
  const run = publish(staging, release(staging, "0.1.0", { "docs/pic.webp": image }), pub, upstream);
  assert.equal(run.status, 0, run.out);
  assert.match(run.out, /binaries {2}1 changed/);
  assert.match(run.out, /^ +docs\/pic\.webp$/m);
});
