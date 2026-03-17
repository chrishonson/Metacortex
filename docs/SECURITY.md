# Security Notes

Known security warnings for the deployed Firebase Open Brain service. These are documented for tracking — not yet resolved.

---

## WARN-1: `memory_events` collection not in Firestore rules

**File:** `firestore.rules`

The `memory_events` audit log collection is not explicitly covered by Firestore security rules. It is currently protected only by Firestore's implicit default-deny behavior. A future rules edit could inadvertently open it.

**Fix:** Add an explicit deny rule for `memory_events`:
```
match /memory_events/{document=**} {
  allow read, write: if false;
}
```

---

## WARN-2: Token length leakage in `isAuthorized()`

**File:** `functions/src/app.ts`, around the `isAuthorized` function

The early-return on length mismatch before calling `timingSafeEqual` reveals whether a provided bearer token has the same byte length as the expected token. An attacker can enumerate token length by trying tokens of varying lengths and observing the fast-fail path.

Risk is low if tokens are fixed-format (e.g., UUID, 32-char hex), but the behavior is worth noting.

**Fix:** Pad or hash both sides to a constant length before comparison to eliminate the length oracle.

---

## WARN-3: `/healthz` reveals endpoint topology

**File:** `functions/src/app.ts`, `/healthz` route

The public, unauthenticated `/healthz` response includes an `endpoints` array that reveals the full internal URL structure of the service. This is not directly exploitable but reduces obscurity.

**Fix:** Remove the `endpoints` field from the healthz response, or gate it behind auth.

---

## WARN-4: No rate limiting on Gemini API calls

**File:** `functions/src/service.ts`, `functions/src/embeddings.ts`

Every authenticated `store_context` or `search_context` call triggers one or more Gemini API calls (embedding and optionally multimodal normalization). A valid client token can trigger unbounded Gemini API usage, with no per-client quota enforcement beyond Cloud Functions concurrency limits.

**Fix options:**
- Add Cloud Armor or Firebase App Check for browser-facing client profiles
- Implement per-client request quotas or token-bucket rate limiting in the function
- Monitor Gemini billing alerts as a short-term mitigation

---

## WARN-5: `DELETE` in CORS `Allow-Methods` but returns 405

**File:** `functions/src/app.ts`, `applyCorsHeaders` function

The `Access-Control-Allow-Methods` header advertises `DELETE` support, but the `DELETE /` route handler returns 405. This is a minor inconsistency — browsers may preemptively allow DELETE requests that the server will reject.

**Fix:** Remove `DELETE` from `Access-Control-Allow-Methods`, or add proper DELETE handling consistent with MCP spec requirements.

---

## INFO: No security headers

**File:** `functions/src/app.ts`

API responses do not set common defensive headers (`X-Content-Type-Options: nosniff`, `X-Frame-Options`). Impact is low for a pure JSON API, but `nosniff` is a cheap hardening win.

---

## INFO: Express v5 in use

**File:** `functions/package.json`

Express v5 is relatively new. Monitor for security advisories as the ecosystem matures.
