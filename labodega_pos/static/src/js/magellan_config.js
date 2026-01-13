/** @odoo-module **/

/**
 * Configuration for Magellan Scale Scanner Bridge
 *
 * Multi-Terminal Setup:
 * - Each POS Config can have its own magellan_bridge_url
 * - Set the URL in Point of Sale → Configuration → Point of Sale
 * - The BRIDGE_URL below is only used as a fallback if not configured
 */

export const BRIDGE_CONFIG = {
    // Fallback Bridge URL (used if not set in POS Config)
    // Each terminal should have its own bridge URL configured in pos.config
    BRIDGE_URL: "https://10.0.0.34:8000",

    // Lower = more responsive but more CPU/network usage
    BARCODE_POLL_INTERVAL: 200,

    // Error retry delay in milliseconds
    ERROR_RETRY_DELAY: 2000,

    // Connection error retry delay
    CONNECTION_ERROR_DELAY: 1000,

    // Log verbosity (set to false in production)
    VERBOSE_LOGGING: true,
};

/**
 * Get the bridge URL from POS config or fallback to default
 * @param {Object} pos - The POS instance
 * @returns {string} Bridge URL
 */
export function getBridgeUrl(pos) {
    const configUrl = pos?.config?.magellan_bridge_url;
    const url = configUrl || BRIDGE_CONFIG.BRIDGE_URL;

    if (BRIDGE_CONFIG.VERBOSE_LOGGING) {
        console.log(`[Magellan] Using bridge URL: ${url}`,
            configUrl ? '(from POS config)' : '(fallback default)');
    }

    return url;
}

