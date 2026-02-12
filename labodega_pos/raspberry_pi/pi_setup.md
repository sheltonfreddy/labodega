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
SERVER_PORT = 8000               # HTTPS port

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

## 12.1 Toshiba Thermal Printer Setup

Toshiba thermal printers (including TCx series, TRST series, HSP series) use ESC/POS commands and work similarly to Epson printers.

### Identify Toshiba Printer

```bash
# List USB devices
lsusb | grep -i toshiba

# Example outputs:
# Bus 001 Device 011: ID 0f66:4535 Toshiba Global Commerce Solutions, Inc. TCx Dual Station Printer
# Bus 001 Device 005: ID 0b49:064f TOSHIBA TEC Corporation
```

### Common Toshiba Vendor/Product IDs

| Model | Vendor | Product | Notes |
|-------|--------|---------|-------|
| **TCx Dual Station** | 0f66 | 4535 | Toshiba Global Commerce Solutions |
| TCx Single Station | 0f66 | 4530 | Toshiba Global Commerce Solutions |
| TRST-A00 | 0b49 | 064f | TOSHIBA TEC |
| TRST-A10 | 0b49 | 064f | TOSHIBA TEC |
| TRST-A15 | 0b49 | 064f | TOSHIBA TEC |
| HSP7000 | 0b49 | 0650 | TOSHIBA TEC |
| HSP7543 | 0b49 | 0650 | TOSHIBA TEC |

> **Note:** TCx series uses vendor ID `0f66`, while older TOSHIBA TEC models use `0b49`

### Find USB Device URI

```bash
lpinfo -v | grep -i usb
# Example output:
# direct usb://Toshiba%20Global%20Commerce%20Solutions,%20Inc./TCx%20Dual%20Station%20Printer%20w/%20Check%20Processing?serial=41-ALP79&interface=2
```

### Check /dev/usb/lp Device

```bash
ls -la /dev/usb/lp*
# Should show /dev/usb/lp0 or /dev/usb/lp1
```

### Add Toshiba to CUPS (RAW Mode)

```bash
# Get the USB URI first
TOSHIBA_URI=$(lpinfo -v | grep -i toshiba | head -1 | awk '{print $2}')
echo "Found: $TOSHIBA_URI"

# Add printer with RAW driver (no filtering)
sudo lpadmin -p toshiba_pos -E \
  -v "$TOSHIBA_URI" \
  -m raw

# Set as default (optional)
sudo lpadmin -d toshiba_pos

# Enable printer
sudo cupsenable toshiba_pos
sudo cupsaccept toshiba_pos
```

### Create udev Rules for Toshiba (IMPORTANT!)

For **TCx series** (vendor 0f66):
```bash
sudo tee /etc/udev/rules.d/99-toshiba-printer.rules << 'EOF'
# Toshiba Global Commerce Solutions (TCx series) - vendor 0f66
SUBSYSTEM=="usb", ATTRS{idVendor}=="0f66", MODE="0666"
SUBSYSTEM=="usbmisc", ATTRS{idVendor}=="0f66", MODE="0666"

# Toshiba TEC (older models) - vendor 0b49
SUBSYSTEM=="usb", ATTRS{idVendor}=="0b49", MODE="0666"
SUBSYSTEM=="usbmisc", ATTRS{idVendor}=="0b49", MODE="0666"
EOF

sudo udevadm control --reload-rules
sudo udevadm trigger
```

### Set Permissions on /dev/usb/lp0

```bash
# Immediate fix
sudo chmod 666 /dev/usb/lp0

# Add user to lp group for persistent access
sudo usermod -aG lp $(whoami)

# Verify
ls -la /dev/usb/lp0
```

### Disable USB Autosuspend for Toshiba

```bash
sudo tee /etc/udev/rules.d/50-usb-printer-nosuspend.rules << 'EOF'
# Toshiba Global Commerce Solutions (TCx)
ACTION=="add", SUBSYSTEM=="usb", ATTRS{idVendor}=="0f66", ATTR{power/autosuspend}="-1"
# Toshiba TEC
ACTION=="add", SUBSYSTEM=="usb", ATTRS{idVendor}=="0b49", ATTR{power/autosuspend}="-1"
EOF

sudo udevadm control --reload-rules
sudo udevadm trigger
```

### Test Toshiba Printer

#### Direct USB Test (Fastest)
```bash
# Find device
ls /dev/usb/lp*

# Direct print test (ESC/POS compatible)
echo -e "\x1B@\nTOSHIBA DIRECT TEST\n\n\n\x1DVA0" | sudo tee /dev/usb/lp0 > /dev/null
```

#### CUPS Test
```bash
echo "TOSHIBA CUPS TEST" | lp -d toshiba_pos
```

### Toshiba-Specific ESC/POS Notes

Toshiba printers are **ESC/POS compatible**, so most commands work the same as Epson:

| Function | ESC/POS Command | Notes |
|----------|-----------------|-------|
| Initialize | `\x1B@` | Same as Epson |
| Cut paper | `\x1DVA0` | Full cut |
| Partial cut | `\x1DVA1` | Leaves small tab |
| Open drawer | `\x1Bp\x00\x19\xFA` | Pin 2, same as Epson |
| Bold on | `\x1BE\x01` | Same |
| Bold off | `\x1BE\x00` | Same |
| Center align | `\x1Ba\x01` | Same |
| Left align | `\x1Ba\x00` | Same |

### Configure scale_bridge.py for Toshiba

If this terminal uses Toshiba instead of Epson, update the bridge configuration:

```python
# In scale_bridge.py, change:
PRINTER_NAME = "toshiba_pos"       # CUPS printer name
PRINTER_DEVICE = "/dev/usb/lp0"    # Direct USB device
```

Or if you have **both printers** on different terminals, make it configurable:

```python
import os

# Environment variable override
PRINTER_NAME = os.environ.get("PRINTER_NAME", "epson_pos")
PRINTER_DEVICE = os.environ.get("PRINTER_DEVICE", "/dev/usb/lp0")
```

Then in systemd service:
```ini
[Service]
Environment="PRINTER_NAME=toshiba_pos"
Environment="PRINTER_DEVICE=/dev/usb/lp0"
```

### Troubleshooting Toshiba

```bash
# Check USB connection
lsusb | grep -i toshiba
dmesg | tail -20

# If not showing, try different USB port/cable
```

