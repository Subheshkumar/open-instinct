# Rex on WhatsApp: one private agent per user

This repository can host Rex behind one Meta WhatsApp Cloud API number. The first supported message creates a user record and a private Maritime VM. Later messages from the same WhatsApp sender on that business number reuse that VM. Conversations, memory, files and app sessions live in the user's VM; each user is the owner of only their own agent.

```text
WhatsApp → Meta → gateway /webhooks/whatsapp → user's Maritime VM
WhatsApp ← Meta ← gateway private reply relay ← user's agent
```

The shared Meta access token and app secret stay in the gateway. Each VM gets a random token for `/api/whatsapp/send/<userId>`. That endpoint fixes the recipient to the user's WhatsApp identity and rejects request-supplied recipients. Composio identities also differ per user. Incoming payloads are authenticated before any account is created, and each agent checks the forwarded sender against its own owner before admitting a turn.

## Deploy

1. Build and publish the **agent image from this version of the repository**. The upstream image will not contain your WhatsApp changes. The existing `.github/workflows/build-images.yml` publishes agent and gateway images for your fork, or use your container build system with `deploy/Dockerfile.agent`. Make the image accessible to Maritime, and set `INSTINCT_AGENT_IMAGE` to its tag or digest.
2. Copy `deploy/.env.whatsapp.example` to `deploy/.env.whatsapp`. Fill in `MARITIME_API_KEY`, `GATEWAY_PUBLIC_URL`, your agent image, model credentials, and the five `WHATSAPP_*` credential/version fields. The Maritime key needs permission to provision, relay messages, set secrets and delete agents. No Inkbox keys are needed for WhatsApp.
3. Deploy `deploy/Dockerfile.gateway` on a container host with a public HTTPS URL. Mount persistent storage at `/data`, set `GATEWAY_DATA_DIR=/data`, and run **one gateway replica**. Its user registry and durable queues use files; horizontal replication needs a shared database/queue first.
4. In your Meta app, configure the callback URL as `https://<your-gateway>/webhooks/whatsapp`, enter `WHATSAPP_VERIFY_TOKEN` as the verification token, subscribe to the `messages` webhook field, and ensure the app is subscribed to your WhatsApp Business Account. `WHATSAPP_PHONE_NUMBER_ID` is the API id, while `WHATSAPP_PUBLIC_NUMBER` is the optional human-facing phone number.
5. Message Rex from two different WhatsApp numbers. Check that `/health` shows two users, two agent creates appear in your Maritime dashboard, each person receives a reply, and a later message reuses their original VM.

For a local gateway behind an HTTPS tunnel:

```bash
pnpm install --frozen-lockfile
pnpm build
cp deploy/.env.whatsapp.example deploy/.env.whatsapp
# Fill in the file; use a local directory for GATEWAY_DATA_DIR.
node --env-file=deploy/.env.whatsapp packages/gateway/dist/main.js
```

Or run `docker compose -f deploy/docker-compose.whatsapp.yml up --build`. The compose port is loopback-only; point your HTTPS proxy/tunnel at port 8787. The private agent VMs still run on Maritime.

## Limits and messaging

Defaults are 100 incoming messages and 300 admitted agent replies per user per UTC day, 100 active accounts, and 20 new accounts per rolling hour. Quotas and creation counts survive restarts. Deleting an account does not reset the rolling account-creation count. Duplicate webhook deliveries and reply-admission retries do not consume another quota slot. Unsupported media receives a text explanation and does not run the model.

New agents receive purchase ceilings of $25 per action and $50 per day, with approval required above $0. Change these through `INSTINCT_SPEND_PER_ACTION_USD`, `INSTINCT_SPEND_PER_DAY_USD`, and `INSTINCT_SPEND_ASK_ABOVE_USD`. The policy guard denies tool calls above the operator ceilings, including approved calls and grants. A purchase tool must report a finite amount through its `amountUsd` metadata; unknown amounts are denied when operator ceilings are enabled. These are purchase limits, not model/VM billing caps. Provider and hosting costs still need account-level budgets.

Text and interactive text replies are supported. Voice, image understanding and file/media delivery are not implemented. Agent text replies are split into messages below the Cloud API text limit.

Scheduled jobs and long-running results use the same private reply relay. Free-form text delivery is limited to 24 hours after the latest inbound user message. For later notifications, configure `WHATSAPP_NOTIFICATION_TEMPLATE` with an approved template containing exactly one body text parameter, and set its language. The template parameter is capped at 1000 characters. Without a template, the late notification is held as an uncertain outbox receipt for operator review; it is not sent as unrestricted free-form text.

## Account deletion

The user sends `delete my account`, then replies `DELETE` within 10 minutes. `CANCEL` keeps the account. These commands bypass daily chat quotas and never run the model.

Deletion disables agent reply admission, deletes the user's VM and volume, removes that user's private Composio connections when configured, discards queued messages/replies, and removes the local user record. Provider failures keep the record in `deleting` state so cleanup can resume. A minimal hash of the sender identity and deletion timestamp prevents old queued messages from recreating the deleted account. A fresh message after deletion creates a new account with a new agent and token. Removing a Composio connection does not erase data in the user's Gmail, Calendar or other source service.

## Recovery and validation

The gateway persists verified webhook receipts before returning HTTP 200. Agent admission preserves the original Meta message id for deduplication. The agent durably admits each event and sends its result independently of the HTTP request, so long tasks do not require polling.

Incoming admission/provisioning failures retry. Outbound Meta requests with an ambiguous outcome are marked `uncertain` and are **not automatically repeated**, because the message may already have been delivered. Inspect `/health` queue counts and `whatsapp.message_pending` / `whatsapp.send_pending` logs. Receipt files under `/data` are `whatsapp-inbox.json` and `whatsapp-outbox.json`; their payloads contain private messages and must remain private. Reconcile uncertain sends with Meta before manual recovery.

Tests exercise verification, owner binding, concurrent first messages, VM reuse, private reply tokens, long-reply transport, restart-persistent quotas, purchase ceilings, deletion confirmation/recovery and uncertain sends. Live Meta delivery and Maritime provisioning require your configured accounts and published agent image; mocked integration tests do not verify those external credentials.

Provider references: [Meta webhook setup](https://whatsapp.github.io/WhatsApp-Nodejs-SDK/receivingMessages/), [Maritime custom-container contract](https://maritime.sh/docs/frameworks/custom), and [Maritime REST API](https://maritime.sh/docs/api).
