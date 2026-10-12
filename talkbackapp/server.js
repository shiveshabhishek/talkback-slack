// talkbackapp backend
//
// Two-way bridge between this app's UI and a Slack channel, via n8n:
//
//   UI -> POST /api/send -> this server -> HTTP POST -> n8n "send-to-slack" webhook -> Slack
//   Slack message -> n8n Slack Trigger -> HTTP POST -> this server's /api/inbox -> stored -> UI polls /api/messages
//
// State is kept in memory on purpose (this is a demo/test app, not production).

const express = require('express');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
// URL of the n8n webhook that posts a message into Slack.
// e.g. http://n8n.n8n-slack-demo.svc.cluster.local:5678/webhook/send-to-slack
const N8N_SEND_WEBHOOK_URL = process.env.N8N_SEND_WEBHOOK_URL || '';
// Shared secret n8n must present (via header) when delivering Slack messages back to us.
const INBOUND_SHARED_SECRET = process.env.INBOUND_SHARED_SECRET || '';

/** @type {Array<{id:number, direction:'outbound'|'inbound', text:string, author:string, ts:number}>} */
const messages = [];
let nextId = 1;

// Slack thread_ts of the single conversation this demo keeps going. Set from
// the first message's response (Slack returns the root message's own ts as
// thread_ts isn't present yet; that ts becomes the thread root for replies).
let slackThreadTs = null;

app.get('/healthz', (_req, res) => res.json({ status: 'ok' }));

// Return all messages (UI polls this).
app.get('/api/messages', (_req, res) => {
  res.json({ messages });
});

// Lets the n8n "Slack -> TalkbackApp" workflow ask which thread is the active
// one, so it can drop replies from unrelated Slack threads/messages.
app.get('/api/thread', (_req, res) => {
  res.json({ thread_ts: slackThreadTs });
});

// Clears the active thread so the next /api/send starts a brand new one.
app.post('/api/thread/reset', (_req, res) => {
  slackThreadTs = null;
  res.json({ ok: true });
});

// UI -> Slack
app.post('/api/send', async (req, res) => {
  const text = (req.body && req.body.message || '').trim();
  if (!text) {
    return res.status(400).json({ error: 'message is required' });
  }
  if (!N8N_SEND_WEBHOOK_URL) {
    return res.status(500).json({ error: 'N8N_SEND_WEBHOOK_URL is not configured on the server' });
  }

  const record = {
    id: nextId++,
    direction: 'outbound',
    text,
    author: 'talkbackapp-ui',
    ts: Date.now(),
  };
  messages.push(record);

  try {
    const resp = await fetch(N8N_SEND_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: text, thread_ts: slackThreadTs }),
    });
    if (!resp.ok) {
      record.deliveryError = `n8n webhook responded ${resp.status}`;
    } else {
      const body = await resp.json().catch(() => ({}));
      if (!slackThreadTs && body.thread_ts) {
        slackThreadTs = body.thread_ts;
      }
    }
  } catch (err) {
    record.deliveryError = String(err);
  }

  res.json({ ok: true, message: record });
});

// Slack (via n8n) -> UI
app.post('/api/inbox', (req, res) => {
  if (INBOUND_SHARED_SECRET) {
    const provided = req.get('x-inbox-secret') || '';
    if (provided !== INBOUND_SHARED_SECRET) {
      return res.status(401).json({ error: 'unauthorized' });
    }
  }

  const { text, user } = req.body || {};
  if (!text) {
    return res.status(400).json({ error: 'text is required' });
  }

  const record = {
    id: nextId++,
    direction: 'inbound',
    text: String(text),
    author: user ? `slack:${user}` : 'slack',
    ts: Date.now(),
  };
  messages.push(record);
  res.json({ ok: true, message: record });
});

app.listen(PORT, () => {
  console.log(`talkbackapp listening on :${PORT}`);
  console.log(`N8N_SEND_WEBHOOK_URL=${N8N_SEND_WEBHOOK_URL || '(not set)'}`);
});
