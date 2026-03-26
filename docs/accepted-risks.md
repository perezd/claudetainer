# Accepted Risks Registry

Risks identified by the synthetic security panel that cannot be eliminated without breaking core functionality or introducing worse trade-offs. Each risk was reviewed by the panel and accepted with documented justification.

## Entry Format

Each entry includes: risk title, affected layer(s), why it can't be resolved, compensating controls, severity, and date identified. Resolved risks are marked with a resolution date and PR reference — never silently deleted.

---

## Open Risks

### IPv6 egress unrestricted

- **Affected layer:** Network Isolation
- **Description:** All outbound IPv6 traffic is allowed (OUTPUT ACCEPT). IPv4 iptables is the enforcement layer.
- **Why it can't be resolved:** Fly.io SSH requires public IPv6 routing, and Fly's kernel has broken IPv6 conntrack, making IPv6 filtering unreliable.
- **Compensating controls:** All security-relevant egress rules are enforced on IPv4. The domain allowlist and CoreDNS filtering operate at the DNS layer, which is protocol-agnostic.
- **Severity:** Medium
- **Date identified:** 2025 (pre-existing, documented in README)

### Settings file writable by claude user

- **Affected layer:** Command Approval
- **Description:** `claude-settings.json` (which configures the approval hook) is owned by the `claude` user. Claude can delete and recreate it, removing the hook.
- **Why it can't be resolved:** Claude Code requires write access to its own settings file for normal operation.
- **Compensating controls:** Layer 2 (network isolation via iptables) and Layer 3 (approval binary at `/opt/approval/`, owned by root) are the real enforcement boundaries. Even if the hook is removed, network isolation prevents data exfiltration and the approval binary cannot be modified.
- **Severity:** Medium
- **Date identified:** 2025 (pre-existing, documented in README)

---

## Resolved Risks

_No resolved risks yet._
