# Server service domains

Service implementations are grouped by the state or runtime boundary they own:

| Directory | Responsibility |
| --- | --- |
| `composition/` | Tool composition catalog, inspection, and provisioning |
| `environments/` | Host, container, and Kubernetes execution environments |
| `identity/` | Authentication, accounts, and user preferences |
| `network/` | TLS, server identity, and LAN discovery |
| `persistence/` | Application database, leases, SQLite, and encryption |
| `projects/` | Project state plus project-specific attachments, connections, and deployment |
| `release/` | Build identity, update checks, and self-update |
| `runtime/` | Terminal adapters, agent maintenance, and runtime profiles |
| `storage/` | Cross-domain storage measurement and cleanup orchestration |
| `usage/` | Usage ingestion, accounting, analytics, and pricing |
| `workspace/` | Workspace catalog, session persistence, artifacts, and secure I/O |

First-party code imports these canonical paths directly. Historical compiled paths under
`dist/server/services/*.js` remain package-compatible through the explicit mapping in
`scripts/service-compatibility.js`; do not add source facades back to this directory.
