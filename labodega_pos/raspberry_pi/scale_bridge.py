#!/usr/bin/env python3
"""
Magellan Scale Scanner Bridge for Odoo POS
Runs on Raspberry Pi connected to Magellan scanner/scale via serial port
Also handles receipt printing to Epson printer
"""

import serial
import threading
import time
import subprocess
import tempfile
import os
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
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

# Printer settings
PRINTER_NAME = "epson_pos"      # CUPS printer name (fallback, check with: lpstat -p)
PRINTER_DEVICE = "/dev/usb/lp0" # Direct USB device path (preferred, faster)
CASH_DRAWER_OPEN_CMD = b'\x1b\x70\x00\x19\x19'  # ESC/POS command to open cash drawer

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
    allow_methods=["GET", "POST", "OPTIONS"],  # Added POST for printing
    allow_headers=["*", "Access-Control-Request-Private-Network"],  # Include PNA header
    expose_headers=["*"],
)


# Add Private Network Access (PNA) headers for Chrome compliance
@app.middleware("http")
async def add_private_network_access_headers(request: Request, call_next):
    """
    Add Private Network Access headers required by Chrome for local network requests.
    This allows HTTPS sites to make requests to local IP addresses.

    Chrome's Private Network Access requires:
    1. Preflight OPTIONS request with Access-Control-Request-Private-Network
    2. Server responds with Access-Control-Allow-Private-Network: true
    """
    # Check if this is a PNA preflight request
    if request.method == "OPTIONS" and "access-control-request-private-network" in request.headers:
        # Respond to PNA preflight
        return JSONResponse(
            content={},
            headers={
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Methods": "GET, POST, OPTIONS",  # Added POST for printing
                "Access-Control-Allow-Headers": "*",
                "Access-Control-Allow-Private-Network": "true",
            }
        )

    # Process the actual request
    response = await call_next(request)

    # Always add the PNA header to responses
    response.headers["Access-Control-Allow-Private-Network"] = "true"

    return response

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


def calculate_upc_check_digit(barcode: str) -> str:
    """
    Calculate UPC/EAN check digit using Modulo 10 algorithm.
    Works for UPC-A (11 digits input) and EAN-13 (12 digits input).
    """
    if not barcode or not barcode.isdigit():
        return ""

    total = 0
    for i, digit in enumerate(barcode):
        if i % 2 == 0:
            total += int(digit) * 3
        else:
            total += int(digit)

    check = (10 - (total % 10)) % 10
    return str(check)


# Set to True to match vendor format (10 digits without leading 0)
# Set to False to use full UPC format (12 digits with check digit)
BARCODE_MATCH_VENDOR_FORMAT = True


def normalize_upc_barcode(barcode: str) -> str:
    """
    Normalize UPC/EAN barcodes to match Odoo product barcodes.

    If BARCODE_MATCH_VENDOR_FORMAT is True:
        - '04133106438' (11 digits) → '4133106438' (10 digits, vendor format)
        - Strips leading zero to match vendor import sheets

    If BARCODE_MATCH_VENDOR_FORMAT is False:
        - '04133106438' (11 digits) → '041331064385' (12 digits, full UPC)
        - Adds check digit for full UPC-A format
    """
    if not barcode or not barcode.isdigit():
        return barcode

    length = len(barcode)

    if BARCODE_MATCH_VENDOR_FORMAT:
        # Match vendor format: strip leading zeros, no check digit
        # This matches how vendors typically provide barcodes in import sheets

        # 11 digits starting with 0 → strip to 10 digits (vendor format)
        if length == 11 and barcode.startswith('0'):
            normalized = barcode[1:]  # Remove leading 0
            print(f"[BARCODE] Normalized: {barcode} → {normalized} (vendor format, stripped leading 0)")
            return normalized

        # 12 digits (full UPC) starting with 0 → strip to 10 digits
        if length == 12 and barcode.startswith('0'):
            normalized = barcode[1:11]  # Remove leading 0 and check digit
            print(f"[BARCODE] Normalized: {barcode} → {normalized} (vendor format, stripped 0 and check)")
            return normalized

        # Already 10 digits or other format - return as-is
        return barcode

    else:
        # Full UPC format: ensure 12 digits with check digit

        # Already complete UPC-A (12) or EAN-13 (13)
        if length in (12, 13):
            return barcode

        # 11 digits - missing check digit (scanner stripped it)
        if length == 11:
            check = calculate_upc_check_digit(barcode)
            normalized = barcode + check
            print(f"[BARCODE] Normalized: {barcode} → {normalized} (added check digit)")
            return normalized

        # 10 digits - missing leading 0 AND check digit
        if length == 10:
            with_zero = '0' + barcode
            check = calculate_upc_check_digit(with_zero)
            normalized = with_zero + check
            print(f"[BARCODE] Normalized: {barcode} → {normalized} (added leading 0 + check)")
            return normalized

        # Other lengths - return as-is
        return barcode


