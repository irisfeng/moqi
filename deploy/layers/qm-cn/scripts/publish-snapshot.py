#!/usr/bin/env python3
import argparse
import html
import os
import re
import subprocess
import sys
import tempfile
import unicodedata
import urllib.parse

LAYER = "deploy/layers/qm-cn/"
LAYER_FILES = {".env.example", "VERSION"}
LAYER_DIRS = ("deploy/", "pm-ocr/", "providers/", "sandbox/", "scripts/", "seed/", "skills/", "soul/")
PRIVATE_ONLY = (".github/workflows/images.yml", "test/public-seed-shape.test.ts")
OVERLAY = LAYER + "deploy/public-root/"
OVERLAY_TARGETS = re.compile(
    r"README(\.[\w-]+)?\.md|NOTICE|CONTRIBUTING\.md|\.github/ISSUE_TEMPLATE/[\w.-]+|\.github/pull_request_template\.md"
    r"|deploy/layers/qm-cn/seed/webui-home\.json"
)
PREFACED = (b"README.md",)
UPSTREAM = "https://github.com/yc-software/qm.git"
UPSTREAM_REPOSITORY = re.compile(r"yc-software/", re.I)
EMAIL_NAME = re.compile(r"[A-Za-z0-9._%+-]{1,64}$")
EMAIL_DOMAIN = re.compile(r"[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}")
EMAIL_DOMAINS = {
    "example.com",
    "example.org",
    "example.net",
    "example.cn",
    "x.cn",
    "acme.com",
    "b.com",
    "li.example",
    "users.noreply.github.com",
}
EMAIL_TLDS = {"test", "example", "invalid", "localhost", "internal", "local"}
IPV4 = re.compile(r"(?<![\d.])(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?!\d|\.\d)")
IP_ALLOWED = {"10.0.0.5"}
TOKENS = re.compile(
    r"sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}"
    r"|glpat-[A-Za-z0-9_-]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY-----"
    r"|eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}|(?<![A-Za-z0-9])LTAI[0-9A-Za-z]{12,}"
    r"|hooks\.slack\.com/services/[\w/]+"
)
TOKENS_ALLOWED = {"AKIAABCDEFGHIJKLMNOP", "ghs_abcdefghijklmnop1234"}
DOC_LINKS = re.compile(
    r"feishu\.cn|larksuite\.com|larkoffice\.com|yuque\.com|notion\.so|docs\.qq\.com|kdocs\.cn|shimo\.im|dingtalk\.com",
    re.I,
)
PRINTABLE_RUN = re.compile(rb"[\x20-\x7e]{8,}")
VERSION = re.compile(r"\d+\.\d+\.\d+")
CREDENTIALS = re.compile(r"//[^/@\s]+@")
NOISE = re.compile(r"[\W_]+")
SURROGATE_ESCAPES = re.compile(r"\\u(d[89ab][0-9a-f]{2})\\u(d[c-f][0-9a-f]{2})", re.I)
UNICODE_ESCAPES = re.compile(r"\\u([0-9a-f]{4})", re.I)
ARCHIVE_SIGNATURES = (b"PK\x03\x04", b"\x1f\x8b", b"%PDF", b"BZh", b"\xfd7zXZ\x00", b"7z\xbc\xaf\x27\x1c", b"Rar!", b"\x28\xb5\x2f\xfd")
ARCHIVE_EXTENSIONS = (".tar", ".woff", ".woff2", ".zip", ".gz", ".tgz", ".bz2", ".xz", ".7z", ".rar", ".zst", ".pdf", ".docx", ".pptx", ".xlsx", ".jar", ".tarbin")
REWRITE_RULES = r"^url\..*\.(insteadof|pushinsteadof)$"
TEXT_CHARACTER = re.compile(r"[\t\n\r\x20-\x7e\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]")


def git(*args, env=None, check=True, data=None):
    run = subprocess.run(["git", *args], capture_output=True, env=env, input=data)
    if check and run.returncode != 0:
        raise SystemExit(shown(f"git {' '.join(args)} failed: {run.stderr.decode('utf-8', 'replace').strip()}"))
    return run.stdout