#### Permission denied
```bash
# Check permissions
ls -l /dev/usb/lp0

# Fix temporarily
sudo chmod 666 /dev/usb/lp0

# Add user to lp group
sudo usermod -aG lp $(whoami)
# Then logout/login or reboot
```

#### Garbage characters printed
- Ensure using RAW driver (not a PPD)
- Send ESC/POS commands only
- Check printer DIP switches

#### Paper width
Most Toshiba receipt printers are 80mm (same as Epson TM-T88). If using 58mm paper:
```python
LINE_WIDTH = 32  # characters for 58mm
# vs
LINE_WIDTH = 42  # characters for 80mm (default)
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

Create a desktop launcher for the POS kiosk with **all stability flags**:

```bash
mkdir -p ~/Desktop

cat > ~/Desktop/odoo-pos.desktop << 'EOF'
[Desktop Entry]
Version=1.0
Type=Application
Name=Odoo POS
Comment=Launch Odoo Point of Sale
Icon=google-chrome
Exec=/usr/bin/google-chrome --kiosk --noerrdialogs --disable-infobars --no-first-run --ignore-certificate-errors --user-data-dir=/home/labodega/.config/chrome-pos --disable-features=CalculateNativeWinOcclusion,BackForwardCache,Translate,PrivateNetworkAccessSendPreflights,PrivateNetworkAccessRespectPreflightResults,TabDiscarding,IntensiveWakeUpThrottling --disable-background-timer-throttling --disable-renderer-backgrounding --disable-backgrounding-occluded-windows --disable-hang-monitor --disable-ipc-flooding-protection --disable-component-update --disable-background-networking --disable-sync --disable-extensions --disable-dev-shm-usage --no-default-browser-check --memory-pressure-off https://erp.labodegacalhoun.com/pos/web?config_id=2
Terminal=false
Categories=Application;
EOF

# Make executable
chmod +x ~/Desktop/odoo-pos.desktop

# Trust the desktop file (GNOME)
gio set ~/Desktop/odoo-pos.desktop metadata::trusted true
```

> **Note:** The `Exec=` line must be on a single line in `.desktop` files. Replace `/home/labodega` with your actual username path (e.g., `/home/youruser`).

**Why these flags prevent blank screen:**
| Flag | Purpose |
|------|---------|
| `--disable-features=TabDiscarding` | Prevents Chrome from unloading the tab to save memory |
| `--disable-features=IntensiveWakeUpThrottling` | Keeps timers active even when "backgrounded" |
| `--disable-background-timer-throttling` | JavaScript setInterval/setTimeout run normally |
| `--disable-renderer-backgrounding` | Renderer stays active |
| `--disable-backgrounding-occluded-windows` | Prevents window from being considered "hidden" |
| `--disable-hang-monitor` | No "page unresponsive" dialogs |
| `--memory-pressure-off` | No memory-saving behaviors |

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
Exec=/bin/bash -c 'sleep 5 && /usr/bin/google-chrome --kiosk --noerrdialogs --disable-infobars --no-first-run --ignore-certificate-errors --user-data-dir=$HOME/.config/chrome-pos --disable-features=CalculateNativeWinOcclusion,BackForwardCache,Translate,PrivateNetworkAccessSendPreflights,PrivateNetworkAccessRespectPreflightResults,TabDiscarding,IntensiveWakeUpThrottling --disable-background-timer-throttling --disable-renderer-backgrounding --disable-backgrounding-occluded-windows --disable-hang-monitor --disable-component-update --disable-background-networking --disable-sync --disable-extensions --disable-dev-shm-usage --memory-pressure-off https://erp.labodegacalhoun.com/pos/web?config_id=2'
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

For more control, create a dedicated launch script with **all stability flags**:

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

# Launch Chrome in kiosk mode with stability flags
exec google-chrome \
  --kiosk \
  --noerrdialogs \
  --disable-infobars \
  --no-first-run \
  --ignore-certificate-errors \
  --user-data-dir="$CHROME_PROFILE" \
  --disable-features=CalculateNativeWinOcclusion,BackForwardCache,Translate,PrivateNetworkAccessSendPreflights,PrivateNetworkAccessRespectPreflightResults,TabDiscarding,IntensiveWakeUpThrottling --disable-background-timer-throttling --disable-renderer-backgrounding --disable-backgrounding-occluded-windows --disable-hang-monitor --disable-ipc-flooding-protection --disable-component-update --disable-background-networking --disable-sync --disable-extensions --disable-dev-shm-usage --no-default-browser-check --memory-pressure-off https://erp.labodegacalhoun.com/pos/web?config_id=2
EOF

sudo chmod +x /usr/local/bin/pos-kiosk
```

---

## 9.8.1 POS Kiosk Watchdog (Prevents Blank Screen)

Create a watchdog that monitors Chrome and auto-refreshes if it goes blank:

```bash
sudo tee /usr/local/bin/pos-watchdog << 'EOF'
#!/bin/bash
# POS Kiosk Watchdog - Monitors Chrome and restarts if needed
# Runs every 60 seconds, refreshes page if Chrome memory is too high or if page is blank

CONFIG_ID=${1:-2}
MAX_MEMORY_MB=1500
CHECK_INTERVAL=60

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1"
}

refresh_page() {
    log "Refreshing POS page..."
    # Send F5 key to Chrome
    xdotool search --onlyvisible --name "Odoo" key F5 2>/dev/null || \
    xdotool search --onlyvisible --class "chrome" key F5 2>/dev/null
}

restart_kiosk() {
    log "Restarting POS kiosk..."
    pkill -f "chrome-pos" 2>/dev/null
    sleep 2
    /usr/local/bin/pos-kiosk $CONFIG_ID &
}

while true; do
    sleep $CHECK_INTERVAL
    
    # Check if Chrome is running
    if ! pgrep -f "chrome-pos" > /dev/null; then
        log "Chrome not running - starting kiosk"
        restart_kiosk
        continue
    fi
    
    # Check Chrome memory usage
    CHROME_MEM=$(ps -C chrome -o rss= 2>/dev/null | awk '{sum+=$1} END {print int(sum/1024)}')
    if [ -n "$CHROME_MEM" ] && [ "$CHROME_MEM" -gt "$MAX_MEMORY_MB" ]; then
        log "Chrome memory high (${CHROME_MEM}MB > ${MAX_MEMORY_MB}MB) - refreshing"
        refresh_page
    fi
    
    # Optional: Check if window is responding (requires xdotool)
    if command -v xdotool &> /dev/null; then
        CHROME_WIN=$(xdotool search --onlyvisible --class "chrome" 2>/dev/null | head -1)
        if [ -z "$CHROME_WIN" ]; then
            log "Chrome window not visible - restarting"
            restart_kiosk
        fi
    fi
done
EOF

sudo chmod +x /usr/local/bin/pos-watchdog

# Create systemd user service
mkdir -p ~/.config/systemd/user

cat > ~/.config/systemd/user/pos-watchdog.service << 'EOF'
[Unit]
Description=POS Kiosk Watchdog
After=graphical-session.target

[Service]
Type=simple
Environment=DISPLAY=:0
ExecStart=/usr/local/bin/pos-watchdog 2
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
EOF

# Enable and start watchdog
systemctl --user daemon-reload
systemctl --user enable --now pos-watchdog.service
```