def clean_magellan_barcode(barcode: str) -> str:
    """
    Clean Magellan scanner barcode prefixes/suffixes and normalize.

    Magellan scanners often prepend codes like:
    - S08A + barcode (most common)
    - S08 + barcode
    - Other symbology identifiers

    This strips known prefixes and normalizes UPC/EAN barcodes.
    """
    if not barcode:
        return barcode

    # List of known Magellan prefixes to strip
    prefixes = [
        'S08A',  # Common Magellan prefix
        'S08F',  # EAN-13 with symbology identifier
        'S08E',  # EAN variant
        'S08',  # Alternate prefix
        'S09',  # Another variant
        'S0A',  # Short variant
        'F',  # Standalone EAN/UPC symbology identifier
        'E',  # Another EAN variant
        'A',  # UPC-A identifier
    ]

    cleaned = barcode
    for prefix in prefixes:
        if barcode.startswith(prefix):
            cleaned = barcode[len(prefix):]
            print(f"[BARCODE] Cleaned: {barcode} → {cleaned} (removed prefix: {prefix})")
            break

    # Normalize UPC/EAN barcodes (add check digit if missing)
    normalized = normalize_upc_barcode(cleaned)
    return normalized


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
                    # Clean Magellan prefixes (like S08A)
                    cleaned_barcode = clean_magellan_barcode(text)
                    print(f"[BARCODE] Scanned: {text} → Clean: {cleaned_barcode}")
                    with barcode_lock:
                        _last_barcode = cleaned_barcode

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


# ============================================================================
# Printer Endpoints
# ============================================================================

@app.post("/print_raw")
async def print_raw(request: Request):
    """
    Print raw ESC/POS data to the receipt printer.
    Uses direct device write for speed (bypasses CUPS).

    Request body: Raw binary data (ESC/POS commands)
    Response: {"status": "printed"} or {"status": "error", "message": "..."}
    """
    try:
        data = await request.body()

        if not data:
            return {"status": "error", "message": "No data received"}

        # Try direct device write first (fastest)
        if os.path.exists(PRINTER_DEVICE):
            try:
                with open(PRINTER_DEVICE, 'wb') as printer:
                    printer.write(data)
                    printer.flush()
                print(f"[PRINT] Direct print sent ({len(data)} bytes)")
                return {"status": "printed", "bytes": len(data)}
            except PermissionError:
                print(f"[PRINT] Permission denied on {PRINTER_DEVICE}, falling back to CUPS")
            except Exception as e:
                print(f"[PRINT] Direct print failed: {e}, falling back to CUPS")

        # Fallback to CUPS if direct write fails
        with tempfile.NamedTemporaryFile(delete=False, suffix='.bin') as f:
            f.write(data)
            temp_path = f.name

        try:
            result = subprocess.run(
                ["lp", "-d", PRINTER_NAME, "-o", "raw", temp_path],
                capture_output=False,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.PIPE,
                timeout=10
            )

            if result.returncode != 0:
                error_msg = result.stderr.decode() if result.stderr else "Unknown error"
                print(f"[PRINT] CUPS Error: {error_msg}")
                return {"status": "error", "message": error_msg}

            print(f"[PRINT] CUPS print job sent ({len(data)} bytes)")
            return {"status": "printed", "bytes": len(data)}

        finally:
            try:
                os.unlink(temp_path)
            except Exception:
                pass

    except Exception as e:
        print(f"[PRINT] Error: {e}")
        return {"status": "error", "message": str(e)}


