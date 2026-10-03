# SleepUp WhatsApp Dialer

Telecallers browser la irundhe WhatsApp call pannalaam. TeleCRM la oru button click la dialer open aagum, call mudinja log Make vazhiya TeleCRM ku pogum.

```
wa-dialer/
  server.js            backend: Meta webhook + Calling API + login
  public/index.html    telecaller dialer (browser)
  chrome-extension/    TeleCRM button + right-click "Call on WhatsApp"
  .env.example         settings template
```

---

## 1. Meta: thaniya "SleepUp Dialer" app

Unga n8n app-ah touch panna vendaam. Calls ku mattum oru separate app.

1. developers.facebook.com → My Apps → **Create app** → type **Business** → name `SleepUp Dialer` → business portfolio: Sleep up mattress.
2. App la **Add product → WhatsApp**.
3. business.facebook.com → Business Settings → **System users** → admin system user select (illana new create) → **Assign assets**:
   - Apps → `SleepUp Dialer` → Full control
   - WhatsApp accounts → `Sleep up mattress` → Full control
4. Same system user → **Generate token** → app `SleepUp Dialer`, expiry **Never**, permissions `whatsapp_business_messaging` + `whatsapp_business_management`. Idhu dhaan `WA_TOKEN`.
5. App-ah unga WhatsApp account ku subscribe pannunga:
   ```bash
   curl -X POST "https://graph.facebook.com/v23.0/<WABA_ID>/subscribed_apps" \
     -H "Authorization: Bearer <WA_TOKEN>"
   ```
   WABA ID: WhatsApp Manager URL la `asset_id=` value (unga screenshot la `974170128559450`). Confirm pannitu use pannunga.
6. **App settings → Basic → App secret** → copy → `APP_SECRET`.
7. Server ready aana apram (step 2): App Dashboard → **WhatsApp → Configuration → Webhook**
   - Callback URL: `https://call.sleepupmattress.com/webhook`
   - Verify token: `.env` la vecha `VERIFY_TOKEN`
   - **Verify and save** → Webhook fields la **`calls` mattum** Subscribe.
8. App top bar la **Live** mode on pannunga. Development mode la real call webhooks varaadhu.

---

## 2. Server deploy

Node 18+ venum. HTTPS kandippa venum (browser mic + Meta webhook rendum HTTPS la dhaan work aagum).

```bash
# DNS: A record  call.sleepupmattress.com  ->  server IP
scp -r wa-dialer user@SERVER:/opt/
ssh user@SERVER
cd /opt/wa-dialer
npm install --omit=dev
cp .env.example .env && nano .env        # values fill pannunga
npm i -g pm2
pm2 start server.js --name wa-dialer && pm2 save && pm2 startup
```

**Nginx** (`/etc/nginx/sites-available/wa-dialer`):

```nginx
server {
  server_name call.sleepupmattress.com;
  location / {
    proxy_pass http://127.0.0.1:3100;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_read_timeout 3600s;
  }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/wa-dialer /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d call.sleepupmattress.com
```

Dograh server la already Caddy/Traefik proxy irundha, adhulaye `call.sleepupmattress.com → 127.0.0.1:3100` add pannunga (WebSocket allow pannanum).

Check: `https://call.sleepupmattress.com/health` → `{"ok":true,...}`

---

## 3. Telecaller logins

`.env` la `AGENTS=name:PIN,name2:PIN2`. Change pannina `pm2 restart wa-dialer`.
PIN maathuna andha telecaller automatic ah sign out aagiduvaanga.

---

## 4. Chrome extension (ovvoru telecaller PC la)

1. `chrome://extensions` → **Developer mode** ON → **Load unpacked** → `chrome-extension` folder select.
2. Extension → Details → **Extension options** → dialer link (default `https://call.sleepupmattress.com`).
3. TeleCRM open pannunga → bottom-right la green **WhatsApp call** button varum.
   - Page la oru number irundha direct ah dialer open aagum; neraya irundha choose panna list varum.
   - Endha page la yum number select panni right-click → **Call "…" on WhatsApp**.

TeleCRM domain `telecrm.in` illana `manifest.json` la `matches` / `host_permissions` maathunga.

---

## 5. TeleCRM la call log (Make)

1. Make → new scenario → **Webhooks → Custom webhook** → URL copy → `.env` la `MAKE_WEBHOOK_URL` → `pm2 restart wa-dialer`.
2. Ovvoru call mudinjadhum indha JSON varum:
   ```json
   {
     "call_id": "wacid.xxx",
     "direction": "outgoing",
     "customer_number": "919876543210",
     "customer_name": "Ravi",
     "agent": "agent1",
     "result": "connected",
     "duration_seconds": 184,
     "started_at": "2026-10-03T05:12:40.000Z",
     "ended_at": "2026-10-03T05:15:44.000Z",
     "business_phone_number_id": "1117138681482647"
   }
   ```
   `result`: `connected` | `not_answered` | `rejected` | `failed` | `missed` (incoming) | `declined` (incoming)
3. Next module: unga existing TeleCRM connection / HTTP module la `customer_number` vechu lead find panni, note or field update (result + duration + agent).

Server la `data/calls.jsonl` la full log um irukkum.

---

## Daily flow (telecallers ku)

1. TeleCRM lead → **WhatsApp call** → dialer open.
2. Green bar = call pannalaam → **Call**.
3. Amber bar = permission illa → **Ask permission on WhatsApp** → customer Allow tap pannadhum dialer automatic ah green aagum.
4. **Hang up** → log auto ah TeleCRM ku.

## Meta rules (nyabagam vechikonga)

- Permission request: oru customer ku 24h la 1, 7 days la 2 dhaan.
- Temporary permission 7 days; customer "always allow" pannina permanent.
- 2 unanswered calls → customer ku "permission reconsider" message. 4 unanswered → permission auto revoke. So customer active ah irukkum bodhu mattum call pannunga.
- Incoming calls: online la irukura ellaa telecallers kum 25 sec ring aagum. Yaarum online illana auto reject. WhatsApp Manager la call hours = office hours set pannunga.

## Troubleshooting

| Problem | Fix |
|---|---|
| "Customer hasn't allowed calls yet" | Ask permission first (error 138006). |
| Webhook varala | App Live mode la irukka? `calls` field subscribe? `subscribed_apps` curl run pannineengala? |
| Call connect aagudhu, audio illa | Office Wi-Fi UDP block pannalaam. Mobile hotspot la test pannunga. Fix na TURN server add pannanum. |
| Mic error | Address bar lock icon → Microphone → Allow. |
| Token error (190) | System user la new token generate panni `WA_TOKEN` update. |
| Chat closed (131047) | Customer first message pannanum, illana `PERMISSION_TEMPLATE_NAME` la approved call-permission template set pannunga. |