def text(*args, **options):
    return git(*args, **options).decode("utf-8", "replace").strip()


def shown(message):
    return CREDENTIALS.sub("//…@", message)


def refuse(reason):
    raise SystemExit(shown(f"Refused: {reason}"))


def numbers(version):
    return tuple(int(part) for part in version.split("."))


def fetched(remote, ref):
    advertised = text("ls-remote", remote, ref).split("\t")[0]
    if not advertised:
        return ""
    git("fetch", "-q", "--no-tags", remote, ref)
    if text("rev-parse", "FETCH_HEAD") != advertised:
        refuse(f"{ref} moved while fetching")
    return advertised


def plain(value):
    return NOISE.sub("", unicodedata.normalize("NFKC", value).casefold())


def unescaped(value):
    try:
        value = SURROGATE_ESCAPES.sub(
            lambda m: chr(0x10000 + ((int(m[1], 16) - 0xD800) << 10) + int(m[2], 16) - 0xDC00), value
        )
        value = UNICODE_ESCAPES.sub(lambda m: chr(int(m[1], 16)), value)
        return html.unescape(urllib.parse.unquote(value))
    except (ValueError, OverflowError):
        return value


def named(views, denylist):
    return any(
        entry in plain(variant) for view in views for variant in (view, unescaped(view)) for entry in denylist
    )


def spellings(data):
    try:
        return [data.decode("utf-8")]
    except UnicodeDecodeError:
        return [data.decode("utf-8", "replace"), data.decode("gb18030", "ignore"), *wide_views(data)]


def wide_views(data):
    decoded = [data.decode(encoding, "replace") for encoding in ("utf-16-le", "utf-16-be")]
    return [view for view in decoded if view and len(TEXT_CHARACTER.findall(view)) > 0.7 * len(view)]


def emails(line):
    for at in (match.start() for match in re.finditer("@", line)):
        name = EMAIL_NAME.search(line[max(0, at - 64) : at])
        domain = EMAIL_DOMAIN.match(line[at + 1 : at + 256])
        if name and domain:
            yield f"{name.group(0)}@{domain.group(0)}", domain.group(0).lower()


def private_ip(parts):
    a, b = parts[0], parts[1]
    return a == 10 or (a == 172 and 16 <= b <= 31) or (a == 192 and b == 168) or (a == 100 and 64 <= b <= 127)


def path_problem(path):
    lowered = path.lower()
    name = lowered.rsplit("/", 1)[-1]
    if lowered.startswith(LAYER + "private/") or "/.scratch/" in "/" + lowered:
        return "private path"
    if name != ".env.example" and (name in (".env", ".envrc") or name.startswith(".env.") or name.endswith(".env")):
        return "env file"
    if lowered.startswith("deploy/layers/") and path != "deploy/layers/README.md":
        inside = path[len(LAYER) :]
        if not path.startswith(LAYER) or (inside not in LAYER_FILES and not inside.startswith(LAYER_DIRS)):
            return "outside the public layer directories"
    return None


def line_problems(line):
    found = []
    line = unicodedata.normalize("NFKC", line)
    for address, domain in emails(line.replace("%40", "@")):
        if domain not in EMAIL_DOMAINS and domain.rsplit(".", 1)[-1] not in EMAIL_TLDS:
            found.append(f"email {address}")
    for match in IPV4.finditer(line):
        parts = [int(p) for p in match.groups()]
        address = ".".join(match.groups())
        if all(p <= 255 for p in parts) and private_ip(parts) and address not in IP_ALLOWED:
            found.append(f"private address {address}")
    found += [f"token {m.group(0)[:8]}…" for m in TOKENS.finditer(line) if m.group(0) not in TOKENS_ALLOWED]
    found += [f"document link {m.group(0)}" for m in DOC_LINKS.finditer(line)]
    return found