Check watchdog status:
```bash
systemctl --user status pos-watchdog
journalctl --user -u pos-watchdog -f
```

---

## 9.8.2 Scheduled Page Refresh (Alternative)

If watchdog is overkill, just schedule periodic refreshes with cron:

```bash
# Install xdotool if not present
sudo apt install -y xdotool

# Add cron job to refresh every 2 hours
crontab -e
```

Add this line:
```
0 */2 * * * DISPLAY=:0 xdotool search --onlyvisible --class "chrome" key F5
```

---

## 9.8.3 Debugging Chrome Kiosk Mode

In kiosk mode, DevTools (F12/Inspect Element) is disabled. Here are ways to debug:

### Option 1: Remote Debugging (Recommended)

Enable remote debugging by adding the flag to your launcher:

```bash
# Modify your desktop launcher to include remote debugging
cat > ~/Desktop/odoo-pos-debug.desktop << 'EOF'
[Desktop Entry]
Version=1.0
Type=Application
Name=Odoo POS (Debug Mode)
Comment=Launch Odoo POS with Remote Debugging
Icon=google-chrome
Exec=/usr/bin/google-chrome --kiosk --remote-debugging-port=9222 --noerrdialogs --disable-infobars --no-first-run --ignore-certificate-errors --user-data-dir=/home/labodega/.config/chrome-pos-debug --disable-features=CalculateNativeWinOcclusion,BackForwardCache,Translate,PrivateNetworkAccessSendPreflights,PrivateNetworkAccessRespectPreflightResults https://erp.labodegacalhoun.com/pos/web?config_id=2
Terminal=false
Categories=Application;
EOF

chmod +x ~/Desktop/odoo-pos-debug.desktop
```

Then from **another machine on the network** (e.g., your Mac):

```bash
# Open Chrome DevTools connected to the remote instance
# Replace <UBUNTU_IP> with your Ubuntu terminal's IP
google-chrome http://<UBUNTU_IP>:9222
```

Or directly in your browser, navigate to:
```
http://<UBUNTU_IP>:9222
```

You'll see a list of inspectable pages - click to open DevTools remotely.

### Option 2: Non-Kiosk Debug Mode

Temporarily run Chrome without kiosk mode:

```bash
# Close kiosk instance first (Alt+F4 or pkill)
pkill chrome

# Run without kiosk for debugging
google-chrome \
  --ignore-certificate-errors \
  --disable-web-security \
  --disable-features=PrivateNetworkAccessSendPreflights,PrivateNetworkAccessRespectPreflightResults \
  --user-data-dir=$HOME/.config/chrome-debug \
  "https://erp.labodegacalhoun.com/pos/web?config_id=2"
```

Now you can use F12 for DevTools normally.

### Option 3: Exit Kiosk Mode Temporarily

To exit kiosk mode:
- **Alt+F4** - Close the window
- **Alt+Tab** - Switch to another window (if available)
- **Ctrl+Alt+T** - Open terminal (may not work in all setups)
- **SSH from another machine** and run `pkill chrome`

### Option 4: Debug Script

Create a debug launcher script:

```bash
sudo tee /usr/local/bin/pos-debug << 'EOF'
#!/bin/bash
# POS Debug Mode - Runs Chrome with DevTools available

CONFIG_ID=${1:-2}
ODOO_URL="https://erp.labodegacalhoun.com/pos/web?config_id=${CONFIG_ID}"

# Kill existing Chrome
pkill -f "chrome-pos" 2>/dev/null
sleep 1

echo "Starting Chrome in DEBUG mode..."
echo "  - Press F12 to open DevTools"
echo "  - Remote debug available at: http://$(hostname -I | awk '{print $1}'):9222"
echo ""

google-chrome \
  --remote-debugging-port=9222 \
  --ignore-certificate-errors \
  --disable-web-security \
  --disable-features=PrivateNetworkAccessSendPreflights,PrivateNetworkAccessRespectPreflightResults \
  --user-data-dir="$HOME/.config/chrome-pos-debug" \
  "$ODOO_URL"
EOF

sudo chmod +x /usr/local/bin/pos-debug
```

Usage:
```bash
# Run in debug mode (not kiosk)
pos-debug 2

# Then access DevTools from your Mac:
# Chrome > http://<UBUNTU_IP>:9222
```

### Option 5: View Console Logs via journalctl

Chrome logs can be captured:

```bash
# If running via systemd, check logs
journalctl --user -u odoo-pos -f

# Or launch Chrome with logging
google-chrome --enable-logging --v=1 2>&1 | tee /tmp/chrome-debug.log
```

---

## 9.8.4 CRITICAL: Fix Blank Screen Issue (Both Chrome and Chromium)

The blank screen issue is usually caused by **memory pressure**, **tab throttling**, or **GPU issues**. Apply ALL these fixes:

### Fix 1: Disable Chrome/Chromium Tab Freezing (System-wide)