@app.post("/print_receipt")
async def print_receipt(request: Request):
    """
    Print a receipt from HTML or text content.
    Converts to ESC/POS format for thermal printer.
    Uses direct device write for speed (bypasses CUPS).

    Request body: JSON with {"content": "receipt text or html", "cut": true}
    Response: {"status": "printed"} or {"status": "error", "message": "..."}
    """
    try:
        body = await request.json()
        content = body.get("content", "")
        should_cut = body.get("cut", True)
        open_drawer = body.get("open_drawer", False)

        if not content:
            return {"status": "error", "message": "No content provided"}

        # Build ESC/POS data
        esc_data = bytearray()

        # Initialize printer
        esc_data.extend(b'\x1b\x40')  # ESC @ - Initialize printer

        # If HTML, strip tags for now (basic conversion)
        if '<' in content and '>' in content:
            import re
            # Remove HTML tags
            text = re.sub(r'<br\s*/?>', '\n', content, flags=re.IGNORECASE)
            text = re.sub(r'<[^>]+>', '', text)
            # Decode HTML entities
            text = text.replace('&nbsp;', ' ')
            text = text.replace('&amp;', '&')
            text = text.replace('&lt;', '<')
            text = text.replace('&gt;', '>')
            content = text

        # Add content
        esc_data.extend(content.encode('utf-8', errors='replace'))

        # Add line feeds before cut
        esc_data.extend(b'\n\n\n\n')

        # Cut paper if requested
        if should_cut:
            esc_data.extend(b'\x1d\x56\x00')  # GS V 0 - Full cut

        # Open cash drawer if requested
        if open_drawer:
            esc_data.extend(CASH_DRAWER_OPEN_CMD)

        # Try direct device write first (fastest)
        if os.path.exists(PRINTER_DEVICE):
            try:
                with open(PRINTER_DEVICE, 'wb') as printer:
                    printer.write(esc_data)
                    printer.flush()
                print(f"[PRINT] Direct receipt print ({len(esc_data)} bytes)")
                return {"status": "printed", "bytes": len(esc_data)}
            except PermissionError:
                print(f"[PRINT] Permission denied on {PRINTER_DEVICE}, falling back to CUPS")
            except Exception as e:
                print(f"[PRINT] Direct print failed: {e}, falling back to CUPS")

        # Fallback to CUPS
        with tempfile.NamedTemporaryFile(delete=False, suffix='.bin') as f:
            f.write(esc_data)
            temp_path = f.name

        try:
            result = subprocess.run(
                ["lp", "-d", PRINTER_NAME, "-o", "raw", temp_path],
                capture_output=False,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.PIPE,
                timeout=10
            )

            if result.returncode != 0:
                error_msg = result.stderr.decode() if result.stderr else "Unknown error"
                print(f"[PRINT] CUPS Error: {error_msg}")
                return {"status": "error", "message": error_msg}

            print(f"[PRINT] CUPS receipt printed ({len(esc_data)} bytes)")
            return {"status": "printed", "bytes": len(esc_data)}

        finally:
            try:
                os.unlink(temp_path)
            except Exception:
                pass

    except Exception as e:
        print(f"[PRINT] Error: {e}")
        return {"status": "error", "message": str(e)}


