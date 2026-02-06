# La Bodega – Raspberry Pi Scale / Scanner / Printer Bridge (iot_bridge)

This guide documents the **complete production setup** for running the **Magellan scale + Epson receipt printer bridge** (`iot_bridge / scale_bridge.py`) on a **headless Raspberry Pi** for Odoo POS.

This version **prioritizes Direct USB printing first**, with CUPS as fallback.

---

## Target Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Ubuntu POS Terminals                      │
│                                                              │
│   ┌──────────────────┐    ┌──────────────────┐              │
│   │  Odoo POS        │    │  Odoo POS        │              │
│   │  (Chrome)        │    │  (Chrome)        │              │
│   └────────┬─────────┘    └────────┬─────────┘              │
│            │ HTTPS                 │ HTTPS                   │
└────────────┼───────────────────────┼────────────────────────┘
             │                       │
             ▼                       ▼
┌─────────────────────────────────────────────────────────────┐
│                    Raspberry Pi (LAN)                        │
│                                                              │
│   ┌─────────────────────────────────────────────────────┐   │
│   │              scale_bridge.py (FastAPI)               │   │
│   │                                                      │   │
│   │  Endpoints:                                          │   │
│   │    /barcode  - Get scanned barcode                   │   │
│   │    /weight   - Get current weight                    │   │
│   │    /print_raw - Print ESC/POS data                   │   │
│   │    /open_drawer - Open cash drawer                   │   │
│   │    /printer_status - Check printer status            │   │
│   └──────────┬────────────────────────┬─────────────────┘   │
│              │                        │                      │
│   ┌──────────▼──────────┐  ┌─────────▼─────────┐            │
│   │  Magellan Scanner   │  │  Epson Printer    │            │
│   │  /dev/ttyUSB0       │  │  /dev/usb/lp0     │            │
│   │  (Serial RS-232)    │  │  (Direct USB)     │            │
│   └─────────────────────┘  └───────────────────┘            │
└─────────────────────────────────────────────────────────────┘
```

**Components:**
- **Ubuntu POS terminals** - Run Odoo POS in browser, make HTTPS calls to Pi
- **Raspberry Pi (LAN)** - Runs `scale_bridge.py` FastAPI server
  - Magellan scanner/scale (serial `/dev/ttyUSB0`)
  - Epson ESC/POS printer (USB `/dev/usb/lp0`)
  - Direct USB printing (preferred, faster)
  - CUPS fallback (if direct USB fails)

---

## Project Layout

```
/home/labodega2/iot_bridge/
├── scale_bridge.py          # Main bridge application
├── venv/                    # Python virtual environment
└── certs/                   # SSL certificates for HTTPS
    ├── cert.pem
    └── key.pem
```

---

# Part 1: Raspberry Pi OS Installation

## 1.1 Install Raspberry Pi OS Lite on SSD (Recommended)

### Option A: Raspberry Pi Imager (Best Method)

1. On your computer, download and open **Raspberry Pi Imager**
2. Choose OS: **Raspberry Pi OS Lite (64-bit)**
3. Choose storage: your **SSD** (USB-connected or NVMe)
4. Click the **gear icon** for advanced settings:
   - Set hostname: `labodega2` (or your preferred name)
   - Enable SSH: ✓
   - Set username: `labodega2`
   - Set password: (your secure password)
   - Configure Wi-Fi (optional, Ethernet preferred)
   - Set locale/timezone
5. Click **Write** → Wait for completion
6. Connect SSD to Pi and boot

> **Recommendation:** Use Ethernet for best stability in a store environment.

### Option B: Manual Image Write

```bash
# On Linux/Mac
sudo dd if=raspios-lite.img of=/dev/sdX bs=4M status=progress
sync
```

---

## 1.2 Initial Pi Setup

### First Boot - Connect via SSH

```bash
ssh labodega2@labodega2.local
# Or use IP address
ssh labodega2@<PI_IP>
```

### Update System Packages

```bash
sudo apt update && sudo apt -y upgrade
sudo reboot
```

### Install Required Dependencies

```bash
sudo apt -y install python3 python3-venv python3-pip git
```

---

# Part 2: Scale/Scanner Bridge Setup

## 2.1 Create Project Folder and Python Environment

```bash
mkdir -p /home/labodega2/iot_bridge
cd /home/labodega2/iot_bridge

# Create virtual environment
python3 -m venv venv
source venv/bin/activate

# Install Python packages
pip install --upgrade pip
pip install fastapi uvicorn pyserial
```

## 2.2 Deploy the Bridge Script

Copy `scale_bridge.py` to the Pi:

```bash
# From your development machine
scp scale_bridge.py labodega2@<PI_IP>:/home/labodega2/iot_bridge/
```

Or create/edit directly:

```bash
nano /home/labodega2/iot_bridge/scale_bridge.py
```

## 2.3 Identify Serial Device

```bash
# List serial devices
ls -la /dev/ttyUSB* /dev/ttyACM* 2>/dev/null

# Check kernel messages for device info
dmesg | tail -n 80

# Typical output for Magellan scanner
# [    7.479452] usb 1-1.4: pl2303 converter now attached to ttyUSB0
```

Common serial port names:
- `/dev/ttyUSB0` - USB-to-Serial adapter (most common)
- `/dev/ttyACM0` - USB CDC device
- `/dev/serial0` - Raspberry Pi GPIO serial

## 2.4 Add User to Serial Group

```bash
sudo usermod -aG dialout labodega2
sudo reboot
```

After reboot, confirm group membership:

```bash
groups labodega2
# Should include: dialout
```

## 2.5 Configure scale_bridge.py

Edit the configuration section:

```bash
nano /home/labodega2/iot_bridge/scale_bridge.py
```

Key configuration items:

```python
# Serial port settings
SERIAL_PORT = "/dev/ttyUSB0"    # Your serial device
BAUDRATE = 9600                  # Match scanner settings

