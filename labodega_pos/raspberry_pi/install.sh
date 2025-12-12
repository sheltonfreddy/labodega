#!/bin/bash
#
# Installation script for Magellan Scale Scanner Bridge on Raspberry Pi
# Run with: bash install.sh
#

set -e  # Exit on any error

echo "=========================================="
echo "Magellan Scale Scanner Bridge Installer"
echo "=========================================="
echo ""

# Check if running on Raspberry Pi / Linux
if [[ ! -f /etc/os-release ]]; then
    echo "ERROR: This script is designed for Linux/Raspberry Pi"
    exit 1
fi

# Install Python dependencies
echo "[1/4] Installing Python dependencies..."
pip3 install fastapi uvicorn pyserial --user

# Check serial port
echo ""
echo "[2/4] Checking for serial ports..."
if ls /dev/ttyUSB* 1> /dev/null 2>&1; then
    echo "Found USB serial port(s):"
    ls -la /dev/ttyUSB*
    DETECTED_PORT=$(ls /dev/ttyUSB* | head -n1)
    echo ""
    echo "Detected port: $DETECTED_PORT"
    echo "Make sure to update SERIAL_PORT in scale_bridge.py if this is wrong"
else
    echo "WARNING: No /dev/ttyUSB* ports found"
    echo "Make sure your scanner is connected and drivers are installed"
fi

# Add user to dialout group (for serial port access)
echo ""
echo "[3/4] Adding user to dialout group for serial port access..."
sudo usermod -a -G dialout $USER
echo "✓ User added to dialout group"
echo "NOTE: You may need to logout/login or reboot for this to take effect"

# Create systemd service
echo ""
echo "[4/4] Creating systemd service..."

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
SCRIPT_PATH="$SCRIPT_DIR/scale_bridge.py"

sudo tee /etc/systemd/system/scale-bridge.service > /dev/null <<EOF
[Unit]
Description=Magellan Scale Scanner Bridge for Odoo POS
After=network.target

[Service]
Type=simple
User=$USER
WorkingDirectory=$SCRIPT_DIR
ExecStart=/usr/bin/python3 $SCRIPT_PATH
Restart=always
RestartSec=3
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload

echo "✓ Systemd service created"
echo ""
echo "=========================================="
echo "Installation Complete!"
echo "=========================================="
echo ""
echo "Next steps:"
echo ""
echo "1. Edit configuration in scale_bridge.py:"
echo "   nano $SCRIPT_PATH"
echo ""
echo "2. Test the bridge manually:"
echo "   python3 $SCRIPT_PATH"
echo ""
echo "3. Once working, enable as a service:"
echo "   sudo systemctl enable scale-bridge"
echo "   sudo systemctl start scale-bridge"
echo ""
echo "4. Check service status:"
echo "   sudo systemctl status scale-bridge"
echo ""
echo "5. View logs:"
echo "   sudo journalctl -u scale-bridge -f"
echo ""
echo "6. Test the API:"
echo "   curl http://localhost:8000/"
echo "   curl http://localhost:8000/barcode"
echo "   curl http://localhost:8000/weight"
echo ""

