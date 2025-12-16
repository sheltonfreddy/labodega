# -*- coding: utf-8 -*-
import requests
import logging
from odoo import http
from odoo.http import request

_logger = logging.getLogger(__name__)


class MagellanBridgeController(http.Controller):
    """
    Proxy controller to forward requests from POS frontend to Raspberry Pi bridge
    Supports multiple terminals with different bridge URLs per POS configuration
    """

    def _get_bridge_url(self, pos_session_id=None):
        """
        Get the bridge URL from the POS config or system parameters
        Supports multi-terminal setups where each terminal has its own Raspberry Pi
        """

        # Try to get from POS session's config first
        if pos_session_id:
            try:
                session = request.env['pos.session'].sudo().browse(pos_session_id)
                if session.exists() and session.config_id.magellan_bridge_url:
                    url = session.config_id.magellan_bridge_url
                    _logger.info(f"[Magellan] Using bridge URL from POS config '{session.config_id.name}': {url}")
                    return url
            except Exception as e:
                _logger.warning(f"[Magellan] Could not get bridge URL from session {pos_session_id}: {e}")

        # Fallback to system-wide parameter
        # Default changed to Tailscale IP - change this to your Pi's Tailscale IP
        bridge_url = request.env['ir.config_parameter'].sudo().get_param(
            'labodega_pos.bridge_url',
            'http://100.69.187.119:8000'  # Tailscale IP of Raspberry Pi
        )
        _logger.info(f"[Magellan] Using system-wide bridge URL: {bridge_url}")
        return bridge_url

    @http.route('/pos/magellan/barcode', type='json', auth='user', methods=['POST'], csrf=False)
    def get_barcode(self, pos_session_id=None, **kwargs):
        """
        Proxy endpoint for barcode reading
        Args:
            pos_session_id: ID of the POS session (determines which Pi to connect to)
        Returns: {"barcode": "123456789"} or {"barcode": null}
        """
        bridge_url = None
        try:
            bridge_url = self._get_bridge_url(pos_session_id)
            _logger.debug(f"[Magellan] Barcode request to: {bridge_url}/barcode")

            response = requests.get(
                f"{bridge_url}/barcode",
                timeout=5
            )
            response.raise_for_status()
            data = response.json()

            if data.get('barcode'):
                _logger.info(f"[Magellan] Got barcode: {data.get('barcode')}")

            return data
        except requests.exceptions.ConnectTimeout as e:
            error_msg = f"Connection timeout to {bridge_url or 'unknown'}"
            _logger.error(f"[Magellan] {error_msg}: {e}")
            return {"barcode": None, "error": error_msg}
        except requests.exceptions.ConnectionError as e:
            error_msg = f"Connection refused to {bridge_url or 'unknown'}"
            _logger.error(f"[Magellan] {error_msg}: {e}")
            return {"barcode": None, "error": error_msg}
        except Exception as e:
            _logger.error(f"[Magellan] Error in /pos/magellan/barcode: {e}")
            return {"barcode": None, "error": str(e)}

    @http.route('/pos/magellan/weight', type='json', auth='user', methods=['POST'], csrf=False)
    def get_weight(self, pos_session_id=None, **kwargs):
        """
        Proxy endpoint for weight reading
        Args:
            pos_session_id: ID of the POS session (determines which Pi to connect to)
        Returns: {"weight": 0.450, "raw": "S110045"} or {"weight": null, "error": "..."}
        """
        bridge_url = None
        try:
            bridge_url = self._get_bridge_url(pos_session_id)
            _logger.debug(f"[Magellan] Weight request to: {bridge_url}/weight")

            response = requests.get(
                f"{bridge_url}/weight",
                timeout=5
            )
            response.raise_for_status()
            data = response.json()

            if data.get('weight'):
                _logger.info(f"[Magellan] Got weight: {data.get('weight')} kg")

            return data
        except requests.exceptions.ConnectTimeout as e:
            error_msg = f"Connection timeout to {bridge_url or 'unknown'}"
            _logger.error(f"[Magellan] {error_msg}: {e}")
            return {"weight": None, "error": error_msg}
        except Exception as e:
            _logger.error(f"[Magellan] Error in /pos/magellan/weight: {e}")
            return {"weight": None, "error": str(e)}

    @http.route('/pos/magellan/status', type='json', auth='user', methods=['POST'], csrf=False)
    def get_status(self, pos_session_id=None, **kwargs):
        """
        Check if the bridge is reachable
        Returns: {"status": "ok"} or {"status": "error", "error": "..."}
        """
        bridge_url = None
        try:
            bridge_url = self._get_bridge_url(pos_session_id)
            _logger.info(f"[Magellan] Testing connection to: {bridge_url}")

            response = requests.get(
                f"{bridge_url}/",
                timeout=3
            )
            response.raise_for_status()
            data = response.json()

            _logger.info(f"[Magellan] Successfully connected to bridge: {data.get('service', 'Unknown')}")

            return {
                "status": "ok",
                "bridge_info": data,
                "bridge_url": bridge_url
            }
        except Exception as e:
            _logger.error(f"[Magellan] Error in /pos/magellan/status: {e}")
            return {
                "status": "error",
                "error": str(e),
                "bridge_url": bridge_url or 'unknown'
            }

    # HTTP GET routes for browser fetch() compatibility (avoids mixed content HTTPS→HTTP)

    @http.route('/labodega_pos/proxy/barcode', type='http', auth='user', methods=['GET'], csrf=False)
    def proxy_barcode_get(self, bridge_url=None, **kwargs):
        """
        HTTP GET proxy for barcode reading (browser fetch compatibility)
        Args:
            bridge_url: IP:port of the Raspberry Pi (e.g., "10.0.0.35:8000")
        Returns: JSON {"barcode": "123456789"} or {"barcode": null}
        """
        try:
            # Construct full bridge URL
            if not bridge_url:
                bridge_url = "10.0.0.35:8000"  # Default

            if not bridge_url.startswith('http'):
                bridge_url = f"http://{bridge_url}"

            _logger.debug(f"[Magellan] Barcode proxy GET to: {bridge_url}/barcode")

            response = requests.get(
                f"{bridge_url}/barcode",
                timeout=5
            )
            response.raise_for_status()
            data = response.json()

            if data.get('barcode'):
                _logger.info(f"[Magellan] Got barcode via proxy: {data.get('barcode')}")

            return request.make_json_response(data)
        except requests.exceptions.ConnectTimeout as e:
            error_msg = f"Connection timeout to {bridge_url}"
            _logger.error(f"[Magellan] {error_msg}: {e}")
            return request.make_json_response({"barcode": None, "error": error_msg})
        except requests.exceptions.ConnectionError as e:
            error_msg = f"Connection refused to {bridge_url}"
            _logger.error(f"[Magellan] {error_msg}: {e}")
            return request.make_json_response({"barcode": None, "error": error_msg})
        except Exception as e:
            _logger.error(f"[Magellan] Error in proxy barcode GET: {e}")
            return request.make_json_response({"barcode": None, "error": str(e)})

    @http.route('/labodega_pos/proxy/weight', type='http', auth='user', methods=['GET'], csrf=False)
    def proxy_weight_get(self, bridge_url=None, **kwargs):
        """
        HTTP GET proxy for weight reading (browser fetch compatibility)
        Args:
            bridge_url: IP:port of the Raspberry Pi (e.g., "10.0.0.35:8000")
        Returns: JSON {"weight": 0.450, "raw": "S110045"} or {"weight": null}
        """
        try:
            # Construct full bridge URL
            if not bridge_url:
                bridge_url = "10.0.0.35:8000"  # Default

            if not bridge_url.startswith('http'):
                bridge_url = f"http://{bridge_url}"

            _logger.debug(f"[Magellan] Weight proxy GET to: {bridge_url}/weight")

            response = requests.get(
                f"{bridge_url}/weight",
                timeout=5
            )
            response.raise_for_status()
            data = response.json()

            if data.get('weight'):
                _logger.info(f"[Magellan] Got weight via proxy: {data.get('weight')} kg")

            return request.make_json_response(data)
        except requests.exceptions.ConnectTimeout as e:
            error_msg = f"Connection timeout to {bridge_url}"
            _logger.error(f"[Magellan] {error_msg}: {e}")
            return request.make_json_response({"weight": None, "error": error_msg})
        except Exception as e:
            _logger.error(f"[Magellan] Error in proxy weight GET: {e}")
            return request.make_json_response({"weight": None, "error": str(e)})