# Weight parsing
WEIGHT_DIVISOR = 100             # Divide raw weight by this

# Server settings
SERVER_HOST = "0.0.0.0"          # Listen on all interfaces
SERVER_PORT = 8443               # HTTPS port (or 8000 for HTTP)

# Printer settings
PRINTER_NAME = "epson_pos"       # CUPS printer (fallback)
PRINTER_DEVICE = "/dev/usb/lp0"  # Direct USB (preferred)
```

---

# Part 3: SSL/HTTPS Setup (Required for Browser Access)

Modern browsers require HTTPS for accessing local network resources from HTTPS pages.

## 3.1 Generate Self-Signed Certificates

```bash
mkdir -p /home/labodega2/iot_bridge/certs
cd /home/labodega2/iot_bridge/certs

# Get Pi's IP address
PI_IP=$(hostname -I | awk '{print $1}')

# Generate certificate valid for 10 years
openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout key.pem -out cert.pem -days 3650 \
  -subj "/CN=$PI_IP" \
  -addext "subjectAltName=IP:$PI_IP"

# Verify files created
ls -la *.pem
```

## 3.2 Trust Certificate on POS Terminals

On each Ubuntu POS terminal browser:

1. Navigate to `https://<PI_IP>:8443/`
2. Click **Advanced** → **Proceed to <IP> (unsafe)**
3. This trusts the self-signed certificate for this session

For permanent trust (optional):

```bash
# Copy cert to POS terminal
scp labodega2@<PI_IP>:/home/labodega2/iot_bridge/certs/cert.pem /tmp/

# Add to system trust store
sudo cp /tmp/cert.pem /usr/local/share/ca-certificates/pi-bridge.crt
sudo update-ca-certificates
```

---

# Part 4: Systemd Service (Auto-Start on Boot)

## 4.1 Create Service File

```bash
sudo nano /etc/systemd/system/iot_bridge.service
```

Paste the following:

```ini
[Unit]
Description=Magellan Scale Scanner Bridge (FastAPI)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=labodega2
WorkingDirectory=/home/labodega2/iot_bridge
Environment="PYTHONUNBUFFERED=1"
ExecStart=/home/labodega2/iot_bridge/venv/bin/python /home/labodega2/iot_bridge/scale_bridge.py
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
```

## 4.2 Enable and Start Service

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now iot_bridge
sudo systemctl status iot_bridge --no-pager
```

Expected output:

```
● iot_bridge.service - Magellan Scale Scanner Bridge (FastAPI)
     Loaded: loaded (/etc/systemd/system/iot_bridge.service; enabled)
     Active: active (running) since ...
```

---

# Part 5: Epson POS Receipt Printer Setup (Direct USB First)

This section configures an **Epson TM-series ESC/POS printer** for **instant printing**
without browser dialogs or CUPS latency.

Supported models:
- TM-T20II / TM-T20III
- TM-T88IV / TM-T88V / TM-T88VI

---

## 1. Install CUPS (Fallback Only)

Even when using direct USB, install CUPS as a fallback.

```bash
sudo apt update
sudo apt install -y cups cups-bsd
```

---

## 2. Add User to Printer Groups

```bash
sudo usermod -aG lpadmin labodega2
sudo usermod -aG lp labodega2
sudo reboot
```

---

## 3. Identify Printer

```bash
lsusb | grep -i epson
```

Example:
```
Bus 001 Device 005: ID 04b8:0202 Seiko Epson Corp.
```

Find URI (for CUPS fallback):
```bash
lpinfo -v | grep -i usb
```

Example:
```
usb://EPSON/TM-T88IV?serial=XXXXXXXXXX
```

---

## 4. Add Printer to CUPS (RAW)

```bash
sudo lpadmin -p epson_pos -E   -v 'usb://EPSON/TM-T88IV?serial=YOUR_SERIAL'   -m raw

sudo lpadmin -d epson_pos
sudo cupsenable epson_pos
sudo cupsaccept epson_pos
```

---

## 5. Enable Direct USB Printing (Preferred)

### Verify device
```bash
ls -la /dev/usb/lp*
```

Expected:
```
/dev/usb/lp0
```

### Temporary permissions
```bash
sudo chmod 666 /dev/usb/lp0
```

### Persistent udev rules
```bash
sudo tee /etc/udev/rules.d/99-usb-printer.rules << 'EOF'
# Epson receipt printer – allow direct access
SUBSYSTEM=="usb", ATTRS{idVendor}=="04b8", MODE="0666"
SUBSYSTEM=="usbmisc", ATTRS{idVendor}=="04b8", MODE="0666"
EOF

