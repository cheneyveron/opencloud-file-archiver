import json
import re
import sys

import yaml


SECRET_EXPRESSION = re.compile(r"\$\{\{.*?\bsecrets\b.*?\}\}", re.IGNORECASE | re.DOTALL)
NETWORK_TO_SHELL = re.compile(r"\b(?:curl|wget)\b[^|]{0,2000}\|\s*(?:ba)?sh\b", re.IGNORECASE | re.DOTALL)
SOURCE_SECURITY_WORKFLOW = ".github/workflows/source-security.yml"
PINNED_ACTION = re.compile(r"^[a-z0-9_.-]+/[a-z0-9_.-]+(?:/[a-z0-9_.-]+)?@[a-f0-9]{40}$", re.IGNORECASE)
TRUSTED_SOURCE_SECURITY_ACTIONS = {
    "actions/checkout",
    "github/codeql-action/autobuild",
    "github/codeql-action/init",
    "github/codeql-action/analyze",
}


MISSING = object()


class GitHubActionsLoader(yaml.SafeLoader):
    """Parse Actions YAML like YAML 1.2 and reject duplicate mapping keys."""


GitHubActionsLoader.yaml_implicit_resolvers = {
    key: [resolver for resolver in resolvers if resolver[0] != "tag:yaml.org,2002:bool"]
    for key, resolvers in yaml.SafeLoader.yaml_implicit_resolvers.items()
}
GitHubActionsLoader.add_implicit_resolver(
    "tag:yaml.org,2002:bool",
    re.compile(r"^(?:true|false)$", re.IGNORECASE),
    list("tTfF"),
)


def unique_mapping(loader, node, deep=False):
    mapping = {}
    for key_node, value_node in node.value:
        key = loader.construct_object(key_node, deep=deep)
        if key in mapping:
            raise yaml.constructor.ConstructorError(
                "while constructing a mapping",
                node.start_mark,
                f"found duplicate key {key!r}",
                key_node.start_mark,
            )
        mapping[key] = loader.construct_object(value_node, deep=deep)
    return mapping


GitHubActionsLoader.add_constructor(
    yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG,
    unique_mapping,
)


def event_config(document, name):
    triggers = document.get("on", document.get(True))
    if isinstance(triggers, str):
        return {} if triggers == name else MISSING
    if isinstance(triggers, list):
        return {} if name in triggers else MISSING
    if isinstance(triggers, dict):
        return triggers[name] if name in triggers else MISSING
    return MISSING


def walk(value, path=()):
    yield path, value
    if isinstance(value, dict):
        for key, item in value.items():
            yield from walk(item, path + (str(key),))
    elif isinstance(value, list):
        for index, item in enumerate(value):
            yield from walk(item, path + (str(index),))