```bash
# Create Chrome policy directory
sudo mkdir -p /etc/opt/chrome/policies/managed
sudo mkdir -p /etc/chromium/policies/managed

# Create policy to disable tab freezing
sudo tee /etc/opt/chrome/policies/managed/no-throttle.json << 'EOF'
{
  "TabFreezingEnabled": false,
  "IntensiveWakeUpThrottlingEnabled": false,
  "BackgroundModeEnabled": false,
  "HardwareAccelerationModeEnabled": true,
  "DefaultBrowserSettingEnabled": false,
  "MetricsReportingEnabled": false,
  "PromotionalTabsEnabled": false,
  "ShowHomeButton": false,
  "SyncDisabled": true
}
EOF

# Copy for Chromium
sudo cp /etc/opt/chrome/policies/managed/no-throttle.json /etc/chromium/policies/managed/
```

### Fix 2: Increase System Swap (For Low Memory Systems)

```bash
# Check current swap
free -h

# Create 2GB swap file if needed
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile

# Make permanent
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

### Fix 3: Reduce Memory Pressure

```bash
# Add swap aggressiveness setting
echo 'vm.swappiness=60' | sudo tee -a /etc/sysctl.conf
sudo sysctl -p
```

### Fix 4: Disable Wayland (Use X11 for Better Stability)

```bash
# Edit GDM config
sudo nano /etc/gdm3/custom.conf

# Uncomment or add:
# WaylandEnable=false
```

Then reboot:
```bash
sudo reboot
```

### Fix 5: GPU/Rendering Stability

```bash
# For systems with Intel GPU - use software rendering
sudo tee /etc/environment.d/90-chrome.conf << 'EOF'
LIBGL_ALWAYS_SOFTWARE=1
EOF

# Or set per-session
export LIBGL_ALWAYS_SOFTWARE=1
```

### Fix 6: Comprehensive Kiosk Startup Script (RECOMMENDED)

Create a robust startup script that handles all edge cases:

```bash
sudo tee /usr/local/bin/pos-kiosk-robust << 'EOF'
#!/bin/bash
# Robust POS Kiosk with auto-recovery
# Usage: pos-kiosk-robust [config_id] [chrome|chromium]

CONFIG_ID=${1:-2}
BROWSER=${2:-chrome}
ODOO_URL="https://erp.labodegacalhoun.com/pos/web?config_id=${CONFIG_ID}"
PROFILE_DIR="$HOME/.config/${BROWSER}-pos-${CONFIG_ID}"
LOG_FILE="/tmp/pos-kiosk.log"
MAX_RESTART=5
RESTART_COUNT=0

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" | tee -a "$LOG_FILE"
}

# Disable screen blanking
xset s off 2>/dev/null || true
xset -dpms 2>/dev/null || true
xset s noblank 2>/dev/null || true

# Set memory limits for Chrome
ulimit -v unlimited 2>/dev/null || true

# Kill any existing browser instances for this config
pkill -f "${BROWSER}-pos-${CONFIG_ID}" 2>/dev/null
pkill -f "${BROWSER}.*config_id=${CONFIG_ID}" 2>/dev/null
sleep 2

# Common flags for both browsers
COMMON_FLAGS="
  --kiosk
  --noerrdialogs
  --disable-infobars
  --no-first-run
  --ignore-certificate-errors
  --user-data-dir=$PROFILE_DIR
  --disable-features=CalculateNativeWinOcclusion,BackForwardCache,Translate,PrivateNetworkAccessSendPreflights,PrivateNetworkAccessRespectPreflightResults,TabDiscarding,IntensiveWakeUpThrottling --disable-background-timer-throttling --disable-renderer-backgrounding --disable-backgrounding-occluded-windows --disable-hang-monitor --disable-ipc-flooding-protection --disable-component-update --disable-background-networking --disable-sync --disable-extensions --disable-dev-shm-usage --memory-pressure-off --password-store=basic
"

# Browser-specific command
if [ "$BROWSER" = "chromium" ]; then
    BROWSER_CMD="chromium-browser"
    EXTRA_FLAGS="--no-sandbox --disable-gpu-sandbox"
else
    BROWSER_CMD="google-chrome"
    EXTRA_FLAGS=""
fi

log "Starting POS kiosk: browser=$BROWSER config=$CONFIG_ID"
log "URL: $ODOO_URL"

# Launch browser with monitoring
while true; do
    log "Launching $BROWSER_CMD (attempt $((RESTART_COUNT + 1)))"
    
    # Start browser
    $BROWSER_CMD $COMMON_FLAGS $EXTRA_FLAGS "$ODOO_URL" &
    BROWSER_PID=$!
    
    # Monitor browser process
    while kill -0 $BROWSER_PID 2>/dev/null; do
        sleep 30
        
        # Check if browser window is visible (requires xdotool)
        if command -v xdotool &> /dev/null; then
            WIN_ID=$(xdotool search --onlyvisible --pid $BROWSER_PID 2>/dev/null | head -1)
            if [ -z "$WIN_ID" ]; then
                log "WARNING: Browser window not visible - possible blank screen"
                # Send F5 to refresh
                xdotool search --pid $BROWSER_PID key F5 2>/dev/null || true
            fi
        fi
        
        # Check memory usage
        MEM_KB=$(ps -p $BROWSER_PID -o rss= 2>/dev/null | tr -d ' ')
        if [ -n "$MEM_KB" ] && [ "$MEM_KB" -gt 2000000 ]; then
            log "WARNING: High memory usage (${MEM_KB}KB) - refreshing page"
            xdotool search --pid $BROWSER_PID key F5 2>/dev/null || true
        fi
    done
    
    log "Browser process ended"
    RESTART_COUNT=$((RESTART_COUNT + 1))
    
    if [ $RESTART_COUNT -ge $MAX_RESTART ]; then
        log "ERROR: Max restart count reached ($MAX_RESTART)"
        # Reset counter after cooldown
        sleep 300
        RESTART_COUNT=0
    fi
    
    sleep 5
done
EOF

sudo chmod +x /usr/local/bin/pos-kiosk-robust
```

---

## 9.8.3 Debugging Chrome Kiosk Mode

In kiosk mode, DevTools (F12/Inspect Element) is disabled. Here are ways to debug:

### Option 1: Remote Debugging (Recommended)

Enable remote debugging by adding the flag to your launcher:

```bash
# Modify your desktop launcher to include remote debugging
cat > ~/Desktop/odoo-pos-debug.desktop << 'EOF'
[Desktop Entry]
Version=1.0
Type=Application
Name=Odoo POS (Debug Mode)
Comment=Launch Odoo POS with Remote Debugging
Icon=google-chrome
Exec=/usr/bin/google-chrome --kiosk --remote-debugging-port=9222 --noerrdialogs --disable-infobars --no-first-run --ignore-certificate-errors --user-data-dir=/home/labodega/.config/chrome-pos-debug --disable-features=CalculateNativeWinOcclusion,BackForwardCache,Translate,PrivateNetworkAccessSendPreflights,PrivateNetworkAccessRespectPreflightResults https://erp.labodegacalhoun.com/pos/web?config_id=2
Terminal=false
Categories=Application;
EOF

