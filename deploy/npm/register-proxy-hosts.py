#!/usr/bin/env python3
"""Put the institution's two names on the NPM edge, idempotently.

The institution runs on i2 and the edge is nginx-proxy-manager on the proxy
host. Nothing about that pair is automatic: NPM routes by hostname, so both
`atheniq.innotel.site` and `registrar.innotel.site` need a proxy host that
forwards to the container's published port, with the zone's wildcard
certificate attached.

Run it on the proxy host, where NPM's API credentials already live:

    python3 register-proxy-hosts.py --dry-run
    python3 register-proxy-hosts.py

It re-reads NPM's own state before every write, so a second run changes
nothing. It never prints the credential it authenticates with.
Exit status: 0 done, 1 NPM refused or answered unexpectedly, 2 bad input.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request

NPM_API = os.environ.get("NPM_API", "http://127.0.0.1:81/api")
CREDENTIALS = os.environ.get("NPM_ENV", "/data/wildcard-hooks/npm.env")


def read_credentials(path: str) -> tuple[str, str, str]:
    """NPM_EMAIL / NPM_PASSWORD, plus an optional NPM_API override."""

    values: dict[str, str] = {}
    with open(path, encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            values[key.strip()] = value.strip().strip('"').strip("'")
    try:
        return values["NPM_EMAIL"], values["NPM_PASSWORD"], values.get("NPM_API", NPM_API)
    except KeyError as missing:
        raise SystemExit(f"register-proxy-hosts: {missing} missing from {path}") from None


def call(method: str, path: str, token: str | None, body: dict | None, base: str) -> tuple[int, object]:
    data = json.dumps(body).encode() if body is not None else None
    request = urllib.request.Request(f"{base}{path}", data=data, method=method)
    request.add_header("Accept", "application/json")
    if data is not None:
        request.add_header("Content-Type", "application/json")
    if token:
        request.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            payload = response.read().decode() or "null"
            return response.status, json.loads(payload)
    except urllib.error.HTTPError as error:
        text = error.read().decode("utf-8", "replace")
        try:
            parsed = json.loads(text)
        except json.JSONDecodeError:
            parsed = text
        return error.code, parsed


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--domain", action="append", default=[], help="hostname to route (repeatable)")
    parser.add_argument("--forward-host", default="192.168.1.52", help="where the institution listens")
    parser.add_argument("--forward-port", type=int, default=8091, help="published container port")
    parser.add_argument("--forward-scheme", default="http", choices=("http", "https"), help="upstream scheme")
    parser.add_argument("--advanced-config", default="", help="extra nginx directives for the host")
    parser.add_argument("--cert-domain", default="*.innotel.site", help="wildcard certificate to attach")
    parser.add_argument("--dry-run", action="store_true", help="report, change nothing")
    args = parser.parse_args(argv)

    domains = args.domain or ["atheniq.innotel.site", "registrar.innotel.site"]
    email, password, base = read_credentials(CREDENTIALS)

    status, token_body = call("POST", "/tokens", None, {"identity": email, "secret": password}, base)
    if status != 200 or not isinstance(token_body, dict) or "token" not in token_body:
        print(f"register-proxy-hosts: NPM refused the login ({status}): {token_body}", file=sys.stderr)
        return 1
    token = token_body["token"]

    status, certificates = call("GET", "/nginx/certificates", token, None, base)
    if status != 200 or not isinstance(certificates, list):
        print(f"register-proxy-hosts: could not list certificates ({status})", file=sys.stderr)
        return 1
    certificate = next(
        (item for item in certificates if args.cert_domain in (item.get("domain_names") or [])),
        None,
    )
    if certificate is None:
        print(f"register-proxy-hosts: no certificate covers {args.cert_domain}", file=sys.stderr)
        return 1

    status, hosts = call("GET", "/nginx/proxy-hosts", token, None, base)
    if status != 200 or not isinstance(hosts, list):
        print(f"register-proxy-hosts: could not list proxy hosts ({status})", file=sys.stderr)
        return 1

    body = {
        "domain_names": domains,
        "forward_scheme": args.forward_scheme,
        "forward_host": args.forward_host,
        "forward_port": args.forward_port,
        "certificate_id": certificate["id"],
        "ssl_forced": True,
        "http2_support": True,
        "hsts_enabled": False,
        "hsts_subdomains": False,
        "block_exploits": True,
        "caching_enabled": False,
        "allow_websocket_upgrade": True,
        "access_list_id": 0,
        "advanced_config": args.advanced_config,
        "meta": {"letsencrypt_agree": False, "dns_challenge": False},
        "locations": [],
    }

    for domain in domains:
        existing = next((host for host in hosts if domain in (host.get("domain_names") or [])), None)
        if existing is not None:
            same = (
                existing.get("forward_host") == args.forward_host
                and existing.get("forward_port") == args.forward_port
                and (existing.get("forward_scheme") or "http") == args.forward_scheme
                and existing.get("certificate_id") == certificate["id"]
            )
            print(f"{domain}: already routed by proxy host {existing['id']} ({'matches' if same else 'DIFFERS'})")
            if same or args.dry_run:
                continue
            patch = {**body, "domain_names": existing.get("domain_names") or [domain]}
            status, result = call("PUT", f"/nginx/proxy-hosts/{existing['id']}", token, patch, base)
            print(f"{domain}: updated -> {status}")
            continue

        if args.dry_run:
            print(f"{domain}: would create proxy host -> {args.forward_scheme}://{args.forward_host}:{args.forward_port} "
                  f"(cert {certificate['id']} for {args.cert_domain})")
            continue

        status, result = call("POST", "/nginx/proxy-hosts", token, body, base)
        if status not in (200, 201):
            print(f"register-proxy-hosts: creating the host for {domains} failed ({status}): {result}", file=sys.stderr)
            return 1
        print(f"{', '.join(domains)}: created proxy host {result.get('id') if isinstance(result, dict) else '?'} "
              f"-> {args.forward_scheme}://{args.forward_host}:{args.forward_port}, cert {certificate['id']}")
        break

    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
