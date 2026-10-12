# n8n ⇄ Slack 2-way bridge (k8s / kind + cloud-provider-kind)

A minimal setup that lets you type a message in a web UI ("talkbackapp"), have it
posted into a Slack channel via n8n, and have replies typed in that Slack
channel show back up in the UI — again routed through n8n.

```
 [talkbackapp UI] --POST /api/send--> [talkbackapp backend] --webhook--> [n8n: Send workflow] --Slack API--> [Slack channel]

 [Slack channel] --message event--> [n8n: Slack Trigger workflow] --HTTP POST--> [talkbackapp backend /api/inbox] --poll--> [talkbackapp UI]
```

Both `n8n` and `talkbackapp` Services are `type: LoadBalancer`, exposed via
**cloud-provider-kind** — no Ingress controller needed.

## Files

```
00-namespace.yaml               Namespace "n8n-slack-demo"
01-n8n-secret.yaml              n8n basic-auth creds + encryption key, talkbackapp inbound secret
02-n8n-pvc.yaml                 Persistent volume for n8n's data (workflows, credentials)
03-n8n-deployment.yaml          n8n Deployment
04-n8n-service.yaml             n8n Service, type LoadBalancer
05-talkbackapp-configmap.yaml   talkbackapp env config (n8n webhook URL)
06-talkbackapp-deployment.yaml  talkbackapp Deployment
07-talkbackapp-service.yaml     talkbackapp Service, type LoadBalancer

talkbackapp/               Node/Express backend + static UI (source for the talkbackapp image)
n8n-workflows/             n8n workflow JSON to import (send-to-slack, slack-to-talkbackapp)
```

## 0. Make sure cloud-provider-kind is running

In a separate terminal (it needs to keep running for LB IPs to be assigned):

```bash
sudo cloud-provider-kind
```

## 1. Create the Slack app

1. Go to https://api.slack.com/apps -> **Create New App** -> From scratch.
2. **OAuth & Permissions** -> add Bot Token Scopes:
   - `chat:write`
   - `channels:history` (or `groups:history` for private channels)
   - `channels:read`
3. Install the app to your workspace, invite the bot to the target channel
   (`/invite @your-bot`), and copy the **Bot User OAuth Token** (`xoxb-...`)
   from **OAuth & Permissions** — this is the *access token*.
4. Go to **Basic Information** -> **App Credentials** and copy the
   **Signing Secret** — this is what n8n's Slack Trigger node uses to verify
   that an inbound event really came from Slack (and not some random POST to
   your webhook URL).
5. Note the target channel's ID (right-click the channel -> View channel
   details -> copy Channel ID).
6. Leave **Event Subscriptions** for later (step 5) — see the note on public
   reachability there; a kind LoadBalancer IP alone is not reachable from
   Slack's servers over the internet.

   You now have two values to hand, both needed in step 4 below:
   - **Access Token** (`xoxb-...`) — from OAuth & Permissions
   - **Signing Secret** — from Basic Information -> App Credentials

## 2. Build and load the talkbackapp image

```bash
docker build -t talkbackapp:latest ./talkbackapp
kind load docker-image talkbackapp:latest    # --name <your-cluster-name> if not "kind"
```

## 3. Edit secrets, then deploy

Edit `01-n8n-secret.yaml`:
- `N8N_BASIC_AUTH_USER` / `N8N_BASIC_AUTH_PASSWORD` — n8n editor login
- `N8N_ENCRYPTION_KEY` — generate with `openssl rand -hex 32`
- `INBOUND_SHARED_SECRET` — any random string; must match the value you put
  in the "Forward to TalkbackApp" node's `x-inbox-secret` header (step 5)

Apply everything:

```bash
kubectl apply -f 00-namespace.yaml
kubectl apply -f 01-n8n-secret.yaml
kubectl apply -f 02-n8n-pvc.yaml
kubectl apply -f 03-n8n-deployment.yaml
kubectl apply -f 04-n8n-service.yaml
kubectl apply -f 05-talkbackapp-configmap.yaml
kubectl apply -f 06-talkbackapp-deployment.yaml
kubectl apply -f 07-talkbackapp-service.yaml
```

Wait for `cloud-provider-kind` to assign external IPs, then fetch them:

```bash
kubectl -n n8n-slack-demo get svc n8n talkbackapp
```

```
NAME          TYPE           CLUSTER-IP      EXTERNAL-IP     PORT(S)
n8n           LoadBalancer   10.96.x.x       172.18.x.x      5678:3xxxx/TCP
talkbackapp   LoadBalancer   10.96.x.x       172.18.x.y      3000:3yyyy/TCP
```

`03-n8n-deployment.yaml` ships with `PLACEHOLDER_N8N_LB_IP` for `N8N_HOST`,
`WEBHOOK_URL`, and `N8N_EDITOR_BASE_URL` — n8n needs these to match its real
external address so webhook URLs it generates are correct. Patch them with
the IP you just got (replace `<N8N_EXTERNAL_IP>`):

```bash
N8N_IP=<N8N_EXTERNAL_IP>
sed -i "s/PLACEHOLDER_N8N_LB_IP/${N8N_IP}/g" 03-n8n-deployment.yaml
kubectl apply -f 03-n8n-deployment.yaml
kubectl -n n8n-slack-demo rollout status deploy/n8n
```

