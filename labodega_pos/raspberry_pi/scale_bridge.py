#!/usr/bin/env python3
"""
Magellan Scale Scanner Bridge for Odoo POS
Runs on Raspberry Pi connected to Magellan scanner/scale via serial port
"""

import serial
import threading
import time
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
import uvicorn

# ============================================================================
# CONFIGURATION - Adjust these settings for your setup
# ============================================================================

SERIAL_PORT = "/dev/ttyUSB0"   # Change to your serial port (check with: ls /dev/tty*)
BAUDRATE = 9600                 # Scanner baudrate (usually 9600)

WEIGHT_CMD = b"S11\r"          # Magellan weight request command
WEIGHT_DIVISOR = 100            # Divide raw weight value by this (100 or 1000)
                                # If weight shows 4.5 instead of 0.45, change to 1000

# HTTP Server settings
SERVER_HOST = "0.0.0.0"        # Listen on all interfaces
SERVER_PORT = 8000              # Port for the HTTP API

# ============================================================================
# Application Code
# ============================================================================

app = FastAPI(
    title="Magellan Scale Scanner Bridge",
    description="Bridge between Magellan scanner/scale and Odoo POS",
    version="1.0.0"
)

# Enable CORS for browser access from Odoo
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "https://erp.labodegacalhoun.com",
        "http://localhost:8069",
        "http://127.0.0.1:8069",
        "*"  # Allow all origins (remove in production if needed)
    ],
    allow_credentials=True,
    allow_methods=["GET", "OPTIONS"],
    allow_headers=["*"],
    expose_headers=["*"],
)

# Separate locks: one for serial hardware, one for shared barcode state
serial_lock = threading.Lock()
barcode_lock = threading.Lock()

_last_barcode = None
ser = None


def open_serial():
    """Open and configure serial port connection to scanner"""
    global ser
    if ser and ser.is_open:
        return ser

    print(f"Opening serial port {SERIAL_PORT} at {BAUDRATE} baud...")
    ser = serial.Serial(
        port=SERIAL_PORT,
        baudrate=BAUDRATE,
        bytesize=serial.EIGHTBITS,
        parity=serial.PARITY_NONE,
        stopbits=serial.STOPBITS_ONE,
        timeout=0.35,     # Slightly longer helps with S11 response
        rtscts=False,
        xonxoff=False,
    )
    print(f"Serial port {SERIAL_PORT} opened successfully")
    return ser


def parse_s11_response(frame: bytes):
    """
    Parse S11 weight response frame
    Example: b'S110201\\r' → 2.01 (if WEIGHT_DIVISOR=100)
    Returns float weight or None if invalid
    """
    frame = frame.strip()
    if not frame.startswith(b"S11"):
        return None
    digits = frame[3:]  # Extract digits after 'S11'
    if not digits:
        return None
    try:
        val = int(digits)
        return val / WEIGHT_DIVISOR
    except Exception:
        return None


def barcode_reader_loop():
    """
    Continuously read from serial port.
    - Ignore S11 weight responses (those are on-demand)
    - Treat other CR-terminated frames as barcodes
    - Store the last barcode for the /barcode endpoint to retrieve
    """
    global _last_barcode
    print("Starting barcode reader loop...")

    s = open_serial()
    buf = b""

    while True:
        try:
            with serial_lock:
                data = s.read(256)

            if not data:
                time.sleep(0.01)
                continue

            buf += data

            # Process complete frames (ending with \r)
            while b"\r" in buf:
                line, buf = buf.split(b"\r", 1)
                line = line.strip()
                if not line:
                    continue

                # Ignore weight responses (they're handled by /weight endpoint)
                if line.startswith(b"S11"):
                    continue

                # This is a barcode
                text = line.decode("ascii", errors="ignore").strip()
                if text:
                    print(f"[BARCODE] Scanned: {text}")
                    with barcode_lock:
                        _last_barcode = text

        except Exception as e:
            print(f"[ERROR] Barcode reader error: {e}")
            time.sleep(0.2)