def constrained_codeql_upload(file_name, document):
    normalized_top_keys = {"on" if key is True else str(key) for key in document}
    if (
        file_name != SOURCE_SECURITY_WORKFLOW
        or normalized_top_keys != {"jobs", "name", "on", "permissions"}
        or document.get("name") != "Source security"
        or document.get("permissions") != {}
    ):
        return False
    triggers = document.get("on", document.get(True))
    if triggers != {
        "pull_request": {"types": ["opened", "synchronize", "reopened", "ready_for_review"]},
        "push": {"branches": ["main"]},
        "merge_group": {},
        "workflow_dispatch": {},
    }:
        return False
    jobs = document.get("jobs")
    if not isinstance(jobs, dict) or set(jobs) != {"analyze"}:
        return False
    job = jobs["analyze"]
    if not isinstance(job, dict) or set(job) != {"name", "permissions", "runs-on", "steps", "strategy"}:
        return False
    if job.get("name") != "CodeQL / ${{ matrix.language }}" or job.get("runs-on") != "ubuntu-24.04":
        return False
    if job.get("permissions") != {
        "actions": "read",
        "contents": "read",
        "security-events": "write",
    }:
        return False
    if job.get("strategy") != {
        "fail-fast": False,
        "matrix": {
            "include": [
                {"language": "go", "build-mode": "autobuild"},
                {"language": "javascript-typescript", "build-mode": "none"},
            ]
        },
    }:
        return False
    steps = job.get("steps")
    if not isinstance(steps, list) or len(steps) != 4:
        return False

    expected_step_keys = [
        {"name", "uses", "with"},
        {"name", "uses", "with"},
        {"if", "name", "uses"},
        {"name", "uses", "with"},
    ]
    for step, expected_keys in zip(steps, expected_step_keys):
        if not isinstance(step, dict) or set(step) != expected_keys:
            return False
        if not isinstance(step["uses"], str) or not PINNED_ACTION.fullmatch(step["uses"]):
            return False
        action, _revision = step["uses"].lower().split("@", 1)
        if action not in TRUSTED_SOURCE_SECURITY_ACTIONS:
            return False

    checkout, init, autobuild, analyze = steps
    if checkout["name"] != "Check out the proposed revision" or checkout["uses"].split("@", 1)[0].lower() != "actions/checkout":
        return False
    if checkout["with"] != {"persist-credentials": False}:
        return False
    if init["name"] != "Initialize CodeQL" or init["uses"].split("@", 1)[0].lower() != "github/codeql-action/init":
        return False
    if init["with"] != {
        "languages": "${{ matrix.language }}",
        "build-mode": "${{ matrix.build-mode }}",
        "queries": "security-extended",
    }:
        return False
    if autobuild != {
        "name": "Autobuild Go",
        "if": "${{ matrix.build-mode == 'autobuild' }}",
        "uses": autobuild["uses"],
    } or autobuild["uses"].split("@", 1)[0].lower() != "github/codeql-action/autobuild":
        return False
    if analyze["name"] != "Analyze source" or analyze["uses"].split("@", 1)[0].lower() != "github/codeql-action/analyze":
        return False
    if analyze["with"] != {"category": "/language:${{ matrix.language }}"}:
        return False
    codeql_shas = {
        step["uses"].split("@", 1)[1]
        for step in (init, autobuild, analyze)
    }
    if len(codeql_shas) != 1:
        return False
    return True


def analyze(file_name, source):
    findings = []
    try:
        document = yaml.load(source, Loader=GitHubActionsLoader)
    except yaml.YAMLError as error:
        return [f"{file_name}: workflow YAML is invalid: {error}"]
    if not isinstance(document, dict):
        return [f"{file_name}: workflow root must be a mapping"]

    if event_config(document, "pull_request_target") is not MISSING:
        findings.append(f"{file_name}: pull_request_target is forbidden")

    pull_request = event_config(document, "pull_request")
    pull_request_enabled = pull_request is not MISSING
    closed_only = False
    if isinstance(pull_request, dict):
        event_types = pull_request.get("types")
        closed_only = event_types == ["closed"] or event_types == "closed"
    codeql_upload_is_constrained = constrained_codeql_upload(file_name, document)

    for path, item in walk(document):
        key = path[-1].lower() if path else ""
        if key == "permissions":
            if isinstance(item, str) and item.lower() == "write-all":
                findings.append(f"{file_name}: permissions: write-all is forbidden")
            if pull_request_enabled and not closed_only and isinstance(item, dict):
                writable = sorted(str(name) for name, access in item.items() if str(access).lower() == "write")
                codeql_upload_only = (
                    codeql_upload_is_constrained
                    and path == ("jobs", "analyze", "permissions")
                    and writable == ["security-events"]
                )
                if writable and not codeql_upload_only:
                    findings.append(
                        f"{file_name}: pull_request workflow grants write permissions: {', '.join(writable)}"
                    )
        if key == "persist-credentials" and item not in (False, "false", None):
            findings.append(f"{file_name}: persist-credentials must be false")
        if key == "secrets" and isinstance(item, str) and item.lower() == "inherit":
            findings.append(f"{file_name}: secrets: inherit is forbidden")
        if isinstance(item, str):
            if pull_request_enabled and SECRET_EXPRESSION.search(item):
                findings.append(f"{file_name}: pull_request workflows must not reference repository secrets")
            if key in ("run", "script"):
                if SECRET_EXPRESSION.search(item):
                    findings.append(f"{file_name}: do not interpolate secrets directly into run/script content")
                if NETWORK_TO_SHELL.search(item.replace("\\\n", " ")):
                    findings.append(f"{file_name}: piping network content to a shell is forbidden")

    return sorted(set(findings))


def main():
    payload = json.load(sys.stdin)
    errors = []
    for workflow in payload:
        errors.extend(analyze(workflow["file"], workflow["source"]))
    json.dump(errors, sys.stdout)


if __name__ == "__main__":
    main()
