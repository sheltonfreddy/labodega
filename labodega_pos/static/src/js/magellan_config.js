/** @odoo-module **/

/**
 * Configuration for Magellan Scale Scanner Bridge
 *
 * Update BRIDGE_URL to point to your Raspberry Pi if it's not on localhost
 */

export const BRIDGE_CONFIG = {
    // Bridge server URL - Browser talks DIRECTLY to Pi via HTTPS (not through Odoo server)
    //
    // IMPORTANT: This connection happens in the browser, on your LOCAL network
    // The browser must be on the same LAN as the Raspberry Pi (10.0.0.x network)
    //
    // Using HTTPS to avoid mixed content warnings on HTTPS Odoo site
    // First time: You may need to accept the self-signed certificate by visiting
    // https://10.0.0.35:8000 directly in your browser
    //BRIDGE_URL: "https://172.16.19.185:8000",
    BRIDGE_URL: "https://10.0.0.35:8000",
    // Lower = more responsive but more CPU/network usage
    BARCODE_POLL_INTERVAL: 200,

    // Error retry delay in milliseconds
    ERROR_RETRY_DELAY: 2000,

    // Connection error retry delay
    CONNECTION_ERROR_DELAY: 1000,

    // Log verbosity (set to false in production)
    VERBOSE_LOGGING: true,
};

