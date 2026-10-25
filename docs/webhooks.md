# Webhooks

Create a webhook in **Server Settings → Integrations** and copy its URL. It looks like:

```
https://chat.example.com/api/v1/webhooks/<id>/<token>
```

Send a message by POSTing JSON:

```sh
curl -X POST "$WEBHOOK_URL" -H 'content-type: application/json' -d '{
  "content": "Deploy finished ✅",
  "username": "CI",
  "embeds": [{ "title": "Build #42", "description": "All tests passed", "url": "https://ci.example.com/42", "color": "#23a55a" }]
}'
```

| Field | Notes |
|---|---|
| `content` | Message text (markdown supported) |
| `username` | Overrides the webhook's display name for this message |
| `embeds` | Up to 10 rich embeds with `title`, `description`, `url` and `color` |

Anyone who has the URL can post as the webhook. Delete it from Integrations to revoke it.
