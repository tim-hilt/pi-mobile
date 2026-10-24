# Remote access via Cloudflare Tunnel

The bridge binds to `127.0.0.1` only. A named Cloudflare Tunnel is the sole public entry point: it terminates HTTPS/WSS and forwards to the local port. Cloudflare proxies WebSockets by default; the bridge pings every 30 s, well inside Cloudflare's ~100 s idle timeout.

Requires `cloudflared` and a domain on Cloudflare (`pi.example.com` below).

## 1. Tunnel

```sh
cloudflared tunnel login
cloudflared tunnel create pi-bridge                       # prints <TUNNEL_ID>, writes ~/.cloudflared/<TUNNEL_ID>.json
cloudflared tunnel route dns pi-bridge pi.example.com     # stable hostname
```

`~/.cloudflared/config.yml`:

```yaml
tunnel: <TUNNEL_ID>
credentials-file: /Users/<you>/.cloudflared/<TUNNEL_ID>.json
ingress:
  - hostname: pi.example.com
    service: http://127.0.0.1:8787
  - service: http_status:404
```

Run it (`cloudflared tunnel run pi-bridge`) or install as a service (`sudo cloudflared service install`).

## 2. Bridge

Write the settings once, to `~/.pi/agent/bridge.json` (`chmod 600` it):

```json
{ "publicUrl": "wss://pi.example.com", "ntfyTopic": "<openssl rand -hex 16>" }
```

`publicUrl` is the address the app reaches the bridge at; drop `ntfyTopic` to disable notifications. `port` (default 8787) must match the tunnel's service port. The first pi starts the bridge with them; restart it after edits. Its auth token is fresh on every start and kept in memory only.

Then enable session sharing as in the [README](../README.md#share-pi-sessions).

Notifications come through the [ntfy app](https://apps.apple.com/app/ntfy/id1625396347): subscribe to your `ntfyTopic` there. Self-hosted ntfy: also set `ntfyUrl` and add that server in the ntfy app.

## 3. App

Run `/show-bridge-qr` in pi. Tap **Scan QR Code to Log In** in the app and scan it. The QR code contains the token: don't share it. After a bridge restart, scan again.

## Check

```sh
curl -si https://pi.example.com | head -1                 # 401/426 from the bridge, not a Cloudflare error
```

Remote demo (cellular, Wi-Fi off): open the app → transcript catches up → send a prompt → it streams → ntfy notification when the run settles, also with the app closed.
