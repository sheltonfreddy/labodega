#!/bin/bash
# Quick setup script for Magellan Scale Scanner Bridge

echo "================================================"
echo "Magellan Scale Scanner Bridge - Quick Setup"
echo "================================================"
echo ""

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Check if running on Raspberry Pi
if [ -f /proc/device-tree/model ]; then
    MODEL=$(cat /proc/device-tree/model)
    echo -e "${GREEN}Detected: $MODEL${NC}"
else
    echo -e "${YELLOW}Warning: Not running on Raspberry Pi?${NC}"
fi

echo ""
echo "Step 1: Installing system dependencies..."
sudo apt-get update
sudo apt-get install -y python3-pip python3-serial

echo ""
echo "Step 2: Installing Python packages..."
pip3 install fastapi uvicorn pyserial requests

echo ""
echo "Step 3: Adding user to dialout group..."
sudo usermod -a -G dialout $USER

echo ""
echo "Step 4: Detecting serial ports..."
echo -e "${YELLOW}Available serial ports:${NC}"
ls -la /dev/tty* | grep -E "ttyUSB|ttyACM|ttyS" || echo "No serial devices found"

echo ""
echo "Step 5: Checking if scale_bridge.py exists..."
if [ -f "scale_bridge.py" ]; then
    echo -e "${GREEN}✓ scale_bridge.py found${NC}"
else
    echo -e "${RED}✗ scale_bridge.py not found in current directory${NC}"
    echo "Please copy scale_bridge.py to this directory first."
    exit 1
fi

echo ""
echo "Step 6: Creating systemd service..."
sudo bash -c 'cat > /etc/systemd/system/magellan-bridge.service << EOL
[Unit]
Description=Magellan Scale Scanner Bridge
After=network.target

[Service]
Type=simple
User='$USER'
WorkingDirectory='$(pwd)'
ExecStart=/usr/bin/python3 '$(pwd)'/scale_bridge.py
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
EOL'

echo ""
echo "Step 7: Enabling and starting service..."
sudo systemctl daemon-reload
sudo systemctl enable magellan-bridge
sudo systemctl start magellan-bridge

echo ""
echo "Step 8: Checking service status..."
sudo systemctl status magellan-bridge --no-pager

echo ""
echo "================================================"
echo -e "${GREEN}Setup Complete!${NC}"
echo "================================================"
echo ""
echo "Next steps:"
echo "1. Logout and login again (or reboot) for dialout group to take effect"
echo "2. Edit scale_bridge.py to configure SERIAL_PORT, BAUDRATE, etc."
echo "3. Restart the service: sudo systemctl restart magellan-bridge"
echo "4. Test endpoints:"
echo "   curl http://localhost:8000/"
echo "   curl http://localhost:8000/barcode"
echo "   curl http://localhost:8000/weight"
echo ""
echo "View logs:"
echo "   journalctl -u magellan-bridge -f"
echo ""
echo "To find your IP address:"
echo "   hostname -I"
echo ""

