/** @odoo-module **/

/**
 * Configuration for Magellan Scale Scanner Bridge
 *
 * Update BRIDGE_URL to point to your Raspberry Pi if it's not on localhost
 */

export const BRIDGE_CONFIG = {
    // Bridge server URL
    // For localhost (development/testing): "http://127.0.0.1:8000"
    // For remote Pi: "http://192.168.1.100:8000" (use your Pi's IP)
    BRIDGE_URL: "http://10.0.0.35:8000",

    // Polling interval in milliseconds
    // Lower = more responsive but more CPU/network usage
    BARCODE_POLL_INTERVAL: 200,

    // Error retry delay in milliseconds
    ERROR_RETRY_DELAY: 2000,

    // Connection error retry delay
    CONNECTION_ERROR_DELAY: 1000,

    // Log verbosity (set to false in production)
    VERBOSE_LOGGING: true,
};