@app.get("/")
def root():
    """Health check endpoint"""
    return {
        "status": "running",
        "service": "Magellan Scale Scanner Bridge",
        "version": "1.0.0",
        "serial_port": SERIAL_PORT,
        "endpoints": {
            "barcode": "/barcode - Get last scanned barcode",
            "weight": "/weight - Get current scale weight"
        }
    }


@app.get("/barcode")
def get_barcode():
    """
    Get the last scanned barcode.
    Returns the barcode and clears it (single-read).

    Response:
        {"barcode": "7501234567890"}  or  {"barcode": null}
    """
    global _last_barcode
    with barcode_lock:
        bc = _last_barcode
        _last_barcode = None

    if bc:
        print(f"[API] /barcode → {bc}")

    return {"barcode": bc}


@app.get("/weight")
def get_weight():
    """
    Request current weight from scale.
    Sends S11 command and reads response.

    Response:
        {"weight": 0.450, "raw": "S110045"}
        or
        {"weight": null, "error": "error message"}
    """
    try:
        s = open_serial()
        with serial_lock:
            # Clear input buffer to avoid reading old data
            try:
                s.reset_input_buffer()
            except Exception:
                pass

            # Send weight request command
            s.write(WEIGHT_CMD)
            s.flush()

            # Read response (one CR-terminated frame)
            frame = s.read_until(b"\r", 64)

        w = parse_s11_response(frame)
        raw = frame.decode("ascii", errors="ignore").strip()

        print(f"[API] /weight → {w} kg (raw: {raw})")

        return {
            "weight": w,
            "raw": raw
        }

    except Exception as e:
        error_msg = str(e)
        print(f"[ERROR] /weight error: {error_msg}")
        return {"weight": None, "error": error_msg}


if __name__ == "__main__":
    import os

    # Check for SSL certificates
    ssl_keyfile = os.path.expanduser("~/magellan_bridge/certs/key.pem")
    ssl_certfile = os.path.expanduser("~/magellan_bridge/certs/cert.pem")
    use_https = os.path.exists(ssl_keyfile) and os.path.exists(ssl_certfile)

    protocol = "https" if use_https else "http"

    print("=" * 60)
    print("Magellan Scale Scanner Bridge")
    print("=" * 60)
    print(f"Serial Port: {SERIAL_PORT}")
    print(f"Baudrate: {BAUDRATE}")
    print(f"Weight Divisor: {WEIGHT_DIVISOR}")
    print(f"HTTP Server: {protocol}://{SERVER_HOST}:{SERVER_PORT}")
    if use_https:
        print("🔒 HTTPS enabled (certificates found)")
    else:
        print("⚠️  HTTP only (no certificates found)")
        print("   Run: openssl req -x509 -newkey rsa:4096 -nodes \\")
        print(f"        -keyout {ssl_keyfile} \\")
        print(f"        -out {ssl_certfile} \\")
        print("        -days 3650 -subj \"/CN=$(hostname -I | awk '{print $1}')\"")
    print("=" * 60)
    print()

    # Open serial port
    try:
        open_serial()
    except Exception as e:
        print(f"ERROR: Could not open serial port: {e}")
        print()
        print("Common fixes:")
        print("  1. Check port name: ls -la /dev/tty*")
        print("  2. Add user to dialout group: sudo usermod -a -G dialout $USER")
        print("  3. Reboot or logout/login after adding to group")
        exit(1)

    # Start barcode reader thread
    threading.Thread(target=barcode_reader_loop, daemon=True).start()

    # Start HTTP server
    print()
    print("Bridge is running!")
    print(f"Test with: curl {'-k ' if use_https else ''}{protocol}://localhost:{SERVER_PORT}/barcode")
    print(f"           curl {'-k ' if use_https else ''}{protocol}://localhost:{SERVER_PORT}/weight")
    print()

    if use_https:
        import ssl
        uvicorn.run(
            app,
            host=SERVER_HOST,
            port=SERVER_PORT,
            ssl_keyfile=ssl_keyfile,
            ssl_certfile=ssl_certfile,
            ssl_version=ssl.PROTOCOL_TLS_SERVER,
            ssl_cert_reqs=ssl.CERT_NONE,
            ssl_ca_certs=None
        )
    else:
        uvicorn.run(app, host=SERVER_HOST, port=SERVER_PORT)

