# Zapier Gmail Sync Setup

This project now supports Zapier as the preferred Gmail sync path for sold-load and rate-confirmation emails.

Production endpoint:
- `https://carrierdatabasev2.netlify.app/api/zapier/rate-confirmation`

Status endpoint:
- `https://carrierdatabasev2.netlify.app/api/zapier/status`

## Netlify Env Var Required

Set this in Netlify site settings:

- `ZAPIER_SYNC_SECRET`

Zapier should send that value in this request header:

- `x-zapier-secret`

## Exact Zap

Build exactly this Zap:

### Step 1

- App: `Gmail`
- Trigger event: `New Email Matching Search`

Use this Gmail search string:

```text
("rate confirmation" OR "rate con" OR "carrier confirmation" OR "load tender") newer_than:60d -in:trash -in:spam
```

If you already use a Gmail label for sold loads, make it tighter:

```text
label:sold-loads ("rate confirmation" OR "rate con" OR "carrier confirmation" OR "load tender") newer_than:60d -in:trash -in:spam
```

Connect the Gmail inbox that receives your sold-load rate confirmations.

### Step 2

- App: `Filter by Zapier`

Only continue if at least one of these is true:

- `Subject` contains `Rate Confirmation`
- `Subject` contains `Rate Con`
- `Subject` contains `Carrier Confirmation`
- `Body Plain` contains `Load #`

This keeps random emails from posting into the carrier database.

### Step 3

- App: `Webhooks by Zapier`
- Action event: `POST`

Set these fields exactly:

- `URL`

```text
https://carrierdatabasev2.netlify.app/api/zapier/rate-confirmation
```

- `Payload Type`

```text
json
```

- `Data`

Map these keys exactly:

```text
subject        -> Subject
from           -> From
to             -> To
cc             -> Cc
date           -> Date
snippet        -> Snippet
bodyPlain      -> Body Plain
bodyHtml       -> Body HTML
messageId      -> Message ID
threadId       -> Thread ID
```

- `Headers`

Add:

```text
x-zapier-secret : YOUR_ZAPIER_SYNC_SECRET
```

You do not need extra auth beyond that header.

### Optional Step 4

- App: `Gmail`
- Action event: `Add Label to Email`

Use a label like:

```text
synced-to-carrier-db
```

This helps prevent confusion when reviewing which sold-load emails already fed the database.

## Exact Webhook Body Example

If Zapier shows you a raw JSON preview, this is the shape you want:

```json
{
  "subject": "Rate Confirmation Load #2349999",
  "from": "Mac Milovanovic <mac@paminternationalinc.com>",
  "to": "ops@circledelivers.com",
  "cc": "",
  "date": "Mon, 16 Mar 2026 10:15:00 -0400",
  "snippet": "Rate Confirmation Load #2349999 Pickup: El Paso, TX Delivery: La Vergne, TN Rate: $2,450.00",
  "bodyPlain": "Rate Confirmation\nLoad #2349999\nPickup: El Paso, TX\nDelivery: La Vergne, TN\nPickup Date: 03/16/2026\nDelivery Date: 03/18/2026\nRate: $2,450.00\nDispatcher: Mac Milovanovic\nPhone: 312-414-1431 ext.120",
  "bodyHtml": "<div>Rate Confirmation<br>Load #2349999<br>Pickup: El Paso, TX<br>Delivery: La Vergne, TN<br>Pickup Date: 03/16/2026<br>Delivery Date: 03/18/2026<br>Rate: $2,450.00<br>Dispatcher: Mac Milovanovic<br>Phone: 312-414-1431 ext.120</div>",
  "messageId": "18fa-example",
  "threadId": "18fa-thread-example"
}
```

## What This Updates In The Database

When the sender or message body matches an existing carrier email already in the database, the backend tries to update:

- `loadHistory`
- `avgRate`
- `preferredLanes`
- `dispatcher`
- `phone`
- `email`
- `lastActive`

The webhook is intentionally conservative:

- it updates existing carriers
- it does not blindly create brand-new carriers from unknown emails
- it is designed around sold loads and rate confirmations, not general inbox sync

## What The Sync Updates

If a sold-load email matches an existing carrier email already in the database, the backend tries to update:

- `loadHistory`
- `avgRate`
- `preferredLanes`
- `dispatcher`
- `phone`
- `email`
- `lastActive`
- Gmail source metadata

It does not blindly create new carriers from unknown emails. Matching is intentionally conservative.

## Notes

- This is better than direct Gmail OAuth for this project because Netlify does not need to hold the Gmail app credentials.
- The shared database still lives in Netlify Blobs, so all testers stay synced after a Zap posts a new sold-load email.
