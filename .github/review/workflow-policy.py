import json
import re
import sys

import yaml


SECRET_EXPRESSION = re.compile(r"\$\{\{.*?\bsecrets\b.*?\}\}", re.IGNORECASE | re.DOTALL)
NETWORK_TO_SHELL = re.compile(r"\b(?:curl|wget)\b[^|]{0,2000}\|\s*(?:ba)?sh\b", re.IGNORECASE | re.DOTALL)
SOURCE_SECURITY_WORKFLOW = ".github/workflows/source-security.yml"
PINNED_ACTION = re.compile(r"^[a-z0-9_.-]+/[a-z0-9_.-]+(?:/[a-z0-9_.-]+)?@[a-f0-9]{40}$", re.IGNORECASE)
ALLOWED_SOURCE_SECURITY_ACTIONS = {
    "actions/checkout",
    "github/codeql-action/init",
    "github/codeql-action/analyze",
}


MISSING = object()


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
    if file_name != SOURCE_SECURITY_WORKFLOW or document.get("permissions") != {}:
        return False
    job = document.get("jobs", {}).get("analyze")
    if not isinstance(job, dict):
        return False
    if job.get("permissions") != {
        "actions": "read",
        "contents": "read",
        "security-events": "write",
    }:
        return False
    steps = job.get("steps")
    if not isinstance(steps, list) or len(steps) != 3 or job.get("env") is not None:
        return False

    checkout_steps = []
    init_steps = []
    analyze_steps = []
    for step in steps:
        if not isinstance(step, dict) or "run" in step or "script" in step or "env" in step:
            return False
        action = step.get("uses")
        if action:
            if not isinstance(action, str) or not PINNED_ACTION.fullmatch(action):
                return False
            action_name = action.split("@", 1)[0].lower()
            if action_name not in ALLOWED_SOURCE_SECURITY_ACTIONS:
                return False
            if action_name == "actions/checkout":
                checkout_steps.append(step)
            elif action_name == "github/codeql-action/init":
                init_steps.append(step)
            elif action_name == "github/codeql-action/analyze":
                analyze_steps.append(step)
        for path, item in walk(step):
            key = path[-1].lower() if path else ""
            if key in ("gh_token", "github_token"):
                return False
            if isinstance(item, str) and re.search(r"(?:github\.token|\bGITHUB_TOKEN\b|\bGH_TOKEN\b)", item, re.IGNORECASE):
                return False

    if len(checkout_steps) != 1 or len(init_steps) != 1 or len(analyze_steps) != 1:
        return False
    if checkout_steps[0].get("with") != {"persist-credentials": False}:
        return False
    init_action = init_steps[0]["uses"].split("@", 1)[1]
    analyze_action = analyze_steps[0]["uses"].split("@", 1)[1]
    if init_action != analyze_action:
        return False
    init_with = init_steps[0].get("with", {})
    if set(init_with) != {"build-mode", "languages", "queries"}:
        return False
    if init_with.get("build-mode") != "none" or init_with.get("queries") != "security-extended" or not init_with.get("languages"):
        return False
    analyze_with = analyze_steps[0].get("with", {})
    if set(analyze_with) - {"category"}:
        return False
    return True


def analyze(file_name, source):
    findings = []
    try:
        document = yaml.safe_load(source)
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
