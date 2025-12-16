/** @odoo-module **/

/**
 * Configuration for Magellan Scale Scanner Bridge
 *
 * Update BRIDGE_URL to point to your Raspberry Pi if it's not on localhost
 */

export const BRIDGE_CONFIG = {
    // Bridge server URL - Browser talks DIRECTLY to Pi (no Odoo proxy, no Tailscale)
    // LAN IP: "http://10.0.0.35:8000" - Direct connection on same local network
    //
    // ✅ DIRECT LAN CONNECTION (no Tailscale needed)
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

