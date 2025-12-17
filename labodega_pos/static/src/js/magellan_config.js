/** @odoo-module **/

/**
 * Configuration for Magellan Scale Scanner Bridge
 *
 * Update BRIDGE_URL to point to your Raspberry Pi if it's not on localhost
 */

export const BRIDGE_CONFIG = {
    // Bridge server URL - Browser talks DIRECTLY to Pi via HTTPS (no mixed content error)
    // LAN IP: "https://10.0.0.35:8000" - Direct HTTPS connection on same local network
    //
    // ✅ HTTPS ENABLED (browser can connect from https://erp.labodegacalhoun.com)
    // ⚠️  First time: Open https://10.0.0.35:8000 in browser and accept self-signed cert
    BRIDGE_URL: "https://10.0.0.35:8000",

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