@app.post("/print_image")
async def print_image(request: Request):
    """
    Print a base64-encoded image (from Odoo's htmlToCanvas).
    Converts to ESC/POS raster format for thermal printer.

    Request body: JSON with {"image": "base64_jpeg_data"}
    Response: {"status": "printed"} or {"status": "error", "message": "..."}
    """
    try:
        import base64

        body = await request.json()
        image_data = body.get("image", "")

        if not image_data:
            return {"status": "error", "message": "No image data provided"}

        # Decode base64 image
        try:
            # Remove data URL prefix if present
            if "," in image_data:
                image_data = image_data.split(",")[1]

            image_bytes = base64.b64decode(image_data)
        except Exception as e:
            return {"status": "error", "message": f"Invalid base64 data: {e}"}

        # For now, save as temp file and print via CUPS
        # A full implementation would convert JPEG to ESC/POS raster bitmap
        with tempfile.NamedTemporaryFile(delete=False, suffix='.jpg') as f:
            f.write(image_bytes)
            temp_path = f.name

        try:
            # Try printing the image directly
            # Note: This may require printer-specific drivers
            result = subprocess.run(
                ["lp", "-d", PRINTER_NAME, temp_path],
                capture_output=True,
                text=True,
                timeout=15
            )

            if result.returncode != 0:
                print(f"[PRINT] Image print error: {result.stderr}")
                # Fallback: return error so client can use text printing
                return {"status": "error", "message": "Image printing not supported"}

            print(f"[PRINT] Image printed ({len(image_bytes)} bytes)")
            return {"status": "printed", "bytes": len(image_bytes)}

        finally:
            try:
                os.unlink(temp_path)
            except Exception:
                pass

    except Exception as e:
        print(f"[PRINT] Image error: {e}")
        return {"status": "error", "message": str(e)}


@app.post("/open_drawer")
async def open_drawer():
    """
    Open the cash drawer connected to the printer.
    Uses direct device write for speed (bypasses CUPS).

    Response: {"status": "opened"} or {"status": "error", "message": "..."}
    """
    try:
        # Try direct device write first (fastest)
        if os.path.exists(PRINTER_DEVICE):
            try:
                with open(PRINTER_DEVICE, 'wb') as printer:
                    printer.write(CASH_DRAWER_OPEN_CMD)
                    printer.flush()
                print("[DRAWER] Cash drawer opened (direct)")
                return {"status": "opened"}
            except PermissionError:
                print(f"[DRAWER] Permission denied on {PRINTER_DEVICE}, falling back to CUPS")
            except Exception as e:
                print(f"[DRAWER] Direct write failed: {e}, falling back to CUPS")

        # Fallback to CUPS
        with tempfile.NamedTemporaryFile(delete=False, suffix='.bin') as f:
            f.write(CASH_DRAWER_OPEN_CMD)
            temp_path = f.name

        try:
            result = subprocess.run(
                ["lp", "-d", PRINTER_NAME, "-o", "raw", temp_path],
                capture_output=False,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.PIPE,
                timeout=10
            )

            if result.returncode != 0:
                error_msg = result.stderr.decode() if result.stderr else "Unknown error"
                print(f"[DRAWER] CUPS Error: {error_msg}")
                return {"status": "error", "message": error_msg}

            print("[DRAWER] Cash drawer opened (CUPS)")
            return {"status": "opened"}

        finally:
            try:
                os.unlink(temp_path)
            except Exception:
                pass

    except Exception as e:
        print(f"[DRAWER] Error: {e}")
        return {"status": "error", "message": str(e)}