sudo udevadm control --reload-rules
sudo udevadm trigger
```

---

## 6. Disable ColorManager (Critical for Speed)

```bash
sudo systemctl stop colord
sudo systemctl disable colord
sudo systemctl mask colord
sudo apt remove colord -y
sudo systemctl restart cups
```

---

## 7. Disable USB Autosuspend (Prevents Disconnects)

```bash
echo -1 | sudo tee /sys/bus/usb/devices/*/power/autosuspend 2>/dev/null
```

Persistent:
```bash
sudo tee /etc/udev/rules.d/50-usb-printer-nosuspend.rules << 'EOF'
ACTION=="add", SUBSYSTEM=="usb", ATTRS{idVendor}=="04b8", ATTR{power/autosuspend}="-1"
EOF

sudo udevadm control --reload-rules
sudo udevadm trigger
```

---

## 8. Testing

### Direct USB Test (Fastest)
```bash
echo -e "\x1B@\nDIRECT USB TEST\n\n\n\x1DVA0" | sudo tee /dev/usb/lp0 > /dev/null
```

### CUPS Test
```bash
echo "CUPS TEST" | lp -d epson_pos
```

---

## 9. Bridge API Tests

```bash
curl -k https://localhost:8443/printer_status
```

Expected (direct):
```json
{
  "status": "ready",
  "printer": "/dev/usb/lp0",
  "method": "direct"
}
```

Print:
```bash
curl -k -X POST https://localhost:8443/print_raw   -H "Content-Type: application/octet-stream"   --data-binary $'\x1B@\nAPI TEST\n\n\n\x1DVA0'
```

Cash drawer:
```bash
curl -k -X POST https://localhost:8443/open_drawer
```

---

## 10. Bridge Printer Configuration (scale_bridge.py)

```python
PRINTER_NAME = "epson_pos"        # CUPS fallback
PRINTER_DEVICE = "/dev/usb/lp0"   # Direct USB (preferred)
```

Priority:
1. Direct USB
2. CUPS fallback

---

## 11. Troubleshooting

### Permission denied
```bash
ls -l /dev/usb/lp0
groups labodega2
```

Fix:
```bash
sudo chmod 666 /dev/usb/lp0
sudo usermod -aG lp labodega2
sudo reboot
```

### USB disconnects
```bash
dmesg | grep -i usb | tail -20
```

Use:
- Powered USB hub
- Different cable
- Autosuspend disabled

### Garbage output
- Ensure RAW driver
- Send ESC/POS commands only
- Check printer DIP switches

---

## 12. Common Epson Vendor IDs

| Model | Vendor | Product |
|-----|-------|--------|
| TM-T20II | 04b8 | 0e15 |
| TM-T20III | 04b8 | 0e28 |
| TM-T88IV | 04b8 | 0202 |
| TM-T88V | 04b8 | 0202 |
| TM-T88VI | 04b8 | 0e27 |

---

## 13. Service Management

```bash
sudo systemctl status iot_bridge
sudo systemctl restart iot_bridge
sudo journalctl -u iot_bridge -f
```

---

# Part 6: Network Configuration

## 6.1 Get Pi IP Address

```bash
hostname -I
ip a
```

## 6.2 Static IP (Recommended for Production)

**Option A: DHCP Reservation (Preferred)**

Create a DHCP reservation in your router so the Pi always keeps the same IP address.
This is the cleanest solution and requires no Pi configuration.

**Option B: Static IP on Pi**

Edit the dhcpcd configuration:

```bash
sudo nano /etc/dhcpcd.conf
```

Add at the end:

```
interface eth0
static ip_address=192.168.1.100/24
static routers=192.168.1.1
static domain_name_servers=192.168.1.1 8.8.8.8
```

Replace with your network's values. Then:

```bash
sudo systemctl restart dhcpcd
```

## 6.3 Firewall (Optional)

If using ufw:

```bash
sudo apt install ufw
sudo ufw allow ssh
sudo ufw allow 8443/tcp  # Bridge HTTPS
sudo ufw enable
```

---

# Part 7: Testing Endpoints

## 7.1 Local Test on Pi

```bash
# Check root endpoint
curl -k https://127.0.0.1:8443/

# Check weight
curl -k https://127.0.0.1:8443/weight

# Check barcode
curl -k https://127.0.0.1:8443/barcode

# Check printer status
curl -k https://127.0.0.1:8443/printer_status
```

## 7.2 Test from Ubuntu POS Terminal

```bash
# Replace <PI_IP> with your Pi's IP address
curl -k https://<PI_IP>:8443/weight
curl -k https://<PI_IP>:8443/barcode
curl -k https://<PI_IP>:8443/printer_status
```

## 7.3 Test Printing

```bash
# Print test receipt
curl -k -X POST https://<PI_IP>:8443/print_raw \
  -H "Content-Type: application/octet-stream" \
  --data-binary $'\x1B@\nTEST RECEIPT\n\n\n\x1DVA0'

# Open cash drawer
curl -k -X POST https://<PI_IP>:8443/open_drawer
```

---

# Part 8: Quick Command Reference

## Service Management

```bash
# Check service status
sudo systemctl status iot_bridge --no-pager

# Restart service
sudo systemctl restart iot_bridge

# Stop service
sudo systemctl stop iot_bridge

# Enable on boot
sudo systemctl enable --now iot_bridge

# Disable on boot
sudo systemctl disable iot_bridge
```

## View Logs

```bash
# Last 200 lines
journalctl -u iot_bridge -n 200 --no-pager

# Follow logs in real-time
journalctl -u iot_bridge -f

# Filter by time
journalctl -u iot_bridge --since "1 hour ago"
```

## Network Commands

```bash
# Get IP address
hostname -I
ip a

# Test connectivity
ping -c 3 <PI_IP>

# Check listening ports
ss -tlnp | grep 8443
```

## Serial Device Discovery

```bash
# List serial devices
ls -la /dev/ttyUSB* /dev/ttyACM* 2>/dev/null

# Check kernel messages
dmesg | tail -n 80

# Watch for device connections
sudo dmesg -w
```

## Printer Commands

```bash
# Check printer device
ls -la /dev/usb/lp*

# Direct USB test print
echo -e "\x1B@\nTEST\n\n\n\x1DVA0" > /dev/usb/lp0

# CUPS test print
echo "TEST" | lp -d epson_pos

# Check CUPS queue
lpstat -o

# Cancel stuck jobs
cancel -a epson_pos

# Re-enable printer
sudo cupsenable epson_pos
sudo cupsaccept epson_pos
```

## SSL Certificate

```bash
# Regenerate certificates (if IP changes)
cd /home/labodega2/iot_bridge/certs
PI_IP=$(hostname -I | awk '{print $1}')
openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout key.pem -out cert.pem -days 3650 \
  -subj "/CN=$PI_IP" \
  -addext "subjectAltName=IP:$PI_IP"
sudo systemctl restart iot_bridge
```

---

# Final Verification Checklist

## Hardware
- [ ] Raspberry Pi boots from SSD
- [ ] Ethernet connected (preferred) or Wi-Fi configured
- [ ] Magellan scanner connected via USB-Serial adapter
- [ ] Epson printer connected via USB

## Software
- [ ] Python venv created with dependencies
- [ ] `scale_bridge.py` deployed
- [ ] SSL certificates generated
- [ ] Systemd service enabled and running

## Permissions
- [ ] User in `dialout` group (for serial)
- [ ] User in `lp` group (for printer)
- [ ] `/dev/usb/lp0` accessible (mode 666)

## Network
- [ ] Static IP configured (DHCP reservation or static)
- [ ] HTTPS endpoint accessible from POS terminals
- [ ] Certificate trusted in browser

## Functionality
- [ ] `/barcode` returns scanned barcodes
- [ ] `/weight` returns scale weight
- [ ] `/print_raw` prints receipts instantly
- [ ] `/open_drawer` opens cash drawer
- [ ] `/printer_status` shows `"method": "direct"`

---

# Maintenance

## Updating the Bridge

```bash
# Stop service
sudo systemctl stop iot_bridge

# Backup current version
cp /home/labodega2/iot_bridge/scale_bridge.py /home/labodega2/iot_bridge/scale_bridge.py.bak

# Deploy new version
scp scale_bridge.py labodega2@<PI_IP>:/home/labodega2/iot_bridge/

# Restart service
sudo systemctl start iot_bridge
```

## Monitoring

```bash
# Check service is running
systemctl is-active iot_bridge

# Check for errors in last hour
journalctl -u iot_bridge --since "1 hour ago" | grep -i error
```

## Backup Configuration

```bash
# Create backup archive
cd /home/labodega2
tar -czf iot_bridge_backup_$(date +%Y%m%d).tar.gz iot_bridge/
```

---

# Part 9: Ubuntu POS Terminal Setup

This section covers setting up **Ubuntu POS terminals** to run Odoo POS in Chrome kiosk mode
with proper access to the Raspberry Pi bridge.

---

## 9.1 Install Google Chrome

### Option A: Download from Google (Recommended)

```bash
# Download Chrome .deb package
wget https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb

# Install Chrome
sudo dpkg -i google-chrome-stable_current_amd64.deb

# Fix any dependency issues
sudo apt --fix-broken install -y

# Verify installation
google-chrome --version
```

### Option B: Add Google Chrome Repository

```bash
# Add Google signing key
wget -q -O - https://dl.google.com/linux/linux_signing_key.pub | sudo gpg --dearmor -o /usr/share/keyrings/google-chrome.gpg

# Add repository
echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google-chrome.gpg] http://dl.google.com/linux/chrome/deb/ stable main" | sudo tee /etc/apt/sources.list.d/google-chrome.list

# Update and install
sudo apt update
sudo apt install -y google-chrome-stable
```

---

## 9.2 Install Required Dependencies

```bash
sudo apt update
sudo apt install -y \
  xdotool \
  unclutter \
  x11-xserver-utils \
  curl \
  ca-certificates
```

---

## 9.3 Trust the Pi's SSL Certificate (Optional but Recommended)

Copy the Pi's self-signed certificate and add to system trust store:

```bash
# Copy certificate from Pi
scp labodega2@<PI_IP>:/home/labodega2/iot_bridge/certs/cert.pem /tmp/pi-bridge.pem

# Add to system trust store
sudo cp /tmp/pi-bridge.pem /usr/local/share/ca-certificates/pi-bridge.crt
sudo update-ca-certificates

# Verify
ls -la /usr/local/share/ca-certificates/
```

> **Note:** Even with system trust, Chrome kiosk mode uses `--ignore-certificate-errors` 
> to ensure no SSL warnings interrupt the POS workflow.

---

## 9.4 Chrome POS Kiosk Launch Command

The key command to launch Chrome in POS kiosk mode:

```bash
google-chrome \
  --ignore-certificate-errors \
  --disable-web-security \
  --disable-features=PrivateNetworkAccessSendPreflights,PrivateNetworkAccessRespectPreflightResults \
  --user-data-dir=$HOME/.config/chrome-pos \
  --kiosk \
  "https://erp.labodegacalhoun.com/pos/web?config_id=2" &
```

### Explanation of Flags:

| Flag | Purpose |
|------|---------|
| `--ignore-certificate-errors` | Accept self-signed SSL certificate from Pi |
| `--disable-web-security` | Allow cross-origin requests to Pi |
| `--disable-features=PrivateNetworkAccess*` | Allow HTTPS page to access local network (Pi) |
| `--user-data-dir=$HOME/.config/chrome-pos` | Separate Chrome profile for POS |
| `--kiosk` | Full-screen kiosk mode (no browser UI) |

### Additional Useful Flags:

```bash
# Full command with all recommended flags
google-chrome \
  --ignore-certificate-errors \
  --disable-web-security \
  --disable-features=PrivateNetworkAccessSendPreflights,PrivateNetworkAccessRespectPreflightResults \
  --user-data-dir=$HOME/.config/chrome-pos \
  --kiosk \
  --noerrdialogs \
  --disable-infobars \
  --disable-session-crashed-bubble \
  --disable-restore-session-state \
  --no-first-run \
  --start-fullscreen \
  "https://erp.labodegacalhoun.com/pos/web?config_id=2" &
```

---

## 9.5 Exiting Kiosk Mode

Kiosk mode hides all browser UI. To exit:

### Method 1: Keyboard Shortcut
- Press `Alt + F4` to close Chrome

### Method 2: Switch to Another TTY
- Press `Ctrl + Alt + F2` to switch to TTY2
- Login and run: `pkill chrome`
- Press `Ctrl + Alt + F1` (or F7) to return to desktop

### Method 3: From SSH
```bash
ssh user@<POS_TERMINAL_IP>
pkill chrome
```

---

## 9.6 Create Desktop Shortcut

Create a desktop launcher for the POS kiosk:

```bash
mkdir -p ~/Desktop

cat > ~/Desktop/odoo-pos.desktop << 'EOF'
[Desktop Entry]
Version=1.0
Type=Application
Name=Odoo POS
Comment=Launch Odoo Point of Sale
Icon=google-chrome
Exec=/bin/bash -c 'google-chrome --ignore-certificate-errors --disable-web-security --disable-features=PrivateNetworkAccessSendPreflights,PrivateNetworkAccessRespectPreflightResults --user-data-dir=$HOME/.config/chrome-pos --kiosk --noerrdialogs --disable-infobars --no-first-run "https://erp.labodegacalhoun.com/pos/web?config_id=2"'
Terminal=false
Categories=Application;
EOF

# Make executable
chmod +x ~/Desktop/odoo-pos.desktop

# Trust the desktop file (GNOME)
gio set ~/Desktop/odoo-pos.desktop metadata::trusted true
```

### For Different POS Configs

If you have multiple POS terminals with different configs, change `config_id`:

```bash
# Terminal 1 (config_id=2)
"https://erp.labodegacalhoun.com/pos/web?config_id=2"

# Terminal 2 (config_id=3)
"https://erp.labodegacalhoun.com/pos/web?config_id=3"
```

---

## 9.7 Auto-Start POS on Login (Optional)

### Option A: Autostart Directory

```bash
mkdir -p ~/.config/autostart

cat > ~/.config/autostart/odoo-pos.desktop << 'EOF'
[Desktop Entry]
Type=Application
Name=Odoo POS Kiosk
Exec=/bin/bash -c 'sleep 5 && google-chrome --ignore-certificate-errors --disable-web-security --disable-features=PrivateNetworkAccessSendPreflights,PrivateNetworkAccessRespectPreflightResults --user-data-dir=$HOME/.config/chrome-pos --kiosk --noerrdialogs --disable-infobars --no-first-run "https://erp.labodegacalhoun.com/pos/web?config_id=2"'
Hidden=false
NoDisplay=false
X-GNOME-Autostart-enabled=true
EOF
```

> The `sleep 5` ensures the desktop is fully loaded before launching Chrome.

### Option B: Systemd User Service

```bash
mkdir -p ~/.config/systemd/user

cat > ~/.config/systemd/user/odoo-pos.service << 'EOF'
[Unit]
Description=Odoo POS Chrome Kiosk
After=graphical-session.target

[Service]
Type=simple
Environment=DISPLAY=:0
ExecStartPre=/bin/sleep 10
ExecStart=/usr/bin/google-chrome --ignore-certificate-errors --disable-web-security --disable-features=PrivateNetworkAccessSendPreflights,PrivateNetworkAccessRespectPreflightResults --user-data-dir=%h/.config/chrome-pos --kiosk --noerrdialogs --disable-infobars --no-first-run "https://erp.labodegacalhoun.com/pos/web?config_id=2"
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
EOF

# Enable the service
systemctl --user daemon-reload
systemctl --user enable odoo-pos.service
```

---

## 9.8 Create POS Launch Script

For more control, create a dedicated launch script:

```bash
sudo tee /usr/local/bin/pos-kiosk << 'EOF'
#!/bin/bash

# POS Kiosk Launch Script
# Usage: pos-kiosk [config_id]

CONFIG_ID=${1:-2}
ODOO_URL="https://erp.labodegacalhoun.com/pos/web?config_id=${CONFIG_ID}"
CHROME_PROFILE="$HOME/.config/chrome-pos-${CONFIG_ID}"

# Kill any existing Chrome POS instances
pkill -f "chrome-pos" 2>/dev/null
sleep 1

# Launch Chrome in kiosk mode
exec google-chrome \
  --ignore-certificate-errors \
  --disable-web-security \
  --disable-features=PrivateNetworkAccessSendPreflights,PrivateNetworkAccessRespectPreflightResults \
  --user-data-dir="$CHROME_PROFILE" \
  --kiosk \
  --noerrdialogs \
  --disable-infobars \
  --no-first-run \
  "$ODOO_URL"
EOF

sudo chmod +x /usr/local/bin/pos-kiosk
```

Usage:
```bash
# Launch with default config (config_id=2)
pos-kiosk

# Launch with specific config
pos-kiosk 3
```

---

## 9.9 Hide Mouse Cursor (Optional)

For a cleaner kiosk experience, hide the mouse cursor when idle:

```bash
# Install unclutter
sudo apt install -y unclutter

# Add to autostart
cat > ~/.config/autostart/unclutter.desktop << 'EOF'
[Desktop Entry]
Type=Application
Name=Unclutter
Exec=unclutter -idle 3
Hidden=false
NoDisplay=false
X-GNOME-Autostart-enabled=true
EOF
```

---

## 9.10 Disable Screen Blanking/Power Management

Prevent the screen from turning off during operation:

```bash
# Disable screen blanking (X11)
xset s off
xset -dpms
xset s noblank

# Make persistent - add to ~/.xprofile
cat >> ~/.xprofile << 'EOF'
# Disable screen blanking for POS
xset s off
xset -dpms
xset s noblank
EOF
```

For GNOME:
```bash
# Disable automatic screen lock
gsettings set org.gnome.desktop.screensaver lock-enabled false
gsettings set org.gnome.desktop.session idle-delay 0

# Disable screen blank
gsettings set org.gnome.settings-daemon.plugins.power sleep-inactive-ac-type 'nothing'
gsettings set org.gnome.settings-daemon.plugins.power idle-dim false
```

---

## 9.11 Firewall Configuration (If Using UFW)

```bash
# Allow outbound HTTPS to Odoo server
# (usually allowed by default)

# Allow outbound to Pi bridge (if needed)
sudo ufw allow out to <PI_IP> port 8443
```

---

## 9.12 Ubuntu Terminal Quick Setup Script

Run this on a fresh Ubuntu POS terminal to set everything up:

```bash
#!/bin/bash
# Ubuntu POS Terminal Setup Script

set -e

echo "=== Installing Google Chrome ==="
wget -q https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
sudo dpkg -i google-chrome-stable_current_amd64.deb || sudo apt --fix-broken install -y
rm google-chrome-stable_current_amd64.deb

echo "=== Installing dependencies ==="
sudo apt update
sudo apt install -y xdotool unclutter curl

echo "=== Creating POS kiosk script ==="
sudo tee /usr/local/bin/pos-kiosk << 'SCRIPT'
#!/bin/bash
CONFIG_ID=${1:-2}
ODOO_URL="https://erp.labodegacalhoun.com/pos/web?config_id=${CONFIG_ID}"
pkill -f "chrome-pos" 2>/dev/null; sleep 1
exec google-chrome \
  --ignore-certificate-errors \
  --disable-web-security \
  --disable-features=PrivateNetworkAccessSendPreflights,PrivateNetworkAccessRespectPreflightResults \
  --user-data-dir="$HOME/.config/chrome-pos-${CONFIG_ID}" \
  --kiosk --noerrdialogs --disable-infobars --no-first-run \
  "$ODOO_URL"
SCRIPT
sudo chmod +x /usr/local/bin/pos-kiosk

echo "=== Creating desktop shortcut ==="
mkdir -p ~/Desktop
cat > ~/Desktop/odoo-pos.desktop << 'DESKTOP'
[Desktop Entry]
Version=1.0
Type=Application
Name=Odoo POS
Icon=google-chrome
Exec=pos-kiosk 2
Terminal=false
DESKTOP
chmod +x ~/Desktop/odoo-pos.desktop

echo "=== Disabling screen blanking ==="
gsettings set org.gnome.desktop.screensaver lock-enabled false 2>/dev/null || true
gsettings set org.gnome.desktop.session idle-delay 0 2>/dev/null || true

echo "=== Setup complete! ==="
echo "Run 'pos-kiosk' or double-click the desktop shortcut to launch POS"
```

Save as `setup-pos-terminal.sh` and run:
```bash
chmod +x setup-pos-terminal.sh
./setup-pos-terminal.sh
```

---

## 9.13 Troubleshooting Ubuntu Terminal

### Chrome won't launch
```bash
# Check if Chrome is installed
which google-chrome
google-chrome --version

# Check for errors
google-chrome --disable-gpu 2>&1 | head -20
```

### Certificate errors in browser
```bash
# Re-import Pi certificate
scp labodega2@<PI_IP>:/home/labodega2/iot_bridge/certs/cert.pem /tmp/
sudo cp /tmp/cert.pem /usr/local/share/ca-certificates/pi-bridge.crt
sudo update-ca-certificates
```

### Private Network Access blocked
Ensure Chrome flags are correct:
```bash
--disable-features=PrivateNetworkAccessSendPreflights,PrivateNetworkAccessRespectPreflightResults
```

### Can't exit kiosk mode
```bash
# From another terminal or SSH
pkill chrome
# Or press Alt+F4
```

### Screen keeps turning off
```bash
xset q | grep -A2 "Screen Saver"
# If enabled, run:
xset s off && xset -dpms
```

---

## 9.14 Minimal Ubuntu Setup (Performance Optimization)

For best POS kiosk performance, remove unnecessary software and disable background services.

### Remove Unnecessary Pre-installed Software

```bash
# Remove snap packages (heavy, slow)
sudo snap remove firefox
sudo snap remove snap-store
sudo snap remove gnome-*
sudo snap remove gtk-common-themes
sudo snap remove snapd-desktop-integration

# Completely remove snapd (optional but recommended)
sudo systemctl stop snapd
sudo systemctl disable snapd
sudo apt remove --purge snapd -y
sudo rm -rf ~/snap /snap /var/snap /var/lib/snapd

# Prevent snapd from being reinstalled
sudo tee /etc/apt/preferences.d/no-snap.pref << 'EOF'
Package: snapd
Pin: release a=*
Pin-Priority: -10
EOF
```

### Remove Unnecessary Desktop Applications

```bash
# Remove office suite, games, and utilities not needed for POS
sudo apt remove --purge -y \
  libreoffice* \
  thunderbird* \
  rhythmbox* \
  totem* \
  shotwell* \
  cheese* \
  gnome-mahjongg \
  gnome-mines \
  gnome-sudoku \
  aisleriot \
  transmission-* \
  deja-dup \
  simple-scan \
  gnome-weather \
  gnome-maps \
  gnome-contacts \
  gnome-calendar \
  gnome-clocks \
  gnome-characters \
  gnome-font-viewer \
  gnome-logs \
  gnome-power-manager \
  gnome-screenshot \
  gnome-system-monitor \
  gnome-disk-utility \
  baobab \
  eog \
  evince \
  gedit \
  seahorse \
  remmina* \
  usb-creator-gtk \
  gnome-todo \
  gnome-music

# Clean up
sudo apt autoremove -y
sudo apt autoclean
```

### Disable Unnecessary System Services

```bash
# Disable Bluetooth (if not needed)
sudo systemctl stop bluetooth
sudo systemctl disable bluetooth

# Disable printing services (using direct USB instead)
# Skip this if you need CUPS as fallback
# sudo systemctl stop cups cups-browsed
# sudo systemctl disable cups cups-browsed

# Disable location services
sudo systemctl stop geoclue
sudo systemctl disable geoclue

# Disable evolution data server (calendar/contacts sync)
sudo systemctl --user stop evolution-addressbook-factory
sudo systemctl --user stop evolution-calendar-factory
sudo systemctl --user stop evolution-source-registry
sudo systemctl --user disable evolution-addressbook-factory
sudo systemctl --user disable evolution-calendar-factory
sudo systemctl --user disable evolution-source-registry

# Disable tracker (file indexing - big performance hit)
systemctl --user mask tracker-store.service
systemctl --user mask tracker-miner-fs.service
systemctl --user mask tracker-miner-rss.service
systemctl --user mask tracker-extract.service
systemctl --user mask tracker-miner-apps.service
systemctl --user mask tracker-writeback.service
tracker reset --hard 2>/dev/null || true

# Disable remote desktop
sudo systemctl stop gnome-remote-desktop
sudo systemctl disable gnome-remote-desktop

# Disable automatic updates popup
sudo systemctl stop unattended-upgrades
sudo systemctl disable unattended-upgrades
sudo apt remove --purge update-notifier -y

# Disable error reporting
sudo systemctl stop apport
sudo systemctl disable apport
sudo apt remove --purge apport -y
```

### Disable GNOME Animations and Visual Effects

```bash
# Disable animations (faster UI response)
gsettings set org.gnome.desktop.interface enable-animations false

# Reduce transparency
gsettings set org.gnome.desktop.interface enable-hot-corners false

# Disable search providers
gsettings set org.gnome.desktop.search-providers disable-external true

# Disable recent files tracking
gsettings set org.gnome.desktop.privacy remember-recent-files false
gsettings set org.gnome.desktop.privacy recent-files-max-age 0

# Disable trash auto-empty prompt
gsettings set org.gnome.desktop.privacy remove-old-trash-files true
gsettings set org.gnome.desktop.privacy remove-old-temp-files true
gsettings set org.gnome.desktop.privacy old-files-age 1
```

### Disable Unnecessary Startup Applications

```bash
# Create directory if not exists
mkdir -p ~/.config/autostart

# Disable GNOME software update check
cat > ~/.config/autostart/gnome-software-service.desktop << 'EOF'
[Desktop Entry]
Type=Application
Name=GNOME Software
Hidden=true
EOF

# Disable online accounts
cat > ~/.config/autostart/gnome-initial-setup-copy-worker.desktop << 'EOF'
[Desktop Entry]
Type=Application
Name=GNOME Initial Setup Copy Worker
Hidden=true
EOF

# Disable GNOME keyring SSH agent (if not using SSH)
cat > ~/.config/autostart/gnome-keyring-ssh.desktop << 'EOF'
[Desktop Entry]
Type=Application
Name=SSH Key Agent
Hidden=true
EOF
```

### Optimize Memory Usage

```bash
# Reduce swappiness (prefer RAM over swap)
echo 'vm.swappiness=10' | sudo tee -a /etc/sysctl.conf

# Apply immediately
sudo sysctl vm.swappiness=10

# Clear page cache periodically (optional)
# Add to crontab: sudo crontab -e
# 0 * * * * sync; echo 3 > /proc/sys/vm/drop_caches
```

### Install Minimal Window Manager (Alternative to GNOME)

For absolute minimal setup, consider using **Openbox** instead of GNOME:

```bash
# Install minimal X and Openbox
sudo apt install -y xorg openbox

# Create autostart for Openbox
mkdir -p ~/.config/openbox

cat > ~/.config/openbox/autostart << 'EOF'
# Disable screen blanking
xset s off
xset -dpms
xset s noblank

# Hide cursor when idle
unclutter -idle 3 &

# Start Chrome kiosk
sleep 3
google-chrome \
  --ignore-certificate-errors \
  --disable-web-security \
  --disable-features=PrivateNetworkAccessSendPreflights,PrivateNetworkAccessRespectPreflightResults \
  --user-data-dir=$HOME/.config/chrome-pos \
  --kiosk \
  --noerrdialogs \
  --disable-infobars \
  --no-first-run \
  "https://erp.labodegacalhoun.com/pos/web?config_id=2" &
EOF

chmod +x ~/.config/openbox/autostart

# Set Openbox as default session
# Select "Openbox" at login screen
```

### Complete Minimal POS Terminal Setup Script

Save as `setup-minimal-pos.sh`:

```bash
#!/bin/bash
# Minimal Ubuntu POS Terminal Setup
# Run with: sudo bash setup-minimal-pos.sh

set -e

echo "=== Removing Snap ==="
snap list 2>/dev/null && snap remove --purge $(snap list | awk 'NR>1 {print $1}') 2>/dev/null || true
systemctl stop snapd 2>/dev/null || true
systemctl disable snapd 2>/dev/null || true
apt remove --purge snapd -y 2>/dev/null || true
rm -rf ~/snap /snap /var/snap /var/lib/snapd 2>/dev/null || true

cat > /etc/apt/preferences.d/no-snap.pref << 'EOF'
Package: snapd
Pin: release a=*
Pin-Priority: -10
EOF

echo "=== Removing Unnecessary Packages ==="
apt remove --purge -y \
  libreoffice* thunderbird* rhythmbox* totem* shotwell* cheese* \
  gnome-mahjongg gnome-mines gnome-sudoku aisleriot transmission-* \
  deja-dup simple-scan gnome-weather gnome-maps gnome-contacts \
  gnome-calendar gnome-clocks gnome-characters gnome-font-viewer \
  gnome-logs gnome-power-manager update-notifier apport 2>/dev/null || true

apt autoremove -y
apt autoclean

echo "=== Disabling Unnecessary Services ==="
systemctl stop bluetooth 2>/dev/null || true
systemctl disable bluetooth 2>/dev/null || true
systemctl stop geoclue 2>/dev/null || true
systemctl disable geoclue 2>/dev/null || true
systemctl stop apport 2>/dev/null || true
systemctl disable apport 2>/dev/null || true

echo "=== Installing Chrome ==="
if ! command -v google-chrome &> /dev/null; then
  wget -q https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
  dpkg -i google-chrome-stable_current_amd64.deb || apt --fix-broken install -y
  rm google-chrome-stable_current_amd64.deb
fi

echo "=== Installing Kiosk Dependencies ==="
apt install -y unclutter xdotool

echo "=== Creating POS Kiosk Script ==="
cat > /usr/local/bin/pos-kiosk << 'SCRIPT'
#!/bin/bash
CONFIG_ID=${1:-2}
ODOO_URL="https://erp.labodegacalhoun.com/pos/web?config_id=${CONFIG_ID}"
pkill -f "chrome-pos" 2>/dev/null; sleep 1
exec google-chrome \
  --ignore-certificate-errors \
  --disable-web-security \
  --disable-features=PrivateNetworkAccessSendPreflights,PrivateNetworkAccessRespectPreflightResults \
  --user-data-dir="$HOME/.config/chrome-pos-${CONFIG_ID}" \
  --kiosk --noerrdialogs --disable-infobars --no-first-run \
  "$ODOO_URL"
SCRIPT
chmod +x /usr/local/bin/pos-kiosk

echo "=== Optimizing System ==="
echo 'vm.swappiness=10' >> /etc/sysctl.conf
sysctl vm.swappiness=10

echo "=== Setup Complete ==="
echo "Reboot and run 'pos-kiosk' to start POS"
echo "Or 'pos-kiosk 3' for config_id=3"
```

Run:
```bash
sudo bash setup-minimal-pos.sh
sudo reboot
```

### Performance Monitoring

Check system resources:

```bash
# Memory usage
free -h

# Running processes
ps aux --sort=-%mem | head -20

# Disk usage
df -h

# Check for heavy background processes
top -b -n 1 | head -30

# List enabled services
systemctl list-unit-files --state=enabled
```

### Recommended Minimum Hardware

For smooth POS operation:

| Component | Minimum | Recommended |
|-----------|---------|-------------|
| CPU | Dual-core 2GHz | Quad-core 2.5GHz+ |
| RAM | 4GB | 8GB |
| Storage | 32GB SSD | 64GB+ SSD |
| Display | 1024x768 | 1920x1080 |

---

## 9.15 Full Ubuntu POS Checklist

### Initial Setup
- [ ] Ubuntu 22.04/24.04 LTS installed
- [ ] System updated (`sudo apt update && sudo apt upgrade -y`)
- [ ] Snap removed (optional but recommended)
- [ ] Unnecessary packages removed
- [ ] Unnecessary services disabled

### Chrome & Kiosk
- [ ] Google Chrome installed
- [ ] `pos-kiosk` script created
- [ ] Desktop shortcut created
- [ ] Auto-start configured (optional)

### Display
- [ ] Screen blanking disabled
- [ ] Animations disabled
- [ ] Mouse cursor auto-hide (unclutter)

### Network
- [ ] Pi bridge accessible (`curl -k https://<PI_IP>:8443/`)
- [ ] Pi certificate trusted or `--ignore-certificate-errors` used

### Performance
- [ ] Tracker/indexing disabled
- [ ] Swappiness reduced
- [ ] Background processes minimized