chmod +x ~/Desktop/odoo-pos-debug.desktop
```

Then from **another machine on the network** (e.g., your Mac):

```bash
# Open Chrome DevTools connected to the remote instance
# Replace <UBUNTU_IP> with your Ubuntu terminal's IP
google-chrome http://<UBUNTU_IP>:9222
```

Or directly in your browser, navigate to:
```
http://<UBUNTU_IP>:9222
```

You'll see a list of inspectable pages - click to open DevTools remotely.

### Option 2: Non-Kiosk Debug Mode

Temporarily run Chrome without kiosk mode:

```bash
# Close kiosk instance first (Alt+F4 or pkill)
pkill chrome

# Run without kiosk for debugging
google-chrome \
  --ignore-certificate-errors \
  --disable-web-security \
  --disable-features=PrivateNetworkAccessSendPreflights,PrivateNetworkAccessRespectPreflightResults \
  --user-data-dir=$HOME/.config/chrome-debug \
  "https://erp.labodegacalhoun.com/pos/web?config_id=2"
```

Now you can use F12 for DevTools normally.

### Option 3: Exit Kiosk Mode Temporarily

To exit kiosk mode:
- **Alt+F4** - Close the window
- **Alt+Tab** - Switch to another window (if available)
- **Ctrl+Alt+T** - Open terminal (may not work in all setups)
- **SSH from another machine** and run `pkill chrome`

### Option 4: Debug Script

Create a debug launcher script:

```bash
sudo tee /usr/local/bin/pos-debug << 'EOF'
#!/bin/bash
# POS Debug Mode - Runs Chrome with DevTools available

CONFIG_ID=${1:-2}
ODOO_URL="https://erp.labodegacalhoun.com/pos/web?config_id=${CONFIG_ID}"

# Kill existing Chrome
pkill -f "chrome-pos" 2>/dev/null
sleep 1

echo "Starting Chrome in DEBUG mode..."
echo "  - Press F12 to open DevTools"
echo "  - Remote debug available at: http://$(hostname -I | awk '{print $1}'):9222"
echo ""

google-chrome \
  --remote-debugging-port=9222 \
  --ignore-certificate-errors \
  --disable-web-security \
  --disable-features=PrivateNetworkAccessSendPreflights,PrivateNetworkAccessRespectPreflightResults \
  --user-data-dir="$HOME/.config/chrome-pos-debug" \
  "$ODOO_URL"
EOF

sudo chmod +x /usr/local/bin/pos-debug
```

Usage:
```bash
# Run in debug mode (not kiosk)
pos-debug 2

# Then access DevTools from your Mac:
# Chrome > http://<UBUNTU_IP>:9222
```

### Option 5: View Console Logs via journalctl

Chrome logs can be captured:

```bash
# If running via systemd, check logs
journalctl --user -u odoo-pos -f

# Or launch Chrome with logging
google-chrome --enable-logging --v=1 2>&1 | tee /tmp/chrome-debug.log
```

---

## 9.8.4 CRITICAL: Fix Blank Screen Issue (Both Chrome and Chromium)

The blank screen issue is usually caused by **memory pressure**, **tab throttling**, or **GPU issues**. Apply ALL these fixes:

### Fix 1: Disable Chrome/Chromium Tab Freezing (System-wide)

```bash
# Create Chrome policy directory
sudo mkdir -p /etc/opt/chrome/policies/managed
sudo mkdir -p /etc/chromium/policies/managed

# Create policy to disable tab freezing
sudo tee /etc/opt/chrome/policies/managed/no-throttle.json << 'EOF'
{
  "TabFreezingEnabled": false,
  "IntensiveWakeUpThrottlingEnabled": false,
  "BackgroundModeEnabled": false,
  "HardwareAccelerationModeEnabled": true,
  "DefaultBrowserSettingEnabled": false,
  "MetricsReportingEnabled": false,
  "PromotionalTabsEnabled": false,
  "ShowHomeButton": false,
  "SyncDisabled": true
}
EOF

# Copy for Chromium
sudo cp /etc/opt/chrome/policies/managed/no-throttle.json /etc/chromium/policies/managed/
```

### Fix 2: Increase System Swap (For Low Memory Systems)

```bash
# Check current swap
free -h

# Create 2GB swap file if needed
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile

# Make permanent
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

### Fix 3: Reduce Memory Pressure

```bash
# Add swap aggressiveness setting
echo 'vm.swappiness=60' | sudo tee -a /etc/sysctl.conf
sudo sysctl -p
```

### Fix 4: Disable Wayland (Use X11 for Better Stability)

```bash
# Edit GDM config
sudo nano /etc/gdm3/custom.conf

# Uncomment or add:
# WaylandEnable=false
```

Then reboot:
```bash
sudo reboot
```

### Fix 5: GPU/Rendering Stability

```bash
# For systems with Intel GPU - use software rendering
sudo tee /etc/environment.d/90-chrome.conf << 'EOF'
LIBGL_ALWAYS_SOFTWARE=1
EOF

# Or set per-session
export LIBGL_ALWAYS_SOFTWARE=1
```

### Fix 6: Comprehensive Kiosk Startup Script (RECOMMENDED)

Create a robust startup script that handles all edge cases:

```bash
sudo tee /usr/local/bin/pos-kiosk-robust << 'EOF'
#!/bin/bash
# Robust POS Kiosk with auto-recovery
# Usage: pos-kiosk-robust [config_id] [chrome|chromium]

CONFIG_ID=${1:-2}
BROWSER=${2:-chrome}
ODOO_URL="https://erp.labodegacalhoun.com/pos/web?config_id=${CONFIG_ID}"
PROFILE_DIR="$HOME/.config/${BROWSER}-pos-${CONFIG_ID}"
LOG_FILE="/tmp/pos-kiosk.log"
MAX_RESTART=5
RESTART_COUNT=0

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" | tee -a "$LOG_FILE"
}

# Disable screen blanking
xset s off 2>/dev/null || true
xset -dpms 2>/dev/null || true
xset s noblank 2>/dev/null || true

# Set memory limits for Chrome
ulimit -v unlimited 2>/dev/null || true

# Kill any existing browser instances for this config
pkill -f "${BROWSER}-pos-${CONFIG_ID}" 2>/dev/null
pkill -f "${BROWSER}.*config_id=${CONFIG_ID}" 2>/dev/null
sleep 2

# Common flags for both browsers
COMMON_FLAGS="
  --kiosk
  --noerrdialogs
  --disable-infobars
  --no-first-run
  --ignore-certificate-errors
  --user-data-dir=$PROFILE_DIR
  --disable-features=CalculateNativeWinOcclusion,BackForwardCache,Translate,PrivateNetworkAccessSendPreflights,PrivateNetworkAccessRespectPreflightResults,TabDiscarding,IntensiveWakeUpThrottling --disable-background-timer-throttling --disable-renderer-backgrounding --disable-backgrounding-occluded-windows --disable-hang-monitor --disable-ipc-flooding-protection --disable-component-update --disable-background-networking --disable-sync --disable-extensions --disable-dev-shm-usage --memory-pressure-off --password-store=basic
"

# Browser-specific command
if [ "$BROWSER" = "chromium" ]; then
    BROWSER_CMD="chromium-browser"
    EXTRA_FLAGS="--no-sandbox --disable-gpu-sandbox"
else
    BROWSER_CMD="google-chrome"
    EXTRA_FLAGS=""
fi

log "Starting POS kiosk: browser=$BROWSER config=$CONFIG_ID"
log "URL: $ODOO_URL"

# Launch browser with monitoring
while true; do
    log "Launching $BROWSER_CMD (attempt $((RESTART_COUNT + 1)))"
    
    # Start browser
    $BROWSER_CMD $COMMON_FLAGS $EXTRA_FLAGS "$ODOO_URL" &
    BROWSER_PID=$!
    
    # Monitor browser process
    while kill -0 $BROWSER_PID 2>/dev/null; do
        sleep 30
        
        # Check if browser window is visible (requires xdotool)
        if command -v xdotool &> /dev/null; then
            WIN_ID=$(xdotool search --onlyvisible --pid $BROWSER_PID 2>/dev/null | head -1)
            if [ -z "$WIN_ID" ]; then
                log "WARNING: Browser window not visible - possible blank screen"
                # Send F5 to refresh
                xdotool search --pid $BROWSER_PID key F5 2>/dev/null || true
            fi
        fi
        
        # Check memory usage
        MEM_KB=$(ps -p $BROWSER_PID -o rss= 2>/dev/null | tr -d ' ')
        if [ -n "$MEM_KB" ] && [ "$MEM_KB" -gt 2000000 ]; then
            log "WARNING: High memory usage (${MEM_KB}KB) - refreshing page"
            xdotool search --pid $BROWSER_PID key F5 2>/dev/null || true
        fi
    done
    
    log "Browser process ended"
    RESTART_COUNT=$((RESTART_COUNT + 1))
    
    if [ $RESTART_COUNT -ge $MAX_RESTART ]; then
        log "ERROR: Max restart count reached ($MAX_RESTART)"
        # Reset counter after cooldown
        sleep 300
        RESTART_COUNT=0
    fi
    
    sleep 5
done
EOF

sudo chmod +x /usr/local/bin/pos-kiosk-robust
```

---

## 9.8.3 Debugging Chrome Kiosk Mode

In kiosk mode, DevTools (F12/Inspect Element) is disabled. Here are ways to debug:

### Option 1: Remote Debugging (Recommended)

Enable remote debugging by adding the flag to your launcher:

```bash
# Modify your desktop launcher to include remote debugging
cat > ~/Desktop/odoo-pos-debug.desktop << 'EOF'
[Desktop Entry]
Version=1.0
Type=Application
Name=Odoo POS (Debug Mode)
Comment=Launch Odoo POS with Remote Debugging
Icon=google-chrome
Exec=/usr/bin/google-chrome --kiosk --remote-debugging-port=9222 --noerrdialogs --disable-infobars --no-first-run --ignore-certificate-errors --user-data-dir=/home/labodega/.config/chrome-pos-debug --disable-features=CalculateNativeWinOcclusion,BackForwardCache,Translate,PrivateNetworkAccessSendPreflights,PrivateNetworkAccessRespectPreflightResults https://erp.labodegacalhoun.com/pos/web?config_id=2
Terminal=false
Categories=Application;
EOF

chmod +x ~/Desktop/odoo-pos-debug.desktop
```

Then from **another machine on the network** (e.g., your Mac):

```bash
# Open Chrome DevTools connected to the remote instance
# Replace <UBUNTU_IP> with your Ubuntu terminal's IP
google-chrome http://<UBUNTU_IP>:9222
```

Or directly in your browser, navigate to:
```
http://<UBUNTU_IP>:9222
```

You'll see a list of inspectable pages - click to open DevTools remotely.

### Option 2: Non-Kiosk Debug Mode

Temporarily run Chrome without kiosk mode:

```bash
# Close kiosk instance first (Alt+F4 or pkill)
pkill chrome

# Run without kiosk for debugging
google-chrome \
  --ignore-certificate-errors \
  --disable-web-security \
  --disable-features=PrivateNetworkAccessSendPreflights,PrivateNetworkAccessRespectPreflightResults \
  --user-data-dir=$HOME/.config/chrome-debug \
  "https://erp.labodegacalhoun.com/pos/web?config_id=2"
```

Now you can use F12 for DevTools normally.

### Option 3: Exit Kiosk Mode Temporarily

To exit kiosk mode:
- **Alt+F4** - Close the window
- **Alt+Tab** - Switch to another window (if available)
- **Ctrl+Alt+T** - Open terminal (may not work in all setups)
- **SSH from another machine** and run `pkill chrome`

### Option 4: Debug Script

Create a debug launcher script:

```bash
sudo tee /usr/local/bin/pos-debug << 'EOF'
#!/bin/bash
# POS Debug Mode - Runs Chrome with DevTools available

CONFIG_ID=${1:-2}
ODOO_URL="https://erp.labodegacalhoun.com/pos/web?config_id=${CONFIG_ID}"

# Kill existing Chrome
pkill -f "chrome-pos" 2>/dev/null
sleep 1

echo "Starting Chrome in DEBUG mode..."
echo "  - Press F12 to open DevTools"
echo "  - Remote debug available at: http://$(hostname -I | awk '{print $1}'):9222"
echo ""

google-chrome \
  --remote-debugging-port=9222 \
  --ignore-certificate-errors \
  --disable-web-security \
  --disable-features=PrivateNetworkAccessSendPreflights,PrivateNetworkAccessRespectPreflightResults \
  --user-data-dir="$HOME/.config/chrome-pos-debug" \
  "$ODOO_URL"
EOF

sudo chmod +x /usr/local/bin/pos-debug
```

Usage:
```bash
# Run in debug mode (not kiosk)
pos-debug 2

# Then access DevTools from your Mac:
# Chrome > http://<UBUNTU_IP>:9222
```

### Option 5: View Console Logs via journalctl

Chrome logs can be captured:

```bash
# If running via systemd, check logs
journalctl --user -u odoo-pos -f

# Or launch Chrome with logging
google-chrome --enable-logging --v=1 2>&1 | tee /tmp/chrome-debug.log
```

---

## 9.8.4 CRITICAL: Fix Blank Screen Issue (Both Chrome and Chromium)

The blank screen issue is usually caused by **memory pressure**, **tab throttling**, or **GPU issues**. Apply ALL these fixes:

### Fix 1: Disable Chrome/Chromium Tab Freezing (System-wide)

```bash
# Create Chrome policy directory
sudo mkdir -p /etc/opt/chrome/policies/managed
sudo mkdir -p /etc/chromium/policies/managed

# Create policy to disable tab freezing
sudo tee /etc/opt/chrome/policies/managed/no-throttle.json << 'EOF'
{
  "TabFreezingEnabled": false,
  "IntensiveWakeUpThrottlingEnabled": false,
  "BackgroundModeEnabled": false,
  "HardwareAccelerationModeEnabled": true,
  "DefaultBrowserSettingEnabled": false,
  "MetricsReportingEnabled": false,
  "PromotionalTabsEnabled": false,
  "ShowHomeButton": false,
  "SyncDisabled": true
}
EOF

# Copy for Chromium
sudo cp /etc/opt/chrome/policies/managed/no-throttle.json /etc/chromium/policies/managed/
```

### Fix 2: Increase System Swap (For Low Memory Systems)

```bash
# Check current swap
free -h

# Create 2GB swap file if needed
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile

# Make permanent
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

### Fix 3: Reduce Memory Pressure

```bash
# Add swap aggressiveness setting
echo 'vm.swappiness=60' | sudo tee -a /etc/sysctl.conf
sudo sysctl -p
```

### Fix 4: Disable Wayland (Use X11 for Better Stability)

```bash
# Edit GDM config
sudo nano /etc/gdm3/custom.conf

# Uncomment or add:
# WaylandEnable=false
```

Then reboot:
```bash
sudo reboot
```

### Fix 5: GPU/Rendering Stability

```bash
# For systems with Intel GPU - use software rendering
sudo tee /etc/environment.d/90-chrome.conf << 'EOF'
LIBGL_ALWAYS_SOFTWARE=1
EOF

# Or set per-session
export LIBGL_ALWAYS_SOFTWARE=1
```

### Fix 6: Comprehensive Kiosk Startup Script (RECOMMENDED)

Create a robust startup script that handles all edge cases:

```bash
sudo tee /usr/local/bin/pos-kiosk-robust << 'EOF'
#!/bin/bash
# Robust POS Kiosk with auto-recovery
# Usage: pos-kiosk-robust [config_id] [chrome|chromium]

CONFIG_ID=${1:-2}
BROWSER=${2:-chrome}
ODOO_URL="https://erp.labodegacalhoun.com/pos/web?config_id=${CONFIG_ID}"
PROFILE_DIR="$HOME/.config/${BROWSER}-pos-${CONFIG_ID}"
LOG_FILE="/tmp/pos-kiosk.log"
MAX_RESTART=5
RESTART_COUNT=0

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" | tee -a "$LOG_FILE"
}

# Disable screen blanking
xset s off 2>/dev/null || true
xset -dpms 2>/dev/null || true
xset s noblank 2>/dev/null || true

# Set memory limits for Chrome
ulimit -v unlimited 2>/dev/null || true

# Kill any existing browser instances for this config
pkill -f "${BROWSER}-pos-${CONFIG_ID}" 2>/dev/null
pkill -f "${BROWSER}.*config_id=${CONFIG_ID}" 2>/dev/null
sleep 2

# Common flags for both browsers
COMMON_FLAGS="
  --kiosk
  --noerrdialogs
  --disable-infobars
  --no-first-run
  --ignore-certificate-errors
  --user-data-dir=$PROFILE_DIR
  --disable-features=CalculateNativeWinOcclusion,BackForwardCache,Translate,PrivateNetworkAccessSendPreflights,PrivateNetworkAccessRespectPreflightResults,TabDiscarding,IntensiveWakeUpThrottling --disable-background-timer-throttling --disable-renderer-backgrounding --disable-backgrounding-occluded-windows --disable-hang-monitor --disable-ipc-flooding-protection --disable-component-update --disable-background-networking --disable-sync --disable-extensions --disable-dev-shm-usage --memory-pressure-off --password-store=basic
"

# Browser-specific command
if [ "$BROWSER" = "chromium" ]; then
    BROWSER_CMD="chromium-browser"
    EXTRA_FLAGS="--no-sandbox --disable-gpu-sandbox"
else
    BROWSER_CMD="google-chrome"
    EXTRA_FLAGS=""
fi

log "Starting POS kiosk: browser=$BROWSER config=$CONFIG_ID"
log "URL: $ODOO_URL"

