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