Open n8n: `http://<N8N_EXTERNAL_IP>:5678`
Open talkbackapp: `http://<TALKBACKAPP_EXTERNAL_IP>:3000`

(talkbackapp talks to n8n over the in-cluster Service DNS name, so no change is
needed in `05-talkbackapp-configmap.yaml` for that direction.)

## 4. Import the workflows into n8n

In the n8n editor: **Workflows -> Import from File**, import both:
- `n8n-workflows/send-to-slack.json`
- `n8n-workflows/slack-to-talkbackapp.json`

For each imported workflow:
1. Open the Slack node (**Post to Slack** in `send-to-slack`, **Slack Trigger**
   in `slack-to-talkbackapp`) and on its **Credential to connect with** dropdown,
   choose **Create New Credential**. Both nodes use the same credential type
   (**Slack API**) and should point at the *same* credential — create it once
   on the first node, then select that existing credential on the second.
2. In the credential screen, fill in:
   - **Access Token** -> paste the Bot User OAuth Token (`xoxb-...`) from
     step 1.
   - **Signing Secret** -> paste the Signing Secret from step 1. This field
     only matters for the Slack Trigger node (it's how n8n verifies inbound
     requests are genuinely from Slack); the Post to Slack node ignores it but
     sharing one credential for both is fine and simpler.
   - Click **Save**, then **Connect**/**Test** if prompted — it should come
     back green.
3. Replace `REPLACE_WITH_SLACK_CHANNEL_ID` with your channel's ID.
4. **Activate** both workflows (toggle top-right).
5. In the "Forward to TalkbackApp" HTTP Request node (slack-to-talkbackapp workflow),
   set the `x-inbox-secret` header value to match `INBOUND_SHARED_SECRET`
   from `01-n8n-secret.yaml`.

## 5. Wire up Slack's Event Subscription (inbound: Slack -> n8n)

The `n8n` LoadBalancer IP from `cloud-provider-kind` is only reachable from
your host machine / the kind docker network — **not** from the public
internet, so Slack's servers cannot call it directly to deliver events or to
verify the subscription URL. Pick one:

- **Recommended for local dev — tunnel it:**
  ```bash
  ngrok http <N8N_EXTERNAL_IP>:5678
  ```
  Open the Slack Trigger node in the `slack-to-talkbackapp` workflow to get its
  webhook path (e.g. `/webhook/slack-events`), then in the Slack app config
  -> **Event Subscriptions**, set the Request URL to
  `https://<your-ngrok-id>.ngrok-free.app/webhook/<path>`, subscribe to the
  bot event `message.channels` (or `message.groups`), and save — n8n handles
  Slack's verification handshake automatically.
- **If your kind node is on a routable network / you have a real LB:** skip
  the tunnel and use `http://<N8N_EXTERNAL_IP>:5678/webhook/<path>` directly
  as the Request URL instead.

The outbound direction (talkbackapp -> Slack) doesn't need any of this — it works
over the LB IP (or even ClusterIP) as soon as the workflow is active, since
nothing external needs to reach *in* to trigger it.

## 6. Try it, and watch the flow live in n8n

1. Open the talkbackapp UI (`http://<TALKBACKAPP_EXTERNAL_IP>:3000`).
2. Type a message, click **Send** — it should show up in Slack within a
   couple of seconds.
3. Reply in the Slack channel — the reply should appear in the UI (polls
   every 2s) as a gray bubble.

To watch each hop execute inside n8n:

- Open the workflow in the n8n editor and click **Executions** (left
  sidebar) — every webhook call / Slack event appears here as soon as it
  happens, newest first.
- Click an execution to open it on the canvas: n8n highlights the path taken
  node-by-node in green, and clicking any node shows its exact input/output
  JSON in the side panel — e.g. you can see the raw Slack event payload
  hitting the Slack Trigger node, then the filtered/reshaped body leaving the
  HTTP Request node toward talkbackapp.
- For a live, step-through view instead of after-the-fact: open the workflow
  and click **"Test workflow"** at the top — this arms the trigger and the
  canvas animates each node as data reaches it the next time you send a
  message from the UI or post in Slack (the pill above each node turns green
  with a row count as it fires).
- `Settings -> enable "Save manual executions"` / production executions is
  on by default, so nothing else needs configuring to keep this history.

## Notes / things to harden for anything beyond a demo

- talkbackapp stores messages in memory only (lost on pod restart) — swap in a
  real datastore if you need persistence.
- The "Ignore bot messages" filter in `slack-to-talkbackapp.json` prevents an
  infinite loop (bot posts -> triggers event -> re-posts...); keep it.
- n8n's PVC uses `ReadWriteOnce` + `strategy: Recreate` — fine for a single
  replica; a multi-replica/HA n8n setup needs external Postgres + queue mode,
  which is out of scope here.
- `cloud-provider-kind` LB IPs are ephemeral per cluster lifetime — if you
  delete/recreate the cluster or the Services, re-run step 3's IP lookup and
  patch/re-apply, and update the Slack Event Subscription URL (and ngrok
  tunnel target) to match.
- Consider TLS and a real secret-management approach (e.g. sealed-secrets /
  external-secrets) instead of plain YAML secrets for anything beyond local
  testing.
