# Recoverable CRM execution

`runPlan(authorization, deps)` persists an operation identified by the server's
`requestId`, then reserves commands through the fenced Task 6 repository. Reusing
the request with another plan, owner, basis or payload is an idempotency conflict.
`ExecutionDeps.verify` must reread canonical sources, the CRM baseline and current
policy both before and after a mutation. Queue execution uses the native verifier;
missing or changed evidence fails closed. Legacy tools must enter this same
reservation path when they are connected by the service layer.

Every send has a durable token and attempt counter before calling the Task 8
adapter. Its HTTP acknowledgement becomes a confirmed receipt only after a GET
matches the requested fields and entity identity. An unknown result, cancellation
after send or abandoned sending token retains the reservation. After 30 seconds,
an abandoned token permits GET reconciliation, never another mutation. Only a
known rate-limit rejection permits a delayed retry, capped at five ledger attempts.

Reconciliation can read a known returned ID after authorization or work expiry.
An uncertain organization/person creation can also be adopted when a complete,
bounded search yields exactly one full field match for its strong CNPJ/email
identifier. Names, deal titles, task text, incomplete searches and ambiguous
matches do not prove a POST's effect and require review. `checkedAt` appears only
after successful read-back. Read failures preserve uncertainty.

Operational authorization lasts at most 300 seconds and never exceeds actor
expiry. Queue deliveries cannot extend it. A fresh authenticated `runPlan` call
with the same request and unchanged plan/basis can renew the authorization window;
fence, source, plan, policy and capability checks still precede new writes.

`runPlan(..., { ...deps, defer: true })` reserves every command before returning
`queued`. `enqueueOperation` checks those durable reservations before publishing
only `{accountKey: 'elotenant', operationId, version}`. The Queue contains neither
bearer tokens nor customer bodies. Consumer batch size and concurrency start at
one. `max_retries: 4` means four retries after the initial delivery (five delivery
attempts); the independent ledger caps actual mutation attempts despite duplicate
deliveries. Infrastructure retries can reach `elo-agendor-operations-dlq`;
business uncertainty remains in the operation ledger for review/reconciliation.

The native verifier compares conversation snapshot hashes and CRM record hashes
with the source references created by the existing adapters, and reads policy
from the account. Unknown source formats require new preparation. Operator
sources require an interactive verifier. A stored policy must exist for native
Queue writes. There is no upstream compare-and-swap contract: a human or an old
uncoordinated tool can still race a CRM write between the before/after reads.

Queue configuration semantics were checked against the installed Wrangler
schema and [Cloudflare's Queue configuration documentation](https://developers.cloudflare.com/queues/configuration/configure-queues/).
