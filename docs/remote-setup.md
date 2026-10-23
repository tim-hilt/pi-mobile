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

Generate the secrets once, into one file:

```sh
cat > ~/.pi-bridge.env <<EOF
PI_BRIDGE_TOKEN=$(openssl rand -hex 32)
PI_BRIDGE_NTFY_TOPIC=$(openssl rand -hex 16)
EOF
chmod 600 ~/.pi-bridge.env
```

`PI_BRIDGE_TOKEN` is the auth secret the app needs; drop `PI_BRIDGE_NTFY_TOPIC` to disable notifications. `PI_BRIDGE_PORT` (default 8787) must match the tunnel's service port. Export them to every pi (e.g. in `~/.zshrc`), so the first pi can start the bridge:

```sh
set -a; . ~/.pi-bridge.env; set +a
```

Then enable session sharing as in the [README](../README.md#share-pi-sessions).

Self-hosted ntfy: also set `PI_BRIDGE_NTFY_URL`. The app learns the topic from the bridge handshake; nothing to configure on the phone.

## 3. App

Enter `wss://pi.example.com` and the token in the connection screen.

## Check

```sh
curl -si https://pi.example.com | head -1                 # 401/426 from the bridge, not a Cloudflare error
```

Remote demo (cellular, Wi-Fi off): open the app → transcript catches up → send a prompt → it streams → ntfy notification when the run settles. v1 has no APNs: notifications arrive only while the app is in the foreground.
