# Security Policy

## Supported versions

LegacyGraph is pre-1.0 and ships from `main`. Only the latest commit on `main` receives
security fixes.

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Report privately through GitHub:
[**Report a vulnerability**](https://github.com/cooperstlogic/legacy-graph/security/advisories/new).
This opens a draft advisory visible only to you and the maintainers.

Please include:

- what the vulnerability lets an attacker do,
- the affected file or endpoint,
- steps to reproduce, ideally a minimal case,
- the commit SHA you tested against.

You can expect an acknowledgement within 7 days and an assessment within 30. If a fix is
warranted, the advisory becomes public once it lands.

## Threat model

LegacyGraph is **self-hosted, local-first software**. It assumes it is running on a machine the
operator controls, serving an operator who is trusted. Two consequences shape what counts as a
vulnerability:

- **Authentication is off unless configured.** With no `$DATA_DIR/_meta/auth.yaml`, every
  endpoint is unauthenticated by design — the assumption is a single user on `localhost`. That
  a default install is open to anyone who can reach the port is documented behaviour, not a
  vulnerability. See [Authentication](README.md#authentication) to turn it on.
- **The data directory is trusted input.** The server parses YAML and Markdown that the
  operator put on their own disk. Crashes on malformed local files are ordinary bugs.

Reports that *are* in scope, whether or not auth is enabled:

- path traversal out of `DATA_DIR` (asset routes, GEDCOM import, story loading)
- authentication or session bypass when `auth.yaml` **is** configured — JWT verification,
  cookie handling, the public-route allowlist
- remote code execution reachable from a request, including via an uploaded asset or an
  imported GEDCOM file
- YAML or Markdown parsing that escalates beyond the parse — deserialization into code
  execution, not a validation error
- stored XSS in rendered stories, person notes, or asset metadata
- secrets leaking into API responses, logs, or Git commits

## Exposing an instance to a network

If you run LegacyGraph anywhere other than `localhost`, configure `auth.yaml` first, put it
behind TLS, and treat `jwt_secret` as a real credential: at least 32 random characters, never
committed. Your data directory is a Git repository containing your family's history — back it
up and control who can read it.
