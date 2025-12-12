# Magellan Scale Scanner Bridge - Raspberry Pi Setup

This directory contains the bridge software that runs on your Raspberry Pi to connect the Magellan scanner/scale to Odoo POS.

## Quick Start

1. **Copy files to Raspberry Pi:**
   ```bash
   scp -r raspberry_pi/ pi@your-pi-ip:~/scale-bridge/
   ```

2. **SSH into Raspberry Pi:**
   ```bash
   ssh pi@your-pi-ip
   cd ~/scale-bridge
   ```

3. **Run installer:**
   ```bash
   chmod +x install.sh
   bash install.sh
   ```

4. **Configure (if needed):**
   ```bash
   nano scale_bridge.py
   ```
   
   Adjust these settings:
   - `SERIAL_PORT` - Usually `/dev/ttyUSB0`
   - `WEIGHT_DIVISOR` - Use `100` or `1000` depending on scale output

5. **Test manually first:**
   ```bash
   python3 scale_bridge.py
   ```
   
   In another terminal, test:
   ```bash
   curl http://localhost:8000/
   curl http://localhost:8000/barcode
   curl http://localhost:8000/weight
   ```

6. **Enable as service (once working):**
   ```bash
   sudo systemctl enable scale-bridge
   sudo systemctl start scale-bridge
   ```

## Files

- **scale_bridge.py** - Main bridge application
- **install.sh** - Automated installation script
- **README.md** - This file

## Configuration

### Finding Your Serial Port

```bash
# List USB serial devices
ls -la /dev/ttyUSB*

# Or check all serial devices
ls -la /dev/tty*

# Check what's connected
dmesg | grep tty
```

Common ports:
- `/dev/ttyUSB0` - USB serial adapter
- `/dev/ttyACM0` - Some USB devices
- `/dev/serial0` - Raspberry Pi GPIO serial

### Testing Serial Communication

```bash
# Install screen
sudo apt-get install screen

# Connect to serial port (Ctrl+A then K to exit)
screen /dev/ttyUSB0 9600
```

### Adjusting Weight Divisor

The scale sends weight as an integer. The divisor converts it to decimal:

- Raw value: `0045` → With divisor `100` → `0.45` kg
- Raw value: `0450` → With divisor `100` → `4.50` kg (wrong!)
- Raw value: `0450` → With divisor `1000` → `0.45` kg (correct!)

If weights are 10x too high/low, change `WEIGHT_DIVISOR`.

## Service Management

```bash
# Start service
sudo systemctl start scale-bridge

# Stop service
sudo systemctl stop scale-bridge

# Restart service
sudo systemctl restart scale-bridge

# Check status
sudo systemctl status scale-bridge

# View logs (live)
sudo journalctl -u scale-bridge -f

# View recent logs
sudo journalctl -u scale-bridge -n 100

# Disable auto-start
sudo systemctl disable scale-bridge
```

## Troubleshooting

### Permission Denied on Serial Port

```bash
# Add your user to dialout group
sudo usermod -a -G dialout $USER

# Logout and login, or reboot
sudo reboot
```

### Service Won't Start

```bash
# Check service status
sudo systemctl status scale-bridge

# Check logs
sudo journalctl -u scale-bridge -n 50

# Test manually
python3 scale_bridge.py
```

### No Barcodes Detected

1. Check serial port is correct
2. Check baudrate matches scanner (usually 9600)
3. Test with `screen /dev/ttyUSB0 9600` - scan a barcode, you should see output
4. Check scanner is in serial mode (not USB HID)

### Weight Returns Null

1. Test manually: `curl http://localhost:8000/weight`
2. Check logs for error messages
3. Verify scale is powered on
4. Try sending weight command manually with `screen`

### Network Access from Odoo

From your Odoo/POS machine:

```bash
# Find Raspberry Pi IP
# On the Pi:
hostname -I

# Test from POS machine:
curl http://PI_IP_ADDRESS:8000/
curl http://PI_IP_ADDRESS:8000/barcode
```

If this doesn't work:
- Check firewall on Pi: `sudo ufw status`
- Ensure both devices are on same network
- Check router/network restrictions

## Updating the Bridge

```bash
# Stop service
sudo systemctl stop scale-bridge

# Edit script
nano scale_bridge.py

# Test changes
python3 scale_bridge.py

# If working, restart service
sudo systemctl start scale-bridge
```

## Performance Tuning

### Barcode Polling Speed

In Odoo's `magellan_scale_service.js`, adjust:
```javascript
await new Promise((resolve) => setTimeout(resolve, 200));  // 200ms = 5 polls/sec
```

Faster = more responsive, but more CPU/network usage.

### Serial Timeout

In `scale_bridge.py`, adjust:
```python
timeout=0.35,  # Seconds to wait for serial data
```

## Security Notes

⚠️ **For Production:**

1. **Enable firewall** and only allow Odoo machine:
   ```bash
   sudo ufw allow from ODOO_IP to any port 8000
   sudo ufw enable
   ```

2. **Restrict CORS** in `scale_bridge.py`:
   ```python
   allow_origins=["http://your-odoo-domain.com"],
   ```

3. **Use HTTPS** (requires certificates and reverse proxy like nginx)

## Monitoring

### CPU/Memory Usage

```bash
# Check running process
ps aux | grep scale_bridge

# Monitor in real-time
top
# Press 'Shift+M' to sort by memory
```

### Network Traffic

```bash
# Install iftop
sudo apt-get install iftop

# Monitor network
sudo iftop -i eth0
```

## Support

If you encounter issues:

1. Check the main README in parent directory
2. Review logs: `sudo journalctl -u scale-bridge -f`
3. Test each component separately:
   - Serial port with `screen`
   - Bridge API with `curl`
   - Network connectivity from POS machine

## Hardware Requirements

- Raspberry Pi 3/4 or similar
- USB to Serial adapter (if not built-in)
- Magellan scanner with scale
- Network connection (WiFi or Ethernet)

## Software Requirements

- Python 3.7+
- FastAPI
- Uvicorn
- PySerial

All installed by `install.sh`.

