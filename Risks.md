# Risks

## Recall callback timeout

If a TLS handshake stalls, the callback times out after five seconds, but the connection can
remain open. We accept this reliability risk for the current low-volume, single-user proof of
concept. Revisit before adding users or relying on timely delivery.

After the successful synthetic benchmark, we disabled the test subscription and restored the
previous transport. Enabling live notifications requires a separate decision.
