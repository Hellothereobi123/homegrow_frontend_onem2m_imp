# HydroOS on oneM2M: Pi, app and cloud CSE

HydroOS monitors a hydroponic system. A **Raspberry Pi** reads the sensors every 30 seconds and
keeps every reading in its own database. A **oneM2M CSE** (the open-source
[ACME](https://acmecse.net) server) holds the recent readings. The **HydroOS app** reads them,
and can ask the Pi for older history through the CSE.

This README is the same in both repositories:

| Repository | What it is |
|---|---|
| `HydroponicPiLogic_onem2m` | The Pi software: sensors, local database, oneM2M uploads, setup scripts for the cloud CSE (`cloud/`) |
| `homegrow_frontend_onem2m` | The HydroOS app (Expo / React Native): Android, and a web build for testing |

Paths below name their repository, e.g. `HydroponicPiLogic_onem2m/pi/config.py`.

**Contents**

1. [How it fits together](#1-how-it-fits-together)
2. [Choose a setup](#2-choose-a-setup)
3. [Cloud CSE on DigitalOcean](#3-cloud-cse-on-digitalocean)
4. [Firewalls](#4-firewalls)
5. [Pi setup](#5-pi-setup)
6. [App setup](#6-app-setup)
7. [Testing without a Pi](#7-testing-without-a-pi)
8. [Day-to-day and troubleshooting](#8-day-to-day-and-troubleshooting)
9. [Security notes and limits](#9-security-notes-and-limits)

---

## 1. How it fits together

```
 sensors ─► Pi (main.py) ─► SQLite hydro.db ─► uploader (onem2m_sync.py) ──HTTP or MQTT──► CSE ◄──HTTP(S)── app
                                     │                ▲                                     │
                                     │                └──── on-demand requests (history) ───┘
                                     └─► Bluetooth server ──────────────────────────────────────────► app nearby
```

- **The Pi's database is the source of truth.** Every 30 s cycle is saved locally first, then
  uploaded. If the CSE or network is down, readings wait and upload later; nothing is lost.
- **The CSE holds about two days of readings** per Pi. The app shows the last 70 minutes and
  refreshes every minute.
- **Older history comes from the Pi on request.** The History tab's **24 h / 7 days** buttons
  leave a request in the Pi's `requests` container on the CSE. The Pi checks every 3 s, answers
  from its database into `responses`, and the app collects the answer.
- **Every path carries the same record** (`recorded_at`, `ph`, `ec`, `temperature_c`,
  `humidity`, `light_intensity`, `co2`, `water_temp`, `water_level`, `system_name`, `username`),
  so the app parses data from the CSE, Bluetooth and Supabase alike.

What the Pi creates on the CSE (`<cse>` is `cse-hydropi` on a Pi, `cse-in` in the cloud):

```
<cse>
└─ HydroPi-<hash>   the Pi (AE), labels type:hydropi, system:<name>
   ├─ acp           access rules: the Pi may do everything; the app may read and discover
   ├─ acp-requests  the app may only create (post a request)
   ├─ readings      one entry per 30 s cycle, about 2 days kept
   ├─ vision        camera metrics
   ├─ requests      on-demand requests from the app (kept 60 s)
   └─ responses     the Pi's answers, labelled rqi:<id> (kept 5 min)
```

`HydroPi-<hash>` is derived from the Pi's serial number, so each Pi gets a unique, stable name.

---

## 2. Choose a setup

| | **A. CSE on the Pi** | **B. Cloud CSE, HTTPS** (recommended) | **C. Cloud CSE, MQTT + Protobuf** | **D. gRPB-M2M demo CSE** |
|---|---|---|---|---|
| Where the CSE runs | On the Pi | DigitalOcean Droplet | DigitalOcean Droplet | DigitalOcean Droplet |
| Pi → CSE | HTTP on the Pi | HTTPS + token | MQTT broker port **1884**, Protobuf | MQTT broker port **1883**, Protobuf |
| App → CSE | HTTP, same network as the Pi | HTTPS + token, from anywhere | HTTPS + token, from anywhere | HTTP through an **SSH tunnel** only |
| Security | Tokens; plain HTTP on the LAN | Tokens, access checks, HTTPS | Same as B for the app; broker limited by firewall | **None** on the CSE; firewall only |
| Setup | [5.2](#52-setup-a-cse-on-the-pi) | [3.3](#33-setup-b-hydroos-cse-https), [5.3](#53-setups-b-c-d-cloud-cse) | [3.4](#34-setup-c-add-mqtt--protobuf-to-the-hydroos-cse), [5.3](#53-setups-b-c-d-cloud-cse) | [3.5](#35-setup-d-the-grpb-m2m-demo-cse), [5.3](#53-setups-b-c-d-cloud-cse) |

- **B** is the simplest complete setup: the app works on any phone, anywhere.
- **C** is B plus the Pi sending over MQTT with Protobuf through the
  [gRPB-M2M](https://github.com/deepk2001/gRPB-M2M) library. The app side is identical to B.
- **D** is the gRPB-M2M project's own CSE and broker. It's useful for that project's demos and
  measurements, but it has no authentication, so the app reaches it only through an SSH tunnel.
- B/C and D can run side by side on one Droplet: they use different ports and brokers.

---

## 3. Cloud CSE on DigitalOcean

### 3.1 Create the Droplet

In the DigitalOcean control panel, **Create → Droplets**:

| Setting | Value |
|---|---|
| Image | **Ubuntu 24.04 LTS** (ACME needs Python 3.11+; 24.04 has 3.12) |
| Size | Basic → Regular, **1 GB / 1 CPU** (about $6/month) is enough for one Pi. 2 GB for several Pis. Skip 512 MB. |
| Region | Near you and the Pi |
| Authentication | **SSH key**, ticked during creation (see the note below) |
| IP | Use the **IPv4** address. A Droplet keeps it until destroyed. |

**SSH keys are only installed when the Droplet is created.** Adding a key to your account
afterwards doesn't reach an existing Droplet. If SSH still asks for a password, either recreate
the Droplet with the key ticked, or add the key through **Droplet → Access → Launch Droplet
Console**:

```bash
mkdir -p ~/.ssh && chmod 700 ~/.ssh
echo "ssh-ed25519 AAAA...your public key..." >> ~/.ssh/authorized_keys
chmod 600 ~/.ssh/authorized_keys
```

On Windows, your public key is `C:\Users\<you>\.ssh\id_ed25519.pub`. If your key has a
non-default name, connect with `ssh -i <path to key> root@<droplet-ip>`.

Billing continues while a Droplet is powered off; only destroying it stops charges.

### 3.2 Set up the firewalls

Do this before installing anything: see [Section 4](#4-firewalls). In short, allow 22 (SSH),
80 and 443 (HTTPS) from anywhere, and the MQTT ports only from the Pi's and your network.

### 3.3 Setup B: HydroOS CSE (HTTPS)

The script `HydroponicPiLogic_onem2m/cloud/setup-acme-ec2.sh` installs:
- **ACME**, as an IN-CSE named `cse-in` (CSE-ID `/id-in`), running as the `acme-cse` service;
- **Caddy**, which provides HTTPS with a free Let's Encrypt certificate (service `caddy`);
- **three tokens** (admin, app, Pi), with access checks on.

It also adds a swap file on small Droplets, and opens the right ports if `ufw` is on. (The
script's name says EC2; it works on DigitalOcean and EC2.)

From the Pi repository on your PC:

```bash
scp cloud/setup-acme-ec2.sh cloud/add-token.sh root@<droplet-ip>:~
```

On the Droplet (`ssh root@<droplet-ip>`):

```bash
chmod +x setup-acme-ec2.sh add-token.sh
./setup-acme-ec2.sh --domain auto
cat /root/acme-tokens.txt          # copy the tokens somewhere safe
```

- `--domain auto` serves HTTPS at `https://<ip-with-dashes>.sslip.io`, a free DNS name for the
  Droplet's IP, e.g. `https://138-68-242-69.sslip.io`. Use `--domain cse.yourdomain.com`
  instead if you point a domain at the Droplet.
- Ports 80 and 443 must be open for the certificate.
- It takes 3-6 minutes on a 1 GB Droplet, and ends with "ACME IN-CSE is running".

| Token in `/root/acme-tokens.txt` | Goes to |
|---|---|
| `ADMIN_TOKEN` | Keep for yourself (checks, cleanup) |
| `APP_TOKEN` | The app: **⚙ oneM2M settings → Token** |
| `PI_TOKEN` | The Pi: `ONEM2M_TOKEN` in `pi/.env` |

More tokens later (another Pi, a teammate): `ssh root@<droplet-ip> acme-add-token <label>`.

Check from your PC:

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://<ip-with-dashes>.sslip.io/cse-in
```

`401` means it's working (it refused only because there was no token). `502` means Caddy is up
but `acme-cse` isn't. A failed connection means Caddy isn't running or 443 is blocked.

Start, stop and boot behaviour:

```bash
systemctl enable --now acme-cse caddy     # start now and at every boot
systemctl stop acme-cse caddy             # stop (they start again at the next boot)
systemctl disable --now acme-cse caddy    # stop and keep them off
```

Re-running the script is safe: it keeps the secret, tokens and data. It rewrites `acme.ini`
(keeping `acme.ini.bak`) and the service file, which **undoes the manual changes in 3.4**.

### 3.4 Setup C: add MQTT + Protobuf to the HydroOS CSE

This gives the HydroOS CSE an MQTT broker on port **1884** and teaches ACME the Protobuf
(`pb`) format from gRPB-M2M. The app side doesn't change. All commands run on the Droplet as
root; back up first.

```bash
SP=/opt/acme/venv/lib/python3.12/site-packages
BK=/root/acme-backup-$(date -u +%Y%m%dT%H%M%SZ); mkdir -p $BK
cp -a $SP/acmecse/etc/Types.py $SP/acmecse/etc/RequestUtils.py \
      $SP/acmecse/plugins/bindings/MQTTClient.py /var/lib/acme/acme.ini \
      /etc/systemd/system/acme-cse.service $BK/
```

**Step 1. Get the gRPB-M2M patch and codec** (if `/root/gRPB-M2M` isn't there yet):

```bash
git clone https://github.com/deepk2001/gRPB-M2M /root/gRPB-M2M
```

**Step 2. Patch ACME.** The patch applies cleanly to ACME 2026.5.3:

```bash
/opt/acme/venv/bin/pip install 'protobuf>=7.35.1'
cd $SP && git apply --include='acmecse/*' /root/gRPB-M2M/patches/acme-protobuf.patch
cp /root/gRPB-M2M/grpb/onem2m/codec.py      acmecse/etc/ProtoCodec.py
cp /root/gRPB-M2M/grpb/onem2m/onem2m_pb2.py acmecse/etc/onem2m_pb2.py
```

**Step 3. Run the HydroOS broker** (the system `mosquitto` service) on port 1884:

```bash
cat > /etc/mosquitto/conf.d/hydroos.conf <<'EOF'
listener 1884 0.0.0.0
protocol mqtt
# gRPB-M2M can't log in to a broker yet; the firewall limits who can reach 1884
allow_anonymous true
max_topic_alias 1000
EOF
systemctl enable --now mosquitto && systemctl restart mosquitto
```

**Step 4. Turn on ACME's MQTT binding.** Append this to `/var/lib/acme/acme.ini`:

```ini
[mqtt]
enable=true
address=127.0.0.1
port=1884
```

Then remove `--no-mqtt` from `ExecStart` in `/etc/systemd/system/acme-cse.service`, and:

```bash
systemctl daemon-reload && systemctl restart acme-cse
ss -tnp | grep ':1884'        # acmecse should be connected to the broker
```

**Step 5. Firewall:** allow 1884 from the Pi's network ([Section 4](#4-firewalls)).

To undo: copy the backed-up files back, `systemctl daemon-reload`, restart `acme-cse`.

### 3.5 Setup D: the gRPB-M2M demo CSE

This runs the gRPB-M2M project's own patched ACME and broker. Follow its README for
`make setup` (it needs `git`, `uv` and `apt`), then on the Droplet, in `/root/gRPB-M2M`:

1. **Broker on every address, port 1883:** in `config/mosquitto.conf`:
   ```
   listener 1883 0.0.0.0
   ```
   Don't bind it to the public IP only: the CSE connects to `127.0.0.1:1883`, and the Pis to
   the public IP, and they must reach the **same** broker. (`0.0.0.0` used to clash with
   Ubuntu's own broker on `127.0.0.1:1883`; with Setup C that one listens on 1884 only.)
2. **CSE HTTP port and CORS:** in `config/acme.ini` (not the copy in `runtime/cse/`, which
   `make cse` overwrites):
   ```ini
   httpPort=8084        ; under [basic.config]; 8080 is the HydroOS CSE

   [http.cors]
   enable=true          ; needed by the app's web build
   ```
3. **Start both so they survive logging out**, in `tmux`:
   ```bash
   tmux new -s grpb
   make broker                    # then Ctrl+B, C for a second window
   make cse                       # then Ctrl+B, D to detach; tmux attach -t grpb to return
   ```
4. **Check they're connected:**
   ```bash
   ss -tnp | grep ':1883'         # an acmecse connection to the broker
   ```

Things to know about this CSE:
- **No authentication:** access checks are off (`enableACPChecks=false`) and there's no token
  login. Keep port 8084 **closed** in the firewall and reach it through an SSH tunnel
  ([6.4](#64-connect-the-app-to-a-cse)).
- **Data is kept in memory:** every `make cse` restart starts empty. The Pi registers again by
  itself.
- **The repo's tools** check HTTP on 8080 by default: `export GRPB_CSE_HTTP=http://127.0.0.1:8084`
  before `make smoke`, `make dashboard`, `make bench` or `make evidence`.

---

## 4. Firewalls

### 4.1 Ports used

| Port | Where | What | Open to |
|---|---|---|---|
| 22 | Droplet | SSH (key login only) | Anywhere, or your IP |
| 80, 443 | Droplet | Caddy: HTTPS for the CSE, certificate renewal | Anywhere |
| 1883 | Droplet | gRPB-M2M demo broker (Setup D) | The Pi's and your network only |
| 1884 | Droplet | HydroOS broker (Setup C) | The Pi's network only |
| 8080 | Droplet | HydroOS CSE behind Caddy | **Closed** (Caddy reaches it locally) |
| 8084 | Droplet | gRPB-M2M demo CSE | **Closed** (SSH tunnel only) |
| 8080 | Pi | CSE on the Pi (Setup A) | Your local network only |
| 8081, 8083 | Your PC | Expo dev server (phone build), app's web build | Local only |

### 4.2 The Droplet: two firewalls

A connection must pass **both**:

1. **DigitalOcean Cloud Firewall** (outside the Droplet), in the control panel under
   **Networking → Firewalls → Create Firewall**, then apply it to the Droplet. Inbound rules:
   SSH 22, HTTP 80, HTTPS 443 from all; TCP 1883/1884 from the Pi's and your IP addresses.
2. **`ufw`** (Ubuntu's firewall, on the Droplet):
   ```bash
   ufw default deny incoming
   ufw default allow outgoing
   ufw allow 22/tcp  comment 'SSH'
   ufw allow 80/tcp  comment 'Caddy HTTP->HTTPS, certificates'
   ufw allow 443/tcp comment 'Caddy HTTPS'
   ufw allow from <pi-public-ip>  to any port 1884 proto tcp comment 'MQTT HydroOS: Pi'
   ufw allow from <pi-public-ip>  to any port 1883 proto tcp comment 'MQTT gRPB: Pi'
   ufw allow from <your-public-ip> to any port 1883 proto tcp comment 'MQTT gRPB: laptop'
   ufw enable
   ```
   Add only the MQTT rules for the setups you use (1884 for C, 1883 for D).
   Always allow 22 **before** `ufw enable`, or you lock yourself out of SSH. If that happens,
   use the Droplet Console in the control panel.

Managing `ufw` rules:

```bash
ufw status numbered      # list rules with numbers
ufw delete <number>      # remove one
journalctl -k | grep "UFW BLOCK" | grep "DPT=1883"    # who was blocked on 1883
```

The rules are stored in `/etc/ufw/user.rules`; `ufw` stays on across reboots.

### 4.3 Finding the right IP address

Firewall rules need the **public** address a network shows to the internet, not the one
`ipconfig` or `ip addr` shows. Your router (or your provider) translates between the two.

| Where | Command |
|---|---|
| On the Pi | `curl -s https://api.ipify.org` (or `curl https://ifconfig.me`) |
| On Windows | `curl.exe -s https://api.ipify.org` |
| What the Droplet sees | `journalctl -k \| grep "UFW BLOCK"` shows the `SRC=` of blocked attempts |

- **Use the IPv4 address.** Many networks still lack IPv6.
- **Campus, office and mobile networks** often share one public address between many devices,
  and change it now and then. A rule for that address lets **everyone on that network** reach
  the port, and stops matching when it changes (uploads then stop until you add the new IP;
  readings wait safely on the Pi).
- **If outgoing 1883/1884 is blocked** by the network (common on campus/office networks), or
  the IP changes too often, run the Pi's MQTT through an **SSH tunnel** instead, and close the
  MQTT port entirely. On the Pi (with its SSH key added to the Droplet):
  ```bash
  ssh -N -L 1884:127.0.0.1:1884 root@<droplet-ip>     # then ONEM2M_MQTT_HOST=127.0.0.1
  ```
  Use `autossh` or a systemd service to keep it running.

### 4.4 The Pi (Setup A)

Raspberry Pi OS has no firewall on by default. If you enable `ufw` on the Pi, allow the app's
network to reach the CSE:

```bash
sudo ufw allow 22/tcp
sudo ufw allow from 192.168.1.0/24 to any port 8080 proto tcp     # your LAN's range
sudo ufw enable
```

Many campus and office Wi-Fi networks block device-to-device traffic, so a phone can't reach a
Pi on the same Wi-Fi. Use a cloud CSE (B or C) there.

### 4.5 Windows (local testing)

When Windows asks about `acmecse.exe` or Node, allow it on **Private** networks only, and make
sure the network is set to Private (Settings → Network → your network → Network profile type).
On a Public network, Windows blocks other devices from reaching it.

---

## 5. Pi setup

### 5.1 Install

On the Pi (64-bit Raspberry Pi OS, Python 3.11+). The service files expect the repository at
`/home/pi/HydroponicPiLogic` and user `pi`; clone it there or edit `pi/systemd/*.service`.

```bash
git clone https://github.com/Hellothereobi123/HydroponicPiLogic_onem2m.git /home/pi/HydroponicPiLogic
cd /home/pi/HydroponicPiLogic/pi
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt     # includes grpb-m2m for MQTT mode
cp .env.example .env
```

**The settings live in `pi/.env`**, which isn't in git: each Pi has its own. Without it, every
setting falls back to its default (backend `supabase`), and the startup line shows
`backend=supabase`. `config.py` loads it from the `pi/` folder.

`python3 main.py` prints the Pi's name at startup: `system_name=HydroPi-…, backend=…`.

### 5.2 Setup A: CSE on the Pi

1. Install ACME in its own virtualenv: `python3 -m venv /home/pi/acme-venv &&
   /home/pi/acme-venv/bin/pip install acmecse`.
2. Copy `acme/.env.example` to `acme/.env`, and set `ACME_SECURITY_SECRET` to a long random value.
3. Create two tokens (Pi and app), each run printing a token and its hash:
   ```bash
   cd pi && python3 -m onem2m.make_token --secret <ACME_SECURITY_SECRET>
   ```
   Put both **hash** lines in `acme/certs/http_token_auth.txt` (copy the `.example` first).
4. In `pi/.env`:
   ```
   HYDRO_BACKEND=onem2m
   ONEM2M_TOKEN=<the Pi's token>
   ```
   The defaults (`ONEM2M_CSE_URL=http://127.0.0.1:8080`, `ONEM2M_CSE_RN=cse-hydropi`) match
   `acme/acme.ini`.
5. Install the services:
   ```bash
   sudo cp systemd/*.service /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now hydro-sensors hydro-ble acme-cse hydro-onem2m
   ```

The app then uses `http://<Pi's LAN IP>:8080`, CSEBase `cse-hydropi`, and the app's token.

### 5.3 Setups B, C, D: cloud CSE

The Pi doesn't run a CSE: it sends to the Droplet. In `pi/.env`, pick one block:

**B: HTTPS to the HydroOS CSE**
```
HYDRO_BACKEND=onem2m
ONEM2M_TRANSPORT=http
ONEM2M_CSE_URL=https://<ip-with-dashes>.sslip.io
ONEM2M_CSE_RN=cse-in
ONEM2M_TOKEN=<PI_TOKEN from /root/acme-tokens.txt>
```

**C: MQTT + Protobuf to the HydroOS CSE**
```
HYDRO_BACKEND=onem2m
ONEM2M_TRANSPORT=mqtt
ONEM2M_MQTT_HOST=<droplet-ip>
ONEM2M_MQTT_PORT=1884
ONEM2M_CSE_ID=id-in
ONEM2M_CSE_RN=cse-in
ONEM2M_SERIALIZATION=pb
```

**D: MQTT + Protobuf to the gRPB-M2M demo CSE**: as C, with `ONEM2M_MQTT_PORT=1883`.

- MQTT mode uses no token: `ONEM2M_TOKEN` is ignored. The broker is protected by the firewall.
- `ONEM2M_MQTT_HOST` and `ONEM2M_MQTT_PORT` are separate settings: don't put `:1884` in the host.
- `ONEM2M_SERIALIZATION=json` sends the same requests as readable JSON (handy for debugging).

Then start the services. Mask the local CSE so `hydro-onem2m` (which wants it) can't start it:

```bash
sudo cp systemd/hydro-sensors.service systemd/hydro-ble.service systemd/hydro-onem2m.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl mask acme-cse
sudo systemctl enable --now hydro-sensors hydro-ble hydro-onem2m
```

Check: `journalctl -u hydro-onem2m -f` should print `uploading to …`, then
`provisioned cse-in/HydroPi-<hash>`, then `uploaded N cycle(s)`. If it keeps retrying with
"not reachable" or "cannot reach", check the firewall ([Section 4](#4-firewalls)) and that the
CSE (and broker) are running on the Droplet.

After changing `.env`, restart: `sudo systemctl restart hydro-onem2m`.

### 5.4 Dummy data

`python3 pi/seed_dummy_data.py` adds 10 plausible cycles to the local database. They're marked
as sent for Supabase, but the oneM2M uploader still sends them. For a continuous simulated Pi
(simulated sensors every 30 s, a separate `-sim` system name, 3 days of seeded history), see
`main_dummy.py` in the `HydroponicPiLogic_onem2m_imp` repository.

### 5.5 Long-term history

The CSE keeps about two days; the full history stays in `pi/hydro.db`. Export it with
`python3 export_readings.py --since 2026-11-01 --out readings.csv`, and back it up off the Pi
regularly.

---

## 6. App setup

### 6.1 Install

On your PC (Node.js 20+), in the `homegrow_frontend_onem2m` folder:

```bash
npm install
```

This copy of the app reads from a oneM2M CSE; the original `homegrow_frontend` reads from
Supabase. **The oneM2M copy isn't in its own GitHub repository yet** (its git remote still
points at the original app's repository), so share the folder directly until it has one.

### 6.2 Web build (quickest for testing)

```bash
npx expo start --web --port 8083
```

Open http://localhost:8083 and sign in with **`admin` / `admin`** (built-in test users,
`src/components/login-screen.tsx`). Then set the CSE in **⚙ oneM2M settings** ([6.4](#64-connect-the-app-to-a-cse)).

The web dev build defaults to `http://localhost:8080` with token `app-test-token`, for the local
trial ([Section 7](#7-testing-without-a-pi)). Saved settings override the defaults; each browser
keeps its own.

### 6.3 Android

**Development build** (JavaScript loads from your PC):

```bash
npx expo start --dev-client                 # terminal 1, keep running
adb reverse tcp:8081 tcp:8081               # terminal 2, phone on USB
npm run android                             # first time, or after native changes / app.json edits
```

On networks that block device-to-device traffic, the `adb reverse` route over USB is what makes
this work.

**Release build** (standalone APK, no PC needed):

```bash
npx expo prebuild                           # applies app.json, incl. plain-HTTP support
cd android && ./gradlew assembleRelease "-Dorg.gradle.jvmargs=-Xmx4096m -XX:MaxMetaspaceSize=1536m"
adb install -r app/build/outputs/apk/release/app-release.apk
```

- On Windows, long paths break the native build: copy the project to a short path such as
  `C:\hg\app` and build there.
- `app.json` → `expo.extra.onem2m` holds the default CSE settings baked into builds
  (`cseUrl`, `cseRn`, `originator`). Don't put a token there; users enter it in the app.
- The app allows plain HTTP (`usesCleartextTraffic`) for Setup A; with only HTTPS CSEs, you can
  turn that off in `app.json`.

### 6.4 Connect the app to a CSE

Open **⚙ oneM2M settings** (on the sign-in screen, or the error screen when it can't connect):

| Setup | CSE address | CSEBase name | Originator | Token |
|---|---|---|---|---|
| A. CSE on the Pi | `http://<Pi's LAN IP>:8080` | `cse-hydropi` | `CHydroOS-app` | the app's token |
| B / C. HydroOS cloud CSE | `https://<ip-with-dashes>.sslip.io` | `cse-in` | `CHydroOS-app` | `APP_TOKEN` |
| D. gRPB-M2M demo CSE | `http://localhost:8084` (through the tunnel below) | `cse-in` | `CHydroOS-app` | empty |
| Local trial (Section 7) | `http://localhost:8080` | `cse-hydropi` | `CHydroOS-app` | `app-test-token` |

**SSH tunnel for Setup D.** The demo CSE's port stays closed to the internet. Keep this running
on your PC, and use `http://localhost:8084` in the app:

```bash
ssh -N -L 8084:127.0.0.1:8084 root@<droplet-ip>
```

- **`localhost` here means "the tunnel's entrance on this PC"**, not that the CSE runs locally.
- It works only on the machine running the tunnel. A phone would need its own tunnel; use
  Setup B or C for phones.
- Pick a different local port if 8084 is taken (`-L 9000:127.0.0.1:8084`, then
  `http://localhost:9000`). Port 8083 is the web build's own.

### 6.5 Using the app

- **Home:** one card per system (one per Pi), refreshed every minute.
- **Dashboard:** latest values with recommended ranges, and the low-water alert.
- **History:** **Live** (last 60 minutes, from the CSE), **24 h** (one reading per 10 min) and
  **7 days** (hourly), the last two **asked from the Pi**. "The Pi didn't answer within 20 s"
  means the Pi is offline or can't reach the CSE: **Try again**.
- **Plant Vision:** latest camera metrics from the Pi's `vision` container.
- **Bluetooth (ᛒ):** reads readings straight from a nearby Pi when there's no network.

---

## 7. Testing without a Pi

`HydroponicPiLogic_onem2m/docs/local-trial.md` runs everything on one Windows PC: ACME with the
Pi repository's `acme.ini`, the Pi's uploader fed with dummy readings, and the app's web build.
It uses public test tokens (`pi-test-token`, `app-test-token`, secret `test-secret-not-for-prod`),
which must **never** be used on an internet-facing CSE.

---

## 8. Day-to-day and troubleshooting

**Where things live on the Droplet**

| What | Where |
|---|---|
| HydroOS CSE program / config / data | `/opt/acme/venv` · `/var/lib/acme/acme.ini` · `/var/lib/acme/data` |
| Secret, token hashes, readable tokens | `/var/lib/acme/.env` · `/var/lib/acme/certs/http_token_auth.txt` · `/root/acme-tokens.txt` |
| Caddy config, certificate | `/etc/caddy/Caddyfile` · `/var/lib/caddy` |
| HydroOS broker (1884) | `/etc/mosquitto/conf.d/hydroos.conf` |
| gRPB-M2M demo (1883 / 8084) | `/root/gRPB-M2M/config/mosquitto.conf` · `config/acme.ini` |

**Useful commands**

```bash
systemctl is-active acme-cse caddy mosquitto        # running?
journalctl -u acme-cse -n 50                        # CSE log (also /var/lib/acme/logs/)
journalctl -u caddy -n 30                           # HTTPS/certificate problems
ss -ltnp | grep -E ':(80|443|1883|1884|8080|8084) ' # what's listening
ps -eo pid,etime,args | grep "[a]cmecse"            # which ACMEs are running
```

**Common problems**

| Symptom | Likely cause | Fix |
|---|---|---|
| App: "CSE … is not reachable" | Wrong address, CSE/Caddy stopped, tunnel closed, or (web build) CORS off | Check the settings table above; `systemctl start acme-cse caddy`; reopen the tunnel; `[http.cors] enable=true` |
| App: "The CSE rejected the token" | Wrong or missing token | Use `APP_TOKEN` from `/root/acme-tokens.txt` |
| App: "No recent sensor readings" | No Pi is uploading, or the demo CSE restarted (memory) | Check the Pi's log; restart its uploader |
| Pi log: `backend=supabase` | No `pi/.env` | `cp .env.example .env` and edit ([5.1](#51-install)) |
| Pi: "cannot reach" broker / CSE | Firewall, or broker/CSE stopped | Add the Pi's public IP ([4.3](#43-finding-the-right-ip-address)); start the services |
| Caddy fails: "permission denied" on Caddyfile | Old setup script | `chmod 755 /etc/caddy && chmod 644 /etc/caddy/Caddyfile && systemctl restart caddy` |
| A process started with `make …` disappeared | It ended with your SSH session | Run it in `tmux` ([3.5](#35-setup-d-the-grpb-m2m-demo-cse)) |
| `Address already in use` on 1883 / 8080 | Another broker or CSE on that port | `ss -ltnp \| grep <port>`; change one port (e.g. the demo CSE to 8084) |

---

## 9. Security notes and limits

- **Tokens aren't tied to originators:** any valid token can act as any originator. Keep
  tokens private, give each Pi and person their own, and revoke leaked ones (delete their line in
  `/var/lib/acme/certs/http_token_auth.txt`, restart `acme-cse`).
- **MQTT has no login or TLS yet**, because gRPB-M2M can't send credentials. The firewall (or an
  SSH tunnel) is the only protection for ports 1883/1884.
- **The demo CSE (Setup D) has no authentication at all**; never open its HTTP port.
- **One basin per Pi** in oneM2M mode.
- **On-demand requests wait up to ~3 s** for the Pi's next check. A push version (MQTT
  notifications) isn't built yet.
- **Protobuf saves little on readings** (394 → 354 bytes), because gRPB-M2M's schema doesn't
  model time-series entries; their content still travels as JSON inside.
- Not yet run end to end on a real Pi with real sensors.
- More detail: `HydroponicPiLogic_onem2m/docs/onem2m.md` (resources, ACME behaviour, transports).
