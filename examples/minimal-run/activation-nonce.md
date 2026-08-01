# A5 — Activation-nonce comment

Posted for every fresh claim activation: fresh claim, takeover, or
legacy migration (immediately after the `claimed-by` comment in
`claim-comment.md`), and also forced-handoff adopt-verbatim, which
posts no separate `claimed-by` of its own. Never posted for a plain
heartbeat, which reuses the existing `{claim-id}`.

---

<!-- markdownlint-disable-next-line MD013 -->
<!-- activation-nonce: copilot-cli-abc12345 claim-20260510T090000Z-55521 nonce-7e2f9c1a8b4d5e6f 2026-05-10T09:00:01Z -->

_copilot-cli-abc12345: claim activation nonce — IDD automation marker. Do not edit._

---

## Field reference

| Field       | Value in this sample           | Meaning                                                           |
| ----------- | ------------------------------ | ----------------------------------------------------------------- |
| `agent-id`  | `copilot-cli-abc12345`         | Tool/session identifier, matching the claim comment               |
| `claim-id`  | `claim-20260510T090000Z-55521` | The `{claim-id}` this nonce activates, matching the claim comment |
| `nonce`     | `nonce-7e2f9c1a8b4d5e6f`       | Fresh opaque token recorded locally alongside agent-id/claim-id   |
| `timestamp` | `2026-05-10T09:00:01Z`         | Human-readable context only; GitHub `created_at` is authoritative |

When 2+ trusted activation-nonce markers exist for the same `claim-id`
(a collision), the winner is the lexicographically earliest `nonce`.