@app.get("/printer_status")
def printer_status():
    """
    Check printer status.
    Checks direct device first, then CUPS as fallback.

    Response: {"status": "ready", "printer": "epson_pos"} or error
    """
    try:
        # Check direct device first (preferred method)
        if os.path.exists(PRINTER_DEVICE):
            try:
                # Try to open device for writing (tests availability)
                with open(PRINTER_DEVICE, 'wb') as printer:
                    pass  # Just test that we can open it
                return {
                    "status": "ready",
                    "printer": PRINTER_DEVICE,
                    "method": "direct",
                    "details": f"Direct USB device {PRINTER_DEVICE} available"
                }
            except PermissionError:
                return {
                    "status": "error",
                    "message": f"Permission denied on {PRINTER_DEVICE}. Run: sudo chmod 666 {PRINTER_DEVICE}"
                }
            except Exception as e:
                # Device exists but can't open - fall through to CUPS check
                pass

        # Fallback: Check CUPS printer status
        result = subprocess.run(
            ["lpstat", "-p", PRINTER_NAME],
            capture_output=True,
            text=True,
            timeout=5
        )

        output = result.stdout.strip()
        is_ready = "idle" in output.lower() or "enabled" in output.lower()

        return {
            "status": "ready" if is_ready else "busy",
            "printer": PRINTER_NAME,
            "method": "cups",
            "details": output
        }

    except Exception as e:
        return {"status": "error", "message": str(e)}


if __name__ == "__main__":
    import os

    # Check for SSL certificates
    ssl_keyfile = os.path.expanduser("~/iot_bridge/certs/key.pem")
    ssl_certfile = os.path.expanduser("~/iot_bridge/certs/cert.pem")

    # Check if certificates exist
    key_exists = os.path.exists(ssl_keyfile)
    cert_exists = os.path.exists(ssl_certfile)
    use_https = key_exists and cert_exists

    protocol = "https" if use_https else "http"

    print("=" * 60)
    print("Magellan Scale Scanner Bridge + Receipt Printer")
    print("=" * 60)
    print(f"Serial Port: {SERIAL_PORT}")
    print(f"Baudrate: {BAUDRATE}")
    print(f"Weight Divisor: {WEIGHT_DIVISOR}")
    print()
    print("Printer Configuration:")
    print(f"  Direct Device: {PRINTER_DEVICE}")
    device_available = os.path.exists(PRINTER_DEVICE)
    print(f"    Available: {'✓ YES (fast mode)' if device_available else '✗ NO (will use CUPS)'}")
    print(f"  CUPS Printer: {PRINTER_NAME} (fallback)")
    print()
    print(f"HTTP Server: {protocol}://{SERVER_HOST}:{SERVER_PORT}")
    print()
    print("SSL Certificate Check:")
    print(f"  Key file:  {ssl_keyfile}")
    print(f"    Exists: {'✓ YES' if key_exists else '✗ NO'}")
    print(f"  Cert file: {ssl_certfile}")
    print(f"    Exists: {'✓ YES' if cert_exists else '✗ NO'}")
    print()
    if use_https:
        print("🔒 HTTPS ENABLED (certificates found)")
    else:
        print("⚠️  HTTP ONLY (no certificates found)")
        print()
        print("To enable HTTPS, generate certificates:")
        print("  mkdir -p ~/iot_bridge/certs")
        print("  cd ~/iot_bridge/certs")
        print("  openssl req -x509 -newkey rsa:2048 -nodes \\")
        print("    -keyout key.pem -out cert.pem -days 3650 \\")
        print("    -subj \"/CN=$(hostname -I | awk '{print $1}')\" \\")
        print("    -addext \"subjectAltName=IP:$(hostname -I | awk '{print $1}')\"")
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
    print(f"           curl {'-k ' if use_https else ''}{protocol}://localhost:{SERVER_PORT}/printer_status")
    print()
    print("Print test:")
    print(f"  echo -e '\\x1B@TEST RECEIPT\\n\\x1DVA0' | curl -X POST -H 'Content-Type: application/octet-stream' --data-binary @- {'-k ' if use_https else ''}{protocol}://localhost:{SERVER_PORT}/print_raw")
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

