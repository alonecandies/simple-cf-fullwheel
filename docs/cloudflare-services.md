# Cloudflare service allowances and cost notes

This guide records the published Free-plan limits referenced by Passing Place.
Cloudflare changes product limits and pricing, so treat the figures as a dated
snapshot and confirm the linked official documentation before relying on them.

[Back to the project README](../README.md).

## Free-plan allocations and practical caps

The following are the published Workers Free allocations checked on **November
23, 2026**. Limits are shared with other services or apps in the same Cloudflare
account where noted, and daily allocations reset at 00:00 UTC. Free-plan
operations can fail after their limit; R2 has separate overage pricing if
account usage goes beyond its included monthly allowance. Monitor account usage
before sharing the demo widely.

| Service | Published Free allocation relevant here | App-side behavior |
| --- | --- | --- |
| Workers | 100,000 requests/day; 10 ms CPU per invocation | API, email handlers, Pages Functions, and Workflow invocations use Workers allocations. |
| D1 | 5 million rows read/day, 100,000 rows written/day, 5 GB total storage | The list returns up to 60 notes; the total count scans at most the 10,000 lifetime note rows. |
| Workers KV | 100,000 reads/day, 1,000 writes/day, 1,000 deletes/day, 1 GB stored | One list key with 60-second expiry; invalidated on approval/card creation. |
| R2 Standard | 10 GB-month storage, 1 million Class A and 10 million Class B operations/month; internet egress is free | Up to 5,000 photos at 512 KiB each and 5,000 cards at 256 KiB each: about 3.7 GiB at the maximum sizes. |
| Queues | 10,000 operations/day; 24-hour message retention on Free | A normal message uses about three operations (write, read, delete); retries and dead-letter delivery use more. |
| Workers AI | 10,000 Neurons/day | Both moderation models draw from the account’s daily allocation. Further calls fail on Free after the cap. |
| AI Gateway | Core dashboard analytics, caching, and rate limiting are free | Moderation calls use the `default` gateway. Payload logging is disabled per request; metadata remains available. |
| AI Search | 5 million ingestion tokens, 10 GB-month storage, 1,000 semantic queries/month, and 1,000 full-text queries/month | The built-in index contains approved notes only. The app caps this index at 6,000 notes and search at 900 calls per UTC month. AI Search billing begins Dec 1, 2026; usage over included amounts is billed. |
| Vectorize | 5 million stored vector dimensions and 30 million queried vector dimensions/month; 100 indexes | Uses 768 dimensions per note and the `@cf/baai/bge-base-en-v1.5` model. Vectorize usage is separate from Workers AI embedding Neurons; check both allowances before enabling. |
| Cloudflare Images | 5,000 unique transformations/month | One fixed WebP transform per approved photo. Free over-limit transforms fail without a charge, and the app serves the original photo instead. |
| Cache API | 50 `match`/`put`/`delete` calls per request, shared with the subrequest limit; 512 MB maximum object | This route makes one lookup and at most one write on a miss. Cache is best-effort within each Cloudflare data center. Every request still runs the Worker and performs the D1 approval check. |
| Workers Analytics Engine | Docs list 100,000 data points/day and 10,000 read queries/day | The app writes one point per moderation and makes no SQL API reads. Cloudflare’s pricing page was last updated April 23, 2026 and said billing had not started at that time; recheck before relying on that statement. |
| Workers Logs and Traces | Through Nov 30, 2026: Workers Logs list 200,000 events/day and 3-day retention. From Dec 1, Observability Free includes 0.5 GB/day ingestion and seven-day retention shared across supported datasets. | Both Workers sample 10%. Traces are now enabled. Query strings are redacted; usage includes platform spans and can reach the shared daily ingestion cap. |
| Cloudflare Access | Zero Trust Free currently supports up to 50 users | This demo allows one configured moderator email. Check current account plan limits before adding users. |
| Cron Triggers | Scheduled invocations use the Workers allowance of 100,000 requests/day | One scheduled invocation every 15 minutes (96 per day), using the Worker's scheduled handler and one aggregate D1 query. Trigger changes can take up to 15 minutes to propagate. |
| Workers Rate Limiting API | No separate quota is listed on the binding page | One approximate 5-per-minute limit is configured per Cloudflare location. It is an abuse-speed bump, not a strict global cap or a replacement for Turnstile. |
| Durable Objects | 100,000 requests/day, 13,000 GB-s/day; SQLite-backed storage has 5 million rows read/day, 100,000 written/day, and 5 GB total | The presence object uses the SQLite-backed class configuration and WebSocket Hibernation API; it stores no application data. |
| Workflows | 100,000 requests/day shared with Workers, 10 ms CPU/invocation, 3,000 steps/day, 1 GB-month state | An approved note uses the regular moderation, metric, notification, AI Search, Vectorize, and share-card steps; each search index is fail-soft. An enabled email notice adds one. Workflow state is retained for three days on Free. |
| Browser Run | 10 browser minutes/day and 3 concurrent browser sessions | Rendering is attempted only after approval. If the daily allowance is exhausted, the note still publishes without a share card. |
| Cloudflare Pages | 500 builds/month, 1 concurrent build; Pages Function requests use the Workers Free shared 100,000 requests/day | Pages is live as the second host. Static asset requests are free; dynamic requests run the Pages Function proxy and then call `passing-place` through a service binding. |
| Hyperdrive | 100,000 database statements/day on Workers Free | Only applies to Hyperdrive usage. The external database provider has separate costs and limits; this demo route runs only a fixed read-only `SELECT 1`. |
| Email Service | Unlimited inbound routing; Free outbound sends only to verified destination addresses | The app’s optional notice is restricted to one verified recipient. Sending to arbitrary destinations requires Workers Paid. |
| Zaraz | 1 million events/month/account; Zaraz Paid is $5 per additional million | The code emits only consented, content-free custom events. Dashboard auto-injection can also send page-view events, so monitor the whole zone's event count. |
| Cloudflare DNS, WAF, Bot Fight Mode | DNS management, Free Managed Ruleset, and Bot Fight Mode are available for eligible Free zones | These are configured on a proxied custom domain. They cannot be attached as zone settings to the shared `workers.dev` or `pages.dev` hostnames. |
| Cloudflare Tunnel and Gateway/WARP | Zero Trust Free services; account and device limits apply | Tunnel needs a local/private origin and a domain for a persistent published hostname. Gateway/WARP protects enrolled user devices and networks, not public guest traffic. |
| Turnstile / Web Analytics / Static Assets | Available on the Free plan | Turnstile and analytics each require their site configuration; static files ship with the Worker. |

