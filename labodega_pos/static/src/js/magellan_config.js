/** @odoo-module **/

/**
 * Configuration for Magellan Scale Scanner Bridge
 *
 * Update BRIDGE_URL to point to your Raspberry Pi if it's not on localhost
 */

export const BRIDGE_CONFIG = {
    // Bridge server URL - Browser talks DIRECTLY to Pi (not through Odoo server)
    //
    // IMPORTANT: This connection happens in the browser, on your LOCAL network
    // The browser must be on the same LAN as the Raspberry Pi (10.0.0.x network)
    //
    // Using HTTP for now - change to https://10.0.0.35:8000 once SSL is configured on Pi
    BRIDGE_URL: "http://10.0.0.35:8000",
    // Lower = more responsive but more CPU/network usage
    BARCODE_POLL_INTERVAL: 200,

    // Error retry delay in milliseconds
    ERROR_RETRY_DELAY: 2000,

    // Connection error retry delay
    CONNECTION_ERROR_DELAY: 1000,

    // Log verbosity (set to false in production)
    VERBOSE_LOGGING: true,
};