# Launch browser with monitoring
while true; do
    log "Launching $BROWSER_CMD (attempt $((RESTART_COUNT + 1)))"
    
    # Start browser
    $BROWSER_CMD $COMMON_FLAGS $EXTRA_FLAGS "$ODOO_URL" &
    BROWSER_PID=$!
    
    # Monitor browser process
    while kill -0 $BROWSER_PID 2>/dev/null; do
        sleep 30
        
        # Check if browser window is visible (requires xdotool)
        if command -v xdotool &> /dev/null; then
            WIN_ID=$(xdotool search --onlyvisible --pid $BROWSER_PID 2>/dev/null | head -1)
            if [ -z "$WIN_ID" ]; then
                log "WARNING: Browser window not visible - possible blank screen"
                # Send F5 to refresh
                xdotool search --pid $BROWSER_PID key F5 2>/dev/null || true
            fi
        fi
        
        # Check memory usage
        MEM_KB=$(ps -p $BROWSER_PID -o rss= 2>/dev/null | tr -d ' ')
        if [ -n "$MEM_KB" ] && [ "$MEM_KB" -gt 2000000 ]; then
            log "WARNING: High memory usage (${MEM_KB}KB) - refreshing page"
            xdotool search --pid $BROWSER_PID key F5 2>/dev/null || true
        fi
    done
    
    log "Browser process ended"
    RESTART_COUNT=$((RESTART_COUNT + 1))
    
    if [ $RESTART_COUNT -ge $MAX_RESTART ]; then
        log "ERROR: Max restart count reached ($MAX_RESTART)"
        # Reset counter after cooldown
        sleep 300
        RESTART_COUNT=0
    fi
    
    sleep 5
done
EOF

sudo chmod +x /usr/local/bin/pos-kiosk-robust
```

---

## 9.14 Dual Monitor Touchscreen Calibration

When using dual monitors with a touchscreen, the touch input may be mapped to the wrong screen. This section explains how to properly map the touchscreen to the correct display.

### Identify Your Displays and Input Devices

```bash
# List all displays
xrandr --query

# Example output:
# HDMI-1 connected 1920x1080+0+0
# DP-1 connected 1024x768+1920+0

# List all input devices
xinput list

# Example output:
# ⎡ Virtual core pointer                    id=2
# ⎜   ↳ eGalax Inc. USB TouchController     id=11
# ⎜   ↳ Logitech USB Mouse                  id=10
```

### Map Touchscreen to Correct Display

```bash
# Get the touchscreen device name/ID
xinput list | grep -i touch

# Get the display name from xrandr
xrandr --query | grep " connected"

# Map touchscreen to specific display
# Replace "eGalax Inc. USB TouchController" with your touch device name
# Replace "HDMI-1" with your primary POS display
xinput map-to-output "eGalax Inc. USB TouchController" HDMI-1

# Or use device ID instead of name
xinput map-to-output 11 HDMI-1
```

### Alternative: Coordinate Transformation Matrix

If `map-to-output` doesn't work, use coordinate transformation:

```bash
# For left monitor (if touchscreen is on left in a side-by-side setup)
# Assuming left monitor is 1920x1080 and total width is 2944 (1920+1024)
xinput set-prop "eGalax Inc. USB TouchController" --type=float \
  "Coordinate Transformation Matrix" \
  0.652174 0 0 \
  0 1 0 \
  0 0 1

# For a single-monitor mapping (full screen)
xinput set-prop "eGalax Inc. USB TouchController" --type=float \
  "Coordinate Transformation Matrix" \
  1 0 0 \
  0 1 0 \
  0 0 1
```

### Make Touchscreen Mapping Persistent

Create a startup script:

```bash
# Create the calibration script
sudo tee /usr/local/bin/touchscreen-calibrate << 'EOF'
#!/bin/bash
# Wait for X to be ready
sleep 3

# Get touchscreen device (adjust grep pattern for your device)
TOUCH_DEVICE=$(xinput list --name-only | grep -i "touch" | head -1)

# Get primary display (adjust for your setup)
PRIMARY_DISPLAY=$(xrandr --query | grep " connected primary" | cut -d' ' -f1)

# If no primary set, use first connected display
if [ -z "$PRIMARY_DISPLAY" ]; then
    PRIMARY_DISPLAY=$(xrandr --query | grep " connected" | head -1 | cut -d' ' -f1)
fi

# Map touchscreen to display
if [ -n "$TOUCH_DEVICE" ] && [ -n "$PRIMARY_DISPLAY" ]; then
    xinput map-to-output "$TOUCH_DEVICE" "$PRIMARY_DISPLAY"
    echo "Mapped '$TOUCH_DEVICE' to '$PRIMARY_DISPLAY'"
else
    echo "Could not find touchscreen or display"
fi
EOF

sudo chmod +x /usr/local/bin/touchscreen-calibrate
```

### Add to Autostart

```bash
# Create autostart entry
mkdir -p ~/.config/autostart

cat > ~/.config/autostart/touchscreen-calibrate.desktop << 'EOF'
[Desktop Entry]
Type=Application
Name=Touchscreen Calibration
Exec=/usr/local/bin/touchscreen-calibrate
Hidden=false
NoDisplay=true
X-GNOME-Autostart-enabled=true
X-GNOME-Autostart-Delay=5
EOF
```

### Run Calibration Now

```bash
# Run immediately
/usr/local/bin/touchscreen-calibrate

# Or manually
xinput map-to-output "$(xinput list --name-only | grep -i touch | head -1)" "$(xrandr | grep ' connected' | head -1 | cut -d' ' -f1)"
```

### Troubleshooting Touchscreen

```bash
# Check if touchscreen is detected
xinput list | grep -i touch

# Test touch events
sudo apt install evtest
sudo evtest /dev/input/event*  # Select touch device

# Check current mapping
xinput list-props "eGalax Inc. USB TouchController" | grep -i "coordinate"

# If touch is inverted (X/Y swapped)
xinput set-prop "eGalax Inc. USB TouchController" "Evdev Axis Inversion" 0 0
xinput set-prop "eGalax Inc. USB TouchController" "Evdev Axes Swap" 0

# For libinput devices
xinput set-prop "eGalax Inc. USB TouchController" "libinput Calibration Matrix" 1 0 0 0 1 0 0 0 1
```

### Quick One-Liner for Dual Monitor Setup

```bash
# Add to your .bashrc or run manually
xinput map-to-output "$(xinput list --name-only | grep -i touch | head -1)" "$(xrandr | grep ' connected' | head -1 | cut -d' ' -f1)"
```

### Set Primary Display

If the touchscreen should always be on the "primary" display:

```bash
# Set HDMI-1 as primary (adjust for your display)
xrandr --output HDMI-1 --primary

# Or for DisplayPort
xrandr --output DP-1 --primary
```

---