These limits are not a guaranteed combined capacity: the same account may have
other Workers, AI calls, Queues, or storage consuming them. The core Worker,
Images, AI Gateway, Analytics Engine (subject to its stale pricing note), and
Pages paths do not require a Paid Workers plan in the published limits.
Vectorize, AI Search, and Workers Traces are enabled; Zaraz and inbound Email
Routing remain off pending their domain setup requirements. AI Search usage
over its included monthly allocation is billable from Dec 1, 2026. Workers Traces and
Logs share the Observability Free ingestion allowance from that date. The
moderator Worker needs a Cloudflare Access policy; without one, its
application-level identity check returns 403.

Pricing and limit references: [Workers](https://developers.cloudflare.com/workers/platform/pricing/), [Observability and Traces](https://developers.cloudflare.com/observability/pricing/), [D1](https://developers.cloudflare.com/d1/platform/pricing/), [KV](https://developers.cloudflare.com/kv/platform/pricing/), [R2](https://developers.cloudflare.com/r2/pricing/), [Queues](https://developers.cloudflare.com/queues/platform/pricing/), [Workers AI](https://developers.cloudflare.com/workers-ai/platform/pricing/), [AI Gateway](https://developers.cloudflare.com/ai-gateway/reference/pricing/), [AI Search](https://developers.cloudflare.com/ai-search/platform/limits-pricing/), [Vectorize](https://developers.cloudflare.com/vectorize/platform/pricing/), [Analytics Engine](https://developers.cloudflare.com/analytics/analytics-engine/pricing/), [Images](https://developers.cloudflare.com/images/pricing/), [Hyperdrive](https://developers.cloudflare.com/hyperdrive/platform/pricing/), [Email Service](https://developers.cloudflare.com/email-service/platform/pricing/), [Email Routing](https://developers.cloudflare.com/email-service/get-started/route-emails/), [Zaraz](https://developers.cloudflare.com/zaraz/pricing-info/), [Pages](https://developers.cloudflare.com/pages/platform/limits/), [Durable Objects](https://developers.cloudflare.com/durable-objects/platform/pricing/), [Workflows](https://developers.cloudflare.com/workflows/reference/pricing/), [Browser Run](https://developers.cloudflare.com/browser-run/pricing/), [Turnstile](https://developers.cloudflare.com/turnstile/), [Web Analytics](https://developers.cloudflare.com/web-analytics/), [Workers Static Assets](https://developers.cloudflare.com/workers/static-assets/), [Cache API](https://developers.cloudflare.com/workers/runtime-apis/cache/), [Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/), [Service bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/), [WAF Free plan](https://developers.cloudflare.com/waf/get-started/), [Bot Fight Mode](https://developers.cloudflare.com/bots/get-started/bot-fight-mode/), [Cloudflare Tunnel](https://developers.cloudflare.com/tunnel/get-started/), [Cloudflare One account limits](https://developers.cloudflare.com/cloudflare-one/account-limits/), and [Zero Trust Free plan](https://www.cloudflare.com/plans/zero-trust-services/).