def blobs(ids):
    wanted = sorted(set(ids))
    out = git("cat-file", "--batch", data="".join(f"{i}\n" for i in wanted).encode())
    found, position = {}, 0
    for wanted_id in wanted:
        end = out.index(b"\n", position)
        header = out[position:end].split()
        if len(header) != 3 or header[1] != b"blob":
            raise SystemExit(f"Cannot read {wanted_id} as a file")
        size = int(header[2])
        found[wanted_id] = out[end + 1 : end + 1 + size]
        position = end + 1 + size + 1
    return found


def scan(base, tree, denylist):
    options = ("--raw", "-z", "--no-renames", "--abbrev=40", "--ignore-submodules=none")
    fields = git("-c", "diff.ignoreSubmodules=none", "diff", *options, base, tree).split(b"\0")
    changes = []
    for index in range(0, len(fields) - 1, 2):
        old_mode, new_mode, old_id, new_id, status = fields[index].decode()[1:].split(" ")
        changes.append((old_mode, new_mode, old_id, new_id, status, fields[index + 1].decode("utf-8", "replace")))
    hits, binaries = [], []
    content = blobs(
        [new for _, mode, _, new, status, _ in changes if status != "D" and mode != "160000"]
        + [old for mode, _, old, _, status, _ in changes if status == "M" and mode != "160000"]
    )
    for old_mode, new_mode, old_id, new_id, status, path in changes:
        if status == "D":
            continue
        if named([path], denylist):
            hits.append(f"{path}: denylisted path")
        hits += [f"{path}: {problem}" for problem in line_problems(path)]
        if new_mode == "160000":
            hits.append(f"{path}: submodule")
            continue
        new = content[new_id]
        if new.startswith(ARCHIVE_SIGNATURES) or path.lower().endswith(ARCHIVE_EXTENSIONS):
            hits.append(f"{path}: archive or compressed file; keep it out of the public tree")
            continue
        if b"\0" in new:
            binaries.append(path)
            squeezed, wide = new.replace(b"\0", b""), wide_views(new)
            lines = [run.decode("ascii") for run in PRINTABLE_RUN.findall(new) + PRINTABLE_RUN.findall(squeezed)]
            lines += [line for view in wide for line in view.split("\n")]
            views = [squeezed.decode("utf-8", "ignore"), *wide]
        else:
            known = set(content[old_id].split(b"\n")) if status == "M" and old_mode != "160000" else set()
            fresh = [line for line in new.split(b"\n") if line not in known]
            lines = [line.decode("utf-8", "replace") for line in fresh]
            views = spellings(b"\n".join(fresh))
        if named(views, denylist):
            hits.append(f"{path}: denylisted text")
        for line in lines:
            hits += [f"{path}: {problem}" for problem in line_problems(line)]
    return hits, binaries


def snapshot_tree(release):
    listing = git("ls-tree", "-r", "-z", "--full-tree", release).split(b"\0")
    entries = [entry.split(b"\t", 1) for entry in listing if entry]
    overlay, private, kept, laid = OVERLAY.encode(), {path.encode() for path in PRIVATE_ONLY}, {}, {}
    for meta, path in entries:
        if path.startswith(overlay):
            target = path[len(overlay) :]
            if not OVERLAY_TARGETS.fullmatch(target.decode("utf-8", "replace")):
                refuse(f"{path.decode('utf-8', 'replace')} is not a file the public root may take")
            if meta.split()[0] not in (b"100644", b"100755"):
                refuse(f"{path.decode('utf-8', 'replace')} is not a regular file")
            laid[target] = meta
        elif path not in private:
            kept[path] = meta
    for target in PREFACED:
        if target in laid and target in kept:
            joined = git("cat-file", "blob", laid[target].split()[2]) + b"\n---\n\n" + git("cat-file", "blob", kept[target].split()[2])
            laid[target] = b"100644 blob " + git("hash-object", "-w", "--stdin", data=joined).strip()
    kept.update(laid)
    for path in kept:
        parts = path.split(b"/")
        for depth in range(1, len(parts)):
            if b"/".join(parts[:depth]) in kept:
                refuse(f"{path.decode('utf-8', 'replace')} sits under a path that is also a file in the snapshot")
    with tempfile.TemporaryDirectory() as scratch:
        env = {**os.environ, "GIT_INDEX_FILE": os.path.join(scratch, "index")}
        listing = b"".join(meta + b"\t" + path + b"\0" for path, meta in sorted(kept.items()))
        git("update-index", "-z", "--index-info", env=env, data=listing)
        tree = text("write-tree", env=env)
    return tree, len(laid)


