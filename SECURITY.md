# Security Policy · dsh-cross-workspace

## Supported versions

| Version | Supported |
|---|---|
| `0.8.x` | ✅ |
| earlier | ❌ (please upgrade) |

## Reporting a vulnerability

**Do not open a public GitHub issue for a security report.**

Email the maintainer at **dream-office** with:

- affected version and DSH version;
- a minimal reproduction (steps, store shape if relevant);
- impact and whether the issue requires local access;
- any suggested fix.

You should receive an acknowledgement within 7 days. Please allow time for a
fix and coordinated disclosure before publishing details.

## Scope notes

This is a local, single-owner DSH plugin. Relevant security boundaries include:

- the management HTTP API admission check (`x-dsh-cross-workspace` +
  `connection.requestRejection` / same-origin fallback);
- attachment copying and the `allowExternalAttachments` escape hatch;
- message visibility (direct messages, group snapshots, workspace broadcasts);
- local `store.json` / attachment permissions.

The plugin makes no outbound network requests. Do not include real personal
data, store dumps, or credentials in a report; use synthetic examples.
