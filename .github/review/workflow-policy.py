import json
import re
import sys

import yaml


SECRET_EXPRESSION = re.compile(r"\$\{\{.*?\bsecrets\b.*?\}\}", re.IGNORECASE | re.DOTALL)
NETWORK_TO_SHELL = re.compile(r"\b(?:curl|wget)\b[^|]{0,2000}\|\s*(?:ba)?sh\b", re.IGNORECASE | re.DOTALL)


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

    for path, item in walk(document):
        key = path[-1].lower() if path else ""
        if key == "permissions":
            if isinstance(item, str) and item.lower() == "write-all":
                findings.append(f"{file_name}: permissions: write-all is forbidden")
            if pull_request_enabled and not closed_only and isinstance(item, dict):
                writable = sorted(str(name) for name, access in item.items() if str(access).lower() == "write")
                if writable:
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


payload = json.load(sys.stdin)
errors = []
for workflow in payload:
    errors.extend(analyze(workflow["file"], workflow["source"]))
json.dump(errors, sys.stdout)