def main():
    parser = argparse.ArgumentParser(description="Publish one release commit as a public snapshot.")
    parser.add_argument("--release", required=True)
    parser.add_argument("--to", required=True)
    parser.add_argument("--upstream", default=UPSTREAM)
    parser.add_argument("--denylist")
    parser.add_argument("--push", action="store_true")
    args = parser.parse_args()

    if args.push and not args.denylist:
        refuse("a push needs --denylist, the private list of names that must never be published")
    denylist = []
    if args.denylist:
        try:
            with open(args.denylist, encoding="utf-8") as source:
                denylist = [plain(entry) for entry in source if entry.strip() and not entry.startswith("#")]
        except UnicodeDecodeError:
            refuse(f"{args.denylist} is not UTF-8 text")
        if any(len(entry) < 2 for entry in denylist):
            refuse(f"{args.denylist} has an entry shorter than two characters once punctuation is removed")
        if args.push and not denylist:
            refuse(f"{args.denylist} has no entries")
    for name in ("to", "upstream"):
        value = getattr(args, name)
        if os.path.exists(value) and not text("remote", "get-url", value, check=False):
            setattr(args, name, os.path.abspath(value))
    os.chdir(text("rev-parse", "--show-toplevel"))
    targets = [args.to, *text("remote", "get-url", "--push", "--all", args.to, check=False).splitlines()]
    for key in ("url", "pushurl"):
        targets += text("config", "--get-all", f"remote.{args.to}.{key}", check=False).splitlines()
    rewrites = [line.split(" ", 1)[1] for line in text("config", "--get-regexp", REWRITE_RULES, check=False).splitlines() if " " in line]
    if any(url.startswith(rule) for rule in rewrites for url in targets):
        refuse("url rewrite rules are not allowed for a public push")
    if any(UPSTREAM_REPOSITORY.search(url) or named([url], denylist) for url in targets):
        refuse(f"{args.to} is a private or upstream repository")
    if any(named([url], denylist) for url in (args.upstream, text("ls-remote", "--get-url", args.upstream))):
        refuse(f"{args.upstream} is one of our repositories, not upstream")
    release = text("rev-parse", "--verify", f"{args.release}^{{commit}}")
    version = text("show", f"{release}:{LAYER}VERSION")
    if not VERSION.fullmatch(version):
        refuse(f"invalid VERSION {version!r}")
    changelog = git("show", f"{release}:{LAYER}deploy/CHANGELOG.md").decode("utf-8", "replace")
    notes = re.search(rf"^## {re.escape(version)}(?![\w.-])[^\n]*\n(.*?)(?=^## |\Z)", changelog, re.S | re.M)
    if not notes or not notes.group(1).strip():
        refuse(f"no release notes for {version}")
    ident = text("var", "GIT_COMMITTER_IDENT")
    who = re.match(r"(.*) <([^>]*)>", ident)
    if not who or not who.group(2).endswith("@users.noreply.github.com"):
        refuse(f"the committer identity {ident.rsplit(' ', 2)[0]!r} is not a GitHub noreply address")

    upstream = fetched(args.upstream, "refs/heads/main")
    if not upstream:
        refuse(f"{args.upstream} has no main branch")
    base = text("merge-base", release, upstream, check=False)
    if not base:
        refuse("the release shares no history with upstream")
    if git("ls-tree", "--full-tree", base, "--", LAYER.rstrip("/")).strip():
        refuse(f"{base[:12]} holds {LAYER}, so it is not an upstream commit")
    for field in ("--author", "--committer"):
        if text("rev-list", "-1", "--fixed-strings", f"{field}={who.group(2)}", base):
            refuse(f"{base[:12]} has commits by {who.group(2)} behind it, so it is not upstream history")

    tree, laid = snapshot_tree(release)
    listing = git("ls-tree", "-r", "-z", "--full-tree", "--name-only", tree).split(b"\0")
    paths = [path.decode("utf-8", "replace") for path in listing if path]
    problems = [f"{path}: {p}" for path in paths if (p := path_problem(path))]
    problems += [f"{path}: private-only file" for path in paths if path in PRIVATE_ONLY or path.startswith(OVERLAY)]
    if problems:
        refuse("the tree holds private files:\n" + "\n".join(problems))
    message = f"Release {version}\n\n{notes.group(1).strip()}\n"
    hits, binaries = scan(text("rev-parse", f"{base}^{{tree}}"), tree, denylist)
    hits += [f"release notes: {problem}" for line in message.splitlines() for problem in line_problems(line)]
    hits += ["release notes: denylisted text"] if named([message], denylist) else []
    hits += ["commit identity: denylisted text"] if named(who.groups(), denylist) else []
    if hits:
        refuse("the scan found:\n" + "\n".join(hits))

    tag = f"refs/tags/v{version}"
    previous = fetched(args.to, "refs/heads/main")
    if previous and text("ls-tree", "--name-only", previous, "--", *PRIVATE_ONLY, OVERLAY.rstrip("/")):
        refuse(f"{args.to} holds private files, so it is not the public repository")
    tagged = fetched(args.to, tag)
    if tagged:
        if text("rev-parse", f"{tagged}^{{tree}}") != tree:
            refuse(f"v{version} is already published with a different tree")
        if not previous:
            refuse(f"v{version} is tagged but the public main is missing")
        print(f"v{version} is already published as {tagged[:12]}")
        return
    if previous and text("rev-parse", f"{previous}^{{tree}}") == tree:
        print(f"main already holds v{version} as {previous[:12]}; only the tag is missing")
        if args.push:
            git("push", "-q", args.to, f"{previous}:{tag}")
            print(shown(f"pushed v{version} to {args.to}"))
        return
    if previous:
        published = text("show", f"{previous}:{LAYER}VERSION", check=False)
        if not VERSION.fullmatch(published):
            refuse("the public main is not a snapshot made by this script")
        if numbers(version) <= numbers(published):
            refuse(f"v{version} is not newer than the published v{published}")
    parents = [previous] if previous else []
    if not previous or subprocess.run(["git", "merge-base", "--is-ancestor", base, previous]).returncode != 0:
        parents.append(base)
    date = text("show", "-s", "--format=%cI", release)
    commit_env = {
        **os.environ,
        "GIT_AUTHOR_NAME": who.group(1),
        "GIT_AUTHOR_EMAIL": who.group(2),
        "GIT_COMMITTER_NAME": who.group(1),
        "GIT_COMMITTER_EMAIL": who.group(2),
        "GIT_AUTHOR_DATE": date,
        "GIT_COMMITTER_DATE": date,
    }
    parent_args = [arg for parent in parents for arg in ("-p", parent)]
    snapshot = text("commit-tree", tree, *parent_args, env=commit_env, data=message.encode())

    print(f"release   {release[:12]}  v{version}")
    source = "" if args.upstream == UPSTREAM else f"  from {args.upstream}, not {UPSTREAM}"
    print(shown(f"upstream  {base[:12]}{source}"))
    print(f"denylist  {len(denylist)} entries")
    print(f"parents   {' '.join(p[:12] for p in parents)}")
    print(f"snapshot  {snapshot}")
    print(f"removed   {', '.join(PRIVATE_ONLY)}")
    print(f"overlaid  {laid} files from {OVERLAY} onto the root")
    print(f"binaries  {len(binaries)} changed against upstream; look at new images before the first publish")
    for path in binaries:
        print(shown(f"          {path}"))
    if not args.push:
        print("dry run: nothing pushed")
        return
    git("push", "-q", "--atomic", args.to, f"{snapshot}:refs/heads/main", f"{snapshot}:{tag}")
    print(shown(f"pushed main and v{version} to {args.to}"))


if __name__ == "__main__":
    sys.exit(main())
